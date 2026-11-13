import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  baseEncode,
  actions,
  createTransaction,
  decodeSignedTransaction,
  KeyPair,
  KeyPairSigner,
  PublicKey,
} from "near-api-js-v7";
import { loadConfig } from "../src/config.js";
import {
  KeeperSigner,
  parseTxOutcome,
  transactionHash,
} from "../src/near/signer.js";
import { NearRpc } from "../src/near/rpc.js";

const success = {
  status: { SuccessValue: Buffer.from("true").toString("base64") },
  receipts_outcome: [
    { outcome: { status: { SuccessValue: "" }, logs: ["done"] } },
  ],
};

function signerFixture() {
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
  const config = {
    ...loadConfig(),
    keeperCredentials: credentials,
    txPollTimeoutMs: 5,
    txPollIntervalMs: 2,
  };
  const call = {
    receiverId: "court.testnet",
    methodName: "link_market",
    args: { market_id: 7, spec_hash: null },
    gasTgas: 100,
  };
  let now = 0;
  const clock = {
    now: () => now,
    delay: async (ms: number) => {
      now += ms;
    },
  };
  return { config, key, call, clock };
}

describe("keeper signing", () => {
  it("matches a fixed borsh transaction hash vector", () => {
    const tx = createTransaction(
      "alice.testnet",
      PublicKey.fromString(`ed25519:${"1".repeat(32)}`),
      "bob.testnet",
      1n,
      [actions.functionCall("ping", {}, 1_000_000_000_000n, 0n)],
      new Uint8Array(32),
    );
    expect(transactionHash(tx.encode())).toBe(
      "HWaTV46pPAMEJJ8k7CxGzSzXXhPRTpLKK2saV4N5m6k7",
    );
  });
  it("signs once, polls UNKNOWN_TRANSACTION, and matches the NEAR transaction hash", async () => {
    const { config, key, call, clock } = signerFixture();
    let signedBytes: Uint8Array | null = null;
    const rpc = {
      call: vi.fn(async () => ({
        nonce: "7",
        block_hash: baseEncode(new Uint8Array(32)),
      })),
      submitSigned: vi.fn(async (bytes: Uint8Array) => {
        signedBytes = bytes;
      }),
      txStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error("UNKNOWN_TRANSACTION"))
        .mockResolvedValueOnce(success),
    } as unknown as NearRpc;
    const sent = await new KeeperSigner(config, rpc, clock).send(call);
    expect(sent.status).toBe("success");
    expect(sent.return_value).toBe(true);
    expect(sent.logs).toEqual(["done"]);
    expect(rpc.submitSigned).toHaveBeenCalledTimes(1);
    expect(rpc.txStatus).toHaveBeenCalledTimes(2);
    expect(rpc.txStatus).toHaveBeenCalledWith(
      sent.txHash,
      config.keeperAccount,
      "EXECUTED_OPTIMISTIC",
    );
    const decoded = decodeSignedTransaction(signedBytes!);
    const nearReference = await KeyPairSigner.fromSecretKey(
      key.toString() as `ed25519:${string}`,
    ).signTransaction(decoded.transaction);
    expect(sent.txHash).toBe(baseEncode(nearReference.txHash));
    expect(sent.txHash).toBe(
      baseEncode(
        createHash("sha256").update(decoded.transaction.encode()).digest(),
      ),
    );
    expect(sent.tx_hash).toBe(sent.txHash);
  });

  it("rotates the same signed bytes after send_tx timeout", async () => {
    const seen: { url: string; method: string; params: any }[] = [];
    const config = {
      ...loadConfig(),
      nearRpcUrls: ["https://one.example", "https://two.example"],
    };
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        seen.push({
          url: String(url),
          method: body.method,
          params: body.params,
        });
        if (seen.length === 1) throw new Error("timeout");
        return new Response(JSON.stringify({ result: "hash" }), {
          status: 200,
        });
      },
    );
    const rpc = new NearRpc(config, fetchMock as typeof fetch, async () => {});
    await rpc.submitSigned(new Uint8Array([1, 2, 3]));
    expect(seen.map(({ url }) => url)).toEqual(config.nearRpcUrls);
    expect(seen.map(({ method }) => method)).toEqual(["send_tx", "send_tx"]);
    expect(seen[0].params).toEqual({
      signed_tx_base64: "AQID",
      wait_until: "NONE",
    });
    expect(seen[1].params).toEqual(seen[0].params);
  });

  it("falls back to broadcast_tx_async when send_tx is unsupported", async () => {
    const methods: string[] = [];
    const config = { ...loadConfig(), nearRpcUrls: ["https://one.example"] };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        methods.push(body.method);
        return new Response(
          JSON.stringify(
            body.method === "send_tx"
              ? { error: { message: "MethodNotFound" } }
              : { result: "hash" },
          ),
          { status: 200 },
        );
      },
    );
    await new NearRpc(
      config,
      fetchMock as typeof fetch,
      async () => {},
    ).submitSigned(new Uint8Array([1]));
    expect(methods).toEqual(["send_tx", "broadcast_tx_async"]);
  });

  it("falls back to the legacy tx status method when needed", async () => {
    const methods: string[] = [];
    const config = { ...loadConfig(), nearRpcUrls: ["https://one.example"] };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        methods.push(body.method);
        return new Response(
          JSON.stringify(
            body.method === "EXPERIMENTAL_tx_status"
              ? { error: { message: "MethodNotFound" } }
              : { result: success },
          ),
          { status: 200 },
        );
      },
    );
    const outcome = await new NearRpc(
      config,
      fetchMock as typeof fetch,
      async () => {},
    ).txStatus("hash", "sender.testnet");
    expect(outcome).toEqual(success);
    expect(methods.at(-1)).toBe("tx");
  });

  it.each([
    ["both endpoints respond", false, { nonce: 8n, complete: true }],
    ["one endpoint fails", true, { nonce: 7n, complete: false }],
  ])(
    "checks optimistic access-key nonce across RPCs: %s",
    async (_name, failSecond, expected) => {
      const config = {
        ...loadConfig(),
        nearRpcUrls: ["https://one.example", "https://two.example"],
      };
      const seen: string[] = [];
      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          expect(body.method).toBe("query");
          expect(body.params.finality).toBe("optimistic");
          seen.push(String(url));
          if (failSecond && String(url) === "https://two.example")
            throw new Error("timeout");
          return new Response(
            JSON.stringify({
              result: {
                nonce: String(url) === "https://one.example" ? "7" : "8",
              },
            }),
            { status: 200 },
          );
        },
      );
      const result = await new NearRpc(
        config,
        fetchMock as typeof fetch,
      ).accessKeyNonce("keeper.testnet", "ed25519:public-key");
      expect(result).toEqual(expected);
      expect(seen).toEqual(config.nearRpcUrls);
    },
  );

  it.each(["already processed", "InvalidNonce", "duplicate transaction"])(
    "treats %s as submitted and continues polling",
    async (message) => {
      const config = { ...loadConfig(), nearRpcUrls: ["https://one.example"] };
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message } }), { status: 200 }),
      );
      await expect(
        new NearRpc(
          config,
          fetchMock as typeof fetch,
          async () => {},
        ).submitSigned(new Uint8Array([1])),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("surfaces the first receipt failure even when top-level status succeeded", () => {
    const parsed = parseTxOutcome("hash", {
      status: { SuccessValue: "" },
      receipts_outcome: [
        {
          outcome: {
            status: {
              Failure: {
                ActionError: {
                  kind: {
                    FunctionCallError: {
                      ExecutionError:
                        "Smart contract panicked: observation not reached",
                    },
                  },
                },
              },
            },
            logs: ["failed"],
          },
        },
      ],
    });
    expect(parsed).toMatchObject({
      status: "failure",
      error: "Smart contract panicked: observation not reached",
      logs: ["failed"],
    });
  });

  it("re-signs only once with a fresh nonce when both poll windows stay unknown", async () => {
    const { config, call, clock } = signerFixture();
    const rpc = {
      call: vi.fn(async () => ({
        nonce: "7",
        block_hash: baseEncode(new Uint8Array(32)),
      })),
      accessKeyNonce: vi.fn(async () => ({ nonce: 7n, complete: true })),
      submitSigned: vi.fn(async () => {}),
      txStatus: vi.fn(async () => {
        throw new Error("UNKNOWN_TRANSACTION");
      }),
    } as unknown as NearRpc;
    const sent = await new KeeperSigner(config, rpc, clock).send(call);
    expect(sent.status).toBe("unknown");
    expect(rpc.call).toHaveBeenCalledTimes(2);
    expect(rpc.accessKeyNonce).toHaveBeenCalledTimes(1);
    expect(rpc.submitSigned).toHaveBeenCalledTimes(2);
    const hashes = await Promise.all(
      (rpc.submitSigned as any).mock.calls.map(
        async ([bytes]: [Uint8Array]) => {
          const tx = decodeSignedTransaction(bytes).transaction;
          return baseEncode(createHash("sha256").update(tx.encode()).digest());
        },
      ),
    );
    expect(hashes[0]).not.toBe(hashes[1]);
    const nonces = (rpc.submitSigned as any).mock.calls.map(
      ([bytes]: [Uint8Array]) =>
        decodeSignedTransaction(bytes).transaction.nonce,
    );
    expect(nonces).toEqual([8n, 9n]);
    expect(sent.txHash).toBe(hashes[1]);
  });

  it("returns pending without re-signing when the first nonce was consumed", async () => {
    const { config, call, clock } = signerFixture();
    const rpc = {
      call: vi.fn(async () => ({
        nonce: "7",
        block_hash: baseEncode(new Uint8Array(32)),
      })),
      accessKeyNonce: vi.fn(async () => ({ nonce: 8n, complete: true })),
      submitSigned: vi.fn(async () => {}),
      txStatus: vi.fn(async () => {
        throw new Error("UNKNOWN_TRANSACTION");
      }),
    } as unknown as NearRpc;
    const sent = await new KeeperSigner(config, rpc, clock).send(call);
    expect(sent.status).toBe("pending");
    expect(sent.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.accessKeyNonce).toHaveBeenCalledTimes(1);
    expect(rpc.submitSigned).toHaveBeenCalledTimes(1);
  });

  it("does not re-sign when the nonce recheck is unavailable", async () => {
    const { config, call, clock } = signerFixture();
    const rpc = {
      call: vi.fn(async () => ({
        nonce: "7",
        block_hash: baseEncode(new Uint8Array(32)),
      })),
      accessKeyNonce: vi.fn(async () => {
        throw new Error("RPC unavailable");
      }),
      submitSigned: vi.fn(async () => {}),
      txStatus: vi.fn(async () => {
        throw new Error("UNKNOWN_TRANSACTION");
      }),
    } as unknown as NearRpc;
    const sent = await new KeeperSigner(config, rpc, clock).send(call);
    expect(sent.status).toBe("unknown");
    expect(rpc.submitSigned).toHaveBeenCalledTimes(1);
  });

  it("does not re-sign when one RPC nonce check fails", async () => {
    const { config, call, clock } = signerFixture();
    const rpc = {
      call: vi.fn(async () => ({
        nonce: "7",
        block_hash: baseEncode(new Uint8Array(32)),
      })),
      accessKeyNonce: vi.fn(async () => ({ nonce: 7n, complete: false })),
      submitSigned: vi.fn(async () => {}),
      txStatus: vi.fn(async () => {
        throw new Error("UNKNOWN_TRANSACTION");
      }),
    } as unknown as NearRpc;
    const sent = await new KeeperSigner(config, rpc, clock).send(call);
    expect(sent.status).toBe("unknown");
    expect(rpc.submitSigned).toHaveBeenCalledTimes(1);
  });
});
