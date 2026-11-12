import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export function parseSpec(value: unknown): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("spec is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("spec must be a JSON object");
  return structuredClone(parsed) as Record<string, any>;
}
export function jcs(value: unknown): string {
  const result = (
    canonicalize as unknown as (value: unknown) => string | undefined
  )(value);
  if (result === undefined) throw new Error("spec is not valid JSON");
  return result;
}
export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
