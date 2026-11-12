import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import {
  CourtClient,
  normalizeCourtItem,
  observationNs,
  specJsonOf,
  specRetryLimit,
  linkRejectionReason,
} from "../court/client.js";
import { NearRpc } from "../near/rpc.js";
import type { KeeperSigner } from "../near/signer.js";
import { SpendCounter } from "../ratelimit.js";
import { WasmRunner } from "../resolver/wasm.js";
import {
  decideMarketActions,
  decideRequestActions,
  type KeeperAction,
} from "./decision.js";
import { classifyLinkRejection, RejectionStore } from "./rejections.js";

export type KeeperDeps = {
  config: Config;
  rpc: NearRpc;
  court: CourtClient;
  signer: Pick<KeeperSigner, "send">;
  wasm: WasmRunner;
  spend: SpendCounter;
  now?: () => number;
};

export class KeeperLoop {
  private db: DatabaseSync;
  private rejections: RejectionStore;
  private activeMarkets = new Set<number>();
  private activeRequests = new Set<string>();
  private recent = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickNumber = 0;
  private marketCursor: number;
  private requestCursor: number;
  private voidUnsupportedUntilMs = 0;
  private voidSuccessUntilMs = new Map<number, number>();
  private linkedRefreshUntilMs = new Map<number, number>();
  lastTickAt: string | null = null;
  lastError: string | null = null;
  counts = {
    scanned_markets: 0,
    active_markets: 0,
    active_requests: 0,
    actions: 0,
    errors: 0,
    link_rejections_permanent: 0,
    link_rejections_pending: 0,
  };
  constructor(private deps: KeeperDeps) {
    mkdirSync(deps.config.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(deps.config.dataDir, "mcp.sqlite"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS keeper_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS keeper_active_markets (id INTEGER PRIMARY KEY)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS keeper_active_requests (id TEXT PRIMARY KEY)",
    );
    this.rejections = new RejectionStore(this.db);
    this.marketCursor = Number(
      (
        this.db
          .prepare("SELECT value FROM keeper_meta WHERE key = 'market_cursor'")
          .get() as { value: string } | undefined
      )?.value ?? 0,
    );
    this.requestCursor = Number(
      (
        this.db
          .prepare("SELECT value FROM keeper_meta WHERE key = 'request_cursor'")
          .get() as { value: string } | undefined
      )?.value ?? 0,
    );
    for (const row of this.db
      .prepare("SELECT id FROM keeper_active_markets")
      .all() as { id: number }[])
      this.activeMarkets.add(row.id);
    for (const row of this.db
      .prepare("SELECT id FROM keeper_active_requests")
      .all() as { id: string }[])
      this.activeRequests.add(row.id);
    for (const id of this.rejections.permanentLinkMarketIds())
      this.activeMarkets.add(id);
    this.updateRejectionCounts();
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private updateRejectionCounts(): void {
    const counts = this.rejections.linkCounts();
    this.counts.link_rejections_permanent = counts.permanent;
    this.counts.link_rejections_pending = counts.pending;
  }

  private log(action: string, fields: Record<string, unknown>) {
    const secret = this.deps.config.nearAiApi;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      ...fields,
    });
    try {
      appendFileSync(
        join(this.deps.config.dataDir, "keeper.log"),
        (secret ? line.replaceAll(secret, "[redacted]") : line) + "\n",
      );
    } catch {
      /* file logging must not crash the process */
    }
  }
  private error(action: string, id: string, error: unknown) {
    this.counts.errors++;
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = this.deps.config.nearAiApi
      ? message.replaceAll(this.deps.config.nearAiApi, "[redacted]")
      : message;
    this.log(action, { id, error: this.lastError });
  }
  private saveCursor(key: string, value: number) {
    this.db
      .prepare(
        "INSERT INTO keeper_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, String(value));
  }
  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.config.keeperIntervalMs,
    );
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db.close();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.tickNumber++;
    this.counts = {
      scanned_markets: 0,
      active_markets: this.activeMarkets.size,
      active_requests: this.activeRequests.size,
      actions: 0,
      errors: 0,
      link_rejections_permanent: this.counts.link_rejections_permanent,
      link_rejections_pending: this.counts.link_rejections_pending,
    };
    try {
      await this.scanMarkets().catch((error) =>
        this.error("scan_markets", "", error),
      );
      for (const id of [...this.activeMarkets])
        await this.processMarket(id).catch((error) =>
          this.error("market", String(id), error),
        );
      await this.scanRequests().catch((error) =>
        this.error("scan_requests", "", error),
      );
      for (const id of [...this.activeRequests])
        await this.processRequest(id).catch((error) =>
          this.error("request", id, error),
        );
    } catch (error) {
      this.error("tick", "", error);
    } finally {
      this.updateRejectionCounts();
      this.lastTickAt = new Date().toISOString();
      this.running = false;
    }
  }

  private async scanMarkets() {
    const count = Number(
      await this.deps.rpc.view<number | string>(
        this.deps.config.noaContract,
        "get_market_count",
        {},
      ),
    );
    while (this.marketCursor < count) {
      const page = await this.deps.rpc.view<Record<string, any>[]>(
        this.deps.config.noaContract,
        "get_markets",
        { from_index: this.marketCursor, limit: 50 },
      );
      if (!Array.isArray(page) || page.length === 0) break;
      for (const market of page)
        if (
          market.resolver === this.deps.config.courtContract &&
          (String(market.metadata_hash).startsWith("noacourt:") ||
            this.rejections.get("link", Number(market.id))?.permanent === 1) &&
          market.status === "Active"
        ) {
          this.activeMarkets.add(Number(market.id));
          this.db
            .prepare(
              "INSERT OR IGNORE INTO keeper_active_markets(id) VALUES(?)",
            )
            .run(Number(market.id));
        }
      this.marketCursor += page.length;
      this.counts.scanned_markets += page.length;
      this.saveCursor("market_cursor", this.marketCursor);
    }
    this.counts.active_markets = this.activeMarkets.size;
  }

  private async processMarket(id: number) {
    const noa = await this.deps.rpc.view<Record<string, any> | null>(
      this.deps.config.noaContract,
      "get_market",
      { market_id: id },
    );
    if (
      !noa ||
      noa.status !== "Active" ||
      noa.resolver !== this.deps.config.courtContract
    ) {
      this.activeMarkets.delete(id);
      this.db.prepare("DELETE FROM keeper_active_markets WHERE id = ?").run(id);
      return;
    }
    const pending = await this.deps.rpc.view<Record<string, any> | null>(
      this.deps.config.noaContract,
      "get_pending_resolution",
      { market_id: id },
    );
    const nowMs = this.nowMs();
    const nowNs = BigInt(nowMs) * 1_000_000n;
    if (
      pending &&
      nowNs >
        BigInt(
          String(pending.dispute_deadline ?? pending.dispute_deadline_ns ?? 0),
        )
    ) {
      await this.act("finalize_resolution", `noa:${id}`, null, null, {
        market_id: id,
      });
      return;
    }
    const courtRaw = await this.deps.court.market(id);
    const court = normalizeCourtItem(courtRaw);
    if (court) {
      this.rejections.clear("link", id);
      this.rejections.clear("void", id);
      this.linkedRefreshUntilMs.delete(id);
    }
    const spec = court?.specHash
      ? await this.deps.court.spec(court.specHash)
      : null;
    const configuredMax =
      court && typeof this.deps.court.maxAttempts === "function"
        ? await this.deps.court.maxAttempts()
        : 3;
    const requestedMax = specRetryLimit(spec);
    const maxAttempts =
      configuredMax && requestedMax
        ? Math.min(configuredMax, requestedMax)
        : (configuredMax ?? requestedMax);
    for (const action of decideMarketActions(
      noa,
      courtRaw,
      pending,
      nowNs,
      observationNs(spec),
      this.deps.config.courtTrustedKeeper,
      maxAttempts,
    )) {
      if (
        action === "link_market" &&
        (nowMs < (this.linkedRefreshUntilMs.get(id) ?? 0) ||
          !this.rejections.canTry("link", id, nowMs))
      )
        continue;
      if (
        action === "void_unlinked" &&
        (nowMs < this.voidUnsupportedUntilMs ||
          nowMs < (this.voidSuccessUntilMs.get(id) ?? 0) ||
          !this.rejections.canTry("void", id, nowMs))
      )
        continue;
      await this.act(action, `noa:${id}`, courtRaw, spec, { market_id: id });
    }
  }

  private async scanRequests() {
    for (let n = this.requestCursor + 1; ; n++) {
      const id = `req:${n}`;
      const item = await this.deps.court.request(id);
      if (!item) break;
      this.activeRequests.add(id);
      this.db
        .prepare("INSERT OR IGNORE INTO keeper_active_requests(id) VALUES(?)")
        .run(id);
      this.requestCursor = n;
      this.saveCursor("request_cursor", n);
    }
    this.counts.active_requests = this.activeRequests.size;
  }

  private async processRequest(id: string) {
    const item = await this.deps.court.request(id);
    const normalized = normalizeCourtItem(item);
    if (
      !normalized ||
      ["resolved", "voided", "unresolvable"].includes(
        normalized.state.toLowerCase(),
      )
    ) {
      this.activeRequests.delete(id);
      this.db
        .prepare("DELETE FROM keeper_active_requests WHERE id = ?")
        .run(id);
      return;
    }
    const spec = normalized.specHash
      ? await this.deps.court.spec(normalized.specHash)
      : null;
    const configuredMax =
      typeof this.deps.court.maxAttempts === "function"
        ? await this.deps.court.maxAttempts()
        : 3;
    const requestedMax = specRetryLimit(spec);
    const maxAttempts =
      configuredMax && requestedMax
        ? Math.min(configuredMax, requestedMax)
        : (configuredMax ?? requestedMax);
    const nowNs = BigInt(this.nowMs()) * 1_000_000n;
    for (const action of decideRequestActions(
      item,
      nowNs,
      observationNs(spec),
      this.deps.config.courtTrustedKeeper,
      maxAttempts,
    ))
      await this.act(action, id, item, spec, { request_id: id });
  }

  private async act(
    action: KeeperAction,
    id: string,
    courtRaw: unknown,
    specEntry: unknown,
    args: Record<string, unknown>,
  ) {
    const state = normalizeCourtItem(courtRaw);
    const key = `${action}:${id}:${state?.state}:${state?.attempt}`;
    if (
      action !== "link_market" &&
      action !== "void_unlinked" &&
      this.tickNumber - (this.recent.get(key) ?? -100) < 2
    )
      return;
    this.recent.set(key, this.tickNumber);
    try {
      if (action === "submit_keeper_verdict") {
        const specJson = specJsonOf(specEntry);
        if (!specJson) throw new Error("Court spec JSON unavailable");
        const [localHash, courtHash] = await Promise.all([
          this.deps.wasm.hash(),
          this.deps.court.refresh(),
        ]);
        if (localHash && courtHash && localHash !== courtHash)
          throw new Error(
            "local resolver sha256 does not match Court configuration",
          );
        const textJudge = JSON.parse(specJson).decide?.kind === "text_judge";
        if (textJudge) {
          if (!this.deps.config.nearAiApi)
            throw new Error("NEAR_AI_API is required for text_judge");
          this.deps.spend.charge();
        }
        const verdict = await this.deps.wasm.run(
          "resolve",
          specJson,
          textJudge,
          { request_id: id, attempt: (state?.attempt ?? 0) + 1, now: null },
        );
        args = { id, verdict_json: JSON.stringify(verdict) };
      }
      const calls: Record<
        KeeperAction,
        {
          receiverId: string;
          methodName: string;
          gasTgas: number;
          depositYocto?: string;
        }
      > = {
        link_market: {
          receiverId: this.deps.config.courtContract,
          methodName: "link_market",
          gasTgas: 100,
        },
        void_unlinked: {
          receiverId: this.deps.config.courtContract,
          methodName: "void_unlinked",
          gasTgas: 80,
        },
        trigger: {
          receiverId: this.deps.config.courtContract,
          methodName: "trigger",
          gasTgas: 300,
        },
        trigger_request: {
          receiverId: this.deps.config.courtContract,
          methodName: "trigger_request",
          gasTgas: 300,
        },
        retry_forward: {
          receiverId: this.deps.config.courtContract,
          methodName: "retry_forward",
          gasTgas: 80,
        },
        void: {
          receiverId: this.deps.config.courtContract,
          methodName: "void",
          gasTgas: 80,
        },
        finalize_resolution: {
          receiverId: this.deps.config.noaContract,
          methodName: "finalize_resolution",
          gasTgas: 100,
          depositYocto: "1",
        },
        submit_keeper_verdict: {
          receiverId: this.deps.config.courtContract,
          methodName: "submit_keeper_verdict",
          gasTgas: 100,
        },
      };
      if (action === "link_market") args = { ...args, spec_hash: null };
      const sent = await this.deps.signer.send({ ...calls[action], args });
      const status = (sent.outcome as Record<string, any>)?.status;
      if (status?.Failure) throw new Error(JSON.stringify(status.Failure));
      if (
        action === "link_market" &&
        status?.SuccessValue &&
        Buffer.from(status.SuccessValue, "base64").toString("utf8") === "false"
      ) {
        await this.rejectLink(
          id,
          linkRejectionReason(sent.outcome) ??
            "link_market returned false without reason",
          sent.txHash,
        );
        return;
      }
      if (action === "link_market")
        this.rejections.clear("link", Number(args.market_id));
      if (action === "void_unlinked") {
        this.rejections.clear("void", Number(args.market_id));
        this.voidSuccessUntilMs.set(
          Number(args.market_id),
          this.nowMs() + 5 * 60_000,
        );
      }
      this.counts.actions++;
      this.log(action, { id, tx_hash: sent.txHash, result: "ok" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (action === "link_market") {
        await this.rejectLink(id, message, undefined, false);
        return;
      }
      if (action === "void_unlinked") {
        if (
          /MethodNotFound|MethodResolveError|Contract method is not found/i.test(
            message,
          )
        ) {
          this.voidUnsupportedUntilMs = this.nowMs() + 60 * 60_000;
          this.log(action, {
            id,
            result: "unsupported",
            retry_at: new Date(this.voidUnsupportedUntilMs).toISOString(),
          });
          return;
        }
        const row = this.rejections.record(
          "void",
          Number(args.market_id),
          message,
          this.nowMs(),
        );
        this.log(action, {
          id,
          result: "rejected",
          reason: message,
          permanent: row.permanent === 1,
          next_retry_at:
            row.next_retry_at === null
              ? null
              : new Date(row.next_retry_at).toISOString(),
        });
        return;
      }
      if (
        /already linked|not due|not triggerable|observation not reached/i.test(
          message,
        )
      )
        this.log(action, { id, result: "skipped", error: message });
      else this.error(action, id, error);
    }
  }

  private async rejectLink(
    id: string,
    reason: string,
    txHash?: string,
    fromCallback = true,
  ): Promise<void> {
    const marketId = Number(id.slice("noa:".length));
    const classification = fromCallback
      ? classifyLinkRejection(reason)
      : "retryable";
    if (classification === "already_linked") {
      this.rejections.clear("link", marketId);
      const refreshed = await this.deps.court
        .market(marketId)
        .catch((error) => {
          this.error("refresh_linked_market", id, error);
          return null;
        });
      if (!refreshed)
        this.linkedRefreshUntilMs.set(marketId, this.nowMs() + 5 * 60_000);
      return;
    }
    const row = this.rejections.record(
      "link",
      marketId,
      reason,
      this.nowMs(),
      classification === "permanent",
    );
    this.updateRejectionCounts();
    this.log("link_market", {
      id,
      tx_hash: txHash,
      result: "rejected",
      reason,
      permanent: row.permanent === 1,
      next_retry_at:
        row.next_retry_at === null
          ? null
          : new Date(row.next_retry_at).toISOString(),
    });
  }
}
