import { effectiveExtract, sourceLabel } from "../catalog.js";
import { jcs, parseSpec, sha256 } from "./canonical.js";

const operatorWords: Record<string, string> = {
  ">=": "greater than or equal",
  ">": "greater than",
  "<=": "less than or equal",
  "<": "less than",
};
const print = (value: unknown) =>
  value === undefined
    ? "not specified"
    : typeof value === "string"
      ? value
      : jcs(value);

export function renderRules(input: unknown, simulatedSha?: string | null) {
  const spec = parseSpec(input);
  delete spec.rules_text_hash;
  const lines = [
    `# ${print(spec.question)}`,
    "",
    `Outcomes: ${print(spec.outcomes)}`,
    `Observation: ${print(spec.observation?.at)} UTC; mode ${print(spec.observation?.mode)}; max_delay ${print(spec.observation?.max_delay)}; baseline_at ${print(spec.observation?.baseline_at)}`,
    "",
    "## Sources",
  ];
  for (const source of spec.sources || []) {
    const extract = effectiveExtract(source);
    lines.push(
      `- ${print(source.id)}: ${print(source.tool)}; ${sourceLabel(source)}.`,
    );
    lines.push(`  Endpoint/params: ${print(source.request || source.params)}.`);
    lines.push(
      `  Extract: path ${print(extract.path)}, type ${print(extract.type)}, decimals ${print(extract.decimals)}.`,
    );
    lines.push(
      `  Identity asserts: ${print(source.expect?.assert || [])}; ${source.identity === "url_only" ? "identity is based on the URL only" : `identity ${print(source.identity)}`}.`,
    );
    lines.push(
      `  Freshness: ${print(source.expect?.as_of)}; status ${print(source.expect?.status)}.`,
    );
  }
  lines.push(
    "",
    `Aggregate: ${print(spec.aggregate?.method)}; tolerance ${print(spec.aggregate?.tolerance)}.`,
    "## Decision",
  );
  const decide = spec.decide || {};
  if (decide.kind === "threshold")
    lines.push(
      `Yes if value ${print(decide.op)} ${print(decide.value)} (${operatorWords[decide.op] || "unknown operator"}).`,
    );
  else if (decide.kind === "buckets")
    lines.push(
      `Buckets: edges ${print(decide.edges)}; half-open intervals [lower, upper), lower inclusive and upper exclusive; first and last buckets extend to infinity.`,
    );
  else if (decide.kind === "text_judge")
    lines.push(
      `Text judge: ${print(decide.question)}; yes criteria ${print(decide.yes_criteria)}; no criteria ${print(decide.no_criteria)}; window ${print(decide.window)}; default if no evidence ${print(decide.default_if_no_evidence)}.`,
    );
  else lines.push(`${print(decide.kind)}: ${print(decide)}.`);
  lines.push(
    `Outcome map: ${print(spec.outcome_map)}.`,
    `On unavailable (including missing/null): ${print(spec.on_unavailable)}.`,
    `Retry: ${print(spec.retry)}.`,
    `Simulated with resolver sha256 ${simulatedSha || "unknown"}: ${simulatedSha ? "yes" : "no"}`,
  );
  const rules_markdown = lines.join("\n") + "\n";
  const rules_text_hash = sha256(rules_markdown);
  spec.rules_text_hash = rules_text_hash;
  const spec_json = jcs(spec);
  return {
    rules_markdown,
    rules_text_hash,
    spec_json,
    spec_hash: sha256(spec_json),
  };
}
