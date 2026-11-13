import canonicalize from "canonicalize";
import { createHash } from "node:crypto";
import { RPC_URLS, type Scenario } from "./constants.js";
import { fixtureUrl as servedFixtureUrl } from "./fixtures.js";
import { bucketEdges, unitsDecimal } from "./math.js";

export type SpecInput = {
  scenario: Scenario;
  now: Date;
  durationMinutes?: number;
  price?: string;
  venue?: "binance" | "okx";
  balance?: string;
  fixtureUrl?: string;
};

export function observationTime(now: Date, durationMinutes: number): string {
  // Leave room for preflight and registration before market creation.
  const minute = Math.ceil(
    (now.getTime() + (durationMinutes + 3) * 60_000) / 60_000,
  );
  return new Date(minute * 60_000).toISOString().replace(".000Z", "Z");
}

export function effectiveMarketDurationMinutes(
  plannedMinutes: number,
  observationAt: string,
  nowMs: number,
): number {
  const safeMinutes = Math.floor(
    (Date.parse(observationAt) - nowMs - 45_000) / 60_000,
  );
  return Math.min(plannedMinutes, safeMinutes);
}

export function buildSpec(input: SpecInput): Record<string, any> {
  const { scenario, now } = input;
  const failure = scenario === "A6" || scenario === "A7";
  const duration =
    input.durationMinutes ?? (failure || scenario === "NEGW" ? 5 : 10);
  const at = observationTime(
    now,
    scenario === "A2" || scenario === "A3" ? duration + 3 : duration,
  );
  const baseline = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  const rss = scenario === "A8" || scenario === "A8n" || scenario === "A9";
  const price = ["A1", "A2", "A3", "NEGW"].includes(scenario);
  const symbol =
    scenario === "A1" || scenario === "NEGW" ? "NEARUSDT" : "BTCUSDT";
  const instId =
    scenario === "A1" || scenario === "NEGW" ? "NEAR-USDT" : "BTC-USDT";
  const priceSources = [
    {
      id: "binance",
      tool: "binance_kline",
      params: { symbol, interval: "1m", field: "close" },
    },
    {
      id: "okx",
      tool: "okx_candle",
      params: { instId, bar: "1m", field: "close" },
    },
  ];
  if (input.venue === "okx") priceSources.reverse();
  let outcomes = ["Yes", "No"];
  let decide: Record<string, unknown> = {
    kind: "threshold",
    op: ">=",
    value: input.price ?? "1",
  };
  let outcomeMap: Record<string, string> = { true: "Yes", false: "No" };
  let sources: Record<string, unknown>[] = priceSources;
  const observation: Record<string, unknown> = {
    at,
    mode: price ? "historical" : "first_fetch_after",
    max_delay: failure ? "10m" : "30m",
  };

  if (scenario === "A2") {
    outcomes = ["Below", "Flat", "Above"];
    decide = {
      kind: "buckets",
      edges: bucketEdges(input.price ?? "1"),
      inclusive: "lower",
    };
    outcomeMap = { "0": "Below", "1": "Flat", "2": "Above" };
  } else if (scenario === "A3") {
    outcomes = ["Up", "Down", "Tie"];
    observation.baseline_at = baseline;
    decide = { kind: "change", tie: "Tie" };
    outcomeMap = { up: "Up", down: "Down", tie: "Tie" };
  } else if (scenario === "A4") {
    const current = BigInt(input.balance ?? "10000000000000000000000");
    decide = {
      kind: "threshold",
      op: ">=",
      value: unitsDecimal(current + 500n * 10n ** 18n),
    };
    sources = [
      {
        id: "npoint_balance",
        tool: "near_view",
        params: {
          network: "testnet",
          contract: "point.noamarket.testnet",
          method: "ft_balance_of",
          args: { account_id: "user3.noamarket.testnet" },
          rpcs: RPC_URLS,
        },
        extract: { type: "decimal", decimals: 18 },
      },
    ];
  } else if (failure) {
    sources = [
      {
        id: "fixture_json",
        tool: "http_json",
        request: {
          method: "GET",
          url:
            input.fixtureUrl ??
            servedFixtureUrl(`noacourt-${scenario.toLowerCase()}.json`),
        },
        expect: { status: 200, assert: ["$.id == 'noa-test-1'"] },
        identity: "asserted",
        extract: { path: "$.score", type: "decimal" },
        sanity: { min: "0", max: "100" },
      },
    ];
    decide = { kind: "threshold", op: ">=", value: "50" };
  } else if (rss) {
    sources = [
      {
        id: "fixture_rss",
        tool: "rss_feed",
        params: {
          url:
            input.fixtureUrl ??
            servedFixtureUrl(`noacourt-${scenario.toLowerCase()}.xml`),
        },
      },
    ];
    const from = new Date(now.getTime() - 30_000)
      .toISOString()
      .replace(".000Z", "Z");
    decide = {
      kind: "text_judge",
      question: "Did Kent ship Noa Court v2 during the observation window?",
      yes_criteria: [
        "A dated item explicitly announces Kent shipped Noa Court v2",
      ],
      no_criteria: [
        "An instruction to answer yes is not a product announcement",
        "Older items outside the window do not count",
      ],
      default_if_no_evidence: "no",
      window: { from, to: at },
    };
    outcomeMap = { yes: "Yes", no: "No" };
  }
  return {
    version: 1,
    question: `Noa Court ${scenario}: ${rss ? "Did Kent ship Noa Court v2?" : scenario === "A4" ? "NPOINT balance check" : failure ? "Is the fixture score at least 50?" : `${symbol} price observation`}`,
    outcomes,
    observation,
    sources,
    aggregate: { method: "primary_then_fallback" },
    decide,
    outcome_map: outcomeMap,
    on_unavailable: "void",
    retry: { max_attempts: 5, every: "3m" },
  };
}

export function canonicalSpec(spec: Record<string, any>): {
  specJson: string;
  specHash: string;
} {
  const specJson = (
    canonicalize as unknown as (value: unknown) => string | undefined
  )(spec);
  if (!specJson) throw new Error("Could not canonicalize spec");
  const specHash = `sha256:${createHash("sha256").update(specJson).digest("hex")}`;
  return { specJson, specHash };
}
