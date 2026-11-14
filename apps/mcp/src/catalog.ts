export type CatalogEntry = {
  name: string;
  summary: string;
  kind: "historical" | "snapshot" | "evidence";
  params: Record<string, unknown>;
  example: Record<string, unknown>;
  notes: string;
};
export const verifiedHosts = [
  "data-api.binance.vision",
  "api.binance.com",
  "www.okx.com",
  "okx.com",
  "api.exchange.coinbase.com",
  "api.coinbase.com",
  "api.coingecko.com",
  "api.github.com",
  "rpc.testnet.near.org",
  "rpc.mainnet.near.org",
  "archival-rpc.mainnet.near.org",
  "free.rpc.fastnear.com",
  "rpc.mainnet.fastnear.com",
  "test.rpc.fastnear.com",
  "archival-rpc.testnet.fastnear.com",
  "near-testnet.lava.build",
  "near.lava.build",
];
export const catalog: CatalogEntry[] = [
  {
    name: "binance_kline",
    summary: "Binance candle close or open at observation time",
    kind: "historical",
    params: {
      symbol: "string",
      interval: "1m",
      field: "close|open (optional)",
    },
    example: {
      id: "binance",
      tool: "binance_kline",
      params: { symbol: "NEARUSDT", interval: "1m" },
    },
    notes:
      "Minute candle containing observation.at; data-api then api.binance.com. Geo blocking may occur.",
  },
  {
    name: "okx_candle",
    summary: "OKX historical candle fallback",
    kind: "historical",
    params: { instId: "string", bar: "1m" },
    example: {
      id: "okx",
      tool: "okx_candle",
      params: { instId: "NEAR-USDT", bar: "1m" },
    },
    notes: "Use as price market fallback.",
  },
  {
    name: "coinbase_candle",
    summary: "Coinbase historical candle",
    kind: "historical",
    params: { product_id: "string", granularity: 60 },
    example: {
      id: "coinbase",
      tool: "coinbase_candle",
      params: { product_id: "NEAR-USD", granularity: 60 },
    },
    notes: "USD quote; do not treat as USDT without explaining.",
  },
  {
    name: "coingecko_price",
    summary: "CoinGecko day-level price",
    kind: "snapshot",
    params: { id: "string", vs: "string" },
    example: {
      id: "coingecko",
      tool: "coingecko_price",
      params: { id: "near", vs: "usd" },
    },
    notes: "Free API has no reliable minute granularity.",
  },
  {
    name: "near_view",
    summary: "NEAR contract view through agreeing RPCs",
    kind: "snapshot",
    params: {
      network: "testnet",
      contract: "string",
      method: "string",
      args: {},
      rpcs: ["at least two URLs"],
    },
    example: {
      id: "balance",
      tool: "near_view",
      params: {
        network: "testnet",
        contract: "point.noamarket.testnet",
        method: "ft_balance_of",
        args: { account_id: "user3.noamarket.testnet" },
        rpcs: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
      },
      extract: { type: "decimal", decimals: 18 },
    },
    notes: "Use first_fetch_after when an historical block cannot be queried.",
  },
  {
    name: "github_repo",
    summary: "GitHub repository snapshot",
    kind: "snapshot",
    params: {
      owner: "string",
      repo: "string",
      field: "stargazers_count|forks_count|open_issues_count|...",
    },
    example: {
      id: "repo",
      tool: "github_repo",
      params: { owner: "near", repo: "nearcore", field: "stargazers_count" },
      expect: { repo_id: 123456789 },
    },
    notes:
      "expect.repo_id is required and must match the numeric immutable GitHub repository ID. Replace the example placeholder with the live ID from source_sample.",
  },
  {
    name: "http_json",
    summary: "GET or POST JSON with status, identity and JSONPath checks",
    kind: "snapshot",
    params: {
      request: {
        method: "GET|POST",
        url: "https://...",
        headers: {},
        auth: { secret: "sealed secret name", header: "header name" },
      },
      expect: {
        status: 200,
        assert: ['$.id == "expected"'],
        as_of: "$.updated_at",
      },
      identity: "asserted|url_only",
      extract: {
        path: "$.data.value",
        type: "int|decimal|bool|string|timestamp",
        decimals: 0,
        allow_index: false,
        index_reason:
          "required when the documented response needs positional indexes",
      },
      sanity: { min: 0 },
    },
    example: {
      id: "score",
      tool: "http_json",
      request: { method: "GET", url: "https://example.com/score.json" },
      expect: { status: 200, assert: ['$.id == "noa-test-1"'] },
      identity: "asserted",
      extract: { path: "$.score", type: "int", decimals: 0 },
    },
    notes:
      "RFC 9535 JSONPath by key. Positional extraction requires allow_index and index_reason plus assertions that pin the documented array shape. No OAuth or pagination in v1.",
  },
  {
    name: "rss_feed",
    summary: "RSS, Atom or JSON Feed evidence",
    kind: "evidence",
    params: { url: "https://...", filter: "optional item filter" },
    example: {
      id: "feed",
      tool: "rss_feed",
      params: { url: "https://example.com/feed.xml" },
    },
    notes: "For text_judge; only declared URLs are evidence.",
  },
  {
    name: "web_text",
    summary: "Static web page text evidence",
    kind: "evidence",
    params: { url: "https://..." },
    example: {
      id: "page",
      tool: "web_text",
      params: { url: "https://example.com/news" },
    },
    notes: "Scripts and tags stripped; dynamic pages may be unavailable.",
  },
];

