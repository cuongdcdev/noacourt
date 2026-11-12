import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  decideMarketActions,
  decideRequestActions,
} from "../src/keeper/decision.js";
import { KeeperLoop } from "../src/keeper/loop.js";
import type { NearRpc } from "../src/near/rpc.js";
import type { CourtClient } from "../src/court/client.js";
import type { KeeperSigner } from "../src/near/signer.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import { SpendCounter } from "../src/ratelimit.js";

const t = 2_000_000_000_000_000_000n;
const market = {
  id: 1,
  status: "Active",
  resolver: "court.testnet",
  metadata_hash: "noacourt:sha256:x",
  resolution_deadline: (t + 1n).toString(),
};

describe("keeper decisions", () => {
  it.each([
    ["unlinked", null, null, t - 10n, false, ["link_market"]],
    ["not yet due", { state: "Linked" }, null, t + 10n, false, []],
    [
      "trigger",
      { status: "Linked", attempts: 0 },
      null,
      t - 10n,
      false,
      ["trigger"],
    ],
    [
      "retry",
      { state: { RetryScheduled: { retry_at: (t - 1n).toString() } } },
      null,
      t - 10n,
      false,
      ["trigger"],
    ],
    ["void", { state: "Unresolvable" }, null, t - 10n, false, ["void"]],
    [
      "finalize",
      { state: "Resolved" },
      { dispute_deadline: (t - 1n).toString() },
      t - 10n,
      false,
      ["finalize_resolution"],
    ],
    ["pending", { state: "Pending" }, null, t - 10n, false, []],
    [
      "trusted",
      { state: "Pending" },
      null,
      t - 10n,
      true,
      ["submit_keeper_verdict"],
    ],
  ])("%s", (_name, court, pending, observation, trusted, expected) => {
    const noa =
      _name === "void"
        ? { ...market, resolution_deadline: (t - 1n).toString() }
        : market;
    expect(
      decideMarketActions(
        noa,
        court,
        pending,
        t,
        observation as bigint,
        trusted as boolean,
        3,
      ),
    ).toEqual(expected);
  });
  it("triggers generic requests only when due", () => {
    expect(
      decideRequestActions({ status: "Linked" }, t, t - 1n, false, 3),
    ).toEqual(["trigger_request"]);
    expect(
      decideRequestActions({ status: "Linked" }, t, t + 1n, false, 3),
    ).toEqual([]);
    expect(
      decideRequestActions({ status: "Pending" }, t, t - 1n, true, 3),
    ).toEqual(["submit_keeper_verdict"]);
  });
  it("honors attempt caps, forwarding, and void_pending", () => {
    expect(
      decideMarketActions(
        market,
        { status: "Linked", attempts: 3 },
        null,
        t,
        t - 1n,
        false,
        3,
      ),
    ).toEqual([]);
    expect(
      decideMarketActions(
        market,
        {
          status: "Resolved",
          forwarded: false,
          resolution_deadline_ns: (t + 1n).toString(),
        },
        null,
        t,
        t - 1n,
        false,
        3,
      ),
    ).toEqual(["retry_forward"]);
    const past = { ...market, resolution_deadline: (t - 1n).toString() };
    expect(
      decideMarketActions(
        past,
        { status: "Resolved", forwarded: false },
        null,
        t,
        t - 1n,
        false,
        3,
      ),
    ).toEqual(["void"]);
    expect(
      decideMarketActions(
        past,
        { status: "Resolved", forwarded: true },
        null,
        t,
        t - 1n,
        false,
        3,
      ),
    ).toEqual([]);
    expect(
      decideMarketActions(
        past,
        { status: "Linked", void_pending: true },
        null,
        t,
        t - 1n,
        false,
        3,
      ),
    ).toEqual([]);
  });
});

