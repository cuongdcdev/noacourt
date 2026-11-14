import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { renderRules } from "../src/spec/render.js";
import { examples } from "../src/guide.js";
import {
  composeNoaRules,
  renderNoaRules,
  validateNoaRules,
} from "../src/spec/noaRules.js";
import { SignStore } from "../src/sign/store.js";
import { createSignRequest } from "../src/sign/service.js";
import { createApp } from "../src/server.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import type { NearRpc } from "../src/near/rpc.js";
import type { CourtClient } from "../src/court/client.js";
import type { KeeperSigner } from "../src/near/signer.js";

const baseConfig = loadConfig();
const clone = (value: unknown) => structuredClone(value) as any;
const A1 = {
  ...clone(examples.A1),
  question: "Will NEAR/USDT close at least 3.10?",
  observation: { at: "2026-11-14T19:28:00Z", mode: "historical", max_delay: "30m" },
  decide: { kind: "threshold", op: ">=", value: "3.10" },
};
const GOOD = `Resolves Yes if the NEAR/USDT 1-minute candle close at 19:28 UTC on 14 Nov 2026 is ≥ 3.10; otherwise No.

Source: Binance NEARUSDT 1m close. OKX NEAR-USDT is the fallback, used only if Binance has no valid price.
If no valid price is available after 5 attempts (every 3 min), the market is voided and all bets are refunded.`;

describe("noa_rules validation", () => {
  it("accepts the good example without warnings", () => {
    const checked = validateNoaRules(GOOD, A1);
    expect(checked.text).toBe(GOOD);
    expect(checked.warnings).toEqual([]);
  });
  it("rejects markdown, JSON, backticks, size, missing outcome and missing void rule", () => {
    expect(() => validateNoaRules(`# Rules\n${GOOD}`, A1)).toThrow(/markdown/);
    expect(() =>
      validateNoaRules(`${GOOD}\n{"interval":"1m"}`, A1),
    ).toThrow(/JSON/);
    expect(() => validateNoaRules(`${GOOD} [x]`, A1)).toThrow(/JSON/);
    expect(() => validateNoaRules(`${GOOD} \`x\``, A1)).toThrow(/backticks/);
    expect(() => validateNoaRules("Too short.", A1)).toThrow(/40-1200/);
    expect(() => validateNoaRules("x ".repeat(700), A1)).toThrow(/40-1200/);
    expect(() =>
      validateNoaRules(GOOD.replace("; otherwise No.", "."), A1),
    ).toThrow(/outcome label.*"No"/);
    expect(() =>
      validateNoaRules(
        GOOD.replace(
          "the market is voided and all bets are refunded",
          "the result is retried",
        ),
        A1,
      ),
    ).toThrow(/voided/);
    expect(() =>
      validateNoaRules(`${GOOD}\nSpec sha256:abc`, A1),
    ).toThrow(/footer/);
  });
  it("gives soft warnings for time, threshold and contradictory comparison", () => {
    const text =
      "Resolves Yes if the NEAR/USDT close is below the level; otherwise No. If no price is available the market is voided and bets are refunded.";
    const { warnings } = validateNoaRules(text, A1);
    expect(warnings.join("\n")).toContain("19:28 UTC");
    expect(warnings.join("\n")).toContain("14 Nov 2026");
    expect(warnings.join("\n")).toContain("threshold 3.10");
    expect(warnings.join("\n")).toContain('comparison ">="');
  });
});

