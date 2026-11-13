export function marketTooLate(
  market: { status?: string; expiration_time?: string } | null,
  nowMs: number,
): boolean {
  if (!market) throw new Error("Noa market view is missing");
  const expiration = Number(
    BigInt(String(market.expiration_time ?? "0")) / 1_000_000n,
  );
  return (
    market.status !== "Active" ||
    (expiration > 0 && expiration <= nowMs + 45_000)
  );
}

export function specTimingDecision(input: {
  observationAt: string;
  nowMs: number;
  durationMinutes: number;
  registration?: { confirmedAt?: string };
}): "keep" | "rebuild" | "resume_registration" | "abort" {
  const latestSafeStart = input.nowMs + (input.durationMinutes + 1) * 60_000;
  if (Date.parse(input.observationAt) >= latestSafeStart) return "keep";
  if (!input.registration) return "rebuild";
  return input.registration.confirmedAt ? "abort" : "resume_registration";
}

export function shouldSkipFallback(status: string, action: string): boolean {
  return (
    ["pending", "resolved", "unresolvable", "voided"].includes(status) ||
    (action === "link_market" && status === "linked")
  );
}

export function hasUnresolvableHistory(
  sawUnresolvable: boolean | undefined,
  events: { message: string }[],
  notes: string[] = [],
): boolean {
  return Boolean(
    sawUnresolvable ||
    events.some((event) => /\bunresolvable\b/i.test(event.message)) ||
    notes.some((note) => /\bunresolvable\b/i.test(note)),
  );
}

export function evaluateVoid(input: {
  noaStatus?: string;
  courtStatus: string;
  attempts: number;
  pendingResolution: unknown;
  resolveReceiptCount: number;
  verdictStatus?: string;
  verdictReason?: string;
  sourceErrors?: unknown[];
  courtError?: string;
  sawUnresolvable?: boolean;
  retryMaxAttempts?: number;
}): { pass: boolean; path: string; note: string; summary: string } {
  const retryExhausted =
    Number.isInteger(input.retryMaxAttempts) &&
    input.retryMaxAttempts! > 0 &&
    input.attempts >= input.retryMaxAttempts!;
  const unresolvable =
    input.sawUnresolvable ||
    input.verdictStatus?.toLowerCase() === "unresolvable" ||
    retryExhausted;
  const path = unresolvable
    ? `unresolvable->void after ${input.attempts} attempts`
    : `deadline void after ${input.attempts} attempts`;
  const errors = [
    ...new Set(
      [
        input.verdictReason,
        ...(input.sourceErrors ?? []),
        input.courtError,
      ].filter(
        (error): error is string =>
          typeof error === "string" && error.length > 0,
      ),
    ),
  ];
  const pass =
    input.noaStatus === "Void" &&
    input.courtStatus === "voided" &&
    input.attempts >= 1 &&
    !input.pendingResolution &&
    input.resolveReceiptCount === 0 &&
    input.verdictStatus?.toLowerCase() !== "resolved";
  return {
    pass,
    path,
    note: `${path}${errors.length ? `; verdict errors: ${errors.join(", ")}` : ""}`,
    summary: `${path}; no pending=${!input.pendingResolution}; no resolve receipt=${input.resolveReceiptCount === 0}; verdict=${input.verdictStatus ?? "none"}`,
  };
}

export function evaluateNegw(input: {
  reason?: string;
  permanent: boolean;
  linkAttempts: number;
  observedForMs: number;
  everLinked: boolean;
  courtLinked: boolean;
  noaStatus?: string;
  stakeReturned: boolean;
}): { pass: boolean; summary: string } {
  const rejected = /resolution window too short for retries/i.test(
    input.reason ?? "",
  );
  const pass =
    rejected &&
    input.permanent &&
    input.linkAttempts > 0 &&
    input.linkAttempts <= 2 &&
    input.observedForMs >= 3 * 60_000 &&
    !input.everLinked &&
    !input.courtLinked &&
    input.noaStatus === "Void" &&
    input.stakeReturned;
  return {
    pass,
    summary: `rejection=${rejected}; permanent=${input.permanent}; link attempts=${input.linkAttempts} over ${Math.floor(input.observedForMs / 1000)}s; never linked=${!input.everLinked}; Noa=${input.noaStatus ?? "unknown"}; creator stake returned=${input.stakeReturned}`,
  };
}
