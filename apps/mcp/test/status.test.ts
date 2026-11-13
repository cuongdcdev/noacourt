import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ActionHistory } from "../src/keeper/history.js";
import {
  annotateReceiptSources,
  lifecycle,
  marketTopLevelStatus,
  nsIso,
  withIso,
} from "../src/status.js";

describe("status history and lifecycle", () => {
  it("persists actions, backfills keeper logs, and supplies explorer links", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "noacourt-actions-"));
    writeFileSync(
      join(dataDir, "keeper.log"),
      JSON.stringify({
        ts: "2026-11-13T08:00:00Z",
        id: "noa:75",
        action: "trigger",
        tx_hash: "a".repeat(32),
        status: "success",
      }) + "\n",
    );
    const config = { ...loadConfig(), dataDir };
    const first = new ActionHistory(config);
    first.record({
      item_id: "noa:75",
      action: "finalize_resolution",
      tx_hash: "b".repeat(32),
      status: "success",
      error: null,
      ts: "2026-11-13T09:00:00Z",
    });
    first.recordLinkRejection(
      76,
      "expiration after observation",
      "c".repeat(32),
    );
    first.close();
    const second = new ActionHistory(config);
    expect(second.forItem("noa:75").map((entry) => entry.action)).toEqual([
      "trigger",
      "finalize_resolution",
    ]);
    expect(second.forItem("noa:75")[0].tx_url).toContain(
      "testnet.nearblocks.io/txns/",
    );
    expect(second.linkRejection(76)).toMatchObject({
      reason: "expiration after observation",
      permanent: true,
      tx_hash: "c".repeat(32),
      tx_url: expect.stringContaining("testnet.nearblocks.io/txns/"),
    });
    second.close();
  });

  it("adds UTC siblings to nanosecond fields and explains dispute finalization", () => {
    const ns = "1794559200000000000";
    expect(nsIso(ns)).toBe("2026-11-13T08:40:00.000Z");
    expect(nsIso(0)).toBeNull();
    expect(nsIso(null)).toBeNull();
    expect(withIso({ retry_at_ns: "0", observation_at_ns: null })).toEqual({
      retry_at_ns: "0",
      retry_at_ns_iso: null,
      observation_at_ns: null,
      observation_at_ns_iso: null,
    });
    expect(
      withIso({ expiration_time: ns, pending: { dispute_deadline: ns } }),
    ).toMatchObject({
      expiration_time_iso: "2026-11-13T08:40:00.000Z",
      pending: { dispute_deadline_iso: "2026-11-13T08:40:00.000Z" },
    });
    expect(
      lifecycle({
        noa: { status: "Active" },
        court: { status: "Resolved" },
        pending: { dispute_deadline: ns },
      }),
    ).toMatchObject({
      lifecycle: "dispute_window",
      next_step: expect.stringContaining("finalize_resolution"),
      next_action_at_utc: "2026-11-13T08:40:00.000Z",
    });
  });
  it("marks source use according to aggregate method and maps dispute/finalized status", () => {
    const verdict = {
      sources: [
        { id: "primary", ok: false, error: "unavailable", value: null },
        { id: "fallback", ok: true, error: null, value: "3.4" },
        { id: "third", ok: true, error: null, value: "3.5" },
      ],
    };
    const spec = {
      sources: [{ id: "primary" }, { id: "fallback" }, { id: "third" }],
      aggregate: { method: "primary_then_fallback" },
    };
    expect(
      (annotateReceiptSources(verdict, spec) as any).sources.map(
        (source: any) => source.used_for_decision,
      ),
    ).toEqual([false, true, false]);
    for (const method of ["median", "all_agree"]) {
      expect(
        (
          annotateReceiptSources(verdict, {
            ...spec,
            aggregate: { method },
          }) as any
        ).sources.map((source: any) => source.used_for_decision),
      ).toEqual([false, true, true]);
    }
    expect(
      (
        annotateReceiptSources(
          { verdict },
          { spec_json: JSON.stringify(spec) },
        ) as any
      ).verdict.sources[1].used_for_decision,
    ).toBe(true);
    expect(
      marketTopLevelStatus(
        { status: "Active" },
        { status: "Resolved" },
        { dispute_deadline: "1" },
        verdict,
      ),
    ).toBe("proposed_in_dispute_window");
    expect(
      marketTopLevelStatus(
        { status: "Resolved" },
        { status: "Resolved" },
        null,
        verdict,
      ),
    ).toBe("finalized");
  });
});
