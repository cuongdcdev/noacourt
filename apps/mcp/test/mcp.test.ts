import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import { examples } from "../src/guide.js";
import { renderRules } from "../src/spec/render.js";
import type { NearRpc } from "../src/near/rpc.js";
import type { CourtClient } from "../src/court/client.js";

const dir = mkdtempSync(join(tmpdir(), "noacourt-mcp-"));
const browserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
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
  view: vi.fn(
    async (_account: string, method: string, args?: { market_id?: number }) =>
      method === "get_market" && args?.market_id === 7
        ? {
            id: 7,
            status: "Active",
            outcomes: [
              { id: 0, name: "Yes" },
              { id: 1, name: "No" },
            ],
          }
        : method === "get_user_positions_in_market"
          ? [{ outcome_id: 0, shares_fp: "123" }]
          : method === "get_user_cost_basis"
            ? "100"
            : null,
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
        spec_hash: `sha256:${"d".repeat(64)}`,
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
  const rawFetch = vi.fn(
    async () =>
      new Response(JSON.stringify([[1, "2", "3", "1", "4", "5", 2]]), {
        status: 200,
      }),
  );
  const rawResolveHost = vi.fn(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const created = createApp(config, {
    rpc,
    court,
    wasm,
    rawFetch: rawFetch as typeof fetch,
    rawResolveHost: rawResolveHost as any,
  });
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
  it("returns JSON discovery without changing stateless MCP method handling", async () => {
    const home = await fetch(`${base}/`, {
      headers: { "user-agent": browserUserAgent },
    });
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("application/json");
    const discovery = await home.json();
    expect(discovery.name).toBe("Noa Court");
    expect(discovery.mcp_endpoint).toBe(
      "https://noacourtmcp.junstudio.xyz/mcp",
    );
    expect(discovery.start_here).toContain("court_guide");
    expect(discovery.docs.integration).toBe(
      "https://noacourtmcp.junstudio.xyz/docs/INTEGRATE.md",
    );
    expect(discovery.docs.near_tokens).toBe(
      "https://noacourtmcp.junstudio.xyz/docs/NEAR_TOKENS.md",
    );
    for (const name of [
      "README.md",
      "MCP.md",
      "ARCHITECTURE.md",
      "SPEC.md",
      "INTEGRATE.md",
      "NEAR_TOKENS.md",
      "SKILL.md",
    ]) {
      const response = await fetch(`${base}/docs/${name}`, {
        headers: { "user-agent": browserUserAgent },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/markdown");
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    const unknown = await fetch(`${base}/docs/unknown.md`, {
      headers: { "user-agent": browserUserAgent },
    });
    expect(unknown.status).toBe(404);

    for (const method of ["GET", "DELETE"] as const) {
      const response = await fetch(`${base}/mcp`, {
        method,
        headers: { "user-agent": browserUserAgent },
      });
      expect(response.status).toBe(405);
      const body = await response.json();
      expect(body.error.code).toBe(-32000);
      if (method === "GET") {
        expect(body.error.data.docs.integration).toBe(
          discovery.docs.integration,
        );
        expect(body.error.data.start_here).toContain("court_guide");
        expect(body.error.data.mcp_endpoint).toBe(discovery.mcp_endpoint);
        expect(body.error.data.transport).toContain("POST");
      }
    }
  });
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
    const guide = (await tool("court_guide", {})).content[0].text;
    expect(guide).toContain("Find an official or first-party source first");
    expect(guide).toContain("docs/NEAR_TOKENS.md");
    expect(guide).toContain("A10_INTEAR_MC");
    expect(guide).toContain("Single-source Intear or JustHoot");
    const entry = JSON.parse(
      (await tool("catalog_tool", { name: "http_json" })).content[0].text,
    );
    expect(
      entry.param_json_schema.properties.extract.properties.path.type,
    ).toBe("string");
    expect(
      entry.param_json_schema.properties.extract.properties.allow_index.type,
    ).toBe("boolean");
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
      const sampledValue = JSON.parse(sampled.content[0].text);
      expect(sampledValue.raw.url).toContain(
        "data-api.binance.vision/api/v3/klines",
      );
      expect(sampledValue.raw.excerpt).toContain('"2"');
      expect(sampledValue.raw.excerpt.length).toBeLessThanOrEqual(2048);
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
      spec_hash: renderRules(examples.A1).spec_hash,
      verdict_spec_hash: `sha256:${"d".repeat(64)}`,
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
  it("omits the separately labelled verdict hash when it matches canonical rules", async () => {
    const canonical = renderRules(examples.A1).spec_hash;
    const runner = vi.spyOn(wasm, "run").mockResolvedValueOnce({
      outcome: "Yes",
      spec_hash: canonical,
      sources: [],
    });
    try {
      const result = JSON.parse(
        (await tool("spec_simulate", { spec: examples.A1 })).content[0].text,
      );
      expect(result.spec_hash).toBe(canonical);
      expect(result).not.toHaveProperty("verdict_spec_hash");
    } finally {
      runner.mockRestore();
    }
  });
  it("shows account shares and distinguishes dispute proposals from finalization", async () => {
    const active = JSON.parse(
      (
        await tool("market_status", {
          market_id: 7,
          account_id: "alice.testnet",
        })
      ).content[0].text,
    );
    expect(active.account_position).toMatchObject({
      claim_status: "not_claimable_yet",
      shares_by_outcome: [
        { outcome_id: 0, shares_fp: "123" },
        { outcome_id: 1, shares_fp: "0" },
      ],
      claimable_amount: null,
      note: expect.stringContaining("no cheap claimable payout"),
    });
    const courtMarket = vi
      .spyOn(court, "market")
      .mockResolvedValue({ status: "Resolved" });
    const noaView = vi
      .spyOn(rpc, "view")
      .mockImplementation(async (_account, method, args) => {
        if (method === "get_market")
          return {
            id: 7,
            status: "Active",
            outcomes: [{ id: 0, name: "Yes" }],
          };
        if (method === "get_pending_resolution")
          return { dispute_deadline: "1794559200000000000" };
        return null;
      });
    try {
      const proposed = JSON.parse(
        (await tool("market_status", { market_id: 7 })).content[0].text,
      );
      expect(proposed.status).toBe("proposed_in_dispute_window");
      expect(proposed.lifecycle).toBe("dispute_window");
      const receipt = JSON.parse(
        (await tool("verdict_get", { market_id: 7 })).content[0].text,
      );
      expect(receipt.status).toBe("proposed_in_dispute_window");
      noaView.mockImplementation(async (_account, method) =>
        method === "get_market"
          ? { id: 7, status: "Resolved", outcomes: [{ id: 0, name: "Yes" }] }
          : method === "get_user_positions_in_market"
            ? [{ outcome_id: 0, shares_fp: "123" }]
            : method === "get_user_cost_basis"
              ? "100"
              : null,
      );
      const finalized = JSON.parse(
        (
          await tool("market_status", {
            market_id: 7,
            account_id: "alice.testnet",
          })
        ).content[0].text,
      );
      expect(finalized.status).toBe("finalized");
      expect(finalized.account_position.claim_status).toBe("claimable");
      expect(
        JSON.parse(
          (await tool("verdict_get", { market_id: 7 })).content[0].text,
        ).status,
      ).toBe("finalized");
    } finally {
      courtMarket.mockRestore();
      noaView.mockRestore();
    }
  });
  it("returns not_found for unknown Noa markets and Court requests", async () => {
    const market = await tool("market_status", { market_id: 999 });
    expect(market.isError).not.toBe(true);
    expect(JSON.parse(market.content[0].text)).toMatchObject({
      status: "not_found",
      lifecycle: "not_found",
      market_id: 999,
      next_step: expect.stringContaining("check the market_id"),
    });
    const verdictMarket = await tool("verdict_get", { market_id: 999 });
    expect(verdictMarket.isError).not.toBe(true);
    expect(JSON.parse(verdictMarket.content[0].text)).toMatchObject({
      status: "not_found",
      lifecycle: "not_found",
      request_id: "noa:999",
      next_step: expect.stringContaining("check the market_id"),
    });
    const verdictRequest = await tool("verdict_get", { request_id: "req:999" });
    expect(verdictRequest.isError).not.toBe(true);
    expect(JSON.parse(verdictRequest.content[0].text)).toMatchObject({
      status: "not_found",
      lifecycle: "not_found",
      request_id: "req:999",
      next_step: expect.stringContaining("check the request_id"),
    });
  });
  it("uses pending only for an existing Court request and keeps RPC failures as errors", async () => {
    const request = vi
      .spyOn(court, "request")
      .mockResolvedValueOnce({ id: "req:1", status: "Linked" });
    const verdict = vi.spyOn(court, "verdict").mockResolvedValueOnce(null);
    try {
      const pending = await tool("verdict_get", { request_id: "req:1" });
      expect(pending.isError).not.toBe(true);
      expect(JSON.parse(pending.content[0].text)).toMatchObject({
        status: "pending",
        lifecycle: "linked",
      });
    } finally {
      request.mockRestore();
      verdict.mockRestore();
    }
    const failedMarket = vi
      .spyOn(rpc, "view")
      .mockRejectedValueOnce(new Error("RPC offline"));
    try {
      const result = await tool("market_status", { market_id: 999 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("RPC offline");
    } finally {
      failedMarket.mockRestore();
    }
    const failedRequest = vi
      .spyOn(court, "request")
      .mockRejectedValueOnce(new Error("Court RPC offline"));
    try {
      const result = await tool("verdict_get", { request_id: "req:999" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Court RPC offline");
    } finally {
      failedRequest.mockRestore();
    }
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