describe("renderNoaRules (noa-rules-v1)", () => {
  it("threshold with primary/fallback and void", () => {
    expect(renderNoaRules(A1)).toBe(`Resolves Yes if the NEAR/USDT 1-minute candle close at 19:28 UTC on 14 Nov 2026 is ≥ 3.10; otherwise No.

Source: Binance NEARUSDT 1m close. OKX NEAR-USDT 1m close is the fallback, used only if Binance has no valid price.
If no valid price is available after 5 attempts (every 3 min), the market is voided and all bets are refunded.`);
  });
  it("renders every threshold operator", () => {
    for (const [op, symbol] of [
      [">", "> 3.10"],
      ["<=", "≤ 3.10"],
      ["<", "< 3.10"],
      [">=", "≥ 3.10"],
    ])
      expect(
        renderNoaRules({ ...A1, decide: { ...A1.decide, op } }),
      ).toContain(`is ${symbol};`);
  });
  it("buckets with median, custom retry and custom labels", () => {
    const spec = {
      ...clone(examples.A2),
      observation: A1.observation,
      aggregate: { method: "median" },
      retry: { max_attempts: 2, every: "1h" },
    };
    const text = renderNoaRules(spec);
    expect(text).toBe(`The BTC/USDT 1-minute candle close at 19:28 UTC on 14 Nov 2026 decides the outcome: Below if it is below 99900; Middle if it is 99900 or more but below 100100; Above if it is 100100 or more.

Sources: Binance BTCUSDT 1m close and OKX BTC-USDT 1m close. The median is used (at least half of the sources must respond).
If no valid price is available after 2 attempts (every 1 hour), the market is voided and all bets are refunded.`);
    expect(validateNoaRules(text, spec).warnings).toEqual([]);
  });
  it("all_agree tolerance and a default-outcome unavailable policy", () => {
    const text = renderNoaRules({
      ...A1,
      aggregate: { method: "all_agree", tolerance: "0.5%" },
      outcomes: ["Up", "Down"],
      outcome_map: { true: "Up", false: "Down" },
      on_unavailable: "Down",
    });
    expect(text).toContain("Resolves Up if");
    expect(text).toContain("otherwise Down.");
    expect(text).toContain("All must respond and agree within 0.5%");
    expect(text).toContain("the market resolves Down.");
    expect(text).not.toContain("refunded");
  });
  it("text_judge describes three jurors and the no-evidence default", () => {
    const spec = {
      ...clone(examples.A8),
      observation: A1.observation,
      decide: {
        ...clone(examples.A8.decide),
        window: { from: "2026-11-14T10:00:00Z", to: "2026-11-14T19:28:00Z" },
      },
    };
    const text = renderNoaRules(spec);
    expect(text).toContain(
      "Resolves Yes if three AI jurors all agree (each at least 70% confident, quoting the evidence) that: Did the publisher announce that Noa Court v2 shipped?",
    );
    expect(text).toContain(
      "published between 10:00 UTC on 14 Nov 2026 and 19:28 UTC on 14 Nov 2026; if there is none, the result is No.",
    );
    expect(text).toContain("Evidence: RSS/Atom feed at gist.githubusercontent.com.");
    expect(text).toContain("If no valid verdict is available after 5 attempts (every 3 min), the market resolves No.");
    expect(text.length).toBeLessThanOrEqual(1200);
  });
});

