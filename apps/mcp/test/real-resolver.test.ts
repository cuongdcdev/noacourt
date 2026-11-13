import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import { renderRules } from "../src/spec/render.js";
import { makeExamples } from "../src/guide.js";
import {
  CourtClient,
  findResolverHash,
  linkRejectionReason,
  outlayerRequestIdFromTx,
  outlayerRequestIdFromVerdict,
} from "../src/court/client.js";
import type { NearRpc } from "../src/near/rpc.js";

const config = loadConfig();
const available =
  existsSync(config.resolverWasm) && existsSync(config.wasmtimeBin);

describe.skipIf(!available)("real resolver lint", () => {
  it.each(Object.entries(makeExamples()))(
    "accepts guide example %s",
    async (_name, spec) => {
      const verdict = (await new WasmRunner(config).run(
        "lint",
        renderRules(spec).spec_json,
      )) as any;
      expect(verdict.mode).toBe("lint");
      expect(verdict.lint?.errors).toEqual([]);
      expect(verdict.lint?.ok).toBe(true);
    },
  );
  it("matches the published WASM_SHA256", async () => {
    const runner = new WasmRunner(config);
    expect(await runner.hash()).toBe(await runner.publishedHash());
  });
});

describe("Court resolver configuration", () => {
  it("reports an unpinned Project without claiming a hash match", async () => {
    const rpc = {
      view: vi.fn(async () => ({
        resolver_source: {
          Project: {
            project_id: "court-ops.noamarket.testnet/court-resolver",
            version_key: null,
          },
        },
        max_attempts: 3,
      })),
    } as unknown as NearRpc;
    const court = new CourtClient(config, rpc);
    expect(await court.refresh()).toBeNull();
    expect(court.resolverStatus()).toEqual({
      hash: null,
      note: "Court resolver unpinned (OutLayer project latest version)",
    });
    expect(await court.maxAttempts()).toBe(3);
  });
  it("accepts a pinned Project hash and legacy nested hashes", () => {
    const hash = "a".repeat(64);
    expect(findResolverHash({ Project: { version_key: hash } })).toBe(
      `sha256:${hash}`,
    );
    expect(findResolverHash({ WasmUrl: { sha256: `sha256:${hash}` } })).toBe(
      `sha256:${hash}`,
    );
  });
  it("extracts a link_rejected reason from Court logs", () => {
    const outcome = {
      receipts_outcome: [
        {
          outcome: {
            logs: [
              'EVENT_JSON:{"event":"link_rejected","data":{"reason":"spec not registered"}}',
            ],
          },
        },
      ],
    };
    expect(linkRejectionReason(outcome)).toBe("spec not registered");
  });
  it("refreshes Court config and WASM hashes every interval while retaining the last good config", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-13T08:00:00Z"));
    const dataDir = mkdtempSync(join(tmpdir(), "court-refresh-"));
    const wasmPath = join(dataDir, "resolver.wasm");
    const hashPath = join(dataDir, "WASM_SHA256");
    writeFileSync(wasmPath, "wasm-one");
    writeFileSync(hashPath, "a".repeat(64));
    const localConfig = {
      ...config,
      dataDir,
      resolverWasm: wasmPath,
      publishedWasmHashFile: hashPath,
      courtConfigRefreshMs: 1000,
      keeperEnabled: false,
    };
    const first = {
      max_attempts: 3,
      min_deposit: "100",
      resolver_source: { Project: { version_key: "a".repeat(64) } },
    };
    const third = {
      max_attempts: 5,
      min_deposit: "200",
      resolver_source: { Project: { version_key: "b".repeat(64) } },
    };
    const rpc = {
      view: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockRejectedValueOnce(new Error("RPC down"))
        .mockResolvedValueOnce(third),
    } as unknown as NearRpc;
    const court = new CourtClient(localConfig, rpc);
    const wasm = new WasmRunner(localConfig, async () => ({}));
    const published = vi.spyOn(wasm, "publishedHash");
    const app = createApp(localConfig, { rpc, court, wasm });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(court.configStatus()).toMatchObject({
        fetched_at: "2026-11-13T08:00:00.000Z",
        last_error: null,
        max_attempts: 3,
        min_deposit: "100",
      });
      expect(court.resolverHash()).toBe(`sha256:${"a".repeat(64)}`);
      const initialHash = await wasm.hash();
      writeFileSync(wasmPath, "wasm-two");
      utimesSync(
        wasmPath,
        new Date("2026-11-13T08:00:01Z"),
        new Date("2026-11-13T08:00:01Z"),
      );
      writeFileSync(hashPath, "b".repeat(64));
      await vi.advanceTimersByTimeAsync(1000);
      expect(court.configStatus()).toMatchObject({
        fetched_at: "2026-11-13T08:00:00.000Z",
        last_error: "RPC down",
        max_attempts: 3,
        min_deposit: "100",
      });
      expect(await court.configView()).toMatchObject(first);
      expect(await wasm.hash()).not.toBe(initialHash);
      expect(await wasm.publishedHash()).toBe(`sha256:${"b".repeat(64)}`);
      await vi.advanceTimersByTimeAsync(1000);
      expect(court.configStatus()).toMatchObject({
        fetched_at: "2026-11-13T08:00:02.000Z",
        last_error: null,
        max_attempts: 5,
        min_deposit: "200",
      });
      expect(court.resolverHash()).toBe(`sha256:${"b".repeat(64)}`);
      expect(published).toHaveBeenCalledTimes(4);
    } finally {
      app.close();
      vi.useRealTimers();
    }
  });
  it("finds the OutLayer request ID in verdict metadata or trigger events", () => {
    expect(
      outlayerRequestIdFromVerdict({ outlayer: { request: { id: 88 } } }),
    ).toBe("88");
    expect(
      outlayerRequestIdFromVerdict({
        outlayer: {
          contract: "outlayer.testnet",
          source: { Project: { project_id: "x" } },
        },
      }),
    ).toBeNull();
    const event = {
      standard: "near-outlayer",
      event: "execution_requested",
      data: [{ request_data: JSON.stringify({ request_id: 37444 }) }],
    };
    expect(
      outlayerRequestIdFromTx({
        receipts_outcome: [
          { outcome: { logs: [`EVENT_JSON:${JSON.stringify(event)}`] } },
        ],
      }),
    ).toBe("37444");
  });
});