describe("keeper tick", () => {
  const temp = () => mkdtempSync(join(tmpdir(), "noacourt-keeper-"));
  it("survives a throwing RPC without crashing", async () => {
    const config = {
      ...loadConfig(),
      dataDir: temp(),
      courtContract: "court.testnet",
      noaContract: "noa.testnet",
    };
    const rpc = {
      view: vi.fn(async () => {
        throw new Error("RPC unavailable");
      }),
    } as unknown as NearRpc;
    const court = {
      request: vi.fn(async () => {
        throw new Error("Court unavailable");
      }),
    } as unknown as CourtClient;
    const signer = { send: vi.fn() } as unknown as Pick<KeeperSigner, "send">;
    const spend = new SpendCounter(config);
    const keeper = new KeeperLoop({
      config,
      rpc,
      court,
      signer,
      wasm: new WasmRunner(config),
      spend,
    });
    await expect(keeper.tick()).resolves.toBeUndefined();
    expect(keeper.lastTickAt).toBeTruthy();
    expect(keeper.counts.errors).toBeGreaterThan(0);
    keeper.stop();
    spend.close();
  });
  it("skips the same action for two ticks and retries later", async () => {
    const config = {
      ...loadConfig(),
      dataDir: temp(),
      courtContract: "court.testnet",
      noaContract: "noa.testnet",
      courtTrustedKeeper: false,
    };
    const rpc = {
      view: vi.fn(async (_contract: string, method: string) => {
        if (method === "get_market_count") return 1;
        if (method === "get_markets") return [market];
        if (method === "get_market") return market;
        if (method === "get_pending_resolution") return null;
        return null;
      }),
    } as unknown as NearRpc;
    const court = {
      market: vi.fn(async () => null),
      request: vi.fn(async () => null),
    } as unknown as CourtClient;
    const signer = {
      send: vi.fn(async () => ({
        txHash: "hash",
        outcome: { status: { SuccessValue: "" } },
      })),
    } as unknown as Pick<KeeperSigner, "send">;
    const spend = new SpendCounter(config);
    const keeper = new KeeperLoop({
      config,
      rpc,
      court,
      signer,
      wasm: new WasmRunner(config),
      spend,
    });
    await keeper.tick();
    await keeper.tick();
    expect(signer.send).toHaveBeenCalledTimes(1);
    await keeper.tick();
    expect(signer.send).toHaveBeenCalledTimes(2);
    keeper.stop();
    spend.close();
  });
  it("submits a local resolver verdict only in trusted mode", async () => {
    const config = {
      ...loadConfig(),
      dataDir: temp(),
      courtContract: "court.testnet",
      noaContract: "noa.testnet",
      courtTrustedKeeper: true,
    };
    const future = { ...market, resolution_deadline: (t + 1n).toString() };
    const rpc = {
      view: vi.fn(async (_contract: string, method: string) => {
        if (method === "get_market_count") return 1;
        if (method === "get_markets") return [future];
        if (method === "get_market") return future;
        if (method === "get_pending_resolution") return null;
        return null;
      }),
    } as unknown as NearRpc;
    const specJson = JSON.stringify({ decide: { kind: "threshold" } });
    const court = {
      market: vi.fn(async () => ({
        status: "Pending",
        spec_hash: "hash",
        attempts: 1,
      })),
      spec: vi.fn(async () => ({
        spec_json: specJson,
        observation_at_ns: (t - 1n).toString(),
      })),
      request: vi.fn(async () => null),
      refresh: vi.fn(async () => null),
    } as unknown as CourtClient;
    const signer = {
      send: vi.fn(async () => ({
        txHash: "hash",
        outcome: { status: { SuccessValue: "" } },
      })),
    } as unknown as Pick<KeeperSigner, "send">;
    const wasm = new WasmRunner(config, async (input) => {
      expect(JSON.parse(input).context).toEqual({
        request_id: "noa:1",
        attempt: 2,
        now: null,
      });
      return { v: 1, mode: "resolve", status: "resolved" };
    });
    const spend = new SpendCounter(config);
    const keeper = new KeeperLoop({
      config,
      rpc,
      court,
      signer,
      wasm,
      spend,
      now: () => Number(t / 1_000_000n),
    });
    await keeper.tick();
    expect(signer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        methodName: "submit_keeper_verdict",
        args: {
          id: "noa:1",
          verdict_json: JSON.stringify({
            v: 1,
            mode: "resolve",
            status: "resolved",
          }),
        },
      }),
    );
    keeper.stop();
    spend.close();
  });
});
