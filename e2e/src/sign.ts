import { readFile } from "node:fs/promises";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  KeyPairSigner,
} from "near-api-js-v7";
import { homedir } from "node:os";
import { join } from "node:path";
import { RPC_URLS } from "./constants.js";
import { Rpc } from "./net.js";
import { save, type RunState, type TxRecord } from "./state.js";

export type Call = {
  signer: string;
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  gasTgas: number;
  deposit: string;
};

type TxStatusKind =
  "confirmed" | "failed" | "unknown" | "pending" | "transport";

export function classifyTxStatus(outcome?: any, error?: unknown): TxStatusKind {
  if (error)
    return /UNKNOWN_TRANSACTION/i.test(String(error)) ? "unknown" : "transport";
  if (outcome?.status?.Failure || outcome?.final_execution_status === "FAILURE")
    return "failed";
  if (outcome?.status?.SuccessValue !== undefined) return "confirmed";
  if (
    ["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"].includes(
      outcome?.final_execution_status,
    )
  )
    return "confirmed";
  if (
    outcome?.status?.Unknown !== undefined ||
    outcome?.final_execution_status === "NONE"
  )
    return "unknown";
  return "pending";
}

export function retireFailedCreate(state: RunState): boolean {
  const record = state.txs.create_market;
  if (!record?.outcome || classifyTxStatus(record.outcome) !== "failed")
    return false;
  const reason = JSON.stringify(
    (record.outcome as any)?.status?.Failure ?? record.outcome,
  );
  state.events.push({
    at: new Date().toISOString(),
    message: `create_market: failed transaction ${record.hash}: ${reason}; re-planning with current balance`,
  });
  delete state.txs.create_market;
  return true;
}

function invalidBroadcastReason(
  error: unknown,
): "expired" | "invalid_nonce" | null {
  const message = String(error);
  if (/Expired|transaction has expired/i.test(message)) return "expired";
  if (/InvalidNonce|invalid nonce/i.test(message)) return "invalid_nonce";
  return null;
}

export function retryDecision(input: {
  status: TxStatusKind;
  elapsedMs: number;
  sinceBroadcastMs: number;
  invalidBroadcast?: "expired" | "invalid_nonce" | null;
  allRpcsUnknown?: boolean;
}): "confirm" | "fail" | "resign" | "rebroadcast" | "poll" | "timeout" {
  if (input.status === "confirmed") return "confirm";
  if (input.status === "failed") return "fail";
  if (input.elapsedMs >= 300_000) return "timeout";
  if (input.invalidBroadcast && input.allRpcsUnknown) return "resign";
  if (
    ["unknown", "transport"].includes(input.status) &&
    input.sinceBroadcastMs >= 10_000
  )
    return "rebroadcast";
  return "poll";
}

export class Sender {
  private tails = new Map<string, Promise<unknown>>();
  private keys = new Map<string, KeyPairSigner>();

  constructor(readonly rpc: Rpc) {}

  async send(
    state: RunState,
    label: string,
    call: Call,
    beforeSign?: () => Promise<Call>,
  ): Promise<TxRecord> {
    const tail = this.tails.get(call.signer) ?? Promise.resolve();
    const task = tail
      .catch(() => {})
      .then(() => this.sendOne(state, label, call, beforeSign));
    this.tails.set(call.signer, task);
    return task;
  }

  private async key(account: string): Promise<KeyPairSigner> {
    const cached = this.keys.get(account);
    if (cached) return cached;
    const path = join(
      homedir(),
      ".near-credentials",
      "testnet",
      `${account}.json`,
    );
    const credentials = JSON.parse(await readFile(path, "utf8")) as {
      account_id?: string;
      private_key?: string;
    };
    if (credentials.account_id && credentials.account_id !== account)
      throw new Error(`Credential account mismatch for ${account}`);
    if (!credentials.private_key)
      throw new Error(`Missing testnet credential for ${account}`);
    const signer = KeyPairSigner.fromSecretKey(
      credentials.private_key as `ed25519:${string}`,
    );
    this.keys.set(account, signer);
    return signer;
  }

