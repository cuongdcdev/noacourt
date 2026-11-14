import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  KeyPairSigner,
} from "near-api-js-v7";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
// NETWORK=mainnet switches RPC, contracts, credentials dir and default sign base.
const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const RPC_URLS =
  NETWORK === "mainnet"
    ? ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"]
    : [
        "https://test.rpc.fastnear.com",
        "https://rpc.testnet.near.org",
        "https://archival-rpc.testnet.fastnear.com",
      ];
const SIGN_BASE = (
  process.env.SIGN_BASE ||
  (NETWORK === "mainnet"
    ? "https://court.noamarket.xyz"
    : "https://noacourtmcp.junstudio.xyz")
).replace(/\/$/, "");
const NOA = NETWORK === "mainnet" ? "v3.noamarket.near" : "v3.noamarket.testnet";
const TOKEN =
  NETWORK === "mainnet" ? "npoint.noamarket.near" : "point.noamarket.testnet";
const TGAS = "100000000000000";
const YOCTO = 10n ** 24n;

type JsonRecord = Record<string, unknown>;
type WalletAction = {
  type: string;
  params?: {
    methodName?: string;
    args?: unknown;
    gas?: string;
    deposit?: string;
  };
};
type WalletTransaction = {
  signerId?: string;
  receiverId: string;
  actions: WalletAction[];
};
type Run = JsonRecord & { started_at: string; transactions: JsonRecord[] };

export function extractSignId(input: string): string {
  let id = input;
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    const match = /^\/sign\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) throw new Error("Sign URL must have a /sign/<id> path");
    id = decodeURIComponent(match[1]);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid sign request ID");
  return id;
}

export function decimalToBaseUnits(amount: string, decimals = 18): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Invalid decimal precision");
  }
  if (!/^\d+(?:\.\d+)?$/.test(amount)) {
    throw new Error("Amount must be a nonnegative decimal string");
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals)
    throw new Error(`Amount exceeds ${decimals} decimals`);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function actionArgsBytes(args: unknown): Uint8Array {
  if (args instanceof Uint8Array) return args;
  if (typeof args === "string") {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        args,
      )
    ) {
      throw new Error("FunctionCall args string must be base64");
    }
    return Buffer.from(args, "base64");
  }
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return Buffer.from(JSON.stringify(args), "utf8");
  }
  throw new Error(
    "FunctionCall args must be an object, base64 string, or Uint8Array",
  );
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`Missing ${name}`);
  }
  return args[index + 1];
}

function now(): string {
  return new Date().toISOString();
}

async function save(path: string, run: Run): Promise<void> {
  run.updated_at = now();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Rpc {
  private cursor = 0;

  async call<T>(method: string, params: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RPC_URLS.length * 3; attempt++) {
      const url = RPC_URLS[this.cursor++ % RPC_URLS.length];
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "wallet-cli",
            method,
            params,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const bodyText = await response.text();
        if (
          response.status === 429 ||
          response.status >= 500 ||
          /DEPRECATED/i.test(bodyText)
        ) {
          lastError = new Error(
            `${url}: HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
          );
          continue;
        }
        if (!response.ok)
          throw new Error(
            `${url}: HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
          );
        const body = JSON.parse(bodyText) as { result?: T; error?: unknown };
        if (body.error) {
          const message = JSON.stringify(body.error);
          if (/DEPRECATED/i.test(message)) {
            lastError = new Error(message);
            continue;
          }
          throw new Error(message);
        }
        if (body.result === undefined)
          throw new Error("RPC response has no result");
        return body.result;
      } catch (error) {
        if (
          error instanceof TypeError ||
          (error as Error)?.name === "TimeoutError" ||
          (error as Error)?.name === "AbortError" ||
          error instanceof SyntaxError
        ) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      `${method} failed across ${NETWORK} RPC endpoints: ${errorText(lastError)}`,
    );
  }

  async view(
    contract: string,
    method: string,
    args: unknown,
  ): Promise<unknown> {
    const result = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "final",
    });
    return JSON.parse(Buffer.from(result.result).toString("utf8"));
  }

  async status(hash: string, account: string): Promise<JsonRecord> {
    const params = {
      tx_hash: hash,
      sender_account_id: account,
      wait_until: "EXECUTED_OPTIMISTIC",
    };
    try {
      return await this.call<JsonRecord>("tx", params);
    } catch (error) {
      if (
        !/MethodNotFound|UNKNOWN_METHOD|does not exist|-32601/i.test(
          errorText(error),
        )
      )
        throw error;
      return this.call<JsonRecord>("EXPERIMENTAL_tx_status", params);
    }
  }
}

