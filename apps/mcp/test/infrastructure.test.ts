import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import { RateLimiter, SpendCounter } from "../src/ratelimit.js";
import { NearRpc } from "../src/near/rpc.js";
import { safeUrl, suggestPaths } from "../src/source.js";

const temp = () => mkdtempSync(join(tmpdir(), "noacourt-test-"));
const config = () => ({
  ...loadConfig(),
  dataDir: temp(),
  nearRpcUrls: ["https://one.example", "https://two.example"],
  wasmTimeoutMs: 100,
});

describe("infrastructure", () => {
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
