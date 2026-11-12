import { normalizeCourtItem } from "../court/client.js";

export type KeeperAction =
  | "link_market"
  | "void_unlinked"
  | "trigger"
  | "trigger_request"
  | "retry_forward"
  | "void"
  | "finalize_resolution"
  | "submit_keeper_verdict";
const ns = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? 0));
  } catch {
    return 0n;
  }
};

export function decideMarketActions(
  noa: Record<string, any>,
  courtRaw: unknown,
  pending: Record<string, any> | null,
  nowNs: bigint,
  observationAtNs: bigint | null,
  trusted = false,
  maxAttempts: number | null = null,
): KeeperAction[] {
  if (String(noa.status) !== "Active") return [];
  if (pending)
    return nowNs > ns(pending.dispute_deadline ?? pending.dispute_deadline_ns)
      ? ["finalize_resolution"]
      : [];
  const court = normalizeCourtItem(courtRaw);
  if (!court) {
    const deadline = ns(noa.resolution_deadline);
    return deadline > 0n && nowNs > deadline
      ? ["void_unlinked"]
      : ["link_market"];
  }
  const state = court.state.toLowerCase();
  const deadline = court.deadlineNs ?? ns(noa.resolution_deadline);
  if (state === "resolved" && court.forwarded === false && nowNs < deadline)
    return ["retry_forward"];
  if (
    nowNs > deadline &&
    !court.voidPending &&
    state !== "pending" &&
    state !== "voided" &&
    !(state === "resolved" && court.forwarded !== false)
  )
    return ["void"];
  if (state === "resolved" || state === "voided" || state === "unresolvable")
    return [];
  if (
    observationAtNs === null ||
    nowNs < observationAtNs ||
    nowNs < court.retryAtNs
  )
    return [];
  if (noa.resolution_deadline != null && nowNs > ns(noa.resolution_deadline))
    return [];
  if (court.deadlineNs !== null && nowNs > court.deadlineNs) return [];
  if (maxAttempts === null || court.attempt >= maxAttempts) return [];
  if (
    trusted &&
    ["linked", "registered", "retryscheduled", "pending"].includes(state)
  )
    return ["submit_keeper_verdict"];
  if (["linked", "registered", "retryscheduled"].includes(state))
    return ["trigger"];
  return [];
}

export function decideRequestActions(
  courtRaw: unknown,
  nowNs: bigint,
  observationAtNs: bigint | null,
  trusted = false,
  maxAttempts: number | null = null,
): KeeperAction[] {
  const court = normalizeCourtItem(courtRaw);
  if (
    !court ||
    observationAtNs === null ||
    nowNs < observationAtNs ||
    nowNs < court.retryAtNs
  )
    return [];
  const state = court.state.toLowerCase();
  if (maxAttempts === null || court.attempt >= maxAttempts) return [];
  if (
    trusted &&
    ["linked", "registered", "retryscheduled", "pending"].includes(state)
  )
    return ["submit_keeper_verdict"];
  return ["linked", "registered", "retryscheduled"].includes(state)
    ? ["trigger_request"]
    : [];
}
