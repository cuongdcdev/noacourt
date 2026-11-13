import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import { RateLimiter, SpendCounter } from "../src/ratelimit.js";
import { NearRpc } from "../src/near/rpc.js";
import { rawSample, safeUrl, sampleUrl, suggestPaths } from "../src/source.js";

const temp = () => mkdtempSync(join(tmpdir(), "noacourt-test-"));
const config = () => ({
  ...loadConfig(),
  dataDir: temp(),
  nearRpcUrls: ["https://one.example", "https://two.example"],
  wasmTimeoutMs: 1_000,
});

describe("infrastructure", () => {
  it.each([
    [
      { tool: "binance_kline", params: { symbol: "NEARUSDT", interval: "1m" } },
      "data-api.binance.vision/api/v3/klines?symbol=NEARUSDT&interval=1m&limit=3",
    ],
    [
      { tool: "okx_candle", params: { instId: "NEAR-USDT", bar: "1m" } },
      "www.okx.com/api/v5/market/candles?instId=NEAR-USDT&bar=1m&limit=100",
    ],
    [
      {
        tool: "coinbase_candle",
        params: { product_id: "NEAR-USD", granularity: 60 },
      },
      "api.exchange.coinbase.com/products/NEAR-USD/candles?granularity=60",
    ],
  ] as const)(
    "fetches a bounded raw candle excerpt for %o",
    async (source, expected) => {
      expect(sampleUrl(source)).toContain(expected);
      const request = vi.fn(
        async () =>
          new Response(JSON.stringify([["x".repeat(5000)]]), { status: 200 }),
      );
      const resolveHost = vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
      ]);
      const result = await rawSample(
        source,
        request as typeof fetch,
        resolveHost as any,
      );
      expect(result?.excerpt.length).toBe(2048);
      expect(request).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ method: "GET" }),
      );
    },
  );
  it("uses the Binance adapter's fallback endpoint when the resolver reports it", () => {
    expect(
      sampleUrl({
        tool: "binance_kline",
        params: { symbol: "NEARUSDT", interval: "1m" },
        adapter_url:
          "https://api.binance.com/api/v3/klines?symbol=NEARUSDT&interval=1m&limit=3",
      }),
    ).toBe(
      "https://api.binance.com/api/v3/klines?symbol=NEARUSDT&interval=1m&limit=3",
    );
  });
  it("uses the three default RPC endpoints and a 70-second trigger grace", () => {
    vi.stubEnv("NEAR_RPC_URLS", "");
    vi.stubEnv("TRIGGER_GRACE_SECONDS", "");
    try {
      expect(loadConfig().nearRpcUrls).toEqual([
        "https://test.rpc.fastnear.com",
        "https://rpc.testnet.near.org",
        "https://archival-rpc.testnet.fastnear.com",
      ]);
      expect(loadConfig().triggerGraceSeconds).toBe(70);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rotates RPCs and throws a typed error when all fail", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (calls.length === 1) throw new Error("down");
      return new Response(JSON.stringify({ result: { ok: true } }), {
        status: 200,
      });
    });
    const rpc = new NearRpc(config(), request as typeof fetch, async () => {});
    expect(await rpc.call("query", {})).toEqual({ ok: true });
    expect(calls).toEqual(["https://one.example", "https://two.example"]);
    const bad = new NearRpc(
      config(),
      vi.fn(async () => {
        throw new Error("down");
      }) as typeof fetch,
      async () => {},
    );
    await expect(bad.call("query", {})).rejects.toMatchObject({
      name: "RpcError",
      attempts: 2,
    });
  });
  it.each([
    ["HTTP 429", new Response("rate limited", { status: 429 })],
    ["deprecated text", new Response("DEPRECATED", { status: 200 })],
    [
      "deprecated result",
      new Response(JSON.stringify({ result: "DEPRECATED" }), { status: 200 }),
    ],
  ])("rotates past a %s endpoint", async (_name, first) => {
    const urls: string[] = [];
    const request = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return urls.length === 1
        ? first.clone()
        : new Response(JSON.stringify({ result: { ok: true } }), {
            status: 200,
          });
    });
    const rpc = new NearRpc(config(), request as typeof fetch, async () => {});
    expect(await rpc.call("query", {})).toEqual({ ok: true });
    expect(urls).toEqual(["https://one.example", "https://two.example"]);
  });
  it("keeps NEAR_AI_API out of argv and only in text judge simulate environment", async () => {
    const dir = temp();
    const fixture = join(dir, "fake-wasmtime");
    const output = join(dir, "seen.json");
    writeFileSync(
      fixture,
      `#!/usr/bin/env node\nconst fs=require('fs'); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({argv:process.argv.slice(2),secret:process.env.NEAR_AI_API||null})); process.stdout.write(JSON.stringify({ok:true}));`,
    );
    chmodSync(fixture, 0o755);
    const wasm = join(dir, "resolver.wasm");
    writeFileSync(wasm, "fake");
    const cfg = {
      ...config(),
      wasmtimeBin: fixture,
      resolverWasm: wasm,
      nearAiApi: "top-secret",
    };
    const runner = new WasmRunner(cfg);
    await runner.run("lint", "{}", true);
    expect(
      JSON.parse((await import("node:fs")).readFileSync(output, "utf8")).secret,
    ).toBeNull();
    await runner.run("simulate", "{}", true);
    const seen = JSON.parse(
      (await import("node:fs")).readFileSync(output, "utf8"),
    );
    expect(seen.secret).toBe("top-secret");
    expect(seen.argv.join(" ")).not.toContain("top-secret");
    expect(seen.argv).toContain("NEAR_AI_API");
  });
  it("times out a hanging runner", async () => {
    const dir = temp();
    const fixture = join(dir, "hang");
    writeFileSync(fixture, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);");
    chmodSync(fixture, 0o755);
    const wasm = join(dir, "resolver.wasm");
    writeFileSync(wasm, "fake");
    await expect(
      new WasmRunner({
        ...config(),
        wasmtimeBin: fixture,
        resolverWasm: wasm,
        wasmTimeoutMs: 30,
      }).run("lint", "{}"),
    ).rejects.toThrow("timed out");
  });
  it("enforces the persistent spend cap", () => {
    const cfg = {
      ...config(),
      nearAiSpendCapUsd: 0.05,
      nearAiCostPerSimulateUsd: 0.05,
    };
    const counter = new SpendCounter(cfg);
    counter.charge();
    expect(() => counter.charge()).toThrow("spend cap");
    counter.close();
  });
  it("limits sliding windows", () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(false);
    now = 60_001;
    expect(limiter.check("ip").allowed).toBe(true);
  });
  it("rejects loopback and private source addresses", async () => {
    await expect(safeUrl("https://localhost/a")).rejects.toThrow("private");
    await expect(safeUrl("https://127.0.0.1/a")).rejects.toThrow("private");
    await expect(
      safeUrl(
        "https://example.com/a",
        async () => [{ address: "10.0.0.1", family: 4 }] as never,
      ),
    ).rejects.toThrow("private");
    expect(suggestPaths({ id: "x", score: 50, items: [{ score: 4 }] })).toEqual(
      {
        identity_asserts: ['$.id == "x"'],
        candidate_extract_paths: ["$.score"],
      },
    );
  });
});
