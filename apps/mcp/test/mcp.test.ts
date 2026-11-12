import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    const missing = await tool("catalog_tool", { name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("binance_kline");
  });
  it("simulates and reads market status via mocked RPC", async () => {
    const result = await tool("spec_simulate", { spec: examples.A1 });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      note: "if resolved now → Yes",
      verdict: { outcome: "Yes" },
    });
    const status = JSON.parse(
      (await tool("market_status", { market_id: 7 })).content[0].text,
    );
    expect(status.market.id).toBe(7);
    expect(status.links.noa).toContain("testnet.nearblocks.io");
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
    await new Promise<void>((resolve) => s.close(() => resolve()));
    local.close();
  });
});
