import express, { type Request } from "express";
import { lookup } from "node:dns/promises";
import { mkdirSync, realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import QRCode from "qrcode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { catalog, catalogParamSchemas } from "./catalog.js";
import { courtGuide } from "./guide.js";
import { NearRpc } from "./near/rpc.js";
import { CourtClient, outlayerRequestIdFromTx } from "./court/client.js";
import { WasmRunner } from "./resolver/wasm.js";
import { RateLimiter, SpendCounter } from "./ratelimit.js";
import { jcs, parseSpec } from "./spec/canonical.js";
import { prelint } from "./spec/prelint.js";
import { DEFAULT_RETRY_POLICY } from "./spec/defaults.js";
import { renderRules } from "./spec/render.js";
import { rawSample } from "./source.js";
import { SignStore } from "./sign/store.js";
import { decimalToUnits } from "./sign/txBuilder.js";
import { SignPlanConflictError } from "./sign/timing.js";
import {
  completeSignRequest,
  createSignRequest,
  planForAccount,
  publicRequest,
  ensureSnapshot,
} from "./sign/service.js";
import {
  ERROR_MESSAGES,
  REPORTABLE_STATES,
  publicationView,
  verifyPublication,
} from "./sign/publication.js";
import { signPage } from "./sign/page/html.js";
import { KeeperSigner } from "./near/signer.js";
import { KeeperLoop } from "./keeper/loop.js";
import { ActionHistory } from "./keeper/history.js";
import {
  annotateReceiptSources,
  lifecycle,
  marketTopLevelStatus,
  outlayerDetails,
  withIso,
} from "./status.js";

const specSchema = z
  .union([z.string(), z.record(z.unknown())])
  .describe("ResolutionSpec v1 JSON object or JSON string");
type ToolOutput = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};
const ok = (value: unknown): ToolOutput => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
});
const failed = (message: string): ToolOutput => ({
  isError: true,
  content: [{ type: "text", text: message }],
});
const formatLintErrors = (errors: unknown[]) =>
  errors
    .map((error) => {
      if (error && typeof error === "object") {
        const issue = error as Record<string, unknown>;
        return `${issue.code || "lint_error"} at ${issue.path || "$"}: ${issue.message || "invalid spec"}`;
      }
      return String(error);
    })
    .join("; ");
const guard =
  <T>(fn: () => Promise<T> | T) =>
  async (): Promise<ToolOutput> => {
    try {
      return ok(await fn());
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  };
const ipOf = (req: Request) =>
  String(
    req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown",
  );
const fixtureTypes: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".rss": "application/rss+xml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export type ServerDeps = {
  rpc?: NearRpc;
  court?: CourtClient;
  wasm?: WasmRunner;
  spend?: SpendCounter;
  rawFetch?: typeof fetch;
  rawResolveHost?: typeof lookup;
  signer?: Pick<KeeperSigner, "send">;
  store?: SignStore;
  /** fetch used for server-side Noa read-back (tests inject a fake). */
  noaFetch?: typeof fetch;
};
const discovery = {
  name: "Noa Court",
  description:
    "Testnet AI resolver for Noa markets. Draft and simulate a resolution spec, then let the creator sign with their own wallet.",
  mcp_endpoint: "https://noacourtmcp.junstudio.xyz/mcp",
  start_here:
    "Connect an MCP client and call court_guide before drafting a market.",
  workflow: [
    "source_sample",
    "spec_lint",
    "spec_simulate",
    "rules_render",
    "market_create_link",
    "creator signs with wallet",
    "market_status",
    "verdict_get",
  ],
  docs: {
    overview: "https://noacourtmcp.junstudio.xyz/docs/README.md",
    mcp: "https://noacourtmcp.junstudio.xyz/docs/MCP.md",
    architecture: "https://noacourtmcp.junstudio.xyz/docs/ARCHITECTURE.md",
    specification: "https://noacourtmcp.junstudio.xyz/docs/SPEC.md",
    integration: "https://noacourtmcp.junstudio.xyz/docs/INTEGRATE.md",
    near_tokens: "https://noacourtmcp.junstudio.xyz/docs/NEAR_TOKENS.md",
    skill: "https://noacourtmcp.junstudio.xyz/docs/SKILL.md",
  },
};
const docs = new Map([
  ["README.md", new URL("../../../README.md", import.meta.url)],
  ["MCP.md", new URL("../README.md", import.meta.url)],
  [
    "ARCHITECTURE.md",
    new URL("../../../docs/ARCHITECTURE.md", import.meta.url),
  ],
  ["SPEC.md", new URL("../../../docs/SPEC.md", import.meta.url)],
  ["INTEGRATE.md", new URL("../../../docs/INTEGRATE.md", import.meta.url)],
  ["NEAR_TOKENS.md", new URL("../../../docs/NEAR_TOKENS.md", import.meta.url)],
  ["SKILL.md", new URL("../../../skills/noa-court/SKILL.md", import.meta.url)],
]);

