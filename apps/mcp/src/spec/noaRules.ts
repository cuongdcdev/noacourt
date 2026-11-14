import { sourceHost } from "../catalog.js";
import { parseSpec } from "./canonical.js";
import { DEFAULT_RETRY_POLICY } from "./defaults.js";

/** Renderer/format version recorded in the snapshot for human-readable Noa rules. */
export const NOA_RULES_VERSION = "noa-rules-v1";
export const NOA_RULES_MIN = 40;
export const NOA_RULES_MAX = 1200;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type Spec = Record<string, any>;

/** "19:28 UTC on 14 Nov 2026" (seconds only when nonzero). */
export function formatUtcHuman(iso: unknown): string {
  const date = new Date(String(iso));
  if (Number.isNaN(+date)) return String(iso ?? "the stated time");
  const pad = (n: number) => String(n).padStart(2, "0");
  const seconds = date.getUTCSeconds();
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${seconds ? `:${pad(seconds)}` : ""} UTC on ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function duration(text: unknown): string {
  const match = /^(\d+)\s*([smhd])$/.exec(String(text ?? ""));
  if (!match) return String(text ?? "");
  const n = Number(match[1]);
  const unit = { s: "sec", m: "min", h: "hour", d: "day" }[match[2]]!;
  return `${n} ${unit}${n !== 1 && (unit === "hour" || unit === "day") ? "s" : ""}`;
}

const INTERVAL_WORDS: Record<string, string> = {
  "1m": "1-minute",
  "3m": "3-minute",
  "5m": "5-minute",
  "15m": "15-minute",
  "30m": "30-minute",
  "1h": "1-hour",
  "1H": "1-hour",
  "4h": "4-hour",
  "4H": "4-hour",
  "1d": "1-day",
  "1D": "1-day",
};
const GRANULARITY: Record<string, string> = {
  "60": "1m",
  "300": "5m",
  "900": "15m",
  "3600": "1h",
  "21600": "6h",
  "86400": "1d",
};
const CANDLE_TOOLS = ["binance_kline", "okx_candle", "coinbase_candle"];

function splitPair(symbol: string): string {
  for (const quote of ["FDUSD", "USDT", "USDC", "BUSD", "USD", "EUR", "BTC", "ETH"])
    if (symbol.endsWith(quote) && symbol.length > quote.length)
      return `${symbol.slice(0, -quote.length)}/${quote}`;
  return symbol;
}
function candleInfo(source: Spec) {
  const p = source.params ?? {};
  const field = p.field === "open" ? "open" : "close";
  if (source.tool === "binance_kline") {
    const symbol = String(p.symbol ?? "");
    return {
      venue: "Binance",
      market: symbol,
      pair: splitPair(symbol),
      interval: String(p.interval ?? "1m"),
      field,
    };
  }
  if (source.tool === "okx_candle") {
    const instId = String(p.instId ?? "");
    return {
      venue: "OKX",
      market: instId,
      pair: instId.replace("-", "/"),
      interval: String(p.bar ?? "1m"),
      field,
    };
  }
  const product = String(p.product_id ?? "");
  return {
    venue: "Coinbase",
    market: product,
    pair: product.replace("-", "/"),
    interval: GRANULARITY[String(p.granularity ?? "60")] ?? "1m",
    field,
  };
}

/** A short plain-words description of where a source's value comes from. */
export function sourcePhrase(source: Spec): string {
  const p = source.params ?? {};
  if (CANDLE_TOOLS.includes(source.tool)) {
    const c = candleInfo(source);
    return `${c.venue} ${c.market} ${c.interval} ${c.field}`;
  }
  const host = sourceHost(source);
  switch (source.tool) {
    case "coingecko_price":
      return `CoinGecko ${p.id}/${p.vs} price`;
    case "near_view":
      return `NEAR ${p.network} contract ${p.contract}, method ${p.method}`;
    case "github_repo":
      return `GitHub repository ${p.owner}/${p.repo} (${p.field})`;
    case "http_json":
      return `JSON data from ${host ?? "the declared URL"}`;
    case "rss_feed":
      return `RSS/Atom feed at ${host ?? "the declared URL"}`;
    case "web_text":
      return `web page at ${host ?? "the declared URL"}`;
    default:
      return String(source.id ?? source.tool ?? "the declared source");
  }
}

function shortName(source: Spec): string {
  return CANDLE_TOOLS.includes(source.tool)
    ? candleInfo(source).venue
    : sourcePhrase(source);
}

function subjectOf(spec: Spec): string {
  const sources: Spec[] = spec.sources ?? [];
  const candle = sources.find((s) => CANDLE_TOOLS.includes(s.tool));
  if (candle) {
    const c = candleInfo(candle);
    return `${c.pair} ${INTERVAL_WORDS[c.interval] ?? c.interval} candle ${c.field}`;
  }
  if (sources.length === 1)
    return `value reported by ${sourcePhrase(sources[0])}`;
  return "value reported by the sources below";
}

function noun(spec: Spec): string {
  if (spec.decide?.kind === "text_judge") return "verdict";
  const sources: Spec[] = spec.sources ?? [];
  return sources.some(
    (s) => CANDLE_TOOLS.includes(s.tool) || s.tool === "coingecko_price",
  )
    ? "price"
    : "value";
}

const OP_SYMBOL: Record<string, string> = {
  ">=": "≥",
  ">": ">",
  "<=": "≤",
  "<": "<",
  "==": "=",
};

/** Deterministic plain-text Noa rules body (no footer) from a ResolutionSpec. */
export function renderNoaRules(input: unknown): string {
  const spec = parseSpec(input);
  const outcomes: string[] = spec.outcomes ?? [];
  const map: Record<string, string> = spec.outcome_map ?? {};
  const out = (key: string, index: number) =>
    map[key] ?? outcomes[index] ?? key;
  const decide = spec.decide ?? {};
  const at = formatUtcHuman(spec.observation?.at);
  const sources: Spec[] = spec.sources ?? [];
  const when =
    spec.observation?.mode === "first_fetch_after" &&
    !sources.every((s) => CANDLE_TOOLS.includes(s.tool))
      ? `in the first valid reading after ${at}`
      : `at ${at}`;
  const subject = subjectOf(spec);
  const retry = { ...DEFAULT_RETRY_POLICY, ...(spec.retry ?? {}) };
  const extra: string[] = [];
  let first: string;
  switch (decide.kind) {
    case "threshold": {
      const op = OP_SYMBOL[decide.op] ?? String(decide.op);
      first = `Resolves ${out("true", 0)} if the ${subject} ${when} is ${op} ${decide.value}; otherwise ${out("false", 1)}.`;
      break;
    }
    case "buckets": {
      const edges: string[] = decide.edges ?? [];
      const parts = [
        `${out("0", 0)} if it is below ${edges[0]}`,
        ...edges
          .slice(1)
          .map(
            (edge, i) =>
              `${out(String(i + 1), i + 1)} if it is ${edges[i]} or more but below ${edge}`,
          ),
        `${out(String(edges.length), edges.length)} if it is ${edges[edges.length - 1]} or more`,
      ];
      first = `The ${subject} ${when} decides the outcome: ${parts.join("; ")}.`;
      break;
    }
    case "equals":
      first = `Resolves ${out("true", 0)} if the ${subject} ${when} equals ${decide.value}; otherwise ${out("false", 1)}.`;
      break;
    case "bool":
      first = `Resolves ${out("true", 0)} if the ${subject} ${when} is true; otherwise ${out("false", 1)}.`;
      break;
    case "change": {
      const base = formatUtcHuman(spec.observation?.baseline_at);
      first = `Compares the ${subject} ${when} with its value at ${base}. Resolves ${out("up", 0)} if it is higher, ${out("down", 1)} if it is lower, and ${out("tie", 2)} if it is unchanged.`;
      break;
    }
    case "text_judge": {
      const yes = out("yes", 0);
      const no = out("no", 1);
      const window = decide.window
        ? ` published between ${formatUtcHuman(decide.window.from)} and ${formatUtcHuman(decide.window.to)}`
        : "";
      const fallback = out(String(decide.default_if_no_evidence ?? "no"), 1);
      first = `Resolves ${yes} if three AI jurors all agree (each at least 70% confident, quoting the evidence) that: ${decide.question} Resolves ${no} if all three agree it did not happen. The jurors read only evidence${window}; if there is none, the result is ${fallback}. If the jurors disagree or are unsure, the check is retried.`;
      const yesC: string[] = decide.yes_criteria ?? [];
      const noC: string[] = decide.no_criteria ?? [];
      if (yesC.length) extra.push(`Counts as ${yes}: ${yesC.join("; ")}.`);
      if (noC.length) extra.push(`Counts as ${no}: ${noC.join("; ")}.`);
      break;
    }
    default:
      first = `Resolves ${outcomes.join(" or ")} according to the full rules linked below.`;
  }

  const method = spec.aggregate?.method;
  const tol = spec.aggregate?.tolerance;
  const phrases = sources.map(sourcePhrase);
  const list = (items: string[]) =>
    items.length <= 2
      ? items.join(" and ")
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  let source: string;
  if (sources.length === 0) source = "Source: as declared in the full rules.";
  else if (sources.length === 1)
    source = `${decide.kind === "text_judge" ? "Evidence" : "Source"}: ${phrases[0]}.`;
  else if (method === "median")
    source = `Sources: ${list(phrases)}. The median is used (at least half of the sources must respond).`;
  else if (method === "all_agree")
    source = `Sources: ${list(phrases)}. All must respond and agree${tol ? ` within ${tol}` : " exactly"}; otherwise the attempt fails and is retried.`;
  else
    source = `Source: ${phrases[0]}. ${list(phrases.slice(1))} ${phrases.length > 2 ? "are fallbacks, used in order" : "is the fallback"}, used only if ${shortName(sources[0])} has no valid ${noun(spec)}.`;

  const tail =
    spec.on_unavailable === "void"
      ? "the market is voided and all bets are refunded."
      : `the market resolves ${spec.on_unavailable}.`;
  const retryLine = `If no valid ${noun(spec)} is available after ${retry.max_attempts} attempt${retry.max_attempts === 1 ? "" : "s"} (every ${duration(retry.every)}), ${tail}`;

  const body = [first, "", source, ...extra, retryLine].join("\n");
  if (body.length <= NOA_RULES_MAX) return body;
  // Too long: drop the optional criteria lines; the canonical rules are linked in the footer.
  return [first, "", source, retryLine].join("\n").slice(0, NOA_RULES_MAX);
}

/** Server-owned footer. The agent never writes it. */
export function noaRulesFooter(
  specHash: string,
  publicBaseUrl: string,
): string {
  const hex = specHash.replace(/^sha256:/, "");
  return `Resolved by Noa Court in an OutLayer TEE. Spec sha256:${hex}\nFull rules: ${publicBaseUrl.replace(/\/+$/, "")}/spec/${hex}`;
}
export function composeNoaRules(
  body: string,
  specHash: string,
  publicBaseUrl: string,
): string {
  return `${body.trim()}\n\n${noaRulesFooter(specHash, publicBaseUrl)}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Short labels such as "No" must match case-sensitively, or the word "no" in any sentence would satisfy them.
const wordRe = (label: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(label)}(?![\\p{L}\\p{N}])`,
    label.length > 3 ? "iu" : "u",
  );

// Comparison wording, checked in this order; each match is removed before the next check.
const INCL_HIGH =
  "≥|>=|at least|greater than or equal|or (?:above|higher|more|over)|no less than|not (?:below|under|less)|\\bminimum";
const INCL_LOW =
  "≤|<=|at most|less than or equal|or (?:below|lower|less|under)|no more than|not (?:above|over|more)|\\bmaximum";
const STRICT_HIGH =
  "(?<![<>=])>(?!=)|\\b(?:above|greater than|more than|higher than|exceeds?|over)\\b";
const STRICT_LOW =
  "(?<![<>=])<(?!=)|\\b(?:below|less than|lower than|under|fewer than)\\b";

function comparisonWords(text: string): Record<string, boolean> {
  let rest = text;
  const found: Record<string, boolean> = {};
  for (const [op, source] of [
    [">=", INCL_HIGH],
    ["<=", INCL_LOW],
    [">", STRICT_HIGH],
    ["<", STRICT_LOW],
  ] as const) {
    found[op] = new RegExp(source, "i").test(rest);
    rest = rest.replace(new RegExp(source, "gi"), " ");
  }
  return found;
}

export type NoaRulesCheck = { text: string; warnings: string[] };

/** Validate agent-written Noa rules. Throws a clear Error on hard failures; returns soft warnings. */
export function validateNoaRules(
  raw: string,
  specInput: unknown,
): NoaRulesCheck {
  const spec = parseSpec(specInput);
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length < NOA_RULES_MIN || text.length > NOA_RULES_MAX)
    throw new Error(
      `noa_rules must be ${NOA_RULES_MIN}-${NOA_RULES_MAX} characters of plain text (got ${text.length})`,
    );
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    throw new Error("noa_rules must not contain control characters");
  if (/^\s*#/m.test(text))
    throw new Error(
      "noa_rules must be plain text: remove lines starting with # (no markdown headings)",
    );
  if (/[{}[\]]/.test(text))
    throw new Error(
      "noa_rules must be plain sentences: remove braces { } and square brackets [ ] (no JSON)",
    );
  if (text.includes("`"))
    throw new Error("noa_rules must be plain text: remove backticks");
  if (
    /^\s*(?:Resolved by Noa Court|Full rules:)/im.test(text) ||
    /sha256:/i.test(text)
  )
    throw new Error(
      "noa_rules must not contain the footer (Resolved by Noa Court / Spec sha256 / Full rules): the server appends it",
    );
  const missing = ((spec.outcomes ?? []) as string[]).filter(
    (label) => !wordRe(label).test(text),
  );
  if (missing.length)
    throw new Error(
      `noa_rules must name every outcome label; missing: ${missing.map((m) => `"${m}"`).join(", ")}`,
    );
  if (spec.on_unavailable === "void" && !/void|refund/i.test(text))
    throw new Error(
      "noa_rules must say what happens when no valid result is available: this spec voids the market, so say that it is voided and bets are refunded",
    );

  const warnings: string[] = [];
  const observed = new Date(String(spec.observation?.at));
  if (!Number.isNaN(+observed)) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const hhmm = `${pad(observed.getUTCHours())}:${pad(observed.getUTCMinutes())}`;
    if (!text.includes(hhmm) || !/UTC/i.test(text))
      warnings.push(
        `noa_rules does not state the observation time (${hhmm} UTC); traders need the exact time.`,
      );
    const day = observed.getUTCDate();
    const month = observed.getUTCMonth();
    const name = `(?:${MONTHS[month]}|${MONTHS_FULL[month]})`;
    const dateOk =
      text.includes(observed.toISOString().slice(0, 10)) ||
      new RegExp(
        `\\b${day}(?:st|nd|rd|th)?\\s+${name}\\b|\\b${name}\\s+${day}\\b`,
        "i",
      ).test(text);
    if (!dateOk)
      warnings.push(
        `noa_rules does not state the observation date (${day} ${MONTHS[month]} ${observed.getUTCFullYear()}).`,
      );
  }
  const decide = spec.decide ?? {};
  const numbers = [
    ...text.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/\d+(?:\.\d+)?/g),
  ].map((x) => Number(x[0]));
  const mentions = (value: unknown) => numbers.includes(Number(value));
  if (decide.kind === "threshold") {
    if (!mentions(decide.value))
      warnings.push(`noa_rules does not mention the threshold ${decide.value}.`);
    const found = comparisonWords(text);
    if (decide.op in found && !found[decide.op])
      warnings.push(
        `noa_rules wording may not match the spec comparison "${decide.op}" ${decide.value} (expected words such as ${{ ">=": '"at least" or ≥', ">": '"above" or >', "<=": '"at most" or ≤', "<": '"below" or <' }[decide.op as string]}); check for a contradiction.`,
      );
  }
  if (decide.kind === "buckets") {
    const gone = ((decide.edges ?? []) as string[]).filter((e) => !mentions(e));
    if (gone.length)
      warnings.push(
        `noa_rules does not mention bucket edge(s): ${gone.join(", ")}.`,
      );
  }
  if (spec.on_unavailable !== "void" && /void|refund/i.test(text))
    warnings.push(
      `noa_rules mentions void/refund but the spec resolves "${spec.on_unavailable}" when no result is available.`,
    );
  return { text, warnings };
}
