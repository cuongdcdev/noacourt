import QRCode from "qrcode";
import type { Config } from "../config.js";
import { CourtClient, linkRejectionReason } from "../court/client.js";
import { NearRpc } from "../near/rpc.js";
import type { KeeperSigner } from "../near/signer.js";
import { renderRules } from "../spec/render.js";
import {
  buildCreateMarketTxs,
  effectiveAttempts,
  parseCreateMarketResult,
  type BuildInput,
} from "./txBuilder.js";
import { SignStore, type SignRequest } from "./store.js";
import {
  buildSnapshot,
  publicationView,
  resolvePublicationConfig,
} from "./publication.js";
import { calculateSignTiming, SignPlanConflictError } from "./timing.js";
import { requiredResolutionWindowMinutes } from "./txBuilder.js";
import { DEFAULT_RETRY_POLICY } from "../spec/defaults.js";
import type { ActionHistory } from "../keeper/history.js";

const STORAGE_BUFFER = 100_000_000_000_000_000_000_000n; // 0.1 NEAR, not refunded by Noa
const DEFAULT_FEE = 500_000_000_000_000_000_000_000n; // Noa's current 0.5 NEAR default

export type SignDependencies = {
  config: Config;
  store: SignStore;
  rpc: NearRpc;
  court: CourtClient;
  signer: Pick<KeeperSigner, "send">;
  history?: ActionHistory;
};

export async function createSignRequest(
  config: Config,
  store: SignStore,
  rawInput: Omit<BuildInput, "court_contract" | "noa_contract"> & {
    description?: string;
  },
  requestedAtMs = Date.now(),
) {
  const { description, ...input } = rawInput;
  const publicationConfig = resolvePublicationConfig(config);
  if (publicationConfig.status === "invalid")
    throw new Error(
      `Noa metadata publication config invalid: ${publicationConfig.error}`,
    );
  if (new URL(config.publicBaseUrl).protocol !== "https:")
    throw new Error("PUBLIC_BASE_URL must use HTTPS");
  const nowMs = Date.now();
  const spec = JSON.parse(input.spec_json) as Record<string, any>;
  const observationAt = String(spec.observation?.at ?? "");
  const requestedCloseAt =
    input.requested_close_at ??
    (input.duration_minutes !== undefined || input.duration_days !== undefined
      ? new Date(
          requestedAtMs +
            (input.duration_minutes ?? (input.duration_days ?? 0) * 1440) *
              60_000,
        ).toISOString()
      : observationAt);
  const timing = calculateSignTiming({
    observation_at: observationAt,
    requested_close_at: requestedCloseAt,
    now_ms: nowMs,
    sign_margin_minutes: config.signMarginMinutes,
  });
  const requiredWindow = requiredResolutionWindowMinutes(
    observationAt,
    timing.expiration_estimate_at,
    effectiveAttempts(spec.retry?.max_attempts, input.court_max_attempts),
    spec.retry?.every ?? DEFAULT_RETRY_POLICY.every,
  );
  const resolutionWindow = Math.max(
    input.resolution_window_minutes ?? requiredWindow,
    requiredWindow,
  );
  const warnings: string[] = [];
  if (
    input.resolution_window_minutes !== undefined &&
    input.resolution_window_minutes < requiredWindow
  )
    warnings.push(
      `resolution_window_minutes ${input.resolution_window_minutes} is too short for observation time and retries; raised to ${requiredWindow} minutes.`,
    );
  if (timing.clipped)
    warnings.push(
      "Requested trading close was after observation.at; clipped to observation time.",
    );
  if (Date.parse(timing.sign_before) - nowMs < 10 * 60_000)
    warnings.push(
      "Sign-before is less than 10 minutes away; choose a later observation time to allow wallet approval.",
    );
  const params = {
    ...input,
    requested_close_at: requestedCloseAt,
    sign_before: timing.sign_before,
    resolution_window_minutes: resolutionWindow,
  };
  const plan = buildCreateMarketTxs({
    ...params,
    duration_minutes: timing.duration_minutes,
    duration_days: undefined,
    observation_at: observationAt,
    expiration_estimate_at: timing.expiration_estimate_at,
    court_contract: config.courtContract,
    noa_contract: config.noaContract,
  });
  const expiresAt = new Date(
    Math.min(nowMs + 24 * 60 * 60_000, Date.parse(timing.sign_before)),
  ).toISOString();
  const snapshot = buildSnapshot({
    spec_json: input.spec_json,
    spec_hash: input.spec_hash,
    title: input.title,
    token_id: input.token_id || config.marketToken,
    outcomes: input.outcomes,
    description,
  });
  const request = store.create(
    params,
    input.spec_json,
    input.spec_hash,
    plan,
    expiresAt,
    snapshot,
  );
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
    metadata_digest: snapshot.metadata_digest,
    description: snapshot.description,
    description_is_fallback:
      description === undefined || description.trim() === "",
    publication: publicationConfig.status,
    sign_before: timing.sign_before,
    requested_close_at: requestedCloseAt,
    now_utc: new Date(nowMs).toISOString(),
    warnings,
    summary: {
      title: input.title,
      outcomes: input.outcomes,
      stake: input.stake,
      token_id: input.token_id || config.marketToken,
      duration_minutes: input.duration_minutes,
      duration_days: input.duration_days,
      resolution_window_minutes: resolutionWindow,
      planned_duration_minutes: timing.duration_minutes,
    },
  };
}