async function signServer(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${SIGN_BASE}${path}`, {
    ...init,
    headers: { "user-agent": USER_AGENT, ...init?.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(
      `Sign API HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  return body;
}

async function loadSigner(account: string): Promise<KeyPairSigner> {
  if (!/^[a-z0-9._-]{2,64}$/.test(account))
    throw new Error("Invalid NEAR account ID");
  const path = join(
    homedir(),
    ".near-credentials",
    NETWORK,
    `${account}.json`,
  );
  let credentials: { account_id?: string; private_key?: string };
  try {
    credentials = JSON.parse(
      await readFile(path, "utf8"),
    ) as typeof credentials;
  } catch {
    throw new Error(`Could not read valid ${NETWORK} credentials for ${account}`);
  }
  if ((credentials.account_id && credentials.account_id !== account) || !credentials.private_key) {
    throw new Error(`Invalid ${NETWORK} credentials for ${account}`);
  }
  return KeyPairSigner.fromSecretKey(
    credentials.private_key as `ed25519:${string}`,
  );
}

function convertActions(entries: WalletAction[]) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("Transaction has no actions");
  return entries.map((entry) => {
    if (entry.type !== "FunctionCall")
      throw new Error(`Unsupported action type: ${entry.type}`);
    const params = entry.params;
    if (
      !params ||
      typeof params.methodName !== "string" ||
      typeof params.gas !== "string" ||
      typeof params.deposit !== "string"
    ) {
      throw new Error("Invalid FunctionCall params");
    }
    return actions.functionCall(
      params.methodName,
      actionArgsBytes(params.args),
      BigInt(params.gas),
      BigInt(params.deposit),
    );
  });
}

