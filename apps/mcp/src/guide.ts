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
    A10_INTEAR_MC: {
      ...base,
      question: `Will Intear report HOOT market cap at or above USD 1,000,000 on its first valid indexed snapshot after ${observationAt}?`,
      observation: { ...base.observation, mode: "first_fetch_after" },
      sources: [
        {
          id: "intear_hoot_market_cap_usd",
          tool: "http_json",
          request: {
            method: "GET",
            url: "https://api.intea.rs/tokens?ids=hoot-8ecf65.launchpad.justhoot.near&fields=price_usd,market_cap_usd,fdv_usd",
          },
          expect: {
            status: 200,
            as_of: "$.timestamp_millis",
            assert: [
              '$.columns[0] == "account_id"',
              '$.columns[1] == "price_usd"',
              '$.columns[2] == "market_cap_usd"',
              '$.columns[3] == "fdv_usd"',
              "$.total == 1",
              "$.missing == []",
              '$.rows[0][0] == "hoot-8ecf65.launchpad.justhoot.near"',
              "$.rows[0][1] > 0",
            ],
          },
          identity: "asserted",
          extract: {
            path: "$.rows[0][2]",
            type: "decimal",
            allow_index: true,
            index_reason:
              "Intear documents rows in requested column order; assertions pin the column names, single row, and token account ID.",
          },
          sanity: { min: 0 },
        },
      ],
      aggregate: { method: "primary_then_fallback" },
      decide: { kind: "threshold", op: ">=", value: "1000000" },
    },
    A11_JUSTHOOT_PRICE: {
      ...base,
      question: `Will JustHoot report HOOT price at or above USD 0.001 on its first valid snapshot after ${observationAt}?`,
      observation: { ...base.observation, mode: "first_fetch_after" },
      sources: [
        {
          id: "justhoot_hoot_price_usd",
          tool: "http_json",
          request: {
            method: "GET",
            url: "https://api.justhoot.fun/api/tokens/hoot-8ecf65.launchpad.justhoot.near",
          },
          expect: {
            status: 200,
            assert: [
              '$.token.id == "hoot-8ecf65.launchpad.justhoot.near"',
              "$.price_usd > 0",
            ],
          },
          identity: "asserted",
          extract: { path: "$.price_usd", type: "decimal" },
          sanity: { min: 0 },
        },
      ],
      aggregate: { method: "primary_then_fallback" },
      decide: { kind: "threshold", op: ">=", value: "0.001" },
    },
  };
}

export const examples = makeExamples();

export type GuideContext = {
  baseUrl?: string;
  network?: string;
  courtContract?: string;
  noaContract?: string;
  token?: string;
};

export function courtGuide(ctx: GuideContext = {}): string {
  const text = renderGuide();
  const base = (ctx.baseUrl || "https://noacourtmcp.junstudio.xyz").replace(
    /\/+$/,
    "",
  );
  const network = ctx.network || "testnet";
  const header = `Network: ${network}${ctx.courtContract ? `. Court contract ${ctx.courtContract}` : ""}${ctx.noaContract ? `, Noa contract ${ctx.noaContract}` : ""}${ctx.token ? `, default token ${ctx.token}` : ""}. ${network === "mainnet" ? "This is NEAR mainnet: markets, stakes and fees use real funds." : "This is NEAR testnet: markets and tokens have no real value."}\n\n`;
  return text
    .replaceAll("https://noacourtmcp.junstudio.xyz", base)
    .replace("now_utc:", `${header}now_utc:`);
}

