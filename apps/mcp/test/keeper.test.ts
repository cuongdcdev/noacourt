import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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
import { DatabaseSync } from "node:sqlite";

const t = 2_000_000_000_000_000_000n;
const second = 1_000_000_000n;
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
    ["unlinked past deadline", null, null, t - 10n, false, ["void_unlinked"]],
    ["not yet due", { state: "Linked" }, null, t + 10n, false, []],
    [
      "trigger",
      { status: "Linked", attempts: 0 },
      null,
      t - 71n * second,
      false,
      ["trigger"],
    ],
    [
      "retry",
      { state: { RetryScheduled: { retry_at: (t - 1n).toString() } } },
      null,
      t - 71n * second,
      false,
      ["trigger"],
    ],
    ["void", { state: "Unresolvable" }, null, t - 10n, false, ["void"]],
    [
      "finalize",
      { state: "Resolved" },
      { dispute_deadline: (t - 1n).toString() },
      t - 71n * second,
      false,
      ["finalize_resolution"],
    ],
    ["pending", { state: "Pending" }, null, t - 10n, false, []],
    [
      "trusted",
      { state: "Pending" },
      null,
      t - 71n * second,
      true,
      ["submit_keeper_verdict"],
    ],
  ])("%s", (_name, court, pending, observation, trusted, expected) => {
    const noa =
      _name === "void" || _name === "unlinked past deadline"
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
      decideRequestActions({ status: "Linked" }, t, t - 70n * second, false, 3),
    ).toEqual(["trigger_request"]);
    expect(
      decideRequestActions({ status: "Linked" }, t, t + 1n, false, 3),
    ).toEqual([]);
    expect(
      decideRequestActions({ status: "Pending" }, t, t - 70n * second, true, 3),
    ).toEqual(["submit_keeper_verdict"]);
  });
  it.each([
    ["before grace", t - 69n * second, null, false, []],
    ["at grace", t - 70n * second, null, false, ["trigger"]],
    ["retry later", t - 70n * second, t + 1n, false, []],
    ["trusted before grace", t - 69n * second, null, true, []],
    [
      "trusted at grace",
      t - 70n * second,
      null,
      true,
      ["submit_keeper_verdict"],
    ],
  ])(
    "market observation grace: %s",
    (_name, observation, retryAt, trusted, expected) => {
      const state = {
        status: "Linked",
        attempts: 0,
        retry_at_ns: retryAt?.toString(),
      };
      expect(
        decideMarketActions(
          market,
          state,
          null,
          t,
          observation as bigint,
          trusted as boolean,
          3,
        ),
      ).toEqual(expected);
    },
  );
  it.each([
    ["before grace", t - 69n * second, null, false, []],
    ["at grace", t - 70n * second, null, false, ["trigger_request"]],
    ["retry later", t - 70n * second, t + 1n, false, []],
    ["trusted before grace", t - 69n * second, null, true, []],
    [
      "trusted at grace",
      t - 70n * second,
      null,
      true,
      ["submit_keeper_verdict"],
    ],
  ])(
    "request observation grace: %s",
    (_name, observation, retryAt, trusted, expected) => {
      const state = {
        status: "Linked",
        attempts: 0,
        retry_at_ns: retryAt?.toString(),
      };
      expect(
        decideRequestActions(
          state,
          t,
          observation as bigint,
          trusted as boolean,
          3,
        ),
      ).toEqual(expected);
    },
  );
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
  const baseMs = Number(t / 1_000_000n);
  const minute = 60_000;
  const rejectionResult = (reason: string) => ({
    txHash: "rejected-hash",
    outcome: {
      status: { SuccessValue: Buffer.from("false").toString("base64") },
      receipts_outcome: [
        {
          outcome: {
            logs: [
              `EVENT_JSON:${JSON.stringify({ event: "link_rejected", data: [{ market_id: 1, reason }] })}`,
            ],
          },
        },
      ],
    },
  });
  function unlinkedHarness(
    dataDir: string,
    clock: { now: number },
    send: (call: { methodName: string; gasTgas: number }) => Promise<unknown>,
    deadlineMs = baseMs + 24 * 60 * minute,
  ) {
    const config = {
      ...loadConfig(),
      dataDir,
      courtContract: "court.testnet",
      noaContract: "noa.testnet",
    };
    const noa = {
      ...market,
      resolution_deadline: String(BigInt(deadlineMs) * 1_000_000n),
    };
    const rpc = {
      view: vi.fn(async (_contract: string, method: string) => {
        if (method === "get_market_count") return 1;
        if (method === "get_markets") return [noa];
        if (method === "get_market") return noa;
        return null;
      }),
    } as unknown as NearRpc;
    const court = {
      market: vi.fn(async () => null),
      request: vi.fn(async () => null),
    } as unknown as CourtClient;
    const signer = { send: vi.fn(send) } as unknown as Pick<
      KeeperSigner,
      "send"
    >;
    const spend = new SpendCounter(config);
    const keeper = new KeeperLoop({
      config,
      rpc,
      court,
      signer,
      wasm: new WasmRunner(config),
      spend,
      now: () => clock.now,
    });
    return {
      keeper,
      court,
      signer,
      close: () => {
        keeper.stop();
        spend.close();
      },
    };
  }

  it.each([
    "wrong resolver",
    "outcomes mismatch",
    "expiration after observation",
    "metadata spec_hash mismatch",
    "invalid market deadline",
    "market is not Active",
    "metadata is not noacourt and no spec_hash supplied",
    "explicit spec_hash requires market creator",
  ])("persists permanent link rejection: %s", async (reason) => {
    const dir = temp();
    const clock = { now: baseMs };
    const send = vi.fn(async () => rejectionResult(reason));
    const first = unlinkedHarness(dir, clock, send);
    for (let i = 0; i < 5; i++) await first.keeper.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.keeper.counts.link_rejections_permanent).toBe(1);
    first.close();
    const restarted = unlinkedHarness(dir, clock, send);
    for (let i = 0; i < 5; i++) await restarted.keeper.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(restarted.keeper.counts.link_rejections_permanent).toBe(1);
    restarted.close();
  });

  it.each([
    "spec not registered",
    "creator has no credit",
    "unknown callback reason",
  ])("backs off and eventually stops retrying: %s", async (reason) => {
    const dir = temp();
    const clock = { now: baseMs };
    const send = vi.fn(async () => rejectionResult(reason));
    const harness = unlinkedHarness(dir, clock, send);
    const runAt = async (minutes: number, count: number) => {
      clock.now = baseMs + minutes * minute;
      await harness.keeper.tick();
      expect(send).toHaveBeenCalledTimes(count);
    };
    await runAt(0, 1);
    await runAt(4, 1);
    await runAt(5, 2);
    await runAt(19, 2);
    await runAt(20, 3);
    await runAt(79, 3);
    await runAt(80, 4);
    await runAt(200, 4);
    expect(harness.keeper.counts.link_rejections_permanent).toBe(1);
    harness.close();
    const db = new DatabaseSync(join(dir, "mcp.sqlite"));
    const row = db
      .prepare(
        "SELECT attempts, permanent FROM keeper_link_rejections WHERE market_id = 1",
      )
      .get() as { attempts: number; permanent: number };
    expect(row).toEqual({ attempts: 4, permanent: 1 });
    db.close();
  });

  it("backs off a failed link transaction without crashing", async () => {
    const dir = temp();
    const clock = { now: baseMs };
    const send = vi.fn(async () => {
      throw new Error("RPC unavailable: expiration after observation");
    });
    const harness = unlinkedHarness(dir, clock, send);
    await expect(harness.keeper.tick()).resolves.toBeUndefined();
    await harness.keeper.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.keeper.counts.link_rejections_pending).toBe(1);
    harness.close();
  });

  it.each(["unknown", "pending"] as const)(
    "logs a %s hash and retries after re-reading Court next tick",
    async (status) => {
      const dir = temp();
      const clock = { now: baseMs };
      const send = vi.fn(async () => ({
        txHash: "known-local-hash",
        tx_hash: "known-local-hash",
        status,
        return_value: null,
        logs: [],
        error: null,
        outcome: null,
      }));
      const harness = unlinkedHarness(dir, clock, send);
      await harness.keeper.tick();
      await harness.keeper.tick();
      expect(send).toHaveBeenCalledTimes(2);
      expect((harness.court.market as any).mock.calls).toHaveLength(2);
      expect(harness.keeper.counts.link_rejections_pending).toBe(0);
      const lines = readFileSync(join(dir, "keeper.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual([
        expect.objectContaining({
          action: "link_market",
          tx_hash: "known-local-hash",
          status,
        }),
        expect.objectContaining({
          action: "link_market",
          tx_hash: "known-local-hash",
          status,
        }),
      ]);
      harness.close();
    },
  );

  it("refreshes on already linked without caching a rejection", async () => {
    const dir = temp();
    const clock = { now: baseMs };
    const harness = unlinkedHarness(dir, clock, async () =>
      rejectionResult("market already linked"),
    );
    await harness.keeper.tick();
    await harness.keeper.tick();
    expect((harness.court.market as any).mock.calls).toHaveLength(3);
    expect((harness.signer.send as any).mock.calls).toHaveLength(1);
    expect(harness.keeper.counts.link_rejections_permanent).toBe(0);
    expect(harness.keeper.counts.link_rejections_pending).toBe(0);
    harness.close();
  });

  it("voids an unlinked market after its deadline with 80 TGas", async () => {
    const clock = { now: baseMs };
    const send = vi.fn(async () => ({
      txHash: "void-hash",
      outcome: { status: { SuccessValue: "" } },
    }));
    const harness = unlinkedHarness(temp(), clock, send, baseMs - 1);
    await harness.keeper.tick();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        methodName: "void_unlinked",
        gasTgas: 80,
        args: { market_id: 1 },
      }),
    );
    harness.close();
  });

  it("suppresses unsupported void_unlinked for one hour, then probes again", async () => {
    const clock = { now: baseMs };
    const send = vi.fn(async () => {
      throw new Error("MethodResolveError: MethodNotFound");
    });
    const harness = unlinkedHarness(temp(), clock, send, baseMs - 1);
    await expect(harness.keeper.tick()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    clock.now += 59 * minute;
    await harness.keeper.tick();
    expect(send).toHaveBeenCalledTimes(1);
    clock.now += minute;
    await harness.keeper.tick();
    expect(send).toHaveBeenCalledTimes(2);
    harness.close();
  });

  it("persists backoff for other void_unlinked failures", async () => {
    const dir = temp();
    const clock = { now: baseMs };
    const send = vi.fn(async () => {
      throw new Error("RPC unavailable");
    });
    const first = unlinkedHarness(dir, clock, send, baseMs - 1);
    await expect(first.keeper.tick()).resolves.toBeUndefined();
    first.close();
    const restarted = unlinkedHarness(dir, clock, send, baseMs - 1);
    clock.now += 4 * minute;
    await restarted.keeper.tick();
    expect(send).toHaveBeenCalledTimes(1);
    clock.now += minute;
    await restarted.keeper.tick();
    expect(send).toHaveBeenCalledTimes(2);
    restarted.close();
  });
  it("attaches 300 TGas to market and request triggers", async () => {
    const config = {
      ...loadConfig(),
      dataDir: temp(),
      courtContract: "court.testnet",
      noaContract: "noa.testnet",
    };
    const rpc = {
      view: vi.fn(async (_contract: string, method: string) => {
        if (method === "get_market_count") return 1;
        if (method === "get_markets") return [market];
        if (method === "get_market") return market;
        return null;
      }),
    } as unknown as NearRpc;
    const linked = { status: "Linked", spec_hash: "spec", attempts: 0 };
    const court = {
      market: vi.fn(async () => linked),
      request: vi.fn(async (id: string) => (id === "req:1" ? linked : null)),
      spec: vi.fn(async () => ({
        observation_at_ns: (t - 71n * second).toString(),
      })),
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
      now: () => Number(t / 1_000_000n),
    });
    await keeper.tick();
    expect(signer.send).toHaveBeenCalledWith(
      expect.objectContaining({ methodName: "trigger", gasTgas: 300 }),
    );
    expect(signer.send).toHaveBeenCalledWith(
      expect.objectContaining({ methodName: "trigger_request", gasTgas: 300 }),
    );
    keeper.stop();
    spend.close();
  });
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
      market: vi.fn(async () => ({
        status: "Linked",
        spec_hash: "spec",
        attempts: 0,
      })),
      spec: vi.fn(async () => ({
        observation_at_ns: (t - 71n * second).toString(),
      })),
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
      now: () => Number(t / 1_000_000n),
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
        observation_at_ns: (t - 71n * second).toString(),
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
