import QRCode from "qrcode";
import type { Config } from "../config.js";
import { CourtClient, linkRejectionReason } from "../court/client.js";
import { NearRpc } from "../near/rpc.js";
import type { KeeperSigner } from "../near/signer.js";
import { renderRules } from "../spec/render.js";
import {
  buildCreateMarketTxs,
  parseCreateMarketResult,
  type BuildInput,
} from "./txBuilder.js";
import { SignStore, type SignRequest } from "./store.js";

const STORAGE_BUFFER = 100_000_000_000_000_000_000_000n; // 0.1 NEAR, not refunded by Noa
const DEFAULT_FEE = 500_000_000_000_000_000_000_000n; // Noa's current 0.5 NEAR default

export type SignDependencies = {
  config: Config;
  store: SignStore;
  rpc: NearRpc;
  court: CourtClient;
  signer: Pick<KeeperSigner, "send">;
};

export async function createSignRequest(
  config: Config,
  store: SignStore,
  input: Omit<BuildInput, "court_contract" | "noa_contract">,
) {
  if (new URL(config.publicBaseUrl).protocol !== "https:")
    throw new Error("PUBLIC_BASE_URL must use HTTPS");
  const plan = buildCreateMarketTxs({
    ...input,
    court_contract: config.courtContract,
    noa_contract: config.noaContract,
  });
  const request = store.create(input, input.spec_json, input.spec_hash, plan);
  const url = `${config.publicBaseUrl.replace(/\/$/, "")}/sign/${request.id}`;
  const qr_png_data_url = await QRCode.toDataURL(url, {
    type: "image/png",
    margin: 1,
  });
  return {
    url,
    qr_png_data_url,
    expires_at: request.expires_at,
    spec_hash: request.spec_hash,
    summary: {
      title: input.title,
      outcomes: input.outcomes,
      stake: input.stake,
      token_id: input.token_id || config.marketToken,
      duration_minutes: input.duration_minutes,
      duration_days: input.duration_days,
      resolution_window_minutes:
        plan.at(-1)?.actions[0]?.params.args.resolution_window_minutes,
    },
  };
}

export function publicRequest(config: Config, request: SignRequest) {
  const rendered = renderRules(request.spec_json);
  const spec = JSON.parse(request.spec_json) as Record<string, any>;
  const url = `${config.publicBaseUrl.replace(/\/$/, "")}/sign/${request.id}`;
  return {
    id: request.id,
    status: request.status,
    expires_at: request.expires_at,
    params: {
      title: request.params.title,
      outcomes: request.params.outcomes,
      stake: request.params.stake,
      duration_minutes: request.params.duration_minutes,
      duration_days: request.params.duration_days,
      resolution_window_minutes: request.params.resolution_window_minutes,
      creator: request.params.creator,
    },
    spec_hash: request.spec_hash,
    rules_markdown: rendered.rules_markdown,
    spec_summary: {
      question: spec.question,
      observation: spec.observation,
      outcomes: spec.outcomes,
      sources: (spec.sources || []).map((source: Record<string, any>) => ({
        id: source.id,
        tool: source.tool,
      })),
    },
    tx_plan: request.tx_plan,
    result: request.result,
    network: {
      networkId: config.nearNetwork,
      nodeUrl: config.nearRpcUrls[0],
      courtContract: config.courtContract,
      noaContract: config.noaContract,
    },
    qr_url: url,
  };
}

export async function planForAccount(
  deps: SignDependencies,
  request: SignRequest,
  accountId: string,
) {
  if (request.status !== "pending")
    throw new Error(`sign request ${request.status}`);
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId))
    throw new Error("invalid NEAR account ID");
  const [feeExempt, balance, courtConfig, noaConfig] = await Promise.all([
    deps.rpc.view<boolean>(deps.config.noaContract, "is_fee_exempt", {
      account_id: accountId,
    }),
    deps.rpc.view<string>(deps.config.noaContract, "get_user_balance", {
      account_id: accountId,
      token_id: deps.config.marketToken,
    }),
    deps.court.configView(),
    deps.rpc.view<Record<string, any>>(
      deps.config.noaContract,
      "get_config",
      {},
    ),
  ]);
  const fee = BigInt(String(noaConfig.market_creation_fee ?? DEFAULT_FEE));
  const createDeposit = feeExempt ? 0n : fee + STORAGE_BUFFER;
  const plan = buildCreateMarketTxs({
    ...(request.params as BuildInput),
    court_contract: deps.config.courtContract,
    noa_contract: deps.config.noaContract,
    token_id: deps.config.marketToken,
    signer_id: accountId,
    internal_balance_yocto: String(balance),
    register_deposit_yocto: String(
      courtConfig.min_deposit ?? "100000000000000000000000",
    ),
    create_market_deposit_yocto: createDeposit.toString(),
  });
  return {
    account_id: accountId,
    tx_plan: plan,
    note: feeExempt
      ? "Fee exempt; Noa creation deposit is zero"
      : "Noa charges its creation fee plus a 0.1 NEAR storage buffer and does not refund excess",
  };
}

