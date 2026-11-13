import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import {
  buildCreateMarketTxs,
  decimalToUnits,
  effectiveAttempts,
  parseCreateMarketResult,
  requiredResolutionWindowMinutes,
} from "../src/lib.js";
import { renderRules } from "../src/spec/render.js";
import { examples } from "../src/guide.js";
import { SignStore } from "../src/sign/store.js";
import { createSignRequest } from "../src/sign/service.js";
import { createApp } from "../src/server.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import type { NearRpc } from "../src/near/rpc.js";
import type { CourtClient } from "../src/court/client.js";
import type { KeeperSigner } from "../src/near/signer.js";
import { calculateSignTiming } from "../src/sign/timing.js";

const hash = `sha256:${"a".repeat(64)}`;
const basic = {
  spec_json: '{"version":1,"observation":{"at":"2099-01-01T00:00:00Z"}}',
  spec_hash: hash,
  title: "NEAR above $3",
  outcomes: ["Yes", "No"],
  stake: "1.000000000000000001",
  court_contract: "court.testnet",
  noa_contract: "noa.testnet",
  duration_minutes: 10,
  expiration_estimate_at: "2099-01-01T00:00:00Z",
};
const fixtureDir = () => mkdtempSync(join(tmpdir(), "noacourt-sign-"));

describe("transaction builder", () => {
  it("caps spec retry attempts at Court max_attempts", () => {
    expect(effectiveAttempts(5, 3)).toBe(3);
    expect(effectiveAttempts(2, 4)).toBe(2);
    expect(effectiveAttempts(undefined, 4)).toBe(4);
    expect(effectiveAttempts(6, undefined)).toBe(6);
    expect(effectiveAttempts()).toBe(5);
    const txs = buildCreateMarketTxs({
      ...basic,
      spec_json: JSON.stringify({
        observation: { at: basic.expiration_estimate_at },
        retry: { max_attempts: 5, every: "3m" },
      }),
      court_max_attempts: 3,
    });
    expect(txs.at(-1)?.actions[0].params.args.resolution_window_minutes).toBe(
      16,
    );
  });
  it("rebuilds signing duration with a margin and refuses late signing", () => {
    const observation = "2026-11-13T08:40:00Z";
    const early = calculateSignTiming({
      observation_at: observation,
      requested_close_at: observation,
      now_ms: Date.parse("2026-11-13T08:30:36Z"),
      sign_margin_minutes: 3,
    });
    expect(early.duration_minutes).toBe(6);
    expect(early.expiration_estimate_at).toBe("2026-11-13T08:36:36.000Z");
    expect(early.sign_before).toBe("2026-11-13T08:32:00.000Z");
    expect(
      requiredResolutionWindowMinutes(
        observation,
        early.expiration_estimate_at,
        5,
        "3m",
      ),
    ).toBe(26);
    expect(() =>
      calculateSignTiming({
        observation_at: observation,
        requested_close_at: observation,
        now_ms: Date.parse("2026-11-13T08:32:00Z"),
        sign_margin_minutes: 3,
      }),
    ).toThrow("Signing deadline passed");
    const earlierClose = calculateSignTiming({
      observation_at: observation,
      requested_close_at: "2026-11-13T08:35:00Z",
      now_ms: Date.parse("2026-11-13T08:20:00Z"),
      sign_margin_minutes: 3,
    });
    expect(earlierClose.duration_minutes).toBe(15);
  });
  it("calculates retry windows with seconds, minutes, hours, days and fallback attempts", () => {
    const observation = "2026-11-13T08:40:00Z";
    expect(
      requiredResolutionWindowMinutes(observation, observation, 5, "3m"),
    ).toBe(22);
    expect(
      requiredResolutionWindowMinutes(
        observation,
        "2026-11-13T08:36:36Z",
        5,
        "3m",
      ),
    ).toBe(26);
    expect(
      requiredResolutionWindowMinutes(observation, observation, 10, "45s"),
    ).toBe(15);
    expect(
      requiredResolutionWindowMinutes(observation, observation, 2, "2h"),
    ).toBe(247);
    expect(
      requiredResolutionWindowMinutes(observation, observation, 1, "1d"),
    ).toBe(1447);
    expect(() =>
      requiredResolutionWindowMinutes(observation, observation, 5, "5x"),
    ).toThrow("retry.every");
  });
  it("uses the required minute window for day-duration markets and rejects a shorter direct plan", () => {
    const dayMarket = buildCreateMarketTxs({
      ...basic,
      spec_json: JSON.stringify({
        observation: { at: basic.expiration_estimate_at },
        retry: { max_attempts: 3, every: "5m" },
      }),
      duration_minutes: undefined,
      duration_days: 1,
    });
    expect(dayMarket.at(-1)?.actions[0].params.args).toMatchObject({
      duration_days: 1,
      duration_minutes: null,
      resolution_window_minutes: 22,
    });
    expect(() =>
      buildCreateMarketTxs({
        ...basic,
        spec_json: JSON.stringify({
          observation: { at: basic.expiration_estimate_at },
          retry: { max_attempts: 3, every: "5m" },
        }),
        resolution_window_minutes: 10,
      }),
    ).toThrow("at least 22");
  });
  it("converts token amounts exactly without floating point", () => {
    expect(decimalToUnits("1.000000000000000001", 18)).toBe(
      "1000000000000000001",
    );
    expect(decimalToUnits("9007199254740993.123456789012345678", 18)).toBe(
      "9007199254740993123456789012345678",
    );
    expect(() => decimalToUnits("1.0000000000000000001", 18)).toThrow(
      "more than 18",
    );
  });
  it("builds exact Court and Noa transactions and optional transfer", () => {
    const txs = buildCreateMarketTxs({
      ...basic,
      internal_balance_yocto: "1",
      signer_id: "alice.testnet",
      register_deposit_yocto: "200",
      create_market_deposit_yocto: "300",
    });
    expect(txs).toHaveLength(3);
    expect(txs[0]).toEqual({
      signerId: "alice.testnet",
      receiverId: "point.noamarket.testnet",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer_call",
            args: {
              receiver_id: "noa.testnet",
              amount: "1000000000000000000",
              msg: "",
            },
            gas: "100000000000000",
            deposit: "1",
          },
        },
      ],
    });
    expect(txs[1].actions[0].params).toEqual({
      methodName: "register_spec",
      args: { spec_json: basic.spec_json },
      gas: "100000000000000",
      deposit: "200",
    });
    expect(txs[2].actions[0].params).toEqual({
      methodName: "create_market",
      args: {
        title: basic.title,
        metadata_hash: `noacourt:${hash}`,
        token_id: "point.noamarket.testnet",
        stake_amount: "1000000000000000001",
        outcomes: ["Yes", "No"],
        resolver: "court.testnet",
        duration_minutes: 10,
        duration_days: null,
        resolution_window_minutes: 22,
      },
      gas: "100000000000000",
      deposit: "300",
    });
    expect(buildCreateMarketTxs(basic)).toHaveLength(2);
  });
  it("decodes a market_id from base64 SuccessValue", () => {
    expect(
      parseCreateMarketResult({
        status: {
          SuccessValue: Buffer.from('{"market_id":42}').toString("base64"),
        },
      }),
    ).toEqual({ market_id: 42 });
    expect(() =>
      parseCreateMarketResult({ status: { SuccessValue: "" } }),
    ).toThrow("no SuccessValue");
  });
});