function renderGuide(): string {
  const currentExamples = makeExamples();
  return `# Noa Court drafting guide

now_utc: ${new Date().toISOString()}.

Flow: lint → simulate → rules_render → (pick token and stake: list_whitelisted_tokens) → write noa_rules (required) → market_create_link → user signs in their wallet. The creator chooses the market token (\`token_id\`, any active Noa-whitelisted token, default NPOINT) and a custom stake, which is the market liquidity, in that token's units; call \`list_whitelisted_tokens\` (with \`outcome_count\`) first to see tokens, decimals and the minimum stake, because a stake below the minimum is rejected. The server never needs a creator private key. \`market_create_link\` takes \`noa_rules\` (REQUIRED step in this workflow: the human-readable resolution rules traders read on Noa; see "Noa rules" below) and an optional \`description\` (one or two plain sentences of context for traders; do not repeat the rules). Neither changes the spec or its hash. The sign page shows the Noa rules first, then the binding canonical rules, the spec hash and a metadata digest for the creator to review, freezes them, and, when the deployment has Noa publication configured, asks the creator to sign a Noa login (NEP-413) before the create transactions and publishes description + rules to Noa afterwards (write-once; \`market_status.metadata_publication\` reports the state). Write the Noa rules to agree with the spec; if they contradict it, create a new link instead. The sign link states a sign-before time, and its plan is recalculated when the user signs. Integration: docs/ARCHITECTURE.md §5–§7.

Documentation: https://noacourtmcp.junstudio.xyz/docs/README.md (overview), https://noacourtmcp.junstudio.xyz/docs/MCP.md (MCP setup), https://noacourtmcp.junstudio.xyz/docs/SPEC.md (specification), https://noacourtmcp.junstudio.xyz/docs/ARCHITECTURE.md (architecture), https://noacourtmcp.junstudio.xyz/docs/INTEGRATE.md (integration), https://noacourtmcp.junstudio.xyz/docs/NEAR_TOKENS.md (NEAR token recipes), https://noacourtmcp.junstudio.xyz/docs/SKILL.md (agent skill).

## Noa rules (required: write \`noa_rules\` for every market)
Noa shows the published rules to traders as plain text (no markdown rendering). Before calling \`market_create_link\`, write \`noa_rules\` in this exact format and show it to the creator:

Resolves Yes if the NEAR/USDT 1-minute candle close at 19:28 UTC on 14 Nov 2026 is ≥ 3.10; otherwise No.

Source: Binance NEARUSDT 1m close. OKX NEAR-USDT is the fallback, used only if Binance has no valid price.
If no valid price is available after 5 attempts (every 3 min), the market is voided and all bets are refunded.

Rules for the text: plain sentences only; no markdown (no # headings, no backticks), no JSON, no braces or square brackets. Name every outcome label exactly as in \`outcomes\`. Give the exact observation time in UTC with the date (HH:MM UTC on D Mon YYYY). State the threshold or bucket edges and the comparison in words or with ≥ ≤ > <. Describe the sources in plain words (exchange, pair, interval) and say which is primary and which is the fallback. Write a tolerance such as "must agree within 0.5%" only when \`aggregate.method\` is \`all_agree\`; for \`primary_then_fallback\` the fallback is used only when the primary has no valid value, and for \`median\` say the median is used. State the retry count and interval. If \`on_unavailable\` is \`void\`, say the market is voided and bets are refunded (required: validation fails without it); if it is an outcome name, say the market resolves to that outcome. For \`text_judge\`, say three AI jurors must all agree. Keep it 40 to 1200 characters. Do NOT write the footer: the server appends "Resolved by Noa Court in an OutLayer TEE. Spec sha256:<hash>" and "Full rules: <this server>/spec/<hash>". The binding rules stay the spec-derived canonical rules (their hash is in the spec); the Noa text is a faithful summary of them, and the sign page shows both. If you omit \`noa_rules\`, the server generates the same format from the spec, but you should still write it yourself and check it against the spec. Hard validation errors and soft warnings (missing time, threshold or comparison wording) are returned by \`market_create_link\`; fix warnings before sending the link.

\`description\` is optional: one or two plain sentences of context (what the market is about), never a repeat of the rules.

## Drafting rules
1. Find an official or first-party source first.
2. Call the real endpoint with source_sample, show the creator a sample response, and explain the chosen fields.
3. Choose JSONPath by key; avoid positional indexes.
4. Include an identity assert, preferably an immutable ID, or declare identity: "url_only".
5. Declare freshness using as_of, a {T} variable, or the first fetch after T.
6. Declare the extracted type and decimals.
7. Use explicit decide boundaries; outcome_map must cover missing/null through on_unavailable.
8. For dedicated price candle adapters, include two sources. For NEAR token price, market cap USD, or FDV USD through http_json, Single-source Intear or JustHoot is the default. Suggest a two-source median only when metric, unit, token identity, and supply definitions are equivalent and the creator chooses it. JustHoot does not expose FDV in the verified response.
9. Simulate and show “if resolved now → X”.

## http_json contract
request: {method: GET|POST, url: HTTPS URL, headers?: {}, auth?: {secret: sealed-secret-name, header: name}}; expect: {status: 200, assert: ['$.id == "expected"'], as_of?: "$.updated_at"}; identity: asserted|url_only; extract: {path: RFC 9535 JSONPath, agg?: null, type: int|decimal|bool|string|timestamp, decimals: 0}; sanity?: {min, max_change_vs_preflight}. Assert string literals use JSON double quotes. Resolve checks status → JSON → asserts → as_of → exactly one typed extract → sanity → decide. No guessing. No positional indexes unless API documentation guarantees order.

Source labels: verified for the allowlist; every other host is “self-declared, may be controlled by the creator”. Verified hosts: ${verifiedHosts.join(", ")}.

Catalog: ${catalog.map((tool) => `${tool.name} (${tool.kind}: ${tool.summary})`).join("; ")}.

Decide kinds: threshold (>=, >, <=, <), buckets (half-open [lower, upper)), equals, bool, change (up/down/tie), text_judge (yes/no with criteria, window, and default_if_no_evidence set to the lowercase result key "yes" or "no"). Lint checks: observation after market close, bucket coverage, snapshot max_delay, two sources for dedicated price adapters, http_json identity, GitHub repo_id identity, outcome_map coverage, change baseline before observation, 2–10 outcomes.

NEAR token snapshots: use full token contract account ID, not ticker. Intear /tokens is columnar: pin columns, one row, and account ID; extract an indexed row value only with allow_index and index_reason. Intear timestamp_millis can serve as as_of to reject an indexed snapshot before observation.at. Both providers must report positive price before accepting market cap or FDV. JustHoot last_trade_at is trade time, not response time. A snapshot market asks for the first valid value after T, never whether a metric was ever reached before T. On missing/unpriced data, retry then void under on_unavailable. Read docs/NEAR_TOKENS.md before drafting.

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