function decodeArgs(action: unknown): Record<string, any> | null {
  const entry = (action as Record<string, any>)?.FunctionCall;
  if (!entry) return null;
  try {
    if (typeof entry.args === "string")
      return JSON.parse(Buffer.from(entry.args, "base64").toString("utf8"));
    if (entry.args && typeof entry.args === "object") return entry.args;
  } catch {
    return null;
  }
  return null;
}

export async function completeSignRequest(
  deps: SignDependencies,
  request: SignRequest,
  txHashes: string[],
  accountId: string,
) {
  if (request.status === "completed") return request.result;
  if (request.status !== "pending")
    throw new Error(`sign request ${request.status}`);
  if (
    !/^[a-z0-9._-]{2,64}$/.test(accountId) ||
    txHashes.length < 2 ||
    txHashes.length > 3 ||
    txHashes.some((hash) => !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hash))
  )
    throw new Error("invalid account or transaction hashes");
  const statuses = await Promise.all(
    txHashes.map((hash) => deps.rpc.txStatus(hash, accountId)),
  );
  for (const status of statuses) {
    if (
      status.transaction?.signer_id !== accountId ||
      status.status?.Failure ||
      (!status.status?.SuccessValue && status.status?.SuccessValue !== "")
    )
      throw new Error("transaction did not succeed for the stated signer");
  }
  const create = statuses.at(-1)!;
  if (create.transaction.receiver_id !== deps.config.noaContract)
    throw new Error("last transaction did not call Noa");
  const action = create.transaction.actions?.find(
    (entry: any) => entry.FunctionCall?.method_name === "create_market",
  );
  const args = decodeArgs(action);
  if (
    !args ||
    args.metadata_hash !== `noacourt:${request.spec_hash}` ||
    args.resolver !== deps.config.courtContract ||
    args.title !== request.params.title ||
    JSON.stringify(args.outcomes) !== JSON.stringify(request.params.outcomes)
  )
    throw new Error(
      "create_market transaction does not match this sign request",
    );
  const register = statuses.at(-2)!;
  const registerAction = register.transaction?.actions?.find(
    (entry: any) => entry.FunctionCall?.method_name === "register_spec",
  );
  const registerArgs = decodeArgs(registerAction);
  if (
    register.transaction?.receiver_id !== deps.config.courtContract ||
    registerArgs?.spec_json !== request.spec_json
  )
    throw new Error(
      "register_spec transaction does not match this sign request",
    );
  const { market_id } = parseCreateMarketResult(create);
  let linked = false;
  let link_tx_hash: string | null = null;
  let link_error: string | null = null;
  try {
    const sent = await deps.signer.send({
      receiverId: deps.config.courtContract,
      methodName: "link_market",
      args: { market_id, spec_hash: null },
      gasTgas: 100,
    });
    link_tx_hash = sent.txHash;
    if (sent.status === "unknown" || sent.status === "pending") {
      link_error = `Court link status ${sent.status}; keeper will recheck the market`;
    } else if (sent.status === "failure") {
      link_error = sent.error ?? "Court link transaction failed";
    } else {
      const status = (sent.outcome as Record<string, any>)?.status;
      const returned = status?.SuccessValue
        ? Buffer.from(status.SuccessValue, "base64").toString("utf8")
        : "";
      linked =
        !status?.Failure && sent.return_value !== false && returned !== "false";
      if (!linked)
        link_error =
          linkRejectionReason(sent.outcome) ||
          "Court link_market rejected; keeper will retry";
    }
  } catch (error) {
    link_error =
      error instanceof Error ? error.message : "keeper link unavailable";
  }
  const result = {
    market_id,
    account_id: accountId,
    tx_hashes: txHashes,
    linked,
    link_tx_hash,
    link_error,
  };
  deps.store.complete(request.id, result);
  return result;
}
