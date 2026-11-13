import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import { examples } from "../src/guide.js";
import type { NearRpc } from "../src/near/rpc.js";
import type { CourtClient } from "../src/court/client.js";

const dir = mkdtempSync(join(tmpdir(), "noacourt-mcp-"));
const wasmPath = join(dir, "resolver.wasm");
writeFileSync(wasmPath, "fake-wasm");
writeFileSync(
  join(dir, "keeper.log"),
  JSON.stringify({
    ts: "2026-11-13T08:00:00Z",
    action: "trigger",
    id: "noa:7",
    tx_hash: "a".repeat(32),
    status: "success",
  }) + "\n",
);
const config = {
  ...loadConfig(),
  dataDir: dir,
  resolverWasm: wasmPath,
  nearAiApi: "test-only",
  nearAiSpendCapUsd: 0.05,
  nearAiCostPerSimulateUsd: 0.05,
  rateLimitPerMin: 30,
};
const rpc = {
  view: vi.fn(async (_account: string, method: string) =>
    method === "get_market" ? { id: 7, status: "Active" } : null,
  ),
  txStatus: vi.fn(async () => ({
    receipts_outcome: [
      {
        outcome: {
          logs: [
            `EVENT_JSON:${JSON.stringify({ standard: "near-outlayer", event: "execution_requested", data: [{ request_data: JSON.stringify({ request_id: 37444 }) }] })}`,
          ],
        },
      },
    ],
  })),
} as unknown as NearRpc;
const court = {
  resolverHash: vi.fn(() => null),
  market: vi.fn(async () => ({ state: "Registered" })),
  verdict: vi.fn(async () => ({ outcome: "Yes" })),
  request: vi.fn(async () => null),
} as unknown as CourtClient;
const wasm = new WasmRunner(config, async (_input, mode) =>
  mode === "lint"
    ? { ok: true, errors: [], warnings: [] }
    : {
        v: 1,
        mode: "simulate",
        status: "resolved",
        outcome: "Yes",
        sources: [
          {
            id: "binance",
            value: "3.41",
            as_of: "2026-12-01T12:00:00Z",
            url: "https://api.binance.com",
            error: null,
          },
        ],
      },
);

