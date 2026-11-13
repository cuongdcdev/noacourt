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
}): { pass: boolean; path: string; note: string; summary: string } {
  const path = input.sawUnresolvable
    ? "unresolvable->void"
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
