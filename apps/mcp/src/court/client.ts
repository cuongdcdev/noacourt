import type { Config } from "../config.js";
import { NearRpc } from "../near/rpc.js";

export class CourtClient {
  private cachedHash: string | null = null;
  private cachedNote: string | null = null;
  private cachedConfig: Record<string, any> | null = null;
  private cachedAt: number | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private lastError: string | null = null;
  private refreshing: Promise<string | null> | null = null;
  constructor(
    private config: Config,
    private rpc: NearRpc,
  ) {}

  async market(id: number) {
    return this.rpc.view<unknown>(this.config.courtContract, "get_market", {
      market_id: id,
    });
  }
  async request(id: string) {
    return this.rpc.view<unknown>(this.config.courtContract, "get_request", {
      request_id: id,
    });
  }
  async verdict(id: string) {
    return this.rpc.view<unknown>(this.config.courtContract, "get_verdict", {
      id,
    });
  }

  async spec(hash: string) {
    return this.rpc.view<unknown>(this.config.courtContract, "get_spec", {
      spec_hash: hash,
    });
  }

  async configView(): Promise<Record<string, any>> {
    if (Date.now() - this.lastAttemptAt >= this.config.courtConfigRefreshMs)
      await this.refresh();
    if (!this.cachedConfig)
      throw new Error(this.lastError ?? "Court config unavailable");
    return this.cachedConfig;
  }

  async maxAttempts(): Promise<number | null> {
    if (Date.now() - this.lastAttemptAt >= this.config.courtConfigRefreshMs)
      await this.refresh();
    const value = Number(this.cachedConfig?.max_attempts);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  resolverHash(): string | null {
    return this.cachedHash;
  }

  configStatus() {
    return {
      fetched_at:
        this.cachedAt === null ? null : new Date(this.cachedAt).toISOString(),
      last_error: this.lastError,
      max_attempts: this.cachedConfig?.max_attempts ?? null,
      min_deposit: this.cachedConfig?.min_deposit ?? null,
    };
  }

  resolverStatus(): { hash: string | null; note: string | null } {
    this.resolverHash();
    return { hash: this.cachedHash, note: this.cachedNote };
  }

  async resolverStatusFresh(): Promise<{
    hash: string | null;
    note: string | null;
  }> {
    if (Date.now() - this.lastAttemptAt >= this.config.courtConfigRefreshMs)
      await this.refresh();
    return { hash: this.cachedHash, note: this.cachedNote };
  }

  refresh(): Promise<string | null> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchConfig().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async fetchConfig(): Promise<string | null> {
    this.lastAttemptAt = Date.now();
    try {
      const config = await this.rpc.view<Record<string, any>>(
        this.config.courtContract,
        "get_config",
        {},
      );
      if (!config || typeof config !== "object")
        throw new Error("Court get_config returned an invalid value");
      const source = config.resolver_source;
      const project =
        source && typeof source === "object" ? source.Project : null;
      let hash: string | null;
      let note: string | null;
      if (
        project &&
        typeof project === "object" &&
        project.version_key == null
      ) {
        hash = null;
        note = "Court resolver unpinned (OutLayer project latest version)";
      } else {
        hash = findResolverHash(source) ?? findResolverHash(config);
        note = hash ? null : "Court resolver sha256 unavailable";
      }
      this.cachedConfig = config;
      this.cachedHash = hash;
      this.cachedNote = note;
      this.cachedAt = Date.now();
      this.lastError = null;
      return this.cachedHash;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = this.config.nearAiApi
        ? message.replaceAll(this.config.nearAiApi, "[redacted]")
        : message;
      return this.cachedHash;
    }
  }
}

export type NormalizedCourtItem = {
  id: string;
  state: string;
  specHash: string | null;
  attempt: number;
  retryAtNs: bigint;
  deadlineNs: bigint | null;
  pending: boolean;
  forwarded: boolean | null;
  voidPending: boolean;
};

export function normalizeCourtItem(value: unknown): NormalizedCourtItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, any>;
  const raw = item.status ?? item.state ?? "Unknown";
  const state =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw
        ? Object.keys(raw)[0]
        : "Unknown";
  const variant = typeof raw === "object" && raw ? raw[state] : null;
  const num = (candidate: unknown): bigint => {
    try {
      return BigInt(String(candidate ?? 0));
    } catch {
      return 0n;
    }
  };
  return {
    id: String(item.id ?? ""),
    state,
    specHash:
      typeof item.spec_hash === "string"
        ? item.spec_hash
        : typeof item.specHash === "string"
          ? item.specHash
          : null,
    attempt: Number(item.attempts ?? item.attempt ?? variant?.attempt ?? 0),
    retryAtNs: num(
      item.retry_at_ns ??
        item.retry_at ??
        variant?.retry_at_ns ??
        variant?.retry_at,
    ),
    deadlineNs:
      item.resolution_deadline_ns != null || item.resolution_deadline != null
        ? num(item.resolution_deadline_ns ?? item.resolution_deadline)
        : null,
    pending: state.toLowerCase() === "pending",
    forwarded: typeof item.forwarded === "boolean" ? item.forwarded : null,
    voidPending: item.void_pending === true,
  };
}