describe("sign request HTTP", () => {
  const dir = fixtureDir();
  const wasmPath = join(dir, "fake.wasm");
  writeFileSync(wasmPath, "fake");
  const config = {
    ...loadConfig(),
    dataDir: dir,
    resolverWasm: wasmPath,
    publicBaseUrl: "https://noacourtmcp.junstudio.xyz",
    keeperEnabled: false,
  };
  const rendered = renderRules(examples.A1);
  const params = {
    spec_json: rendered.spec_json,
    spec_hash: rendered.spec_hash,
    title: "NEAR market",
    outcomes: ["Yes", "No"],
    stake: "5",
    duration_minutes: 10,
  };
  const account = "alice.testnet";
  const registerHash = "1".repeat(32),
    createHash = "2".repeat(32);
  const rpc = {
    view: vi.fn(async (_contract: string, method: string) => {
      if (method === "is_fee_exempt") return true;
      if (method === "get_user_balance") return "0";
      if (method === "get_config")
        return { market_creation_fee: "500000000000000000000000" };
      return null;
    }),
    txStatus: vi.fn(async (hash: string) =>
      hash === registerHash
        ? {
            transaction: {
              signer_id: account,
              receiver_id: config.courtContract,
              actions: [
                {
                  FunctionCall: {
                    method_name: "register_spec",
                    args: Buffer.from(
                      JSON.stringify({ spec_json: rendered.spec_json }),
                    ).toString("base64"),
                  },
                },
              ],
            },
            status: { SuccessValue: "" },
          }
        : {
            transaction: {
              signer_id: account,
              receiver_id: config.noaContract,
              actions: [
                {
                  FunctionCall: {
                    method_name: "create_market",
                    args: Buffer.from(
                      JSON.stringify({
                        title: params.title,
                        metadata_hash: `noacourt:${rendered.spec_hash}`,
                        resolver: config.courtContract,
                        outcomes: params.outcomes,
                      }),
                    ).toString("base64"),
                  },
                },
              ],
            },
            status: {
              SuccessValue: Buffer.from('{"market_id":17}').toString("base64"),
            },
          },
    ),
  } as unknown as NearRpc;
  const court = {
    resolverHash: () => null,
    maxAttempts: vi.fn(async () => 4),
    configView: vi.fn(async () => ({
      min_deposit: "200000000000000000000000",
    })),
  } as unknown as CourtClient;
  const signer = {
    send: vi.fn(async () => ({
      txHash: "3".repeat(32),
      outcome: { status: { SuccessValue: "" } },
    })),
  } as unknown as Pick<KeeperSigner, "send">;
  const wasm = new WasmRunner(config, async (_input, mode) =>
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
  it("stores a full plan, returns a QR of exactly the sign URL, and serves the page", async () => {
    const created = await createSignRequest(config, store, params);
    expect(created.url).toMatch(
      /^https:\/\/noacourtmcp\.junstudio\.xyz\/sign\/[A-Za-z0-9_-]{22}$/,
    );
    expect(created.qr_png_data_url).toMatch(/^data:image\/png;base64,/);
    const id = created.url.split("/").at(-1)!;
    expect(
      store.get(id)?.tx_plan.at(-1)?.actions[0].params.args.metadata_hash,
    ).toBe(`noacourt:${rendered.spec_hash}`);
    const html = await (await fetch(`${base}/sign/${id}`)).text();
    expect(html).toContain("/public/sign.js");
    expect(html).toContain('id="sign-button"');
    const api = (await (await fetch(`${base}/api/sign/${id}`)).json()) as any;
    expect(api).toMatchObject({
      status: "pending",
      spec_hash: rendered.spec_hash,
      network: { networkId: "testnet" },
    });
    expect(api.rules_markdown).toContain("NEAR");
    const plan = (await (
      await fetch(`${base}/api/sign/${id}/plan?account=${account}`)
    ).json()) as any;
    expect(plan.tx_plan).toHaveLength(3);
    expect(plan.tx_plan[1].actions[0].params.deposit).toBe(
      "200000000000000000000000",
    );
    expect(plan.tx_plan[2].actions[0].params.deposit).toBe("0");
    const complete = (await (
      await fetch(`${base}/api/sign/${id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account_id: account,
          tx_hashes: [registerHash, createHash],
        }),
      })
    ).json()) as any;
    expect(complete).toMatchObject({
      market_id: 17,
      linked: true,
      tx_hashes: [registerHash, createHash],
    });
    expect(signer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        methodName: "link_market",
        args: { market_id: 17, spec_hash: null },
      }),
    );
  });
  it("rebuilds the plan from current time instead of reusing the stored transaction", async () => {
    const created = await createSignRequest(config, store, params);
    const id = created.url.split("/").at(-1)!;
    const storedDuration = store.get(id)!.tx_plan.at(-1)!.actions[0].params.args
      .duration_minutes as number;
    const actualNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(actualNow + 60_000);
    try {
      const response = await fetch(
        `${base}/api/sign/${id}/plan?account=${account}`,
      );
      expect(response.status).toBe(200);
      const plan = (await response.json()) as any;
      expect(
        plan.tx_plan.at(-1).actions[0].params.args.duration_minutes,
      ).toBeLessThan(storedDuration);
      expect(
        plan.tx_plan.at(-1).actions[0].params.args.resolution_window_minutes,
      ).toBeGreaterThanOrEqual(created.summary.resolution_window_minutes);
    } finally {
      clock.mockRestore();
    }
  });
  it("shows expired with no transaction button", async () => {
    const request = store.create(
      params,
      rendered.spec_json,
      rendered.spec_hash,
      buildCreateMarketTxs({
        ...params,
        court_contract: config.courtContract,
        noa_contract: config.noaContract,
      }),
    );
    store.expire(request.id);
    const html = await (await fetch(`${base}/sign/${request.id}`)).text();
    expect(html).toContain('id="state">expired');
    expect(html).not.toContain('id="sign-button"');
    expect((await fetch(`${base}/api/sign/${request.id}`)).status).toBe(410);
    const plan = await fetch(
      `${base}/api/sign/${request.id}/plan?account=${account}`,
    );
    expect(plan.status).toBe(409);
    expect((await plan.json()).error).toContain("signing deadline passed");
  });
  it("returns a real pending sign link from the MCP tool", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "market_create_link",
          arguments: {
            title: "NEAR market",
            outcomes: ["Yes", "No"],
            stake: "5",
            duration_minutes: 10,
            spec: examples.A1,
          },
        },
      }),
    });
    const data = (await response.json()) as any;
    expect(data.result.isError).not.toBe(true);
    const link = JSON.parse(data.result.content[0].text);
    expect(link.url).toContain("/sign/");
    expect(link.qr_png_data_url).toMatch(/^data:image\/png;base64,/);
    expect(link.summary.resolution_window_minutes).toBeGreaterThanOrEqual(22);
    expect(link.warnings.join(" ")).toContain(
      "choose a later observation time",
    );
    const request = store.get(link.url.split("/").at(-1)!)!;
    expect(link.spec_hash).toBe(rendered.spec_hash);
    expect(request.spec_json).toBe(rendered.spec_json);
    expect(
      request.tx_plan.find((tx) => tx.receiverId === config.courtContract)
        ?.actions[0].params.args.spec_json,
    ).toBe(rendered.spec_json);
    expect(request.status).toBe("pending");
    expect(
      request.tx_plan.at(-1)?.actions[0].params.args.resolution_window_minutes,
    ).toBe(link.summary.resolution_window_minutes);
  });
  it("recomputes a mismatched incoming rules hash and keeps the rendered spec hash", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: {
          name: "market_create_link",
          arguments: {
            title: "NEAR market",
            outcomes: ["Yes", "No"],
            stake: "5",
            duration_minutes: 10,
            spec: {
              ...examples.A1,
              rules_text_hash: `sha256:${"0".repeat(64)}`,
            },
          },
        },
      }),
    });
    const body = (await response.json()) as any;
    expect(body.result.isError).not.toBe(true);
    const link = JSON.parse(body.result.content[0].text);
    expect(link.spec_hash).toBe(rendered.spec_hash);
    expect(link.warnings.join(" ")).toContain("rules_text_hash differed");
  });
  it("warns and raises an explicit short window in the stored sign plan", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "market_create_link",
          arguments: {
            title: "NEAR market",
            outcomes: ["Yes", "No"],
            stake: "5",
            duration_minutes: 10,
            resolution_window_minutes: 10,
            spec: examples.A1,
          },
        },
      }),
    });
    const data = (await response.json()) as any;
    expect(data.result.isError).not.toBe(true);
    const link = JSON.parse(data.result.content[0].text);
    expect(link.summary.resolution_window_minutes).toBeGreaterThanOrEqual(22);
    expect(link.warnings).toHaveLength(2);
    expect(link.warnings[0]).toContain(
      `raised to ${link.summary.resolution_window_minutes} minutes`,
    );
    expect(link.text).toContain(
      `raised to ${link.summary.resolution_window_minutes} minutes`,
    );
    const id = link.url.split("/").at(-1)!;
    expect(
      store.get(id)?.tx_plan.at(-1)?.actions[0].params.args
        .resolution_window_minutes,
    ).toBe(link.summary.resolution_window_minutes);
    const publicData = (await (
      await fetch(`${base}/api/sign/${id}`)
    ).json()) as any;
    expect(publicData.params.resolution_window_minutes).toBe(
      link.summary.resolution_window_minutes,
    );
    const plan = (await (
      await fetch(`${base}/api/sign/${id}/plan?account=${account}`)
    ).json()) as any;
    expect(
      plan.tx_plan.at(-1).actions[0].params.args.resolution_window_minutes,
    ).toBeGreaterThanOrEqual(link.summary.resolution_window_minutes);
  });
  it("uses Court max_attempts when the input spec omits it", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: {
          name: "market_create_link",
          arguments: {
            title: "NEAR market",
            outcomes: ["Yes", "No"],
            stake: "5",
            duration_minutes: 10,
            spec: { ...examples.A1, retry: { every: "5m" } },
          },
        },
      }),
    });
    const data = (await response.json()) as any;
    expect(data.result.isError).not.toBe(true);
    const link = JSON.parse(data.result.content[0].text);
    expect(link.summary.resolution_window_minutes).toBeGreaterThanOrEqual(30);
    const request = store.get(link.url.split("/").at(-1)!)!;
    expect(JSON.parse(request.spec_json).retry).toEqual({
      max_attempts: 5,
      every: "5m",
    });
    expect(
      request.tx_plan.at(-1)?.actions[0].params.args.resolution_window_minutes,
    ).toBe(link.summary.resolution_window_minutes);
    expect(court.maxAttempts).toHaveBeenCalled();
  });
  it("fills the whole default retry policy using Court's attempt count", async () => {
    const { retry: _retry, ...withoutRetry } = examples.A1;
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: {
          name: "market_create_link",
          arguments: {
            title: "NEAR market",
            outcomes: ["Yes", "No"],
            stake: "5",
            duration_minutes: 10,
            spec: withoutRetry,
          },
        },
      }),
    });
    const data = (await response.json()) as any;
    expect(data.result.isError).not.toBe(true);
    const link = JSON.parse(data.result.content[0].text);
    expect(link.summary.resolution_window_minutes).toBeGreaterThanOrEqual(22);
    const request = store.get(link.url.split("/").at(-1)!)!;
    expect(JSON.parse(request.spec_json).retry).toEqual({
      max_attempts: 5,
      every: "3m",
    });
  });
});
