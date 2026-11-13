import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { classifyLinkRejection, RejectionStore } from "./rejections.js";

export type ActionRecord = {
  item_id: string;
  action: string;
  tx_hash: string;
  status: string;
  error: string | null;
  ts: string;
  tx_url: string;
};

export class ActionHistory {
  private db: DatabaseSync;
  private rejections: RejectionStore;
  constructor(config: Config) {
    this.db = new DatabaseSync(join(config.dataDir, "mcp.sqlite"));
    this.rejections = new RejectionStore(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS keeper_actions (
      item_id TEXT NOT NULL, action TEXT NOT NULL, tx_hash TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT, ts TEXT NOT NULL,
      UNIQUE(item_id, action, tx_hash)
    )`);
    const logPath = join(config.dataDir, "keeper.log");
    if (existsSync(logPath) && statSync(logPath).size <= 10_000_000) {
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        try {
          const entry = JSON.parse(line) as Record<string, any>;
          if (typeof entry.id === "string" && typeof entry.tx_hash === "string")
            this.record({
              item_id: entry.id,
              action: String(entry.action),
              tx_hash: entry.tx_hash,
              status: String(entry.status ?? entry.result ?? "unknown"),
              error: entry.error == null ? null : String(entry.error),
              ts: String(entry.ts ?? new Date().toISOString()),
            });
        } catch {
          // Ignore malformed historical log lines.
        }
      }
    }
  }

  record(entry: Omit<ActionRecord, "tx_url">): void {
    this.db
      .prepare(
        `INSERT INTO keeper_actions(item_id,action,tx_hash,status,error,ts)
       VALUES (?,?,?,?,?,?) ON CONFLICT(item_id,action,tx_hash) DO UPDATE SET
       status=excluded.status,error=excluded.error,ts=excluded.ts`,
      )
      .run(
        entry.item_id,
        entry.action,
        entry.tx_hash,
        entry.status,
        entry.error,
        entry.ts,
      );
  }

  forItem(id: string): ActionRecord[] {
    return (
      this.db
        .prepare(
          "SELECT item_id,action,tx_hash,status,error,ts FROM keeper_actions WHERE item_id = ? ORDER BY ts",
        )
        .all(id) as Omit<ActionRecord, "tx_url">[]
    ).map((entry) => ({
      ...entry,
      tx_url: `https://testnet.nearblocks.io/txns/${encodeURIComponent(entry.tx_hash)}`,
    }));
  }

  linkRejection(marketId: number) {
    try {
      const row = this.rejections.get("link", marketId);
      return row
        ? {
            reason: row.reason,
            permanent: row.permanent === 1,
            tx_hash: row.tx_hash,
            tx_url: row.tx_hash
              ? `https://testnet.nearblocks.io/txns/${encodeURIComponent(row.tx_hash)}`
              : null,
            next_retry_at:
              row.next_retry_at === null
                ? null
                : new Date(row.next_retry_at).toISOString(),
          }
        : null;
    } catch {
      return null;
    }
  }

  recordLinkRejection(marketId: number, reason: string, txHash: string): void {
    const classification = classifyLinkRejection(reason);
    if (classification === "already_linked") return;
    this.rejections.record(
      "link",
      marketId,
      reason,
      Date.now(),
      classification === "permanent",
      txHash,
    );
  }

  close(): void {
    this.db.close();
  }
}