describe("noa_rules freezing and /spec/:hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "noacourt-noa-"));
  const wasmPath = join(dir, "fake.wasm");
  writeFileSync(wasmPath, "fake");
  const config = {
    ...baseConfig,
    dataDir: dir,
    resolverWasm: wasmPath,
    publicBaseUrl: "https://court.noamarket.xyz",
    keeperEnabled: false,
    nearNetwork: "testnet",
    noaApiUrl: "",
    noaAuthRecipient: "",
    noaMarketUrlBase: "",
    rateLimitPerMin: 1000,
  } as any;
  const future = new Date(Date.now() + 3 * 3600_000);
  future.setUTCSeconds(0, 0);
  const spec = { ...clone(examples.A1), observation: { at: future.toISOString().replace(".000Z", "Z"), mode: "historical", max_delay: "30m" } };
  const rendered = renderRules(spec);
  const hex = rendered.spec_hash.slice(7);
  const params = {
    spec_json: rendered.spec_json,
    spec_hash: rendered.spec_hash,
    title: "NEAR market",
    outcomes: ["Yes", "No"],
    stake: "5",
    duration_minutes: 10,
  };
  let chain: "ok" | "fail" | "none" = "ok";
  const rpc = { view: vi.fn(async () => null), txStatus: vi.fn() } as unknown as NearRpc;
  const court = {
    resolverHash: () => null,
    maxAttempts: async () => 4,
    configView: async () => ({}),
    market: async () => null,
    verdict: async () => null,
    spec: async (h: string) => {
      if (chain === "fail") throw new Error("rpc down");
      if (chain === "none" || h !== rendered.spec_hash) return null;
      return { spec_json: rendered.spec_json, spec_hash: h, registered_by: "alice.testnet" };
    },
  } as unknown as CourtClient;
  const signer = { send: vi.fn() } as unknown as Pick<KeeperSigner, "send">;
  const wasm = new WasmRunner(config, async (_i, mode) =>
    mode === "lint" ? { ok: true, errors: [] } : { outcome: "Yes" },
  );
  let server: Server, base: string, close: () => void, store: SignStore;
  beforeAll(async () => {
    store = new SignStore(config);
    const instance = createApp(config, { store, rpc, court, signer, wasm });
    close = instance.close;
    server = await new Promise((resolve) => {
      const s = instance.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
  });

  it("appends the server footer, freezes it and keeps the digest stable across reload", async () => {
    const created = await createSignRequest(config, store, {
      ...params,
      noa_rules: GOOD.replace("19:28", "00:00"),
    } as any);
    const id = created.url.split("/").at(-1)!;
    const frozen = store.get(id)!.snapshot!;
    expect(frozen.rules).toBe(
      composeNoaRules(
        GOOD.replace("19:28", "00:00"),
        rendered.spec_hash,
        config.publicBaseUrl,
      ),
    );
    expect(frozen.rules).toMatch(
      new RegExp(
        `\\n\\nResolved by Noa Court in an OutLayer TEE\\. Spec sha256:${hex}\\nFull rules: https://court\\.noamarket\\.xyz/spec/${hex}$`,
      ),
    );
    expect(frozen.renderer_version).toBe("noa-rules-v1");
    expect(created.noa_rules_generated).toBe(false);
    expect(created.warnings.join(" ")).toContain("observation time");
    expect(created.metadata_digest).toBe(frozen.metadata_digest);
    const reopened = new SignStore(config);
    expect(reopened.get(id)!.snapshot).toEqual(frozen);
    reopened.close();
    const api = (await (await fetch(`${base}/api/sign/${id}`)).json()) as any;
    expect(api.noa_rules).toBe(frozen.rules);
    expect(api.rules_markdown).toBe(rendered.rules_markdown);
    expect(api.metadata_digest).toBe(frozen.metadata_digest);
  });
  it("rejects invalid noa_rules at link creation", async () => {
    await expect(
      createSignRequest(config, store, { ...params, noa_rules: "# bad\n" + GOOD } as any),
    ).rejects.toThrow(/markdown/);
  });

  it("serves the spec page from the chain, escaped", async () => {
    chain = "ok";
    for (const key of [hex, `sha256:${hex}`, hex.toUpperCase()]) {
      const response = await fetch(`${base}/spec/${key}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-source="chain"');
      expect(html).toContain(`sha256:${hex}`);
      expect(html).toContain("Resolved by Noa Court in an OutLayer TEE");
      expect(html).toContain("ai-resolver.noamarket.testnet");
      expect(html).toContain("https://testnet.nearblocks.io/address/");
      expect(html).not.toMatch(/<script>alert/);
    }
  });
  it("rejects bad input and unknown hashes", async () => {
    chain = "ok";
    expect((await fetch(`${base}/spec/abc`)).status).toBe(400);
    expect((await fetch(`${base}/spec/${"g".repeat(64)}`)).status).toBe(400);
    expect((await fetch(`${base}/spec/%3Cscript%3E`)).status).toBe(400);
    expect((await fetch(`${base}/spec/${"0".repeat(64)}`)).status).toBe(404);
    chain = "none";
    expect((await fetch(`${base}/spec/${hex}`)).status).toBe(404);
  });
  it("falls back to the labelled local store when the chain read fails", async () => {
    await createSignRequest(config, store, params as any);
    chain = "fail";
    const response = await fetch(`${base}/spec/${hex}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-source="local"');
    expect((await fetch(`${base}/spec/${"1".repeat(64)}`)).status).toBe(502);
    chain = "ok";
  });
});
