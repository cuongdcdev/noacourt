import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit: number,
    private now: () => number = Date.now,
  ) {}
  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const recent = (this.hits.get(key) || []).filter(
      (time) => now - time < 60_000,
    );
    if (recent.length >= this.limit)
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((60_000 - (now - recent[0])) / 1000),
      };
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export class SpendCounter {
  private db: DatabaseSync;
  constructor(private config: Config) {
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(config.dataDir, "spend.sqlite"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY, at TEXT NOT NULL, cents INTEGER NOT NULL)",
    );
  }
  charge(): void {
    const cost = Math.ceil(this.config.nearAiCostPerSimulateUsd * 100);
    const cap = Math.floor(this.config.nearAiSpendCapUsd * 100);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const total = (
        this.db
          .prepare("SELECT COALESCE(SUM(cents), 0) AS cents FROM spend")
          .get() as { cents: number }
      ).cents;
      if (total + cost > cap)
        throw new Error(
          `NEAR AI simulation spend cap of $${this.config.nearAiSpendCapUsd} reached`,
        );
      this.db
        .prepare("INSERT INTO spend(at, cents) VALUES (?, ?)")
        .run(new Date().toISOString(), cost);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