let server: Server;
let base: string;
let close: () => void;
async function post(body: unknown) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
let nextId = 3;
async function tool(name: string, args: unknown) {
  const result = await post({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (!result.body.result) throw new Error(JSON.stringify(result));
  return result.body.result as {
    isError?: boolean;
    content: [{ text: string }];
  };
}

beforeAll(async () => {
  const created = createApp(config, { rpc, court, wasm });
  close = created.close;
  server = await new Promise((resolve) => {
    const s = created.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  close();
});

describe("MCP HTTP", () => {
  it("serves fresh fixture GET and HEAD responses without cache validators", async () => {
    const fixture = join(dir, "fixtures", "score.json");
    writeFileSync(fixture, '{"score":1}');
    const url = `${base}/fixtures/score.json`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('{"score":1}');
    expect(first.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(first.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(first.headers.get("cdn-cache-control")).toBe("no-store");
    expect(first.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(first.headers.get("pragma")).toBe("no-cache");
    expect(first.headers.get("etag")).toBeNull();
    expect(first.headers.get("last-modified")).toBeNull();
    writeFileSync(fixture, '{"score":2}');
    const second = await fetch(url, {
      headers: {
        "if-none-match": "*",
        "if-modified-since": "Wed, 01 Jan 2100 00:00:00 GMT",
      },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe('{"score":2}');
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String('{"score":2}'.length),
    );
    expect(await head.text()).toBe("");
    for (const [extension, type] of [
      ["xml", "application/xml"],
      ["rss", "application/rss+xml"],
      ["html", "text/html"],
      ["txt", "text/plain"],
    ]) {
      writeFileSync(join(dir, "fixtures", `sample.${extension}`), "sample");
      const response = await fetch(`${base}/fixtures/sample.${extension}`);
      expect(response.headers.get("content-type")).toBe(
        `${type}; charset=utf-8`,
      );
    }
  });
  it("rejects invalid fixture names, unsupported types, and escaping symlinks", async () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "private");
    symlinkSync(outside, join(dir, "fixtures", "escape.txt"));
    for (const name of [
      ".hidden.json",
      "..",
      "bad%2Fname.json",
      "score.exe",
      "missing.json",
      "escape.txt",
    ]) {
      expect((await fetch(`${base}/fixtures/${name}`)).status).toBe(404);
    }
  });
  it("reports WASM health without exposing the local path", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    const health = (await response.json()) as any;
    expect(health.wasm).not.toHaveProperty("path");
    expect(health.wasm).toMatchObject({
      available: true,
      sha256: expect.stringMatching(/^sha256:/),
    });
    expect(health.wasm).toHaveProperty("published_sha256");
    expect(health.wasm).toHaveProperty("match");
    expect(Object.keys(health.wasm).sort()).toEqual([
      "available",
      "match",
      "published_sha256",
      "sha256",
    ]);
    expect(health.keeper.counts).toMatchObject({
      link_rejections_permanent: 0,
      link_rejections_pending: 0,
    });
    expect(health).toHaveProperty("court_config_fetched_at");
    expect(health).toHaveProperty("court_config_last_error");
  });
  it("initializes and lists exactly ten tools with input schemas", async () => {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("noacourt-mcp");
    const list = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(list.body.result.tools).toHaveLength(10);
    expect(list.body.result.tools.map((x: any) => x.name)).toEqual([
      "court_guide",
      "catalog_list",
      "catalog_tool",
      "source_sample",
      "spec_lint",
      "spec_simulate",
      "rules_render",
      "market_create_link",
      "market_status",
      "verdict_get",
    ]);
    for (const entry of list.body.result.tools)
      expect(entry.inputSchema.type).toBe("object");
    for (const entry of list.body.result.tools) {
      expect(entry.annotations.destructiveHint).toBe(false);
      expect(entry.annotations.readOnlyHint).toBe(
        entry.name !== "market_create_link",
      );
      expect(entry.annotations.idempotentHint).toBe(
        entry.name !== "market_create_link",
      );
      expect(entry.annotations.openWorldHint).toBe(
        [
          "source_sample",
          "spec_simulate",
          "market_status",
          "verdict_get",
        ].includes(entry.name),
      );
    }
  });
  it("returns guide and unknown catalog error", async () => {
    expect((await tool("court_guide", {})).content[0].text).toContain(
      "Find an official or first-party source first",
    );
    const entry = JSON.parse(
      (await tool("catalog_tool", { name: "http_json" })).content[0].text,
    );
    expect(
      entry.param_json_schema.properties.extract.properties.path.type,
    ).toBe("string");
    expect(entry.spec_retry_template).toEqual({ max_attempts: 5, every: "3m" });
    expect(entry.recommended_resolution_window_minutes).toBe(20);
    const missing = await tool("catalog_tool", { name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("binance_kline");
  });
  it("uses the default retry policy in source_sample's single-source spec", async () => {
    const runner = vi.spyOn(wasm, "run");
    try {
      const sampled = await tool("source_sample", {
        source: examples.A1.sources[0],
      });
      expect(sampled.isError).not.toBe(true);
      const simulated = runner.mock.calls.find(([mode]) => mode === "simulate");
      expect(simulated).toBeDefined();
      expect(JSON.parse(simulated![1])).toMatchObject({
        retry: { max_attempts: 5, every: "3m" },
      });
    } finally {
      runner.mockRestore();
    }
  });
  it("simulates and reads market status via mocked RPC", async () => {
    const result = await tool("spec_simulate", { spec: examples.A1 });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      preview_using_latest_data: true,
      note: expect.stringContaining(
        "observation time not reached; result uses the latest available data",
      ),
      verdict: { outcome: "Yes" },
    });
    const status = JSON.parse(
      (await tool("market_status", { market_id: 7 })).content[0].text,
    );
    expect(status.market.id).toBe(7);
    expect(status.links.noa).toContain("testnet.nearblocks.io");
    expect(status.now_utc).toMatch(/Z$/);
    expect(status.lifecycle).toBeTypeOf("string");
    expect(status.outlayer_request_id).toBe("37444");
    expect(status.outlayer_request_tx_url).toContain(
      "testnet.nearblocks.io/txns/",
    );
    const missingVerdict = vi
      .spyOn(court, "verdict")
      .mockResolvedValueOnce(null);
    const pending = JSON.parse(
      (await tool("verdict_get", { market_id: 7 })).content[0].text,
    );
    expect(pending).toMatchObject({ status: "pending", request_id: "noa:7" });
    expect(pending.next_step).toBeTypeOf("string");
    missingVerdict.mockRestore();
  });
  it("rejects source_sample loopback and text_judge spend cap", async () => {
    const sample = await tool("source_sample", {
      source: {
        ...examples.A6.sources[0],
        request: { method: "GET", url: "https://127.0.0.1/score" },
      },
    });
    expect(sample.isError).toBe(true);
    expect(sample.content[0].text).toContain("private or loopback");
    expect(
      (await tool("spec_simulate", { spec: examples.A8 })).isError,
    ).not.toBe(true);
    const capped = await tool("spec_simulate", { spec: examples.A8 });
    expect(capped.isError).toBe(true);
    expect(capped.content[0].text).toContain("spend cap");
  });
  it("returns 405 for GET and DELETE", async () => {
    for (const method of ["GET", "DELETE"])
      expect((await fetch(`${base}/mcp`, { method })).status).toBe(405);
  });
  it("returns JSON-RPC 429 with retry hint after request limit", async () => {
    const cfg = {
      ...config,
      dataDir: mkdtempSync(join(tmpdir(), "noacourt-limit-")),
      rateLimitPerMin: 1,
    };
    const local = createApp(cfg, { rpc, court, wasm });
    const s = await new Promise<Server>((resolve) => {
      const value = local.app.listen(0, "127.0.0.1", () => resolve(value));
    });
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}/mcp`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    await fetch(url, { method: "POST", headers, body });
    const response = await fetch(url, { method: "POST", headers, body });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(((await response.json()) as any).error.message).toContain(
      "Rate limited",
    );
    writeFileSync(join(cfg.dataDir, "fixtures", "public.txt"), "available");
    const fixtureResponse = await fetch(
      `http://127.0.0.1:${(s.address() as { port: number }).port}/fixtures/public.txt`,
    );
    expect(fixtureResponse.status).toBe(200);
    expect(await fixtureResponse.text()).toBe("available");
    await new Promise<void>((resolve) => s.close(() => resolve()));
    local.close();
  });
});
