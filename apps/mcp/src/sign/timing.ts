export class SignPlanConflictError extends Error {
  readonly status = 409;
}

function parseTime(value: string, name: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be a UTC time`);
  return result;
}

export function signBeforeAt(
  observationAt: string,
  requestedCloseAt: string,
  marginMinutes: number,
): string {
  const observation = parseTime(observationAt, "observation.at");
  const close = Math.min(
    parseTime(requestedCloseAt, "requested_close_at"),
    observation,
  );
  const marginMs = marginMinutes * 60_000;
  const nearObservation = observation - close <= marginMs;
  const latest = Math.min(
    observation - (5 + marginMinutes) * 60_000,
    close - (5 * 60_000 + (nearObservation ? marginMs : 0)),
  );
  return new Date(latest).toISOString();
}

export function calculateSignTiming(input: {
  observation_at: string;
  requested_close_at: string;
  now_ms: number;
  sign_margin_minutes: number;
}): {
  duration_minutes: number;
  expiration_estimate_at: string;
  close_at: string;
  sign_before: string;
  clipped: boolean;
} {
  const observation = parseTime(input.observation_at, "observation.at");
  const requested = parseTime(input.requested_close_at, "requested_close_at");
  const close = Math.min(requested, observation);
  const marginMs = input.sign_margin_minutes * 60_000;
  const nearObservation = observation - close <= marginMs;
  const signBefore = signBeforeAt(
    input.observation_at,
    input.requested_close_at,
    input.sign_margin_minutes,
  );
  if (input.now_ms >= Date.parse(signBefore))
    throw new SignPlanConflictError(`Signing deadline passed at ${signBefore}`);
  const duration =
    Math.floor((close - input.now_ms) / 60_000) -
    (nearObservation ? input.sign_margin_minutes : 0);
  if (duration < 5)
    throw new SignPlanConflictError(
      "At least 5 minutes of trading must remain before observation; create a new sign link",
    );
  if (input.now_ms + duration * 60_000 > observation)
    throw new SignPlanConflictError(
      "Trading close would be after observation.at; create a new sign link",
    );
  return {
    duration_minutes: duration,
    expiration_estimate_at: new Date(
      input.now_ms + duration * 60_000,
    ).toISOString(),
    close_at: new Date(close).toISOString(),
    sign_before: signBefore,
    clipped: requested > observation,
  };
}
