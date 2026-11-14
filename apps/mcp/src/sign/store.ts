import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import type { WalletTransaction } from "./txBuilder.js";
import type {
  MetadataSnapshot,
  PublicationRecord,
  PublicationState,
} from "./publication.js";

const SNAPSHOT_COLUMNS = [
  "description",
  "rules_text",
  "renderer_version",
  "metadata_digest",
  "publication_state",
  "publication_error",
  "publication_verified_at",
];

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
  /** Frozen reviewed metadata; null for legacy rows created before this feature. */
  snapshot: MetadataSnapshot | null;
  publication: PublicationRecord;
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
    // Backward-compatible migration: nullable columns only.
    const existing = new Set(
      (
        this.db.prepare("PRAGMA table_info(sign_requests)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    for (const column of SNAPSHOT_COLUMNS)
      if (!existing.has(column))
        this.db.exec(`ALTER TABLE sign_requests ADD COLUMN ${column} TEXT`);
  }
  private fromRow(row: Record<string, string>): SignRequest {
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
      snapshot:
        row.rules_text != null && row.metadata_digest != null
          ? {
              description: row.description ?? row.rules_text,
              rules: row.rules_text,
              renderer_version: row.renderer_version,
              spec_hash: row.spec_hash,
              metadata_digest: row.metadata_digest,
            }
          : null,
      publication: {
        state: (row.publication_state as PublicationState | null) ?? null,
        error: row.publication_error ?? null,
        verified_at: row.publication_verified_at ?? null,
      },
    };
  }
  create(
    params: Record<string, any>,
    specJson: string,
    specHash: string,
    txPlan: WalletTransaction[],
    expiresAt?: string,
    snapshot?: MetadataSnapshot,
  ): SignRequest {
    const id = randomBytes(16).toString("base64url");
    const created_at = new Date().toISOString();
    const expires_at =
      expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare(
        "INSERT INTO sign_requests (id, created_at, expires_at, status, params, spec_json, spec_hash, tx_plan, result, description, rules_text, renderer_version, metadata_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
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
        snapshot?.description ?? null,
        snapshot?.rules ?? null,
        snapshot?.renderer_version ?? null,
        snapshot?.metadata_digest ?? null,
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
      snapshot: snapshot ?? null,
      publication: { state: null, error: null, verified_at: null },
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
    return this.fromRow(row);
  }
  /** Newest locally stored spec_json for a full "sha256:<hex>" hash (fallback for /spec/:hash). */
  specJsonByHash(specHash: string): string | null {
    const row = this.db
      .prepare(
        "SELECT spec_json FROM sign_requests WHERE spec_hash = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(specHash) as { spec_json: string } | undefined;
    return row?.spec_json ?? null;
  }
  /** Freeze a snapshot once (never overwrites an existing one). */
  freezeSnapshot(id: string, snapshot: MetadataSnapshot): void {
    this.db
      .prepare(
        "UPDATE sign_requests SET description = ?, rules_text = ?, renderer_version = ?, metadata_digest = ? WHERE id = ? AND rules_text IS NULL",
      )
      .run(
        snapshot.description,
        snapshot.rules,
        snapshot.renderer_version,
        snapshot.metadata_digest,
        id,
      );
  }
  setPublication(
    id: string,
    state: PublicationState,
    error: string | null,
    verifiedAt?: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE sign_requests SET publication_state = ?, publication_error = ?, publication_verified_at = COALESCE(?, publication_verified_at) WHERE id = ?",
      )
      .run(state, error, verifiedAt ?? null, id);
  }
  findByMarketId(marketId: number): SignRequest | null {
    const row = this.db
      .prepare(
        "SELECT * FROM sign_requests WHERE status = 'completed' AND json_extract(result, '$.market_id') = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(marketId) as Record<string, string> | undefined;
    return row ? this.fromRow(row) : null;
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
