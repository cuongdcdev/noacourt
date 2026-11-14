import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { WasmRunner } from "../src/resolver/wasm.js";
import {
  calculateBFromStake,
  ceilAtomicToHuman,
  minimumStakeAtomic,
  stakeMeetsMinimumLiquidity,
  fpLn,
} from "../src/noa/stake.js";
import { createTokenReader } from "../src/noa/tokens.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { examples } from "../src/guide.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NearRpc } from "../src/near/rpc.js";

const WHITELIST = [
  { token_id: "point.noamarket.testnet", min_b_shares_fp: "1370560288844515237", decimals: 18, is_active: true, min_trade_amount: "1000000000000000000" },
  { token_id: "wrap.testnet", min_b_shares_fp: "1370560288844515237", decimals: 24, is_active: true, min_trade_amount: "100000000000000000000000" },
  { token_id: "old.testnet", min_b_shares_fp: "1", decimals: 6, is_active: false },
];
const fakeRpc = () =>
  ({
    view: vi.fn(async (account: string, method: string) => {
      if (method === "get_whitelisted_tokens") return WHITELIST;
      if (method === "get_config") return { safety_bps: 9500 };
      if (method === "ft_metadata")
        if (account === "wrap.testnet") return { symbol: "wNEAR", name: "Wrapped NEAR" };
        else if (account === "point.noamarket.testnet") return { symbol: "NPOINT", name: "Noa Point" };
        else throw new Error("no metadata");
      return null;
    }),
  }) as unknown as NearRpc & { view: ReturnType<typeof vi.fn> };

describe("stake math (port of Noa frontend)", () => {
  it("matches the Noa lmsr.test vectors", () => {
    const b = Number(calculateBFromStake(1000n * 10n ** 6n, 6, 2, 9500)) / 1e18;
    expect(b).toBeGreaterThan(1370);
    expect(b).toBeLessThan(1371);
    expect(calculateBFromStake(1n, 24, 2, 9500)).toBe(0n);
    expect(calculateBFromStake(1000n * 10n ** 6n, 6, 1, 9500)).toBe(0n);
  });
  it("fpLn is continuous at powers of two", () => {
    const d = fpLn(2n * 10n ** 18n) - fpLn(2n * 10n ** 18n - 1n);
    expect(d <= 2n && d >= -2n).toBe(true);
  });
  it("ceilAtomicToHuman matches the Noa test vectors", () => {
    expect(ceilAtomicToHuman(99_999_999_999_999_999_942n, 18)).toBe("100");
    expect(ceilAtomicToHuman(1_234_000_000_000_000_000n, 18)).toBe("1.24");
    expect(ceilAtomicToHuman(12_301_000_000_000n, 18)).toBe("0.000013");
    expect(ceilAtomicToHuman(1_005_001n, 6)).toBe("1.01");
    expect(ceilAtomicToHuman(5n, 1)).toBe("0.5");
  });
  it("min stake is the exact boundary and grows with outcome count", () => {
    for (const n of [2, 3, 5]) {
      const args = { decimals: 18, outcomeCount: n, safetyBps: 9500, minBSharesFp: 1370560288844515237n };
      const exact = minimumStakeAtomic(args)!;
      expect(stakeMeetsMinimumLiquidity({ ...args, stakeAtomic: exact })).toBe(true);
      expect(stakeMeetsMinimumLiquidity({ ...args, stakeAtomic: exact - 1n })).toBe(false);
    }
    const two = minimumStakeAtomic({ decimals: 18, outcomeCount: 2, safetyBps: 9500, minBSharesFp: 1370560288844515237n })!;
    const three = minimumStakeAtomic({ decimals: 18, outcomeCount: 3, safetyBps: 9500, minBSharesFp: 1370560288844515237n })!;
    expect(three > two).toBe(true);
    // b = stake*0.95/ln2 >= 1.3705... means stake ~ 1 token for 2 outcomes
    expect(ceilAtomicToHuman(two, 18)).toBe("1");
  });
});

describe("token reader", () => {
  it("describes tokens with metadata, min stake and default flag, and caches", async () => {
    const rpc = fakeRpc();
    const reader = createTokenReader(loadConfig(), rpc);
    const tokens = await reader.describe(2);
    expect(tokens.map((t) => t.token_id)).toEqual(["point.noamarket.testnet", "wrap.testnet", "old.testnet"]);
    expect(tokens[0]).toMatchObject({ symbol: "NPOINT", name: "Noa Point", decimals: 18, min_trade_amount: "1", min_stake: "1", default: true, is_active: true });
    expect(tokens[1]).toMatchObject({ symbol: "wNEAR", decimals: 24, min_trade_amount: "0.1", min_stake: "1", default: false });
    expect(tokens[2]).toMatchObject({ symbol: null, name: null, is_active: false, min_trade_amount: null, default: false });
    const calls = rpc.view.mock.calls.length;
    await reader.describe(3);
    expect(rpc.view.mock.calls.length).toBe(calls);
  });
});

describe("MCP tool and create-link guard", () => {
  const config = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), "noacourt-tok-")), keeperEnabled: false, rateLimitPerMin: 1000 };
  const rpc = fakeRpc();
  const wasm = new WasmRunner(config, async () => ({ ok: true, errors: [], warnings: [] }) as any);
  const court = { resolverHash: vi.fn(() => null), maxAttempts: async () => 5 } as any;
  const created = createApp(config, { rpc, court, wasm });
  let server: Server;
  let base = "";
  let nextId = 1;
  beforeAll(async () => {
    server = await new Promise<Server>((resolve) => {
      const v = created.app.listen(0, "127.0.0.1", () => resolve(v));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    created.close();
    server.close();
  });
  const call = async (name: string, args: unknown) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await r.json()) as any;
  };
  const link = (extra: Record<string, unknown>) =>
    call("market_create_link", { title: "NEAR market", outcomes: ["Yes", "No"], duration_minutes: 10, spec: examples.A1, ...extra });

  it("list_whitelisted_tokens returns tokens, network and note", async () => {
    const res = await call("list_whitelisted_tokens", { outcome_count: 3 });
    const out = JSON.parse(res.result.content[0].text);
    expect(out.noa_contract).toBe(config.noaContract);
    expect(out.network).toBe("testnet");
    expect(out.outcome_count).toBe(3);
    expect(out.note).toMatch(/liquidity/);
    expect(out.tokens[0].default).toBe(true);
    expect(out.tokens[0].min_stake).toBe("1.59");
  });
  it("rejects a below-minimum stake and suggests list_whitelisted_tokens", async () => {
    const res = await link({ stake: "0.5" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/below the minimum.*list_whitelisted_tokens/s);
  });
  it("accepts a valid non-default token with a custom stake", async () => {
    const res = await link({ stake: "2.5", token_id: "wrap.testnet" });
    expect(res.result.isError).not.toBe(true);
    const out = JSON.parse(res.result.content[0].text);
    expect(out.url).toContain("/sign/");
  });
  it("rejects an inactive token", async () => {
    const res = await link({ stake: "2", token_id: "old.testnet" });
    expect(res.result.isError).toBe(true);
  });
});