  private async sendOne(
    state: RunState,
    label: string,
    call: Call,
    beforeSign?: () => Promise<Call>,
  ): Promise<TxRecord> {
    let record: TxRecord | undefined = state.txs[label];
    let signedCall = call;
    if (record?.confirmedAt) return record;
    if (
      record?.outcome &&
      /^(bet_|topup_)/.test(label) &&
      classifyTxStatus(record.outcome) === "failed"
    ) {
      const reason = JSON.stringify(
        (record.outcome as any)?.status?.Failure ?? record.outcome,
      );
      state.events.push({
        at: new Date().toISOString(),
        message: `${label}: failed transaction ${record.hash}: ${reason}; signing a replacement`,
      });
      delete state.txs[label];
      await save(state);
      record = undefined;
    }
    if (!record) {
      const signed = await this.signOne(call, beforeSign);
      record = signed.record;
      signedCall = signed.call;
      state.txs[label] = record;
      await save(state); // Crash recovery knows the hash before any network send.
    }
    if (!record.signedBase64)
      throw new Error(
        `${label} has no signed bytes; cannot safely resume ${record.hash}`,
      );

    const started = Date.now();
    let lastBroadcast = -Infinity;
    let invalid: "expired" | "invalid_nonce" | null = null;
    while (Date.now() - started < 300_000) {
      if (
        retryDecision({
          status: "unknown",
          elapsedMs: Date.now() - started,
          sinceBroadcastMs: Date.now() - lastBroadcast,
        }) === "rebroadcast"
      ) {
        lastBroadcast = Date.now();
        try {
          await this.rpc.broadcast(Buffer.from(record.signedBase64!, "base64"));
          invalid = null;
        } catch (error) {
          invalid = invalidBroadcastReason(error);
          if (invalid) {
            state.events.push({
              at: new Date().toISOString(),
              message: `${label}: ${record.hash} rejected as ${invalid}; checking status on every RPC`,
            });
            await save(state);
          }
        }
      }

      let outcome: any;
      let status: TxStatusKind;
      try {
        outcome = await this.rpc.status(record.hash, call.signer);
        status = classifyTxStatus(outcome);
      } catch (error) {
        status = classifyTxStatus(undefined, error);
      }
      if (status === "confirmed") return this.confirm(state, record, outcome);
      if (status === "failed") {
        record.outcome = outcome;
        await save(state);
        throw new Error(
          `${label} failed on-chain: ${JSON.stringify(outcome.status?.Failure ?? outcome)}`,
        );
      }

      if (invalid && status === "unknown") {
        let allRpcsUnknown = true;
        for (let i = 1; i < RPC_URLS.length; i++) {
          try {
            outcome = await this.rpc.status(record.hash, call.signer);
            status = classifyTxStatus(outcome);
          } catch (error) {
            status = classifyTxStatus(undefined, error);
          }
          if (status === "confirmed")
            return this.confirm(state, record, outcome);
          if (status === "failed") {
            record.outcome = outcome;
            await save(state);
            throw new Error(
              `${label} failed on-chain: ${JSON.stringify(outcome.status?.Failure ?? outcome)}`,
            );
          }
          if (status !== "unknown") allRpcsUnknown = false;
        }
        if (
          retryDecision({
            status: "unknown",
            elapsedMs: Date.now() - started,
            sinceBroadcastMs: Date.now() - lastBroadcast,
            invalidBroadcast: invalid,
            allRpcsUnknown,
          }) === "resign"
        ) {
          const oldHash = record.hash;
          state.events.push({
            at: new Date().toISOString(),
            message: `${label}: ${oldHash} expired or has invalid nonce and remains unknown on all RPCs; re-signing the same call`,
          });
          record = (await this.signOne(signedCall)).record;
          state.txs[label] = record;
          await save(state);
          invalid = null;
          lastBroadcast = -Infinity;
          continue;
        }
      }
      if (
        retryDecision({
          status,
          elapsedMs: Date.now() - started,
          sinceBroadcastMs: Date.now() - lastBroadcast,
        }) === "timeout"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `${label} status unknown for ${record.hash}; resume this results file, do not recreate market`,
    );
  }

  private async signOne(
    call: Call,
    beforeSign?: () => Promise<Call>,
  ): Promise<{ record: TxRecord; call: Call }> {
    const signer = await this.key(call.signer);
    const publicKey = await signer.getPublicKey();
    const access = await this.rpc.call<{
      nonce: number | string;
      block_hash: string;
    }>("query", {
      request_type: "view_access_key",
      account_id: call.signer,
      public_key: publicKey.toString(),
      finality: "final",
    });
    const signedCall = beforeSign ? await beforeSign() : call;
    const tx = createTransaction(
      signedCall.signer,
      publicKey,
      signedCall.receiver,
      BigInt(access.nonce) + 1n,
      [
        actions.functionCall(
          signedCall.method,
          signedCall.args,
          BigInt(signedCall.gasTgas) * 1_000_000_000_000n,
          BigInt(signedCall.deposit),
        ),
      ],
      baseDecode(access.block_hash),
    );
    const signed = await signer.signTransaction(tx);
    return {
      call: signedCall,
      record: {
        hash: baseEncode(signed.txHash),
        signer: signedCall.signer,
        receiver: signedCall.receiver,
        method: signedCall.method,
        signedBase64: Buffer.from(signed.signedTransaction.encode()).toString(
          "base64",
        ),
      },
    };
  }

  private async confirm(
    state: RunState,
    record: TxRecord,
    outcome: unknown,
  ): Promise<TxRecord> {
    record.confirmedAt = new Date().toISOString();
    record.outcome = outcome;
    delete record.signedBase64;
    await save(state);
    return record;
  }
}
