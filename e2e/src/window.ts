import { requiredResolutionWindowMinutes } from "../../apps/mcp/src/lib.js";

export function resolutionWindowMinutes(
  spec: { observation: { at: string } },
  baseMinutes: number,
  durationMinutes: number,
  courtMaxAttempts: number,
  nowMs: number,
): number {
  const required = requiredResolutionWindowMinutes(spec, courtMaxAttempts);
  const estimatedExpiration = nowMs + durationMinutes * 60_000;
  const gap = Math.max(
    0,
    Math.ceil((Date.parse(spec.observation.at) - estimatedExpiration) / 60_000),
  );
  return Math.max(baseMinutes, required + gap + 1);
}
