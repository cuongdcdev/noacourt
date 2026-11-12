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

export class KeeperSigner {
  private signer: KeyPairSigner | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private config: Config,
    private rpc: NearRpc,
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

  send(call: KeeperCall): Promise<{ txHash: string; outcome: unknown }> {
    const work = this.tail.then(() => this.sendOne(call));
    this.tail = work.catch(() => {});
    return work;
  }

  private async sendOne(
    call: KeeperCall,
  ): Promise<{ txHash: string; outcome: unknown }> {
    const signer = await this.key();
    const publicKey = await signer.getPublicKey();
    const access = await this.rpc.call<{
      nonce: number | string;
      block_hash: string;
    }>("query", {
      request_type: "view_access_key",
      account_id: this.config.keeperAccount,
      public_key: publicKey.toString(),
      finality: "final",
    });
    const tx = createTransaction(
      this.config.keeperAccount,
      publicKey,
      call.receiverId,
      BigInt(access.nonce) + 1n,
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
    const signed = await signer.signTransaction(tx);
    const txHash = baseEncode(signed.txHash);
    const outcome = await this.rpc.broadcast(signed.signedTransaction.encode());
    return { txHash, outcome };
  }
}
