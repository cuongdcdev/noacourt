import {
  normalizeCourtItem,
  observationNs,
  outlayerRequestIdFromVerdict,
} from "./court/client.js";

export function nsIso(value: unknown): string | null {
  try {
    if (value == null) return null;
    const nanoseconds = BigInt(String(value));
    if (nanoseconds <= 0n) return null;
    const milliseconds = Number(nanoseconds / 1_000_000n);
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

export function withIso(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withIso);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = withIso(entry);
    if (
      key.endsWith("_ns") ||
      ["expiration_time", "resolution_deadline", "dispute_deadline"].includes(
        key,
      )
    )
      output[`${key}_iso`] = nsIso(entry);
  }
  return output;
}

export function marketTopLevelStatus(
  noa: unknown,
  court: unknown,
  pending: unknown,
  verdict: unknown,
): string {
  const noaStatus = String(
    (noa as Record<string, unknown> | null)?.status ?? "",
  ).toLowerCase();
  const courtStatus = normalizeCourtItem(court)?.state.toLowerCase();
  if (noaStatus === "resolved") return "finalized";
  if (noaStatus === "active" && pending != null && courtStatus === "resolved")
    return "proposed_in_dispute_window";
  return verdict ? "resolved" : "pending";
}

export function annotateReceiptSources(
  verdict: unknown,
  specInput: unknown,
): unknown {
  if (!verdict || typeof verdict !== "object") return verdict;
  const result = verdict as Record<string, any>;
  if (result.verdict && typeof result.verdict === "object")
    return {
      ...result,
      verdict: annotateReceiptSources(result.verdict, specInput),
    };
  if (!Array.isArray(result.sources)) return verdict;
  let spec = specInput as Record<string, any> | null;
  try {
    if (typeof spec === "string") spec = JSON.parse(spec);
    else if (typeof spec?.spec_json === "string")
      spec = JSON.parse(spec.spec_json);
  } catch {
    spec = null;
  }
  const sourceIds = Array.isArray(spec?.sources)
    ? spec.sources.map((source: Record<string, any>) => String(source.id))
    : result.sources.map((source: Record<string, any>) => String(source.id));
  const good = (source: Record<string, any>) =>
    source.ok === true ||
    (source.ok !== false && source.value != null && source.error == null);
  const firstGood = sourceIds.find((id: string) =>
    result.sources.some(
      (source: Record<string, any>) => String(source.id) === id && good(source),
    ),
  );
  const method = String(spec?.aggregate?.method ?? "primary_then_fallback");
  return {
    ...result,
    sources: result.sources.map((source: Record<string, any>) => ({
      ...source,
      used_for_decision:
        good(source) &&
        (method === "primary_then_fallback"
          ? String(source.id) === firstGood
          : method === "median" || method === "all_agree"),
    })),
  };
}

export function lifecycle(input: {
  noa?: Record<string, any> | null;
  court?: unknown;
  pending?: Record<string, any> | null;
  rejection?: {
    reason: string;
    permanent: boolean;
    next_retry_at: string | null;
  } | null;
  spec?: unknown;
  genericRequest?: boolean;
  nowMs?: number;
  graceSeconds?: number;
}) {
  const now = input.nowMs ?? Date.now();
  const state = normalizeCourtItem(input.court);
  const noaStatus = String(input.noa?.status ?? "").toLowerCase();
  const courtStatus = state?.state.toLowerCase();
  const observation = observationNs(input.spec);
  const observationMs =
    observation == null ? null : Number(observation / 1_000_000n);
  const nextObservation =
    observationMs == null
      ? null
      : new Date(
          observationMs + (input.graceSeconds ?? 70) * 1000,
        ).toISOString();
  const deadline =
    input.pending?.dispute_deadline ?? input.pending?.dispute_deadline_ns;
  let phase = "created";
  let nextStep = input.genericRequest
    ? "Waiting for Court request registration."
    : "Keeper will link this market to Court.";
  let nextAt: string | null = null;
  if (noaStatus === "resolved") {
    phase = "finalized";
    nextStep = "Resolution is finalized.";
  } else if (
    noaStatus === "void" ||
    noaStatus === "voided" ||
    courtStatus === "voided"
  ) {
    phase = "voided";
    nextStep = "Market was voided.";
  } else if (!state && input.rejection?.permanent) {
    phase = "link_rejected";
    nextStep = `Court rejected linking: ${input.rejection.reason}. Keeper will void after the deadline.`;
  } else if (!state && input.rejection) {
    nextStep = `Keeper will retry linking: ${input.rejection.reason}.`;
    nextAt = input.rejection.next_retry_at;
  } else if (courtStatus === "pending") {
    phase = "resolving";
    nextStep = "OutLayer execution and Court callbacks are pending.";
  } else if (courtStatus === "retryscheduled") {
    phase = "retry_scheduled";
    nextStep = "Keeper will trigger the scheduled retry.";
    nextAt = state?.retryAtNs ? nsIso(state.retryAtNs) : null;
  } else if (courtStatus === "unresolvable") {
    phase = "unresolvable";
    nextStep = "Keeper will void the market after its resolution deadline.";
    nextAt = nsIso(input.noa?.resolution_deadline);
  } else if (courtStatus === "resolved" && noaStatus === "active") {
    phase = "dispute_window";
    nextStep = input.pending
      ? "Keeper automatically calls finalize_resolution after the dispute window."
      : "Keeper will retry forwarding the Court verdict to Noa.";
    nextAt = deadline == null ? null : nsIso(deadline);
  } else if (state && observationMs !== null && now < observationMs) {
    phase = "awaiting_observation";
    nextStep = `Keeper will trigger ${input.genericRequest ? "the request" : "resolution"} after observation time and its grace period.`;
    nextAt = nextObservation;
  } else if (state) {
    phase = "linked";
    nextStep = `Keeper will trigger ${input.genericRequest ? "the request" : "resolution"} when due.`;
    nextAt = nextObservation;
  }
  return {
    lifecycle: phase,
    next_step: nextStep,
    next_action_at_utc: nextAt,
    text: "During the dispute window Court shows Resolved while Noa remains Active; the keeper automatically finalizes after the window.",
  };
}

export function outlayerDetails(verdict: unknown) {
  const outlayer = (verdict as Record<string, any> | null)?.outlayer ?? null;
  return {
    outlayer: withIso(outlayer),
    outlayer_request_id: outlayerRequestIdFromVerdict(verdict),
    outlayer_contract_url:
      typeof outlayer?.contract === "string"
        ? `https://testnet.nearblocks.io/address/${encodeURIComponent(outlayer.contract)}`
        : null,
  };
}