export function specRetryLimit(specEntry: unknown): number | null {
  if (!specEntry || typeof specEntry !== "object") return null;
  const value = Number(
    (specEntry as Record<string, unknown>).retry_max_attempts,
  );
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function observationNs(specEntry: unknown): bigint | null {
  if (!specEntry || typeof specEntry !== "object") return null;
  const entry = specEntry as Record<string, any>;
  if (entry.observation_at_ns != null)
    return BigInt(String(entry.observation_at_ns));
  try {
    const spec = JSON.parse(String(entry.spec_json ?? "{}"));
    return BigInt(Date.parse(spec.observation.at)) * 1_000_000n;
  } catch {
    return null;
  }
}

export function specJsonOf(specEntry: unknown): string | null {
  const item = specEntry as Record<string, any> | null;
  return typeof item?.spec_json === "string" ? item.spec_json : null;
}

export function linkRejectionReason(outcome: unknown): string | null {
  const root = outcome as Record<string, any> | null;
  const receipts = [
    root?.transaction_outcome,
    ...(Array.isArray(root?.receipts_outcome) ? root.receipts_outcome : []),
  ];
  for (const receipt of receipts) {
    for (const line of receipt?.outcome?.logs || []) {
      if (typeof line !== "string" || !line.startsWith("EVENT_JSON:")) continue;
      try {
        const event = JSON.parse(line.slice("EVENT_JSON:".length)) as Record<
          string,
          any
        >;
        if (event.event !== "link_rejected") continue;
        const data = Array.isArray(event.data) ? event.data[0] : event.data;
        if (typeof data?.reason === "string") return data.reason;
      } catch {
        /* malformed event is not a reason */
      }
    }
  }
  return null;
}

function requestId(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    try {
      return requestId(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = requestId(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of [
    "request_id",
    "requestId",
    "execution_id",
    "executionId",
    "id",
  ]) {
    const candidate = object[key];
    if (typeof candidate === "string" || typeof candidate === "number")
      return String(candidate);
  }
  for (const key of [
    "request_data",
    "execution",
    "request",
    "data",
    "metadata",
  ]) {
    const found = requestId(object[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export function outlayerRequestIdFromVerdict(verdict: unknown): string | null {
  const outlayer = (verdict as Record<string, any> | null)?.outlayer;
  return requestId(outlayer);
}

export function outlayerRequestIdFromTx(outcome: unknown): string | null {
  const root = outcome as Record<string, any> | null;
  const receipts = [
    root?.transaction_outcome,
    ...(root?.receipts_outcome ?? []),
  ];
  for (const receipt of receipts) {
    for (const line of receipt?.outcome?.logs ?? []) {
      if (typeof line !== "string") continue;
      if (line.startsWith("EVENT_JSON:")) {
        try {
          const event = JSON.parse(line.slice("EVENT_JSON:".length)) as Record<
            string,
            any
          >;
          if (
            event.standard !== "near-outlayer" ||
            event.event !== "execution_requested"
          )
            continue;
          const found = requestId(event.data);
          if (found !== null) return found;
        } catch {
          continue;
        }
      }
      const match = /request_id:\s*(\d+)/i.exec(line);
      if (match) return match[1];
    }
  }
  return null;
}

export function findResolverHash(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of [
    "version_key",
    "sha256",
    "wasm_sha256",
    "resolver_sha256",
    "hash",
  ]) {
    const candidate = object[key];
    if (
      typeof candidate === "string" &&
      /^(?:sha256:)?[a-f0-9]{64}$/i.test(candidate)
    )
      return `sha256:${candidate.replace(/^sha256:/i, "").toLowerCase()}`;
  }
  for (const nested of Object.values(object)) {
    if (nested && typeof nested === "object") {
      const found = findResolverHash(nested);
      if (found) return found;
    }
  }
  return null;
}