/** Legacy pending rows get one deterministic snapshot, frozen before review/signing. */
export function ensureSnapshot(
  config: Config,
  store: SignStore,
  request: SignRequest,
): SignRequest {
  if (request.snapshot || request.status !== "pending") return request;
  store.freezeSnapshot(
    request.id,
    buildSnapshot({
      spec_json: request.spec_json,
      spec_hash: request.spec_hash,
      title: request.params.title,
      token_id: request.params.token_id ?? config.marketToken,
      outcomes: request.params.outcomes,
    }),
  );
  return store.get(request.id) ?? request;
}

export function publicRequest(config: Config, request: SignRequest) {
  const rendered = request.snapshot
    ? { rules_markdown: request.snapshot.rules }
    : renderRules(request.spec_json);
  const spec = JSON.parse(request.spec_json) as Record<string, any>;
  const url = `${config.publicBaseUrl.replace(/\/$/, "")}/sign/${request.id}`;
  return {
    id: request.id,
    status: request.status,
    expires_at: request.expires_at,
    sign_before: request.params.sign_before,
    requested_close_at: request.params.requested_close_at,
    params: {
      title: request.params.title,
      outcomes: request.params.outcomes,
      stake: request.params.stake,
      duration_minutes: request.params.duration_minutes,
      duration_days: request.params.duration_days,
      resolution_window_minutes: request.params.resolution_window_minutes,
      creator: request.params.creator,
      token_id: request.params.token_id ?? config.marketToken,
    },
    spec_hash: request.spec_hash,
    rules_markdown: rendered.rules_markdown,
    description: request.snapshot?.description ?? null,
    renderer_version: request.snapshot?.renderer_version ?? null,
    metadata_digest: request.snapshot?.metadata_digest ?? null,
    publication: publicationView(config, request),
    spec_summary: {
      question: spec.question,
      observation: spec.observation,
      decision_kind: spec.decide?.kind,
      decide:
        spec.decide?.kind === "threshold"
          ? { kind: "threshold", op: spec.decide.op, value: spec.decide.value }
          : { kind: spec.decide?.kind },
      outcome_map: spec.outcome_map,
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
    throw new SignPlanConflictError(
      `sign request ${request.status}; signing deadline passed`,
    );
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId))
    throw new Error("invalid NEAR account ID");
  const publicationConfig = resolvePublicationConfig(deps.config);
  if (publicationConfig.status === "invalid")
    throw new SignPlanConflictError(
      `Noa metadata publication config invalid; no create transaction will be offered: ${publicationConfig.error}`,
    );
  const spec = JSON.parse(request.spec_json) as Record<string, any>;
  const observationAt = String(spec.observation?.at ?? "");
  const requestedCloseAt =
    request.params.requested_close_at ??
    (request.params.duration_minutes !== undefined ||
    request.params.duration_days !== undefined
      ? new Date(
          Date.parse(request.created_at) +
            (request.params.duration_minutes ??
              request.params.duration_days * 1440) *
              60_000,
        ).toISOString()
      : observationAt);
  const timing = calculateSignTiming({
    observation_at: observationAt,
    requested_close_at: requestedCloseAt,
    now_ms: Date.now(),
    sign_margin_minutes: deps.config.signMarginMinutes,
  });
  const tokenId = request.params.token_id ?? deps.config.marketToken;
  const [feeExempt, balance, courtConfig, noaConfig] = await Promise.all([
    deps.rpc.view<boolean>(deps.config.noaContract, "is_fee_exempt", {
      account_id: accountId,
    }),
    deps.rpc.view<string>(deps.config.noaContract, "get_user_balance", {
      account_id: accountId,
      token_id: tokenId,
    }),
    deps.court.configView(),
    deps.rpc.view<Record<string, any>>(
      deps.config.noaContract,
      "get_config",
      {},
    ),
  ]);
  const configuredAttempts = Number(courtConfig.max_attempts);
  const courtAttempts =
    Number.isSafeInteger(configuredAttempts) && configuredAttempts > 0
      ? configuredAttempts
      : request.params.court_max_attempts;
  const requiredWindow = requiredResolutionWindowMinutes(
    observationAt,
    timing.expiration_estimate_at,
    effectiveAttempts(spec.retry?.max_attempts, courtAttempts),
    spec.retry?.every ?? DEFAULT_RETRY_POLICY.every,
  );
  const resolutionWindow = Math.max(
    request.params.resolution_window_minutes ?? 0,
    requiredWindow,
  );
  const fee = BigInt(String(noaConfig.market_creation_fee ?? DEFAULT_FEE));
  const createDeposit = feeExempt ? 0n : fee + STORAGE_BUFFER;
  const plan = buildCreateMarketTxs({
    ...(request.params as BuildInput),
    duration_minutes: timing.duration_minutes,
    duration_days: undefined,
    observation_at: observationAt,
    expiration_estimate_at: timing.expiration_estimate_at,
    resolution_window_minutes: resolutionWindow,
    court_max_attempts: courtAttempts,
    court_contract: deps.config.courtContract,
    noa_contract: deps.config.noaContract,
    token_id: tokenId,
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
    sign_before: timing.sign_before,
    now_utc: new Date().toISOString(),
    warnings:
      resolutionWindow > (request.params.resolution_window_minutes ?? 0)
        ? [
            `Resolution window raised to ${resolutionWindow} minutes for current signing time.`,
          ]
        : [],
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
  for (const [index, hash] of txHashes.entries()) {
    deps.history?.record({
      item_id: `noa:${market_id}`,
      action:
        index === txHashes.length - 1
          ? "create_market"
          : index === txHashes.length - 2
            ? "register_spec"
            : "ft_transfer_call",
      tx_hash: hash,
      status: "success",
      error: null,
      ts: new Date().toISOString(),
    });
  }
  if (link_tx_hash)
    deps.history?.record({
      item_id: `noa:${market_id}`,
      action: "link_market",
      tx_hash: link_tx_hash,
      status: linked
        ? "success"
        : link_error?.includes("status pending")
          ? "pending"
          : "failure",
      error: link_error,
      ts: new Date().toISOString(),
    });
  if (
    link_tx_hash &&
    !linked &&
    link_error &&
    !link_error.includes("status pending") &&
    !link_error.includes("status unknown")
  )
    deps.history?.recordLinkRejection(market_id, link_error, link_tx_hash);
  deps.store.complete(request.id, result);
  return result;
}
