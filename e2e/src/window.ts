import { requiredResolutionWindowMinutes } from "../../apps/mcp/src/lib.js";

export function resolutionWindowMinutes(
  spec: {
    observation: { at: string };
    retry: { max_attempts: number; every: string };
  },
  baseMinutes: number,
  durationMinutes: number,
  courtMaxAttempts: number,
  nowMs: number,
): number {
  const expirationEstimateAt = new Date(
    nowMs + durationMinutes * 60_000,
  ).toISOString();
  const effectiveAttempts = Math.min(spec.retry.max_attempts, courtMaxAttempts);
  const required = requiredResolutionWindowMinutes(
    spec.observation.at,
    expirationEstimateAt,
    effectiveAttempts,
    spec.retry.every,
  );
  return Math.max(baseMinutes, required + 2);
}
