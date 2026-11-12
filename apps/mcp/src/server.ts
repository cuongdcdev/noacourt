import express, { type Request } from "express";
import { resolve } from "node:path";
import QRCode from "qrcode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { catalog, catalogParamSchemas } from "./catalog.js";
import { courtGuide } from "./guide.js";
import { NearRpc } from "./near/rpc.js";
import { CourtClient } from "./court/client.js";
import { WasmRunner } from "./resolver/wasm.js";
import { RateLimiter, SpendCounter } from "./ratelimit.js";
import { jcs, parseSpec } from "./spec/canonical.js";
import { prelint } from "./spec/prelint.js";
import { renderRules } from "./spec/render.js";
import { rawSample } from "./source.js";
import { SignStore } from "./sign/store.js";
import { decimalToUnits } from "./sign/txBuilder.js";
import {
  completeSignRequest,
  createSignRequest,
  planForAccount,
  publicRequest,
} from "./sign/service.js";
import { signPage } from "./sign/page/html.js";
import { KeeperSigner } from "./near/signer.js";
import { KeeperLoop } from "./keeper/loop.js";

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

export type ServerDeps = {
  rpc?: NearRpc;
  court?: CourtClient;
  wasm?: WasmRunner;
  spend?: SpendCounter;
  rawFetch?: typeof fetch;
  signer?: Pick<KeeperSigner, "send">;
  store?: SignStore;
};
export function createApp(config: Config, deps: ServerDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const rpc = deps.rpc || new NearRpc(config);
  const court = deps.court || new CourtClient(config, rpc);
  const wasm = deps.wasm || new WasmRunner(config);
  const spend = deps.spend || new SpendCounter(config);
  const store = deps.store || new SignStore(config);
  const signer = deps.signer || new KeeperSigner(config, rpc);
  const signDeps = { config, store, rpc, court, signer };
  const keeper = new KeeperLoop({ config, rpc, court, signer, wasm, spend });
  const requestLimit = new RateLimiter(config.rateLimitPerMin);
  const simulateLimit = new RateLimiter(config.simulateLimitPerMin);

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
    const request = store.get(req.params.id);
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
        res.status(410).json({ error: request.status });
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
      res.status(400).json({ error: (error as Error).message });
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
    const hashes = await match();
    const outcome = (verdict as Record<string, any>)?.outcome;
    return {
      verdict,
      ...hashes,
      note: `if resolved now → ${outcome ?? "unavailable"}`,
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
    res.json({
      ok: true,
      version: "0.1.0",
      wasm: {
        path: config.resolverWasm,
        sha256: hash,
        published_sha256: published,
        matches_published_resolver:
          hash && published ? hash === published : null,
        available: !!hash,
      },
      court_resolver_sha256: resolver.hash,
      court_resolver_note: resolver.note,
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
        { description, inputSchema: schema },
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
      "Get one resolver source tool’s full parameter schema, example source object, and usage notes.",
      { name: z.string().describe("Catalog tool name") },
      async ({ name }) => {
        const found = catalog.find((item) => item.name === name);
        return found
          ? ok({ ...found, param_json_schema: catalogParamSchemas[name] })
          : failed(
              `Unknown catalog tool ${name}. Valid names: ${catalog.map((item) => item.name).join(", ")}`,
            );
      },
    );
    register(
      "source_sample",
      "Fetch one source now through resolver simulation; for http_json/GitHub also show a safe raw JSON excerpt, identity asserts, and numeric JSONPaths. Uses the simulate rate limit.",
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
            ? await rawSample(source, deps.rawFetch)
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
            retry: { max_attempts: 1, every: "1m" },
          };
          const checked = await lint(spec);
          if (!checked.ok)
            throw new Error(
              `source sample spec lint failed: ${formatLintErrors(checked.errors)}`,
            );
          const result = await simulate(spec, ip, true);
          const verdict = result.verdict as Record<string, any>;
          return {
            source: verdict?.sources?.[0] || null,
            fallback: verdict?.sources?.[1] || null,
            raw,
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
      "Validate a market and spec, then create a wallet sign URL; never requests or accepts private keys.",
      {
        title: z.string().max(200),
        outcomes: z.array(z.string().max(50)).min(2).max(10),
        stake: z.string().describe("Human NPOINT amount; 18 decimals"),
        duration_minutes: z.number().int().optional(),
        duration_days: z.number().int().optional(),
        resolution_window_minutes: z.number().int().optional(),
        spec: specSchema,
        creator: z.string().optional(),
      },
      async (args) =>
        guard(async () => {
          const checked = await lint(args.spec);
          if (!checked.ok)
            throw new Error(
              `spec lint failed: ${formatLintErrors(checked.errors)}`,
            );
          const spec = parseSpec(args.spec);
          if (JSON.stringify(args.outcomes) !== JSON.stringify(spec.outcomes))
            throw new Error(
              "market outcomes must equal spec.outcomes in order",
            );
          if (!args.title.trim() || args.title.length > 200)
            throw new Error("title must be 1–200 characters");
          if (
            (args.duration_minutes === undefined) ===
            (args.duration_days === undefined)
          )
            throw new Error("provide exactly one duration: minutes or days");
          const minutes =
            args.duration_minutes ?? (args.duration_days || 0) * 1440;
          if (minutes < 5 || minutes > 365 * 1440)
            throw new Error("duration must be 5 minutes to 365 days");
          if ((args.resolution_window_minutes ?? 10) < 10)
            throw new Error("resolution window must be at least 10 minutes");
          if (Date.now() + minutes * 60_000 > Date.parse(spec.observation.at))
            throw new Error("market expiration must be <= spec.observation.at");
          if (
            !/^\d+(?:\.\d{1,18})?$/.test(args.stake) ||
            BigInt(decimalToUnits(args.stake, 18)) <= 0n
          )
            throw new Error(
              "stake must be a positive NPOINT amount with at most 18 decimals",
            );
          const rendered = renderRules(args.spec);
          return createSignRequest(config, store, {
            spec_json: rendered.spec_json,
            spec_hash: rendered.spec_hash,
            title: args.title,
            outcomes: args.outcomes,
            stake: args.stake,
            token_id: config.marketToken,
            token_decimals: 18,
            duration_minutes: args.duration_minutes,
            duration_days: args.duration_days,
            resolution_window_minutes: args.resolution_window_minutes,
            creator: args.creator,
          });
        })(),
    );
    register(
      "market_status",
      "Read Noa market, pending resolution, Court state and verdict; includes testnet explorer links.",
      { market_id: z.number().int().nonnegative() },
      async ({ market_id }) =>
        guard(async () => {
          const market = await rpc.view<unknown>(
            config.noaContract,
            "get_market",
            { market_id },
          );
          if (!market) throw new Error(`Noa market ${market_id} not found`);
          const pending_resolution = await rpc.view<unknown>(
            config.noaContract,
            "get_pending_resolution",
            { market_id },
          );
          const [court_market, verdict] = await Promise.all([
            court.market(market_id),
            court.verdict(`noa:${market_id}`),
          ]);
          return {
            market,
            pending_resolution,
            court_market,
            verdict,
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
          const verdict = await court.verdict(id);
          if (!verdict) throw new Error(`Court verdict ${id} not found`);
          return {
            request_id: id,
            verdict,
            court_request: request_id ? await court.request(request_id) : null,
            link: `https://testnet.nearblocks.io/address/${config.courtContract}`,
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
  app.get("/mcp", unsupported);
  app.delete("/mcp", unsupported);
  return {
    app,
    close: () => {
      keeper.stop();
      store.close();
      spend.close();
    },
    keeper,
  };
}