function decodeSuccess(outcome: JsonRecord): unknown {
  const status = outcome.status as JsonRecord | undefined;
  const value = status?.SuccessValue;
  if (typeof value !== "string") return undefined;
  const text = Buffer.from(value, "base64").toString("utf8");
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function completed(outcome: JsonRecord): boolean {
  const status = outcome.status as JsonRecord | undefined;
  if (status?.Failure !== undefined) return true;
  if (
    status?.SuccessValue !== undefined ||
    status?.SuccessReceiptId !== undefined
  )
    return true;
  return ["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"].includes(
    String(outcome.final_execution_status ?? ""),
  );
}

function unknownTransaction(error: unknown): boolean {
  return /UNKNOWN_TRANSACTION|UnknownTransaction/i.test(errorText(error));
}

async function pollOutcome(
  rpc: Rpc,
  hash: string,
  account: string,
  timeoutMs: number,
): Promise<JsonRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const outcome = await rpc.status(hash, account);
      if (completed(outcome)) return outcome;
    } catch (error) {
      if (!unknownTransaction(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

async function sendTransaction(
  rpc: Rpc,
  account: string,
  signer: KeyPairSigner,
  tx: WalletTransaction,
  run: Run,
  out: string,
): Promise<JsonRecord> {
  if (tx.signerId && tx.signerId !== account)
    throw new Error("Plan signerId differs from --account");
  if (!tx.receiverId || !Array.isArray(tx.actions))
    throw new Error("Invalid transaction plan");
  const transactionActions = convertActions(tx.actions);
  const publicKey = await signer.getPublicKey();
  let record: JsonRecord = {
    receiver_id: tx.receiverId,
    actions: tx.actions,
    started_at: now(),
  };
  run.transactions.push(record);
  await save(out, run);

  for (let nonceRetry = 0; nonceRetry <= 1; nonceRetry++) {
    const access = await rpc.call<{ nonce: number | string }>("query", {
      request_type: "view_access_key",
      account_id: account,
      public_key: publicKey.toString(),
      finality: "final",
    });
    const block = await rpc.call<{ header: { hash: string } }>("block", {
      finality: "final",
    });
    const transaction = createTransaction(
      account,
      publicKey,
      tx.receiverId,
      BigInt(access.nonce) + 1n,
      transactionActions,
      baseDecode(block.header.hash),
    );
    const signed = await signer.signTransaction(transaction);
    const hash = baseEncode(signed.txHash);
    const encoded = Buffer.from(signed.signedTransaction.encode()).toString(
      "base64",
    );
    record = { ...record, hash, signed_at: now() };
    run.transactions[run.transactions.length - 1] = record;
    await save(out, run);

    try {
      await rpc.call("send_tx", {
        signed_tx_base64: encoded,
        wait_until: "NONE",
      });
    } catch (error) {
      if (
        /InvalidNonce|invalid nonce/i.test(errorText(error)) &&
        nonceRetry === 0
      ) {
        record.nonce_retry_at = now();
        await save(out, run);
        continue;
      }
      if (!/failed across \w+ RPC endpoints/i.test(errorText(error)))
        throw error;
      record.broadcast_uncertain = errorText(error);
      await save(out, run);
    }

    let outcome = await pollOutcome(rpc, hash, account, 120_000);
    if (!outcome) {
      record.rebroadcast_at = now();
      await save(out, run);
      try {
        await rpc.call("send_tx", {
          signed_tx_base64: encoded,
          wait_until: "NONE",
        });
      } catch (error) {
        record.rebroadcast_error = errorText(error);
        await save(out, run);
      }
      outcome = await pollOutcome(rpc, hash, account, 120_000);
    }
    if (!outcome)
      throw new Error(`Transaction ${hash} remained unknown after rebroadcast`);
    record.outcome = outcome;
    record.status = outcome.status ?? outcome.final_execution_status;
    record.success_value = decodeSuccess(outcome);
    record.completed_at = now();
    await save(out, run);
    if (
      (outcome.status as JsonRecord | undefined)?.Failure !== undefined ||
      outcome.final_execution_status === "FAILURE"
    ) {
      throw new Error(`Transaction ${hash} failed on-chain`);
    }
    console.log(
      `${tx.receiverId}: ${hash} ${outcome.final_execution_status ?? "executed"}`,
    );
    return record;
  }
  throw new Error("Transaction rejected with InvalidNonce after one retry");
}

function summary(tx: WalletTransaction, index: number): void {
  console.log(`Transaction ${index + 1}: ${tx.receiverId}`);
  for (const action of tx.actions) {
    if (action.type !== "FunctionCall")
      throw new Error(`Unsupported action type: ${action.type}`);
    const params = action.params;
    if (!params) throw new Error("Missing FunctionCall params");
    const args = JSON.stringify(params.args, (_key, value: unknown) =>
      typeof value === "string" && value.length > 200
        ? `${value.slice(0, 200)}…`
        : value,
    );
    console.log(
      `  ${params.methodName} gas=${params.gas} deposit=${params.deposit} args=${args}`,
    );
  }
}

async function signCommand(args: string[], rpc: Rpc): Promise<void> {
  const id = extractSignId(args[0] ?? "");
  const account = requiredOption(args, "--account");
  const out = requiredOption(args, "--out");
  const dryRun = args.includes("--dry-run");
  const request = await signServer(`/api/sign/${encodeURIComponent(id)}`);
  const plan = await signServer(
    `/api/sign/${encodeURIComponent(id)}/plan?account=${encodeURIComponent(account)}`,
  );
  const run: Run = {
    command: "sign",
    id,
    account_id: account,
    dry_run: dryRun,
    started_at: now(),
    request,
    plan,
    transactions: [],
  };
  await save(out, run);
  const txs = (plan as { tx_plan?: WalletTransaction[] }).tx_plan;
  if (!Array.isArray(txs)) throw new Error("Sign plan has no tx_plan array");
  txs.forEach(summary);
  if (dryRun) return;
  const signer = await loadSigner(account);
  for (const tx of txs)
    await sendTransaction(rpc, account, signer, tx, run, out);
  const hashes = run.transactions.map((tx) => String(tx.hash));
  const complete = await signServer(
    `/api/sign/${encodeURIComponent(id)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_hashes: hashes, account_id: account }),
    },
  );
  run.complete = complete;
  run.completed_at = now();
  await save(out, run);
  console.log(JSON.stringify(complete, null, 2));
}

function simpleCall(
  receiverId: string,
  methodName: string,
  args: JsonRecord,
  deposit: string,
): WalletTransaction {
  return {
    receiverId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName, args, gas: TGAS, deposit },
      },
    ],
  };
}

function safeId(value: string | undefined, label: string): number {
  if (!/^\d+$/.test(value ?? ""))
    throw new Error(`${label} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return parsed;
}

async function internalBalance(rpc: Rpc, account: string): Promise<bigint> {
  const value = await rpc.view(NOA, "get_user_balance", {
    account_id: account,
    token_id: TOKEN,
  });
  return BigInt(String(value));
}

async function betCommand(args: string[], rpc: Rpc): Promise<void> {
  const [marketId, outcomeIndex, account, amount] = args;
  const out = requiredOption(args, "--out");
  const market = safeId(marketId, "marketId");
  const outcome = safeId(outcomeIndex, "outcomeIndex");
  const units = decimalToBaseUnits(amount ?? "");
  if (units <= 0n) throw new Error("Bet amount must be positive");
  const need = units + units / 50n + 10n ** 18n;
  const run: Run = {
    command: "bet",
    market_id: marketId,
    outcome_id: outcomeIndex,
    account_id: account,
    amount_npoint: amount,
    amount_base_units: units.toString(),
    required_balance: need.toString(),
    started_at: now(),
    transactions: [],
  };
  await save(out, run);
  const signer = await loadSigner(account);
  const balance = await internalBalance(rpc, account);
  run.initial_internal_balance = balance.toString();
  await save(out, run);
  if (balance < need) {
    await sendTransaction(
      rpc,
      account,
      signer,
      simpleCall(
        TOKEN,
        "ft_transfer_call",
        {
          receiver_id: NOA,
          amount: (need - balance).toString(),
          msg: "",
        },
        "1",
      ),
      run,
      out,
    );
    const deadline = Date.now() + 60_000;
    let current = balance;
    while (Date.now() < deadline) {
      current = await internalBalance(rpc, account);
      if (current >= need) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    run.internal_balance_after_topup = current.toString();
    await save(out, run);
    if (current < need)
      throw new Error(
        "Internal balance did not reach required amount after 60 seconds",
      );
  }
  await sendTransaction(
    rpc,
    account,
    signer,
    simpleCall(
      NOA,
      "buy_shares",
      {
        market_id: market,
        outcome_id: outcome,
        spend_amount_max: units.toString(),
        min_shares_expected_fp: "0",
      },
      (YOCTO / 100n).toString(),
    ),
    run,
    out,
  );
  run.completed_at = now();
  await save(out, run);
}

async function claimCommand(args: string[], rpc: Rpc): Promise<void> {
  const [marketId, account] = args;
  const out = requiredOption(args, "--out");
  const market = safeId(marketId, "marketId");
  const run: Run = {
    command: "claim",
    market_id: marketId,
    account_id: account,
    started_at: now(),
    transactions: [],
  };
  await save(out, run);
  const signer = await loadSigner(account);
  await sendTransaction(
    rpc,
    account,
    signer,
    simpleCall(
      NOA,
      "claim_winnings",
      {
        market_id: market,
      },
      "1",
    ),
    run,
    out,
  );
  run.completed_at = now();
  await save(out, run);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const rpc = new Rpc();
  if (command === "sign") return signCommand(args, rpc);
  if (command === "bet") return betCommand(args, rpc);
  if (command === "claim") return claimCommand(args, rpc);
  if (command === "view") {
    if (args.length !== 3)
      throw new Error("Usage: view <contract> <method> <jsonArgs>");
    console.log(
      JSON.stringify(
        await rpc.view(args[0], args[1], JSON.parse(args[2])),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("Usage: wallet.ts sign|bet|claim|view ...");
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error: unknown) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
