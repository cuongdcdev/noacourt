import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

const root = resolve(import.meta.dirname, "../../..");
dotenv.config({ path: resolve(root, ".env"), quiet: true });

const env = (name: string, fallback: string) => process.env[name] || fallback;
const number = (name: string, fallback: number) => {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
};
const positiveNumber = (name: string, fallback: number) => {
  const value = number(name, fallback);
  if (value <= 0) throw new Error(`Invalid ${name}`);
  return value;
};
const nonnegativeInteger = (name: string, fallback: number) => {
  const value = number(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`Invalid ${name}`);
  return value;
};
const wasmCandidates = [
  resolve(root, "target/wasm32-wasip2/release/resolver.wasm"),
  resolve(root, "resolver/target/wasm32-wasip2/release/resolver.wasm"),
];

export function loadConfig() {
  return {
    port: number("PORT", 3310),
    host: env("HOST", "127.0.0.1"),
    publicBaseUrl: env("PUBLIC_BASE_URL", "https://noacourtmcp.junstudio.xyz"),
    nearNetwork: env("NEAR_NETWORK", "testnet"),
    nearRpcUrls: env(
      "NEAR_RPC_URLS",
      "https://test.rpc.fastnear.com,https://rpc.testnet.near.org,https://archival-rpc.testnet.fastnear.com",
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    courtContract: env("COURT_CONTRACT", "ai-resolver.noamarket.testnet"),
    noaContract: env("NOA_CONTRACT", "v3.noamarket.testnet"),
    marketToken: env("MARKET_TOKEN", "point.noamarket.testnet"),
    keeperAccount: env("KEEPER_ACCOUNT", "court-ops.noamarket.testnet"),
    keeperCredentials: env(
      "KEEPER_CREDENTIALS",
      "/root/.near-credentials/testnet/court-ops.noamarket.testnet.json",
    ),
    resolverWasm: env(
      "RESOLVER_WASM",
      wasmCandidates.find(existsSync) || wasmCandidates[0],
    ),
    publishedWasmHashFile: resolve(root, "resolver/WASM_SHA256"),
    wasmtimeBin: env(
      "WASMTIME_BIN",
      existsSync("/root/.wasmtime/bin/wasmtime")
        ? "/root/.wasmtime/bin/wasmtime"
        : "wasmtime",
    ),
    wasmTimeoutMs: number("WASM_TIMEOUT_MS", 60000),
    nearAiApi: process.env.NEAR_AI_API,
    nearAiSpendCapUsd: number("NEAR_AI_SPEND_CAP_USD", 5),
    nearAiCostPerSimulateUsd: number("NEAR_AI_COST_PER_SIMULATE_USD", 0.05),
    rateLimitPerMin: number("RATE_LIMIT_PER_MIN", 60),
    simulateLimitPerMin: number("SIMULATE_LIMIT_PER_MIN", 10),
    dataDir: resolve(env("DATA_DIR", resolve(root, "apps/mcp/data"))),
    courtTrustedKeeper: env("COURT_TRUSTED_KEEPER", "0") === "1",
    keeperIntervalMs: number("KEEPER_INTERVAL_MS", 30000),
    txPollTimeoutMs: positiveNumber("TX_POLL_TIMEOUT_MS", 90000),
    txPollIntervalMs: positiveNumber("TX_POLL_INTERVAL_MS", 2500),
    courtConfigRefreshMs: positiveNumber("COURT_CONFIG_REFRESH_MS", 60000),
    signMarginMinutes: nonnegativeInteger("SIGN_MARGIN_MINUTES", 3),
    triggerGraceSeconds: number("TRIGGER_GRACE_SECONDS", 70),
    keeperEnabled: env("KEEPER_ENABLED", "1") === "1",
    // Noa metadata publication (see sign/publication.ts). Empty = not configured.
    noaApiUrl: process.env.NOA_API_URL?.trim() || "",
    noaAuthRecipient: process.env.NOA_AUTH_RECIPIENT?.trim() || "",
    noaMarketUrlBase: process.env.NOA_MARKET_URL_BASE?.trim() || "",
    publicationVerifyPerMin: number("PUBLICATION_VERIFY_PER_MIN", 12),
  };
}

export type Config = ReturnType<typeof loadConfig>;