export function sourceHost(source: Record<string, any>): string | null {
  const url =
    source.request?.url ||
    source.params?.request?.url ||
    source.params?.url ||
    source.url ||
    (source.tool === "github_repo" ? "https://api.github.com" : null) ||
    (source.tool === "binance_kline"
      ? "https://data-api.binance.vision"
      : null) ||
    (source.tool === "okx_candle" ? "https://www.okx.com" : null) ||
    (source.tool === "coinbase_candle"
      ? "https://api.exchange.coinbase.com"
      : null) ||
    (source.tool === "coingecko_price" ? "https://api.coingecko.com" : null) ||
    (source.tool === "near_view"
      ? source.params?.rpcs?.[0] || "https://rpc.mainnet.near.org"
      : null);
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
export function sourceLabel(source: Record<string, any>): string {
  return verifiedHosts.includes(sourceHost(source) || "")
    ? "verified"
    : "self-declared, may be controlled by the creator";
}

export function effectiveExtract(source: Record<string, any>): {
  path: string;
  type: string;
  decimals: number | string;
} {
  const tool = source.tool;
  if (["binance_kline", "okx_candle", "coinbase_candle"].includes(tool))
    return {
      path: `adapter candle ${source.params?.field === "open" ? "open" : "close"}`,
      type: "decimal",
      decimals: 0,
    };
  if (tool === "coingecko_price")
    return { path: "adapter price", type: "decimal", decimals: 0 };
  if (tool === "github_repo")
    return {
      path: `adapter field ${source.params?.field ?? "unknown"}`,
      type: "from response field",
      decimals: 0,
    };
  if (tool === "rss_feed" || tool === "web_text")
    return { path: "adapter text evidence", type: "string", decimals: 0 };
  return {
    path: source.extract?.path ?? "adapter response root",
    type: source.extract?.type ?? "derived from response",
    decimals: source.extract?.decimals ?? 0,
  };
}

const string = { type: "string" };
const object = { type: "object", additionalProperties: true };
const url = { type: "string", format: "uri", pattern: "^https://" };
const schema = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const catalogParamSchemas: Record<string, ReturnType<typeof schema>> = {
  binance_kline: schema(
    {
      symbol: string,
      interval: { const: "1m" },
      field: { enum: ["close", "open"] },
    },
    ["symbol"],
  ),
  okx_candle: schema({ instId: string, bar: { const: "1m" } }, ["instId"]),
  coinbase_candle: schema(
    {
      product_id: string,
      granularity: { type: "integer", const: 60 },
    },
    ["product_id"],
  ),
  coingecko_price: schema({ id: string, vs: string }),
  near_view: schema(
    {
      network: { enum: ["testnet", "mainnet"] },
      contract: string,
      method: string,
      args: object,
      rpcs: { type: "array", items: url, minItems: 2 },
    },
    ["network", "contract", "method", "args"],
  ),
  github_repo: schema({ owner: string, repo: string, field: string }),
  http_json: schema(
    {
      request: schema(
        {
          method: { enum: ["GET", "POST"] },
          url,
          headers: { type: "object", additionalProperties: { type: "string" } },
          auth: schema({ secret: string, header: string }),
        },
        ["url"],
      ),
      expect: schema(
        {
          status: { type: "integer" },
          assert: { type: "array", items: string },
          as_of: string,
        },
        [],
      ),
      identity: { enum: ["asserted", "url_only"] },
      extract: schema(
        {
          path: string,
          agg: { type: ["string", "null"] },
          type: { enum: ["int", "decimal", "bool", "string", "timestamp"] },
          decimals: { type: "integer", minimum: 0 },
          allow_index: { type: "boolean" },
          index_reason: string,
        },
        ["path", "type"],
      ),
      sanity: schema(
        { min: { type: "number" }, max_change_vs_preflight: string },
        [],
      ),
    },
    ["request", "extract"],
  ),
  rss_feed: schema({ url, filter: string }, ["url"]),
  web_text: schema({ url }),
};
