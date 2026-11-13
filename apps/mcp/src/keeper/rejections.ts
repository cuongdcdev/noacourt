import { DatabaseSync } from "node:sqlite";

export type Rejection = {
  market_id: number;
  reason: string;
  first_at: number;
  last_at: number;
  attempts: number;
  next_retry_at: number | null;
  permanent: number;
  tx_hash: string | null;
};

const RETRY_DELAYS_MS = [5, 15, 60].map((minutes) => minutes * 60_000);
const PERMANENT_REASONS = [
  "wrong resolver",
  "outcomes mismatch",
  "expiration after observation",
  "resolution window too short for retries",
  "metadata spec_hash mismatch",
  "invalid market deadline",
  "market is not active",
  "not active",
  "metadata is not noacourt and no spec_hash supplied",
  "explicit spec_hash requires market creator",
];

export function classifyLinkRejection(
  reason: string,
): "permanent" | "retryable" | "already_linked" {
  const normalized = reason.toLowerCase();
  if (normalized.includes("market already linked")) return "already_linked";
  if (PERMANENT_REASONS.some((entry) => normalized.includes(entry)))
    return "permanent";
  return "retryable";
}

export class RejectionStore {
  constructor(private db: DatabaseSync) {
    for (const table of ["keeper_link_rejections", "keeper_void_rejections"])
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        market_id INTEGER PRIMARY KEY,
        reason TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        next_retry_at INTEGER,
        permanent INTEGER NOT NULL,
        tx_hash TEXT
      )`);
    for (const table of ["keeper_link_rejections", "keeper_void_rejections"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === "tx_hash"))
        db.exec(`ALTER TABLE ${table} ADD COLUMN tx_hash TEXT`);
    }
  }

  private table(kind: "link" | "void"): string {
    return kind === "link"
      ? "keeper_link_rejections"
      : "keeper_void_rejections";
  }

  get(kind: "link" | "void", marketId: number): Rejection | null {
    return (
      (this.db
        .prepare(`SELECT * FROM ${this.table(kind)} WHERE market_id = ?`)
        .get(marketId) as Rejection | undefined) ?? null
    );
  }

  canTry(kind: "link" | "void", marketId: number, nowMs: number): boolean {
    const row = this.get(kind, marketId);
    return !row || (!row.permanent && (row.next_retry_at ?? 0) <= nowMs);
  }

  record(
    kind: "link" | "void",
    marketId: number,
    reason: string,
    nowMs: number,
    permanent = false,
    txHash: string | null = null,
  ): Rejection {
    const previous = this.get(kind, marketId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const stopped = permanent || attempts > RETRY_DELAYS_MS.length;
    const nextRetryAt = stopped ? null : nowMs + RETRY_DELAYS_MS[attempts - 1];
    this.db
      .prepare(
        `INSERT INTO ${this.table(kind)}
          (market_id, reason, first_at, last_at, attempts, next_retry_at, permanent, tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(market_id) DO UPDATE SET
           reason=excluded.reason, last_at=excluded.last_at,
           attempts=excluded.attempts, next_retry_at=excluded.next_retry_at,
           permanent=excluded.permanent,tx_hash=excluded.tx_hash`,
      )
      .run(
        marketId,
        reason,
        previous?.first_at ?? nowMs,
        nowMs,
        attempts,
        nextRetryAt,
        stopped ? 1 : 0,
        txHash,
      );
    return this.get(kind, marketId)!;
  }

  clear(kind: "link" | "void", marketId: number): void {
    this.db
      .prepare(`DELETE FROM ${this.table(kind)} WHERE market_id = ?`)
      .run(marketId);
  }

  permanentLinkMarketIds(): number[] {
    return (
      this.db
        .prepare(
          "SELECT market_id FROM keeper_link_rejections WHERE permanent = 1",
        )
        .all() as { market_id: number }[]
    ).map((row) => row.market_id);
  }

  linkCounts(): { permanent: number; pending: number } {
    const rows = this.db
      .prepare(
        "SELECT permanent, COUNT(*) AS count FROM keeper_link_rejections GROUP BY permanent",
      )
      .all() as { permanent: number; count: number }[];
    return {
      permanent: rows.find((row) => row.permanent === 1)?.count ?? 0,
      pending: rows.find((row) => row.permanent === 0)?.count ?? 0,
    };
  }
}
