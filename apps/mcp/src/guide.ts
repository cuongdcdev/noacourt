import { catalog, verifiedHosts } from "./catalog.js";

const base = {
  version: 1,
  question: "PLACEHOLDER: replace question and UTC time before use",
  outcomes: ["Yes", "No"],
  observation: {
    at: "2026-12-01T12:00:00Z",
    baseline_at: null,
    mode: "historical",
    max_delay: "30m",
  },
  sources: [] as unknown[],
  aggregate: { method: "primary_then_fallback", tolerance: "0.5%" },
  decide: { kind: "threshold", op: ">=", value: "3.40" },
  outcome_map: { true: "Yes", false: "No" },
  on_unavailable: "void",
  retry: { max_attempts: 3, every: "5m" },
};
export const examples = {
  A1: {
    ...base,
    question: "PLACEHOLDER: Will NEAR/USDT 1m close at T be at least 3.40?",
    sources: [
      {
        id: "binance",
        tool: "binance_kline",
        params: { symbol: "NEARUSDT", interval: "1m" },
      },
      {
        id: "okx",
        tool: "okx_candle",
        params: { instId: "NEAR-USDT", bar: "1m" },
      },
    ],
  },
  A2: {
    ...base,
    question: "PLACEHOLDER: Which BTC/USDT bucket contains the 1m close at T?",
    outcomes: ["Below", "Middle", "Above"],
    sources: [
      {
        id: "binance",
        tool: "binance_kline",
        params: { symbol: "BTCUSDT", interval: "1m" },
      },
      {
        id: "okx",
        tool: "okx_candle",
        params: { instId: "BTC-USDT", bar: "1m" },
      },
    ],
    decide: { kind: "buckets", edges: ["99900", "100100"], inclusive: "lower" },
    outcome_map: { 0: "Below", 1: "Middle", 2: "Above" },
  },
  A6: {
    ...base,
    question: "PLACEHOLDER: Is the published score at least 50?",
    observation: { ...base.observation, mode: "first_fetch_after" },
    sources: [
      {
        id: "score",
        tool: "http_json",
        request: {
          method: "GET",
          url: "https://gist.githubusercontent.com/REPLACE/score.json",
        },
        expect: { status: 200, assert: ['$.id == "noa-test-1"'] },
        identity: "asserted",
        extract: { path: "$.score", type: "int", decimals: 0 },
      },
    ],
    decide: { kind: "threshold", op: ">=", value: "50" },
  },
  A8: {
    ...base,
    question: "PLACEHOLDER: Did Kent publish the specified announcement by T?",
    observation: { ...base.observation, mode: "first_fetch_after" },
    sources: [
      {
        id: "feed",
        tool: "rss_feed",
        params: { url: "https://example.com/REPLACE/feed.xml" },
      },
    ],
    decide: {
      kind: "text_judge",
      question: "Did Kent publish Noa Court v2?",
      yes_criteria: [
        "A dated feed item explicitly says Kent shipped Noa Court v2",
      ],
      no_criteria: ["Rumors, plans, and unrelated releases"],
      default_if_no_evidence: "no",
      window: { from: "2026-12-01T11:00:00Z", to: "2026-12-01T12:00:00Z" },
    },
    outcome_map: { yes: "Yes", no: "No" },
    on_unavailable: "No",
  },
};

export function courtGuide(): string {
  return `# Noa Court drafting guide

Flow: lint → simulate → rules_render → market_create_link → user signs in their wallet. The server never needs a creator private key. Integration: docs/ARCHITECTURE.md §5–§7.

## Drafting rules
1. Find an official or first-party source first.
2. Call the real endpoint with source_sample, show the creator a sample response, and explain the chosen fields.
3. Choose JSONPath by key; avoid positional indexes.
4. Include an identity assert, preferably an immutable ID, or declare identity: "url_only".
5. Declare freshness using as_of, a {T} variable, or the first fetch after T.
6. Declare the extracted type and decimals.
7. Use explicit decide boundaries; outcome_map must cover missing/null through on_unavailable.
8. Include a fallback source; it is mandatory for price markets.
9. Simulate and show “if resolved now → X”.

## http_json contract
request: {method: GET|POST, url: HTTPS URL, headers?: {}, auth?: {secret: sealed-secret-name, header: name}}; expect: {status: 200, assert: ['$.id == "expected"'], as_of?: "$.updated_at"}; identity: asserted|url_only; extract: {path: RFC 9535 JSONPath, agg?: null, type: int|decimal|bool|string|timestamp, decimals: 0}; sanity?: {min, max_change_vs_preflight}. Assert string literals use JSON double quotes. Resolve checks status → JSON → asserts → as_of → exactly one typed extract → sanity → decide. No guessing. No positional indexes unless API documentation guarantees order.

Source labels: verified for the allowlist; every other host is “self-declared, may be controlled by the creator”. Verified hosts: ${verifiedHosts.join(", ")}.

Catalog: ${catalog.map((tool) => `${tool.name} (${tool.kind}: ${tool.summary})`).join("; ")}.

Decide kinds: threshold (>=, >, <=, <), buckets (half-open [lower, upper)), equals, bool, change (up/down/tie), text_judge (yes/no with criteria, window, and default_if_no_evidence set to the lowercase result key "yes" or "no"). Lint checks: observation after market close, bucket coverage, snapshot max_delay, two price sources, http_json identity, GitHub repo_id identity, outcome_map coverage, change baseline before observation, 2–10 outcomes.

Noa constraints: 2–10 outcomes; title at most 200 characters; outcome at most 50 characters; market duration at least 5 minutes; resolution window at least 10 minutes; market.expiration must be <= spec.observation.at. Market token ${"point.noamarket.testnet"} is NPOINT with 18 decimals.

## Example ResolutionSpec v1 JSON
All dates, prices, URLs and thresholds below are placeholders. Replace them with real values and simulate before creating a market.
${Object.entries(examples)
  .map(
    ([name, spec]) =>
      `### ${name}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
  )
  .join("\n\n")}`;
}
