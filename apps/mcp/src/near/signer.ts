import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  KeyPairSigner,
} from "near-api-js-v7";
import type { Config } from "../config.js";
import { NearRpc } from "./rpc.js";

export type KeeperCall = {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto?: string;
};

export type SignerResult = {
  txHash: string;
  tx_hash: string;
  status: "success" | "failure" | "pending" | "unknown";
  return_value: unknown;
  logs: string[];
  error: string | null;
  outcome: Record<string, any> | null;
};

export function transactionHash(serializedTransaction: Uint8Array): string {
  return baseEncode(
    createHash("sha256").update(serializedTransaction).digest(),
  );
}

function failureMessage(failure: unknown): string {
  if (typeof failure === "string") return failure;
  if (!failure || typeof failure !== "object") return String(failure);
  const item = failure as Record<string, unknown>;
  if (typeof item.ExecutionError === "string") return item.ExecutionError;
  for (const key of ["ActionError", "kind", "FunctionCallError", "Failure"])
    if (item[key] !== undefined) return failureMessage(item[key]);
  return JSON.stringify(failure);
}

export function parseTxOutcome(
  txHash: string,
  outcome: Record<string, any>,
): SignerResult | null {
  const receipts = Array.isArray(outcome.receipts_outcome)
    ? outcome.receipts_outcome
    : [];
  const logs = [outcome.transaction_outcome, ...receipts]
    .flatMap((entry) => entry?.outcome?.logs ?? [])
    .filter((entry): entry is string => typeof entry === "string");
  const receiptFailure = receipts.find(
    (entry) => entry?.outcome?.status?.Failure,
  )?.outcome?.status?.Failure;
  const status = outcome.status;
  const failure = receiptFailure ?? status?.Failure;
  if (failure)
    return {
      txHash,
      tx_hash: txHash,
      status: "failure",
      return_value: null,
      logs,
      error: failureMessage(failure),
      outcome,
    };
  if (status?.SuccessValue !== undefined || status?.SuccessReceiptId) {
    let returnValue: unknown = null;
    if (status.SuccessValue) {
      const decoded = Buffer.from(status.SuccessValue, "base64").toString(
        "utf8",
      );
      try {
        returnValue = JSON.parse(decoded);
      } catch {
        returnValue = decoded;
      }
    }
    return {
      txHash,
      tx_hash: txHash,
      status: "success",
      return_value: returnValue,
      logs,
      error: null,
      outcome,
    };
  }
  return null;
}

type Clock = {
  now: () => number;
  delay: (ms: number) => Promise<void>;
};

function unresolvedResult(
  txHash: string,
  status: "pending" | "unknown",
): SignerResult {
  return {
    txHash,
    tx_hash: txHash,
    status,
    return_value: null,
    logs: [],
    error: null,
    outcome: null,
  };
}

export class KeeperSigner {
  private signer: KeyPairSigner | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private config: Config,
    private rpc: NearRpc,
    private clock: Clock = {
      now: () => Date.now(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {}

  private async key(): Promise<KeyPairSigner> {
    if (!this.signer) {
      const credential = JSON.parse(
        await readFile(this.config.keeperCredentials, "utf8"),
      ) as { account_id?: string; private_key?: string };
      if (
        !credential.private_key ||
        (credential.account_id &&
          credential.account_id !== this.config.keeperAccount)
      )
        throw new Error("keeper credentials unavailable or account mismatch");
      this.signer = KeyPairSigner.fromSecretKey(
        credential.private_key as `ed25519:${string}`,
      );
    }
    return this.signer;
  }

  send(call: KeeperCall): Promise<SignerResult> {
    const work = this.tail.then(() => this.sendOne(call));
    this.tail = work.catch(() => {});
    return work;
  }

  private async poll(txHash: string): Promise<SignerResult | null> {
    const deadline = this.clock.now() + this.config.txPollTimeoutMs;
    do {
      try {
        const outcome = await this.rpc.txStatus(
          txHash,
          this.config.keeperAccount,
          "EXECUTED_OPTIMISTIC",
        );
        const result = parseTxOutcome(txHash, outcome);
        if (result) return result;
      } catch {
        // UNKNOWN_TRANSACTION, endpoint errors, and timeouts are transient here.
      }
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) break;
      await this.clock.delay(Math.min(this.config.txPollIntervalMs, remaining));
    } while (this.clock.now() <= deadline);
    return null;
  }

  private async sendOne(call: KeeperCall): Promise<SignerResult> {
    const signer = await this.key();
    const publicKey = await signer.getPublicKey();
    let lastHash = "";
    let lastNonce = 0n;
    for (let signingAttempt = 0; signingAttempt < 2; signingAttempt++) {
      const access = await this.rpc.call<{
        nonce: number | string;
        block_hash: string;
      }>("query", {
        request_type: "view_access_key",
        account_id: this.config.keeperAccount,
        public_key: publicKey.toString(),
        finality: "final",
      });
      const nonce =
        BigInt(access.nonce) + 1n > lastNonce
          ? BigInt(access.nonce) + 1n
          : lastNonce + 1n;
      lastNonce = nonce;
      const tx = createTransaction(
        this.config.keeperAccount,
        publicKey,
        call.receiverId,
        nonce,
        [
          actions.functionCall(
            call.methodName,
            call.args,
            BigInt(call.gasTgas) * 1_000_000_000_000n,
            BigInt(call.depositYocto ?? "0"),
          ),
        ],
        baseDecode(access.block_hash),
      );
      lastHash = transactionHash(tx.encode());
      const signed = await signer.signTransaction(tx);
      try {
        await this.rpc.submitSigned(signed.signedTransaction.encode());
      } catch {
        // The RPC may have accepted the bytes before timing out; poll our hash.
      }
      const outcome = await this.poll(lastHash);
      if (outcome) return outcome;
      if (signingAttempt === 0) {
        try {
          const latestAccess = await this.rpc.accessKeyNonce(
            this.config.keeperAccount,
            publicKey.toString(),
          );
          if (latestAccess.nonce >= nonce)
            return unresolvedResult(lastHash, "pending");
          if (!latestAccess.complete)
            return unresolvedResult(lastHash, "unknown");
        } catch {
          // Re-signing without a nonce check could duplicate a pending call.
          return unresolvedResult(lastHash, "unknown");
        }
      }
    }
    return unresolvedResult(lastHash, "unknown");
  }
}
