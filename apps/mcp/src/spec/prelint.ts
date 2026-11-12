import { parseSpec } from "./canonical.js";

export type Prelint = { ok: boolean; errors: string[]; warnings: string[] };
export function prelint(input: unknown): Prelint {
  const errors: string[] = [];
  let spec: Record<string, any>;
  try {
    spec = parseSpec(input);
  } catch (error) {
    return { ok: false, errors: [(error as Error).message], warnings: [] };
  }
  if (spec.version !== 1) errors.push("version must be 1");
  if (typeof spec.question !== "string" || !spec.question.trim())
    errors.push("question is required");
  if (
    !Array.isArray(spec.outcomes) ||
    spec.outcomes.length < 2 ||
    spec.outcomes.length > 10 ||
    spec.outcomes.some(
      (v: unknown) => typeof v !== "string" || !v.trim() || v.length > 50,
    )
  )
    errors.push(
      "outcomes must contain 2–10 nonempty strings of at most 50 characters",
    );
  if (
    !spec.observation ||
    typeof spec.observation.at !== "string" ||
    Number.isNaN(Date.parse(spec.observation.at))
  )
    errors.push("observation.at must be a valid date");
  if (!Array.isArray(spec.sources) || spec.sources.length === 0)
    errors.push("sources must be a nonempty array");
  if (!spec.aggregate || typeof spec.aggregate.method !== "string")
    errors.push("aggregate.method is required");
  if (!spec.decide || typeof spec.decide.kind !== "string")
    errors.push("decide.kind is required");
  if (!spec.outcome_map || typeof spec.outcome_map !== "object")
    errors.push("outcome_map is required");
  if (spec.on_unavailable === undefined)
    errors.push("on_unavailable is required");
  if (
    !spec.retry ||
    !Number.isInteger(spec.retry.max_attempts) ||
    typeof spec.retry.every !== "string"
  )
    errors.push("retry.max_attempts and retry.every are required");
  return { ok: errors.length === 0, errors, warnings: [] };
}
