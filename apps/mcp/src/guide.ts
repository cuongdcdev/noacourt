import { catalog, verifiedHosts } from "./catalog.js";
import { DEFAULT_RETRY_POLICY } from "./spec/defaults.js";

function utcMinute(timeMs: number): string {
  return new Date(timeMs).toISOString().replace(".000Z", "Z");
}

export function makeExamples(now: Date = new Date()) {
  const nextMinuteMs = Math.ceil(now.getTime() / 60_000) * 60_000;
  const observationAt = utcMinute(nextMinuteMs + 10 * 60_000);
  const windowFrom = utcMinute(nextMinuteMs);
  const base = {
    version: 1,
    question: `Will the NEAR/USDT 1-minute close at ${observationAt} be at least 3.40?`,
    outcomes: ["Yes", "No"],
    observation: {
      at: observationAt,
      baseline_at: null,
      mode: "historical",
      max_delay: "30m",
    },
    sources: [] as unknown[],
    aggregate: { method: "primary_then_fallback", tolerance: "0.5%" },
    decide: { kind: "threshold", op: ">=", value: "3.40" },
    outcome_map: { true: "Yes", false: "No" },
    on_unavailable: "void",
    retry: { ...DEFAULT_RETRY_POLICY },
  };
  return {
    A1: {
      ...base,
      question: `Will the NEAR/USDT 1-minute close at ${observationAt} be at least 3.40?`,
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
      question: `Which bucket contains the BTC/USDT 1-minute close at ${observationAt}: below 99,900, from 99,900 to below 100,100, or at least 100,100?`,
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
      decide: {
        kind: "buckets",
        edges: ["99900", "100100"],
        inclusive: "lower",
      },
      outcome_map: { 0: "Below", 1: "Middle", 2: "Above" },
    },
    A6: {
      ...base,
      question: `Is the published JSON score at least 50 at ${observationAt}?`,
      observation: { ...base.observation, mode: "first_fetch_after" },
      sources: [
        {
          id: "score",
          tool: "http_json",
          request: {
            method: "GET",
            url: "https://gist.githubusercontent.com/replace-with-your-owner/replace-with-your-gist-id/raw/score.json",
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
      question: `Did the publisher announce that Noa Court v2 shipped by ${observationAt}?`,
      observation: { ...base.observation, mode: "first_fetch_after" },
      sources: [
        {
          id: "feed",
          tool: "rss_feed",
          params: {
            url: "https://gist.githubusercontent.com/replace-with-your-owner/replace-with-your-gist-id/raw/feed.xml",
          },
        },
      ],
      decide: {
        kind: "text_judge",
        question: "Did the publisher announce that Noa Court v2 shipped?",
        yes_criteria: [
          "A dated feed item explicitly says Noa Court v2 shipped",
        ],
        no_criteria: ["Rumors, plans, and unrelated releases"],
        default_if_no_evidence: "no",
        window: { from: windowFrom, to: observationAt },
      },
      outcome_map: { yes: "Yes", no: "No" },
      on_unavailable: "No",
    },
  };
}

export const examples = makeExamples();

export function courtGuide(): string {
  const currentExamples = makeExamples();
  return `# Noa Court drafting guide

now_utc: ${new Date().toISOString()}.

Flow: lint → simulate → rules_render → market_create_link → user signs in their wallet. The server never needs a creator private key. The sign link states a sign-before time, and its plan is recalculated when the user signs. Integration: docs/ARCHITECTURE.md §5–§7.

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

Default retry policy: max_attempts 5, every 3m. The Court deadline floor is observation.at + 5 × 3m + 5m = 20 minutes after observation. The sign plan computes the window from its estimated market expiration to that deadline, with 2 extra minutes of margin. A shorter requested window is raised with a warning by market_create_link. Sign before the deadline on the sign page; a late plan is refused.

Noa constraints: 2–10 outcomes; title at most 200 characters; outcome at most 50 characters; market duration at least 5 minutes; resolution window at least 10 minutes and large enough for retries; market.expiration must be <= spec.observation.at. Market token ${"point.noamarket.testnet"} is NPOINT with 18 decimals.

## Example ResolutionSpec v1 JSON
The UTC observation time in each example is generated when this guide is requested (the next whole minute plus 10 minutes); the RSS judging window begins at the next whole minute. Replace these times with the creator's real market times. The A6 and A8 Gist URLs are examples: replace them with your own source URLs. Choose the actual prices and thresholds, then simulate before creating a market.
${Object.entries(currentExamples)
  .map(
    ([name, spec]) =>
      `### ${name}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
  )
  .join("\n\n")}`;
}
