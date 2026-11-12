import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import { renderRules } from "../src/spec/render.js";
import { examples } from "../src/guide.js";
import {
  CourtClient,
  findResolverHash,
  linkRejectionReason,
} from "../src/court/client.js";
import type { NearRpc } from "../src/near/rpc.js";

const config = loadConfig();
const available =
  existsSync(config.resolverWasm) && existsSync(config.wasmtimeBin);

describe.skipIf(!available)("real resolver lint", () => {
  it.each(Object.entries(examples))(
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
});
