import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import type { WalletTransaction } from "./txBuilder.js";

export type SignRequest = {
  id: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "completed" | "expired";
  params: Record<string, any>;
  spec_json: string;
  spec_hash: string;
  tx_plan: WalletTransaction[];
  result: Record<string, any> | null;
};

export class SignStore {
  private db: DatabaseSync;
  constructor(config: Config) {
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(config.dataDir, "mcp.sqlite"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS sign_requests (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      status TEXT NOT NULL, params TEXT NOT NULL, spec_json TEXT NOT NULL,
      spec_hash TEXT NOT NULL, tx_plan TEXT NOT NULL, result TEXT
    )`);
  }
  create(
    params: Record<string, any>,
    specJson: string,
    specHash: string,
    txPlan: WalletTransaction[],
    expiresAt?: string,
  ): SignRequest {
    const id = randomBytes(16).toString("base64url");
    const created_at = new Date().toISOString();
    const expires_at =
      expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare("INSERT INTO sign_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        created_at,
        expires_at,
        "pending",
        JSON.stringify(params),
        specJson,
        specHash,
        JSON.stringify(txPlan),
        null,
      );
    return {
      id,
      created_at,
      expires_at,
      status: "pending",
      params,
      spec_json: specJson,
      spec_hash: specHash,
      tx_plan: txPlan,
      result: null,
    };
  }
  get(id: string): SignRequest | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    const row = this.db
      .prepare("SELECT * FROM sign_requests WHERE id = ?")
      .get(id) as Record<string, string> | undefined;
    if (!row) return null;
    if (row.status === "pending" && Date.now() >= Date.parse(row.expires_at)) {
      this.db
        .prepare("UPDATE sign_requests SET status = 'expired' WHERE id = ?")
        .run(id);
      row.status = "expired";
    }
    return {
      id: row.id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      status: row.status as SignRequest["status"],
      params: JSON.parse(row.params),
      spec_json: row.spec_json,
      spec_hash: row.spec_hash,
      tx_plan: JSON.parse(row.tx_plan),
      result: row.result ? JSON.parse(row.result) : null,
    };
  }
  complete(id: string, result: Record<string, any>): void {
    this.db
      .prepare(
        "UPDATE sign_requests SET status = 'completed', result = ? WHERE id = ? AND status = 'pending'",
      )
      .run(JSON.stringify(result), id);
  }
  expire(id: string): void {
    this.db
      .prepare("UPDATE sign_requests SET status = 'expired' WHERE id = ?")
      .run(id);
  }
  close(): void {
    this.db.close();
  }
}
