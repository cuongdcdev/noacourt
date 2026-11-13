import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ActionHistory } from "../src/keeper/history.js";
import { lifecycle, nsIso, withIso } from "../src/status.js";

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
});
