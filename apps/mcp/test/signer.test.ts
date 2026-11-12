import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseEncode, KeyPair } from "near-api-js-v7";
import { loadConfig } from "../src/config.js";
import { KeeperSigner } from "../src/near/signer.js";
import type { NearRpc } from "../src/near/rpc.js";

describe("keeper signing", () => {
  it("signs locally and broadcasts only through the rotating RPC client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noacourt-signer-"));
    const key = KeyPair.fromRandom("ed25519");
    const credentials = join(dir, "keeper.json");
    writeFileSync(
      credentials,
      JSON.stringify({
        account_id: "court-ops.noamarket.testnet",
        private_key: key.toString(),
      }),
    );
    const config = { ...loadConfig(), keeperCredentials: credentials };
    const rpc = {
      call: vi.fn(async () => ({
        nonce: "7",
        block_hash: baseEncode(new Uint8Array(32)),
      })),
      broadcast: vi.fn(async () => ({ status: { SuccessValue: "" } })),
    } as unknown as NearRpc;
    const signer = new KeeperSigner(config, rpc);
    const sent = await signer.send({
      receiverId: "court.testnet",
      methodName: "link_market",
      args: { market_id: 7, spec_hash: null },
      gasTgas: 100,
    });
    expect(sent.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(rpc.broadcast).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(rpc.call).toHaveBeenCalledWith(
      "query",
      expect.objectContaining({
        request_type: "view_access_key",
        account_id: config.keeperAccount,
      }),
    );
  });
});