export function createApp(config: Config, deps: ServerDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.get("/", (_req, res) => res.json(discovery));
  app.get("/docs/:name", async (req, res) => {
    const file = docs.get(req.params.name);
    if (!file) {
      res.sendStatus(404);
      return;
    }
    try {
      const content = await readFile(file, "utf8");
      res.type("text/markdown; charset=utf-8").send(content);
    } catch {
      res.sendStatus(404);
    }
  });
  const rpc = deps.rpc || new NearRpc(config);
  const court = deps.court || new CourtClient(config, rpc);
  const wasm = deps.wasm || new WasmRunner(config);
  const spend = deps.spend || new SpendCounter(config);
  const store = deps.store || new SignStore(config);
  const history = new ActionHistory(config);
  const signer = deps.signer || new KeeperSigner(config, rpc);
  const signDeps = { config, store, rpc, court, signer, history };
  const keeper = new KeeperLoop({
    config,
    rpc,
    court,
    signer,
    wasm,
    spend,
    history,
  });
  let refreshRunning = false;
  const refreshCourtConfig = () => {
    if (refreshRunning) return;
    refreshRunning = true;
    const work = [wasm.hash(), wasm.publishedHash()];
    if (typeof court.refresh === "function") work.push(court.refresh());
    void Promise.allSettled(work).finally(() => {
      refreshRunning = false;
    });
  };
  refreshCourtConfig();
  const courtRefreshTimer = setInterval(
    refreshCourtConfig,
    config.courtConfigRefreshMs,
  );
  courtRefreshTimer.unref();
  const outlayerIdCache = new Map<string, { id: string; txHash: string }>();
  const outlayerInfo = async (id: string, verdict: unknown) => {
    const details = outlayerDetails(verdict);
    if (details.outlayer_request_id !== null) return details;
    const actions = history
      .forItem(id)
      .filter((entry) => ["trigger", "trigger_request"].includes(entry.action));
    let known = outlayerIdCache.get(id);
    if (known && actions.at(-1)?.tx_hash !== known.txHash) known = undefined;
    if (!known) {
      for (const action of actions.slice(-1)) {
        try {
          const outcome = await rpc.txStatus(
            action.tx_hash,
            config.keeperAccount,
            "EXECUTED_OPTIMISTIC",
          );
          const requestId = outlayerRequestIdFromTx(outcome);
          if (requestId !== null) {
            known = { id: requestId, txHash: action.tx_hash };
            outlayerIdCache.set(id, known);
            break;
          }
        } catch {
          // A missing or temporarily unavailable transaction does not hide the verdict.
        }
      }
    }
    return {
      ...details,
      outlayer_request_id: known?.id ?? null,
      outlayer_request_tx_hash: known?.txHash ?? null,
      outlayer_request_tx_url: known
        ? `https://testnet.nearblocks.io/txns/${encodeURIComponent(known.txHash)}`
        : null,
    };
  };
  const requestLimit = new RateLimiter(config.rateLimitPerMin);
  const simulateLimit = new RateLimiter(config.simulateLimitPerMin);
  const fixtureLimit = new RateLimiter(600);
  const fixturesDir = resolve(config.dataDir, "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  const fixturesRealDir = realpathSync(fixturesDir);

  app.get("/fixtures/:name", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("CDN-Cache-Control", "no-store");
    res.setHeader("Cloudflare-CDN-Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const limit = fixtureLimit.check(ipOf(req));
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      res.status(429).end();
      return;
    }
    const name = req.params.name;
    if (!/^[a-z0-9._-]+$/.test(name) || name.startsWith(".")) {
      res.status(404).end();
      return;
    }
    const extension = name.slice(name.lastIndexOf("."));
    const contentType = fixtureTypes[extension];
    if (!contentType) {
      res.status(404).end();
      return;
    }
    try {
      const filePath = await realpath(resolve(fixturesDir, name));
      if (!filePath.startsWith(`${fixturesRealDir}${sep}`)) {
        res.status(404).end();
        return;
      }
      if (!(await stat(filePath)).isFile()) {
        res.status(404).end();
        return;
      }
      const contents = await readFile(filePath);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(contents.length));
      res.status(200).end(req.method === "HEAD" ? undefined : contents);
    } catch {
      res.status(404).end();
    }
  });

  app.use(
    "/public",
    express.static(resolve(process.cwd(), "dist/public"), {
      index: false,
      maxAge: "1h",
    }),
  );
  app.get("/sign/:id", (req, res) => {
    const request = store.get(req.params.id);
    res
      .type("html")
      .send(
        signPage(
          req.params.id,
          request?.status || "not found",
          request?.params.title,
        ),
      );
  });
  app.get("/api/sign/:id", async (req, res) => {
    let request = store.get(req.params.id);
    if (request) request = ensureSnapshot(config, store, request);
    if (!request) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (request.status === "expired") {
      res.status(410).json({ error: "expired" });
      return;
    }
    const url = `${config.publicBaseUrl.replace(/\/$/, "")}/sign/${request.id}`;
    res.json({
      ...publicRequest(config, request),
      qr_png_data_url: await QRCode.toDataURL(url, {
        type: "image/png",
        margin: 1,
      }),
    });
  });
  app.get("/api/sign/:id/qr", async (req, res) => {
    const request = store.get(req.params.id);
    if (!request || request.status === "expired") {
      res
        .status(request ? 410 : 404)
        .json({ error: request ? "expired" : "not found" });
      return;
    }
    const url = `${config.publicBaseUrl.replace(/\/$/, "")}/sign/${request.id}`;
    res.json({
      qr_png_data_url: await QRCode.toDataURL(url, {
        type: "image/png",
        margin: 1,
      }),
    });
  });
  app.get("/api/sign/:id/plan", async (req, res) => {
    try {
      const request = store.get(req.params.id);
      if (!request) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (request.status !== "pending") {
        res.status(409).json({
          error: `sign request ${request.status}; signing deadline passed`,
        });
        return;
      }
      res.json(
        await planForAccount(
          signDeps,
          request,
          String(req.query.account || ""),
        ),
      );
    } catch (error) {
      res
        .status(error instanceof SignPlanConflictError ? 409 : 400)
        .json({ error: (error as Error).message });
    }
  });
  app.post("/api/sign/:id/complete", async (req, res) => {
    try {
      const request = store.get(req.params.id);
      if (!request) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (request.status === "expired") {
        res.status(410).json({ error: "expired" });
        return;
      }
      const hashes = z.array(z.string()).parse(req.body?.tx_hashes);
      const account = z.string().parse(req.body?.account_id);
      res.json(await completeSignRequest(signDeps, request, hashes, account));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  const publicationLimit = new RateLimiter(config.publicationVerifyPerMin);
  const noaFetch = deps.noaFetch || fetch;
  const completedRequest = (id: string) => {
    const request = store.get(id);
    if (!request)
      return { ok: false as const, error: 404, message: "not found" };
    if (request.status !== "completed" || !request.result)
      return {
        ok: false as const,
        error: 409,
        message: "market not created yet",
      };
    return { ok: true as const, request };
  };
  app.post("/api/sign/:id/publication/verify", async (req, res) => {
    const found = completedRequest(req.params.id);
    if (!found.ok) {
      res.status(found.error).json({ error: found.message });
      return;
    }
    const limit = publicationLimit.check(`${req.params.id}:${ipOf(req)}`);
    if (!limit.allowed) {
      res
        .status(429)
        .set("Retry-After", String(limit.retryAfterSeconds))
        .json({ error: "too many verification requests" });
      return;
    }
    const view = publicationView(config, found.request);
    if (view.state === "legacy_unavailable" || !view.noa) {
      res
        .status(409)
        .json({ error: "publication unavailable", state: view.state });
      return;
    }
    try {
      const outcome = await verifyPublication(
        config,
        store,
        found.request,
        noaFetch,
      );
      res.json({
        ...outcome,
        publication: publicationView(config, store.get(found.request.id)!),
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.post("/api/sign/:id/publication/report", (req, res) => {
    const found = completedRequest(req.params.id);
    if (!found.ok) {
      res.status(found.error).json({ error: found.message });
      return;
    }
    const view = publicationView(config, found.request);
    if (!view.noa || view.state === "legacy_unavailable") {
      res
        .status(409)
        .json({ error: "publication unavailable", state: view.state });
      return;
    }
    const state = String(req.body?.state);
    const code = req.body?.error_code;
    if (!(REPORTABLE_STATES as readonly string[]).includes(state)) {
      res
        .status(400)
        .json({ error: "state cannot be reported by the browser" });
      return;
    }
    if (found.request.publication.state !== "published")
      store.setPublication(
        found.request.id,
        state as (typeof REPORTABLE_STATES)[number],
        typeof code === "string" && ERROR_MESSAGES[code]
          ? ERROR_MESSAGES[code]
          : null,
      );
    res.json({
      publication: publicationView(config, store.get(found.request.id)!),
    });
  });

  const match = async () => {
    const [local, published] = await Promise.all([
      wasm.hash(),
      wasm.publishedHash(),
    ]);
    const remote =
      typeof (court as any).resolverStatusFresh === "function"
        ? await court.resolverStatusFresh()
        : { hash: court.resolverHash(), note: null };
    return {
      wasm_sha256: local,
      published_sha256: published,
      matches_published_resolver:
        local && published ? local === published : null,
      matches_court_resolver:
        local && remote.hash ? local === remote.hash : null,
      court_resolver_note: remote.note,
    };
  };
  const lint = async (input: unknown) => {
    const preliminary = prelint(input);
    const hashes = await match();
    if (!preliminary.ok)
      return {
        ok: false,
        errors: preliminary.errors,
        warnings: preliminary.warnings,
        prelint: preliminary,
        ...hashes,
      };
    if (!hashes.wasm_sha256 && !deps.wasm)
      return {
        ok: false,
        errors: ["resolver.wasm not available yet"],
        warnings: [],
        prelint: preliminary,
        ...hashes,
      };
    const result = await wasm.run("lint", jcs(parseSpec(input)));
    const object =
      result && typeof result === "object"
        ? (result as Record<string, any>)
        : {};
    const lintReport =
      object.lint && typeof object.lint === "object" ? object.lint : object;
    const errors = Array.isArray(lintReport.errors)
      ? lintReport.errors
      : ["resolver lint report missing errors array"];
    return {
      ok: lintReport.ok === true && errors.length === 0,
      errors,
      warnings: lintReport.warnings || [],
      labels: lintReport.labels || {},
      resolver_reason: object.reason || null,
      prelint: preliminary,
      ...hashes,
    };
  };
  const simulate = async (
    input: unknown,
    ip: string,
    alreadyLimited = false,
  ) => {
    if (!alreadyLimited) {
      const limit = simulateLimit.check(ip);
      if (!limit.allowed)
        throw new Error(
          `simulate rate limited; retry in ${limit.retryAfterSeconds}s`,
        );
    }
    const preliminary = prelint(input);
    if (!preliminary.ok)
      throw new Error(`prelint failed: ${preliminary.errors.join("; ")}`);
    const spec = parseSpec(input);
    if (spec.decide.kind === "text_judge") {
      if (!config.nearAiApi)
        throw new Error("NEAR_AI_API is required for text_judge simulation");
      spend.charge();
    }
    const verdict = await wasm.run(
      "simulate",
      jcs(spec),
      spec.decide.kind === "text_judge",
    );
    const rendered = renderRules(spec);
    const verdictHash = (verdict as Record<string, unknown> | null)?.spec_hash;
    const hashes = await match();
    const outcome = (verdict as Record<string, any>)?.outcome;
    return {
      verdict: annotateReceiptSources(verdict, spec),
      spec_hash: rendered.spec_hash,
      ...(typeof verdictHash === "string" && verdictHash !== rendered.spec_hash
        ? { verdict_spec_hash: verdictHash }
        : {}),
      ...hashes,
      preview_using_latest_data: Date.now() < Date.parse(spec.observation.at),
      note:
        Date.now() < Date.parse(spec.observation.at)
          ? `observation time not reached; result uses the latest available data and may change. If resolved now → ${outcome ?? "unavailable"}`
          : `if resolved now → ${outcome ?? "unavailable"}`,
    };
  };

  app.get("/healthz", async (_req, res) => {
    const [hash, published] = await Promise.all([
      wasm.hash(),
      wasm.publishedHash(),
    ]);
    const resolver =
      typeof (court as any).resolverStatus === "function"
        ? court.resolverStatus()
        : { hash: court.resolverHash(), note: null };
    const courtConfig =
      typeof court.configStatus === "function"
        ? court.configStatus()
        : {
            fetched_at: null,
            last_error: null,
            max_attempts: null,
            min_deposit: null,
          };
    res.json({
      ok: true,
      version: "0.1.0",
      wasm: {
        sha256: hash,
        published_sha256: published,
        match: hash && published ? hash === published : null,
        available: !!hash,
      },
      court_resolver_sha256: resolver.hash,
      court_resolver_note: resolver.note,
      court_config_fetched_at: courtConfig.fetched_at,
      court_config_last_error: courtConfig.last_error,
      court_max_attempts: courtConfig.max_attempts,
      court_min_deposit: courtConfig.min_deposit,
      keeper: {
        enabled: config.keeperEnabled,
        last_tick_at: keeper.lastTickAt,
        last_error: keeper.lastError,
        counts: keeper.counts,
      },
    });
  });

  app.post("/mcp", async (req, res) => {
    const ip = ipOf(req);
    const requestRate = requestLimit.check(ip);
    if (!requestRate.allowed) {
      res.setHeader("Retry-After", String(requestRate.retryAfterSeconds));
      res.status(429).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: {
          code: -32000,
          message: `Rate limited; retry in ${requestRate.retryAfterSeconds}s`,
        },
      });
      return;
    }
    const server = new McpServer({ name: "noacourt-mcp", version: "0.1.0" });
    const register = <S extends z.ZodRawShape>(
      name: string,
      description: string,
      schema: S,
      fn: (args: z.infer<z.ZodObject<S>>) => Promise<ToolOutput>,
    ) =>
      server.registerTool(
        name,
        {
          description,
          inputSchema: schema,
          annotations: {
            readOnlyHint: name !== "market_create_link",
            destructiveHint: false,
            idempotentHint: name !== "market_create_link",
            openWorldHint: [
              "source_sample",
              "spec_simulate",
              "market_status",
              "verdict_get",
            ].includes(name),
          },
        },
        fn as any,
      );
    register(
      "court_guide",
      "Read the complete Noa Court drafting workflow, source rules, verified hosts, and example ResolutionSpec JSON before writing a market.",
      {},
      guard(() => courtGuide()),
    );
    register(
      "catalog_list",
      "List every resolver source tool and whether it returns historical, snapshot, or text evidence.",
      {},
      guard(() =>
        catalog.map(({ name, summary, kind }) => ({ name, summary, kind })),
      ),
    );
    register(
      "catalog_tool",
      "Get one resolver source tool’s full parameter schema, example source object, usage notes, and the default retry/window template.",
      { name: z.string().describe("Catalog tool name") },
      async ({ name }) => {
        const found = catalog.find((item) => item.name === name);
        return found
          ? ok({
              ...found,
              param_json_schema: catalogParamSchemas[name],
              spec_retry_template: { ...DEFAULT_RETRY_POLICY },
              recommended_resolution_window_minutes: 20,
            })
          : failed(
              `Unknown catalog tool ${name}. Valid names: ${catalog.map((item) => item.name).join(", ")}`,
            );
      },
    );
    register(
      "source_sample",
      "Fetch one source now through resolver simulation; show a safe raw JSON excerpt for http_json, GitHub, and candle tools. Uses the simulate rate limit.",
      {
        source: z
          .record(z.unknown())
          .describe("One source object as used in ResolutionSpec.sources"),
        at: z
          .string()
          .optional()
          .describe("Optional UTC sample observation time"),
      },
      async ({ source, at }) => {
        return guard(async () => {
          const observation = at || new Date().toISOString();
          const limit = simulateLimit.check(ip);
          if (!limit.allowed)
            throw new Error(
              `simulate rate limited; retry in ${limit.retryAfterSeconds}s`,
            );
          // Reject unsafe direct targets before any resolver network access.
          const raw = ["http_json", "github_repo"].includes(String(source.tool))
            ? await rawSample(source, deps.rawFetch, deps.rawResolveHost)
            : null;
          const sampled = structuredClone(source) as Record<string, any>;
          sampled.id ||= "sample";
          if (
            sampled.tool === "github_repo" &&
            sampled.expect?.repo_id == null &&
            raw?.suggested_repo_id != null
          )
            sampled.expect = {
              ...sampled.expect,
              repo_id: raw.suggested_repo_id,
            };
          const priceTools = [
            "binance_kline",
            "okx_candle",
            "coinbase_candle",
            "coingecko_price",
          ];
          const price = priceTools.includes(String(sampled.tool));
          const numeric =
            price ||
            ["int", "decimal"].includes(String(sampled.extract?.type)) ||
            (sampled.tool === "github_repo" &&
              typeof sampled.params?.field === "string" &&
              ["stargazers_count", "forks_count", "open_issues_count"].includes(
                sampled.params.field,
              ));
          const sources = [sampled];
          if (price) {
            let fallback: Record<string, any>;
            if (sampled.tool === "binance_kline")
              fallback = {
                id: "sample_fallback",
                tool: "okx_candle",
                params: {
                  instId: String(sampled.params?.symbol || "NEARUSDT").replace(
                    /USDT$/,
                    "-USDT",
                  ),
                  bar: "1m",
                },
              };
            else if (sampled.tool === "okx_candle")
              fallback = {
                id: "sample_fallback",
                tool: "binance_kline",
                params: {
                  symbol: String(sampled.params?.instId || "NEAR-USDT").replace(
                    "-",
                    "",
                  ),
                  interval: "1m",
                },
              };
            else fallback = { ...sampled, id: "sample_fallback" };
            sources.push(fallback);
          }
          const spec = {
            version: 1,
            question: "Sample this source now",
            outcomes: ["Yes", "No"],
            observation: {
              at: observation,
              mode: "first_fetch_after",
              max_delay: "10m",
            },
            sources,
            aggregate: { method: "primary_then_fallback" },
            decide: numeric
              ? { kind: "threshold", op: ">=", value: "0" }
              : {
                  kind: "equals",
                  value: sampled.extract?.type === "bool" ? true : "",
                },
            outcome_map: { true: "Yes", false: "No" },
            on_unavailable: "void",
            retry: { ...DEFAULT_RETRY_POLICY },
          };
          const checked = await lint(spec);
          if (!checked.ok)
            throw new Error(
              `source sample spec lint failed: ${formatLintErrors(checked.errors)}`,
            );
          const result = await simulate(spec, ip, true);
          const verdict = result.verdict as Record<string, any>;
          const candleRaw = [
            "binance_kline",
            "okx_candle",
            "coinbase_candle",
          ].includes(String(sampled.tool))
            ? await rawSample(
                { ...sampled, adapter_url: verdict?.sources?.[0]?.url },
                deps.rawFetch,
                deps.rawResolveHost,
              ).catch((error) => ({
                error: error instanceof Error ? error.message : String(error),
              }))
            : null;
          return {
            source: verdict?.sources?.[0] || null,
            fallback: verdict?.sources?.[1] || null,
            raw: candleRaw ?? raw,
            wasm_sha256: result.wasm_sha256,
            matches_court_resolver: result.matches_court_resolver,
            court_resolver_note: result.court_resolver_note,
          };
        })();
      },
    );
    register(
      "spec_lint",
      "Run light structural prelint and authoritative pinned resolver.wasm lint; report errors and Court hash match.",
      { spec: specSchema },
      async ({ spec }) =>
        guard(async () => {
          const result = await lint(spec);
          if (result.errors.includes("resolver.wasm not available yet"))
            throw new Error(
              `resolver.wasm not available yet; prelint: ${JSON.stringify(result.prelint)}`,
            );
          return result;
        })(),
    );
    register(
      "spec_simulate",
      "Run pinned resolver.wasm against live sources now; return Verdict and “if resolved now” outcome. Text judging spends NEAR AI budget.",
      { spec: specSchema },
      async ({ spec }) => guard(() => simulate(spec, ip))(),
    );
    register(
      "rules_render",
      "Render deterministic human-readable rules, rules_text_hash, canonical RFC 8785 spec_json, and spec_hash.",
      { spec: specSchema, simulated_wasm_sha256: z.string().optional() },
      async ({ spec, simulated_wasm_sha256 }) =>
        guard(() => renderRules(spec, simulated_wasm_sha256))(),
    );
    register(
      "market_create_link",
      "Validate a market and spec, then store a wallet sign URL with a frozen reviewed description and rules (optional description input). This tool sends no transaction and never requests private keys; the user signs later in a wallet.",
      {
        title: z
          .string()
          .max(200)
          .describe("Market question/title, at most 200 characters."),
        outcomes: z
          .array(z.string().max(50))
          .min(2)
          .max(10)
          .describe("Ordered labels; must exactly equal spec.outcomes."),
        stake: z
          .string()
          .describe(
            "Human token amount, usually NPOINT (18 decimals); no yocto conversion needed.",
          ),
        duration_minutes: z
          .number()
          .int()
          .optional()
          .describe(
            "Optional trading duration from link creation, clipped at observation.at; the signer plan recalculates remaining minutes.",
          ),
        duration_days: z
          .number()
          .int()
          .optional()
          .describe(
            "Optional trading duration in days from link creation; do not provide together with duration_minutes.",
          ),
        resolution_window_minutes: z
          .number()
          .int()
          .optional()
          .describe(
            "Optional resolution window; computed from observation.at and retries at signing time. Larger values are allowed.",
          ),
        spec: specSchema.describe(
          "ResolutionSpec v1 object or JSON string; outcomes and observation.at control timing.",
        ),
        creator: z
          .string()
          .optional()
          .describe(
            "Optional creator account hint for display or fee preview; the actual creator is whoever signs.",
          ),
        token_id: z
          .string()
          .optional()
          .describe(
            "Noa-whitelisted token contract; defaults to point.noamarket.testnet (NPOINT).",
          ),
        description: z
          .string()
          .max(4000)
          .optional()
          .describe(
            "Optional plain-text explanation of the final spec for traders (published to Noa as the market description, with the spec-derived rules). It never changes the spec or its hash; omitted = the rendered rules are used. The creator reviews both on the sign page.",
          ),
      },
      async (args) =>
        guard(async () => {
          const requestedAtMs = Date.now();
          const originalSpec = parseSpec(args.spec);
          const rendered = renderRules(originalSpec);
          const spec = parseSpec(rendered.spec_json);
          const configuredAttempts =
            typeof court.maxAttempts === "function"
              ? await court.maxAttempts().catch(() => null)
              : null;
          const checked = await lint(spec);
          if (!checked.ok)
            throw new Error(
              `spec lint failed: ${formatLintErrors(checked.errors)}`,
            );
          if (JSON.stringify(args.outcomes) !== JSON.stringify(spec.outcomes))
            throw new Error(
              "market outcomes must equal spec.outcomes in order",
            );
          if (!args.title.trim() || args.title.length > 200)
            throw new Error("title must be 1–200 characters");
          if (
            args.duration_minutes !== undefined &&
            args.duration_days !== undefined
          )
            throw new Error("provide at most one duration: minutes or days");
          const minutes =
            args.duration_minutes ?? (args.duration_days ?? 0) * 1440;
          if (
            (args.duration_minutes !== undefined ||
              args.duration_days !== undefined) &&
            (minutes < 5 || minutes > 365 * 1440)
          )
            throw new Error("duration must be 5 minutes to 365 days");
          const tokenId = args.token_id ?? config.marketToken;
          let tokenDecimals = 18;
          try {
            const tokens = await rpc.view<
              { token_id: string; decimals: number; is_active: boolean }[]
            >(config.noaContract, "get_whitelisted_tokens", {});
            const token = tokens.find(
              (item) => item.token_id === tokenId && item.is_active,
            );
            if (!token)
              throw new Error(
                `token_id ${tokenId} is not an active Noa-whitelisted token`,
              );
            tokenDecimals = token.decimals;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes("not an active Noa-whitelisted token")
            )
              throw error;
            if (tokenId !== config.marketToken)
              throw new Error(
                "Could not verify token whitelist; only the configured market token is available",
              );
          }
          if (
            !/^\d+(?:\.\d+)?$/.test(args.stake) ||
            BigInt(decimalToUnits(args.stake, tokenDecimals)) <= 0n
          )
            throw new Error(
              `stake must be a positive token amount with at most ${tokenDecimals} decimals`,
            );
          const hashWarnings =
            typeof originalSpec.rules_text_hash === "string" &&
            originalSpec.rules_text_hash !== rendered.rules_text_hash
              ? [
                  "Incoming rules_text_hash differed from deterministic rules; recomputed it.",
                ]
              : [];
          const link = await createSignRequest(
            config,
            store,
            {
              spec_json: rendered.spec_json,
              spec_hash: rendered.spec_hash,
              title: args.title,
              outcomes: args.outcomes,
              stake: args.stake,
              token_id: tokenId,
              token_decimals: tokenDecimals,
              duration_minutes: args.duration_minutes,
              duration_days: args.duration_days,
              resolution_window_minutes: args.resolution_window_minutes,
              court_max_attempts: configuredAttempts ?? undefined,
              creator: args.creator,
              description: args.description,
            },
            requestedAtMs,
          );
          return {
            ...link,
            warnings: [...link.warnings, ...hashWarnings],
            text:
              [...link.warnings, ...hashWarnings].length > 0
                ? [...link.warnings, ...hashWarnings].join("\n")
                : `Sign before ${link.sign_before}; resolution window ${link.summary.resolution_window_minutes} minutes.`,
          };
        })(),
    );
    register(
      "market_status",
      "Read Noa market, pending resolution, Court state and verdict; includes testnet explorer links.",
      {
        market_id: z.number().int().nonnegative(),
        account_id: z
          .string()
          .optional()
          .describe(
            "Optional NEAR account ID for per-outcome shares and claim eligibility.",
          ),
      },
      async ({ market_id, account_id }) =>
        guard(async () => {
          const market = await rpc.view<unknown>(
            config.noaContract,
            "get_market",
            { market_id },
          );
          if (market == null)
            return {
              status: "not_found",
              lifecycle: "not_found",
              now_utc: new Date().toISOString(),
              market_id,
              market: null,
              pending_resolution: null,
              court_market: null,
              verdict: null,
              next_step: `Noa market ${market_id} does not exist; check the market_id and try again.`,
              next_action_at_utc: null,
              eta_utc: null,
            };
          const pending_resolution = await rpc.view<unknown>(
            config.noaContract,
            "get_pending_resolution",
            { market_id },
          );
          const [court_market, verdict] = await Promise.all([
            court.market(market_id),
            court.verdict(`noa:${market_id}`),
          ]);
          const courtItem = court_market as Record<string, any> | null;
          const specEntry = courtItem?.spec_hash
            ? await court.spec(String(courtItem.spec_hash))
            : null;
          let accountPosition: Record<string, unknown> | null = null;
          if (account_id !== undefined) {
            if (!/^[a-z0-9._-]{2,64}$/.test(account_id))
              throw new Error("invalid NEAR account ID");
            const [positions, costBasis] = await Promise.all([
              rpc.view<Record<string, any>[]>(
                config.noaContract,
                "get_user_positions_in_market",
                { account_id, market_id },
              ),
              rpc.view<string | null>(
                config.noaContract,
                "get_user_cost_basis",
                { account_id, market_id },
              ),
            ]);
            const noaMarket = market as Record<string, any>;
            const outcomes = Array.isArray(noaMarket.outcomes)
              ? noaMarket.outcomes
              : [];
            const shares = outcomes.map(
              (outcome: Record<string, any>, index: number) => {
                const outcomeId = Number(outcome.id ?? index);
                const position = positions.find(
                  (entry) => Number(entry.outcome_id) === outcomeId,
                );
                return {
                  outcome_id: outcomeId,
                  name: outcome.name ?? String(outcomeId),
                  shares_fp: String(position?.shares_fp ?? "0"),
                };
              },
            );
            const state = String(noaMarket.status ?? "").toLowerCase();
            const hasEntry = positions.length > 0 || costBasis != null;
            accountPosition = {
              account_id,
              shares_by_outcome: shares,
              cost_basis: costBasis,
              claim_status:
                state === "resolved" || state === "void"
                  ? hasEntry
                    ? "claimable"
                    : "claimed_or_never_held"
                  : state === "active"
                    ? "not_claimable_yet"
                    : "not_claimable",
              claimable_amount: null,
              note: "Noa has no cheap claimable payout or claimed flag view; no remaining position or cost basis can also mean never held.",
            };
          }
          const rejection = history.linkRejection(market_id);
          const signRequest = store.findByMarketId(market_id);
          const publication = signRequest
            ? publicationView(config, signRequest)
            : null;
          return {
            metadata_publication: publication
              ? {
                  state: publication.state,
                  error: publication.error,
                  last_verified_at: publication.last_verified_at,
                  noa_market_url: publication.market_url,
                  sign_url: `${config.publicBaseUrl.replace(/\/$/, "")}/sign/${signRequest!.id}`,
                }
              : null,
            status: marketTopLevelStatus(
              market,
              court_market,
              pending_resolution,
              verdict,
            ),
            now_utc: new Date().toISOString(),
            market: withIso(market),
            pending_resolution: withIso(pending_resolution),
            court_market: withIso(court_market),
            verdict: withIso(annotateReceiptSources(verdict, specEntry)),
            spec: withIso(specEntry),
            account_position: accountPosition,
            link_rejection: rejection,
            actions: history.forItem(`noa:${market_id}`),
            ...(await outlayerInfo(`noa:${market_id}`, verdict)),
            ...lifecycle({
              noa: market as Record<string, any>,
              court: court_market,
              pending: pending_resolution as Record<string, any>,
              rejection,
              spec: specEntry,
              graceSeconds: config.triggerGraceSeconds,
            }),
            links: {
              noa: `https://testnet.nearblocks.io/address/${config.noaContract}`,
              court: `https://testnet.nearblocks.io/address/${config.courtContract}`,
            },
          };
        })(),
    );
    register(
      "verdict_get",
      "Get a stored Court receipt for a Noa market ID or generic request ID, with testnet explorer link.",
      {
        market_id: z.number().int().nonnegative().optional(),
        request_id: z.string().optional(),
      },
      async ({ market_id, request_id }) =>
        guard(async () => {
          const id =
            request_id || (market_id !== undefined ? `noa:${market_id}` : null);
          if (!id) throw new Error("market_id or request_id is required");
          const noa =
            market_id === undefined
              ? null
              : await rpc.view<unknown>(config.noaContract, "get_market", {
                  market_id,
                });
          if (market_id !== undefined && noa == null)
            return {
              status: "not_found",
              lifecycle: "not_found",
              now_utc: new Date().toISOString(),
              request_id: id,
              market_id,
              verdict: null,
              court_market: null,
              next_step: `Noa market ${market_id} does not exist; check the market_id and try again.`,
              next_action_at_utc: null,
              eta_utc: null,
            };
          const courtItem = request_id
            ? await court.request(id)
            : await court.market(market_id!);
          if (request_id && courtItem == null)
            return {
              status: "not_found",
              lifecycle: "not_found",
              now_utc: new Date().toISOString(),
              request_id: id,
              verdict: null,
              court_request: null,
              next_step: `Court request ${id} does not exist; check the request_id and try again.`,
              next_action_at_utc: null,
              eta_utc: null,
            };
          const [verdict, pending] = await Promise.all([
            court.verdict(id),
            market_id === undefined
              ? null
              : rpc.view<unknown>(
                  config.noaContract,
                  "get_pending_resolution",
                  { market_id },
                ),
          ]);
          const item = courtItem as Record<string, any> | null;
          const specEntry = item?.spec_hash
            ? await court.spec(String(item.spec_hash))
            : null;
          const rejection =
            market_id === undefined ? null : history.linkRejection(market_id);
          const phase = lifecycle({
            noa: noa as Record<string, any>,
            court: courtItem,
            pending: pending as Record<string, any>,
            rejection,
            spec: specEntry,
            graceSeconds: config.triggerGraceSeconds,
            genericRequest: request_id !== undefined,
          });
          return {
            request_id: id,
            status:
              market_id === undefined
                ? verdict
                  ? "resolved"
                  : "pending"
                : marketTopLevelStatus(noa, courtItem, pending, verdict),
            now_utc: new Date().toISOString(),
            verdict: withIso(annotateReceiptSources(verdict, specEntry)),
            court_request: request_id ? withIso(courtItem) : null,
            court_market: market_id === undefined ? null : withIso(courtItem),
            spec: withIso(specEntry),
            actions: history.forItem(id),
            ...(await outlayerInfo(id, verdict)),
            ...phase,
            eta_utc: verdict ? null : phase.next_action_at_utc,
            link: `https://testnet.nearblocks.io/address/${config.courtContract}`,
            links: {
              court: `https://testnet.nearblocks.io/address/${config.courtContract}`,
              noa: `https://testnet.nearblocks.io/address/${config.noaContract}`,
            },
          };
        })(),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent)
        res.status(500).json({
          jsonrpc: "2.0",
          id: req.body?.id ?? null,
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : "MCP transport error",
          },
        });
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
  const unsupported = (_req: Request, res: express.Response) =>
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Method not allowed in stateless MCP mode",
      },
    });
  app.get("/mcp", (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Method not allowed in stateless MCP mode",
        data: {
          mcp_endpoint: discovery.mcp_endpoint,
          transport:
            "Send MCP JSON-RPC requests using POST; GET is not supported in stateless mode.",
          start_here: discovery.start_here,
          docs: discovery.docs,
        },
      },
    }),
  );
  app.delete("/mcp", unsupported);
  return {
    app,
    close: () => {
      clearInterval(courtRefreshTimer);
      keeper.stop();
      history.close();
      store.close();
      spend.close();
    },
    keeper,
  };
}
