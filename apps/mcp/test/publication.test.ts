import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verify as edVerify, createPublicKey } from "node:crypto";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { renderRules } from "../src/spec/render.js";
import { examples } from "../src/guide.js";
import { SignStore } from "../src/sign/store.js";
import { createSignRequest } from "../src/sign/service.js";
import {
  buildSnapshot,
  resolvePublicationConfig,
  MAINNET_NOA_DEFAULTS,
} from "../src/sign/publication.js";
import { createApp } from "../src/server.js";
import { WasmRunner } from "../src/resolver/wasm.js";
import type { NearRpc } from "../src/near/rpc.js";
import type { CourtClient } from "../src/court/client.js";
import type { KeeperSigner } from "../src/near/signer.js";
import {
  base58Decode,
  noaLogin,
  normalizeSignature,
  recoverPublication,
  type PublicationPayload,
} from "../src/sign/page/noaPublish.js";
import {
  base58Encode,
  keySigner,
  nep413Digest,
  parseSecretKey,
} from "../src/sign/nep413.js";

const baseConfig = loadConfig();
const cfg = (over: Record<string, unknown>) =>
  ({ ...baseConfig, ...over }) as any;

describe("publication config", () => {
  it("is disabled when absent on testnet", () => {
    expect(
      resolvePublicationConfig(
        cfg({
          nearNetwork: "testnet",
          noaApiUrl: "",
          noaAuthRecipient: "",
          noaMarketUrlBase: "",
        }),
      ),
    ).toMatchObject({ status: "disabled" });
  });
  it("uses mainnet defaults", () => {
    expect(
      resolvePublicationConfig(
        cfg({
          nearNetwork: "mainnet",
          noaApiUrl: "",
          noaAuthRecipient: "",
          noaMarketUrlBase: "",
        }),
      ),
    ).toEqual({
      status: "enabled",
      apiUrl: MAINNET_NOA_DEFAULTS.apiUrl,
      authRecipient: "noamarket.near",
      marketUrlBase: MAINNET_NOA_DEFAULTS.marketUrlBase,
    });
  });
  it("accepts localhost http with a testnet recipient", () => {
    expect(
      resolvePublicationConfig(
        cfg({
          nearNetwork: "testnet",
          noaApiUrl: "http://localhost:3401/",
          noaAuthRecipient: "noamarket.testnet",
          noaMarketUrlBase: "http://localhost:3411/markets/",
        }),
      ),
    ).toMatchObject({ status: "enabled", apiUrl: "http://localhost:3401" });
  });
  it.each([
    [
      "partial",
      {
        noaApiUrl: "https://x.example",
        noaAuthRecipient: "",
        noaMarketUrlBase: "",
      },
    ],
    [
      "plain http remote",
      {
        noaApiUrl: "http://evil.example",
        noaAuthRecipient: "noamarket.testnet",
        noaMarketUrlBase: "https://a.example/m/",
      },
    ],
    [
      "wrong network suffix",
      {
        noaApiUrl: "https://a.example",
        noaAuthRecipient: "noamarket.near",
        noaMarketUrlBase: "https://a.example/m/",
      },
    ],
    [
      "credentials in url",
      {
        noaApiUrl: "https://u:p@a.example",
        noaAuthRecipient: "noamarket.testnet",
        noaMarketUrlBase: "https://a.example/m/",
      },
    ],
    [
      "query in url",
      {
        noaApiUrl: "https://a.example?x=1",
        noaAuthRecipient: "noamarket.testnet",
        noaMarketUrlBase: "https://a.example/m/",
      },
    ],
  ])("is invalid: %s", (_name, over) => {
    expect(
      resolvePublicationConfig(cfg({ nearNetwork: "testnet", ...over })),
    ).toMatchObject({ status: "invalid" });
  });
});

describe("NEP-413 parity with Noa's reference implementation", () => {
  const nonce = Buffer.alloc(32, 0xab);
  const recipient = "noamarket.testnet";
  it("matches the reference digest vector", () => {
    // Vector produced by noamarket-monorepo packages/site-config .../create-market/auth.ts nep413Digest.
    expect(
      nep413Digest(
        `Login to Noa Market: ${nonce.toString("hex")}`,
        nonce,
        recipient,
      ).toString("hex"),
    ).toBe("cbe763cc97e9682061fdd7bd356f0714c7d2491532e57ede3c4a92e3fde02903");
  });
  it("signs deterministically like the reference and verifies", async () => {
    const secret = `ed25519:${base58Encode(Buffer.alloc(32, 7))}`;
    const signed = await keySigner(
      "alice.testnet",
      secret,
    )({
      message: `Login to Noa Market: ${nonce.toString("hex")}`,
      recipient,
      nonce,
    });
    expect(signed.publicKey).toBe(
      "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB",
    );
    expect(signed.signature).toBe(
      "0uhMKOF+VkcEeFZUXlc8PoFyE7i+V5pvtr9ws5ZsWBWWxiZG9dqFjRykSvVEwY95cIdNWmNJab9E+W52jVfUDw==",
    );
    const pub = base58Decode(signed.publicKey.slice(8));
    const keyObject = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]),
      format: "der",
      type: "spki",
    });
    expect(
      edVerify(
        null,
        nep413Digest(
          `Login to Noa Market: ${nonce.toString("hex")}`,
          nonce,
          recipient,
        ),
        keyObject,
        Buffer.from(signed.signature, "base64"),
      ),
    ).toBe(true);
  });
  it("normalizes wallet signature encodings to base64", () => {
    const bytes = Uint8Array.from([1, 2, 3, 250]);
    const b64 = Buffer.from(bytes).toString("base64");
    expect(normalizeSignature(bytes)).toBe(b64);
    expect(normalizeSignature(`ed25519:${base58Encode(bytes)}`)).toBe(b64);
    expect(normalizeSignature(b64)).toBe(b64);
  });
});

// ---- fake Noa --------------------------------------------------------------
const NONCE = "cd".repeat(32);
const payload: PublicationPayload = {
  market_id: 17,
  title: "T",
  outcomes: ["Yes", "No"],
  token_id: "point.noamarket.testnet",
  description: "desc",
  rules: "rules",
};
function fakeNoa(opts: { postStatuses?: number[]; loginStatus?: number } = {}) {
  const posts: any[] = [];
  const logins: any[] = [];
  let postCall = 0;
  const handler = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/auth/challenge")
      return Response.json({
        nonce: NONCE,
        message: `Login to Noa Market: ${NONCE}`,
      });
    if (path === "/auth/login") {
      logins.push(JSON.parse(String(init?.body)));
      return Response.json(
        { access_token: `tok${logins.length}` },
        { status: opts.loginStatus ?? 200 },
      );
    }
    if (path === "/v1/markets" && init?.method === "POST") {
      posts.push({
        headers: init.headers,
        body: JSON.parse(String(init.body)),
      });
      const status = (opts.postStatuses ?? [200])[
        Math.min(postCall++, (opts.postStatuses ?? [200]).length - 1)
      ];
      return Response.json(
        status === 200
          ? { status: postCall > 1 ? "already_published" : "created" }
          : { error: "x" },
        { status },
      );
    }
    return new Response("nf", { status: 404 });
  });
  return { fetch: handler as unknown as typeof fetch, posts, logins, handler };
}
const wallet = (accountId = "alice.testnet") => {
  const secret = `ed25519:${base58Encode(Buffer.alloc(32, 9))}`;
  const sign = keySigner(accountId, secret);
  return vi.fn(sign);
};
const common = {
  apiUrl: "http://noa.local",
  recipient: "noamarket.testnet",
  creator: "alice.testnet",
  payload,
  backoffMs: 1,
};
const noSleep = async () => {};

describe("noaPublish module", () => {
  it("logs in with the exact challenge, recipient and no callbackUrl, then publishes", async () => {
    const noa = fakeNoa();
    const signer = wallet();
    let verifies = 0;
    const result = await recoverPublication(
      { fetch: noa.fetch, signMessage: signer, sleep: noSleep },
      {
        ...common,
        verify: async () =>
          ++verifies === 1
            ? { verified: false, state: "not_started", reason: "missing" }
            : { verified: true, state: "published" },
      },
    );
    expect(result.state).toBe("published");
    expect(signer).toHaveBeenCalledTimes(1);
    const call = signer.mock.calls[0][0];
    expect(call.recipient).toBe("noamarket.testnet");
    expect(call.message).toBe(`Login to Noa Market: ${NONCE}`);
    expect(Buffer.from(call.nonce).toString("hex")).toBe(NONCE);
    expect(Object.keys(call)).not.toContain("callbackUrl");
    expect(noa.logins[0]).toMatchObject({
      accountId: "alice.testnet",
      nonce: NONCE,
    });
    expect(noa.posts[0].headers.authorization).toBe("Bearer tok1");
    expect(noa.posts[0].body).toEqual({
      market_id: 17,
      title: "T",
      outcomes: ["Yes", "No"],
      token_id: "point.noamarket.testnet",
      description: "desc",
      rules: "rules",
    });
    expect(noa.posts[0].body).not.toHaveProperty("market_status");
  });
  it("skips login and publish when read-back already matches", async () => {
    const noa = fakeNoa();
    const signer = wallet();
    const result = await recoverPublication(
      { fetch: noa.fetch, signMessage: signer },
      {
        ...common,
        verify: async () => ({ verified: true, state: "published" }),
      },
    );
    expect(result.state).toBe("published");
    expect(signer).not.toHaveBeenCalled();
    expect(noa.handler).not.toHaveBeenCalled();
  });
  it("treats an identical retry (200 already_published) as success path", async () => {
    const noa = fakeNoa({ postStatuses: [200, 200] });
    let verified = false;
    const run = () =>
      recoverPublication(
        { fetch: noa.fetch, signMessage: wallet(), sleep: noSleep },
        {
          ...common,
          verify: async () => ({
            verified,
            state: verified ? "published" : "not_started",
            reason: "missing",
          }),
          verifyAttempts: 1,
        },
      );
    expect((await run()).state).toBe("awaiting_verification");
    verified = true;
    expect((await run()).state).toBe("published");
  });
  it("stops on 409 conflict without retrying and without re-login", async () => {
    const noa = fakeNoa({ postStatuses: [409] });
    const report = vi.fn(async () => {});
    const result = await recoverPublication(
      { fetch: noa.fetch, signMessage: wallet(), sleep: noSleep },
      {
        ...common,
        report,
        verify: async () => ({
          verified: false,
          state: "not_started",
          reason: "missing",
        }),
      },
    );
    expect(result).toMatchObject({ state: "conflict", code: "http_409" });
    expect(noa.posts).toHaveLength(1);
    expect(noa.logins).toHaveLength(1);
    expect(report).toHaveBeenLastCalledWith("conflict", "http_409");
  });
  it("renews login once on 401, then does not loop", async () => {
    const ok = fakeNoa({ postStatuses: [401, 200] });
    const r1 = await recoverPublication(
      { fetch: ok.fetch, signMessage: wallet(), sleep: noSleep },
      {
        ...common,
        session: { accessToken: "stale", accountId: "alice.testnet" },
        verify: (() => {
          let n = 0;
          return async () =>
            ++n < 2
              ? { verified: false, state: "x", reason: "missing" }
              : { verified: true, state: "published" };
        })(),
      },
    );
    expect(r1.state).toBe("published");
    expect(ok.logins).toHaveLength(1);
    expect(ok.posts.map((p) => p.headers.authorization)).toEqual([
      "Bearer stale",
      "Bearer tok1",
    ]);
    const bad = fakeNoa({ postStatuses: [401, 401, 401] });
    const r2 = await recoverPublication(
      { fetch: bad.fetch, signMessage: wallet(), sleep: noSleep },
      {
        ...common,
        verify: async () => ({
          verified: false,
          state: "x",
          reason: "missing",
        }),
      },
    );
    expect(r2).toMatchObject({ state: "auth_required", code: "http_401" });
    expect(bad.posts.length).toBeLessThanOrEqual(2);
  });
  it("retries 5xx and 429 with bounded attempts", async () => {
    const noa = fakeNoa({ postStatuses: [503, 429, 200] });
    let n = 0;
    const sleep = vi.fn(noSleep);
    const result = await recoverPublication(
      { fetch: noa.fetch, signMessage: wallet(), sleep },
      {
        ...common,
        verify: async () =>
          n++ === 0
            ? { verified: false, state: "x", reason: "missing" }
            : { verified: true, state: "published" },
      },
    );
    expect(result.state).toBe("published");
    expect(noa.posts).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const always = fakeNoa({ postStatuses: [500] });
    const failed = await recoverPublication(
      { fetch: always.fetch, signMessage: wallet(), sleep: noSleep },
      {
        ...common,
        verify: async () => ({
          verified: false,
          state: "x",
          reason: "missing",
        }),
      },
    );
    expect(failed).toMatchObject({
      state: "retryable_error",
      code: "http_5xx",
    });
    expect(always.posts).toHaveLength(3);
  });
  it("403 means not the creator: stop, no retry", async () => {
    const noa = fakeNoa({ postStatuses: [403] });
    const result = await recoverPublication(
      { fetch: noa.fetch, signMessage: wallet(), sleep: noSleep },
      {
        ...common,
        verify: async () => ({
          verified: false,
          state: "x",
          reason: "missing",
        }),
      },
    );
    expect(result).toMatchObject({ state: "auth_required", code: "http_403" });
    expect(noa.posts).toHaveLength(1);
  });
  it("declined/unsupported/wrong-account login never posts", async () => {
    const noa = fakeNoa();
    const verify = async () => ({
      verified: false,
      state: "x",
      reason: "missing",
    });
    const declined = await recoverPublication(
      {
        fetch: noa.fetch,
        signMessage: async () => {
          throw new Error("User rejected");
        },
      },
      { ...common, verify },
    );
    expect(declined.code).toBe("declined");
    const unsupported = await recoverPublication(
      { fetch: noa.fetch },
      { ...common, verify },
    );
    expect(unsupported.code).toBe("unsupported");
    const wrong = await recoverPublication(
      { fetch: noa.fetch, signMessage: wallet("mallory.testnet") },
      { ...common, verify },
    );
    expect(wrong.code).toBe("account_mismatch");
    expect(noa.posts).toHaveLength(0);
    expect(noa.logins).toHaveLength(0);
  });
  it("refuses a challenge whose message does not match its nonce", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ nonce: NONCE, message: "Login to Evil: x" }),
    ) as unknown as typeof fetch;
    await expect(
      noaLogin(
        { fetch: fetchImpl, signMessage: wallet() },
        {
          apiUrl: "http://n",
          recipient: "r.testnet",
          expectedAccountId: "alice.testnet",
        },
      ),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
  it("discards a session that belongs to another account", async () => {
    const noa = fakeNoa();
    const signer = wallet();
    await recoverPublication(
      { fetch: noa.fetch, signMessage: signer, sleep: noSleep },
      {
        ...common,
        session: { accessToken: "other", accountId: "mallory.testnet" },
        verify: (() => {
          let n = 0;
          return async () =>
            n++
              ? { verified: true, state: "published" }
              : { verified: false, state: "x", reason: "missing" };
        })(),
      },
    );
    expect(signer).toHaveBeenCalled();
    expect(noa.posts[0].headers.authorization).toBe("Bearer tok1");
  });
});

// ---- server integration ----------------------------------------------------
describe("publication server flow", () => {
  const dir = mkdtempSync(join(tmpdir(), "noacourt-pub-"));
  const wasmPath = join(dir, "fake.wasm");
  writeFileSync(wasmPath, "fake");
  const config = {
    ...baseConfig,
    dataDir: dir,
    resolverWasm: wasmPath,
    publicBaseUrl: "https://noacourtmcp.junstudio.xyz",
    keeperEnabled: false,
    nearNetwork: "testnet",
    noaApiUrl: "http://localhost:3401",
    noaAuthRecipient: "noamarket.testnet",
    noaMarketUrlBase: "http://localhost:3411/markets/",
    publicationVerifyPerMin: 4,
  } as any;
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
  const rpc = {
    view: vi.fn(async () => null),
    txStatus: vi.fn(),
  } as unknown as NearRpc;
  const court = {
    resolverHash: () => null,
    maxAttempts: async () => 4,
    configView: async () => ({}),
    market: async () => null,
    verdict: async () => null,
    spec: async () => null,
  } as unknown as CourtClient;
  const signer = { send: vi.fn() } as unknown as Pick<KeeperSigner, "send">;
  const wasm = new WasmRunner(config, async (_i, mode) =>
    mode === "lint" ? { ok: true, errors: [] } : { outcome: "Yes" },
  );
  let noaMarket: Record<string, any> | null | "down" = null;
  const noaFetch = vi.fn(async (url: string) => {
    expect(url).toMatch(/^http:\/\/localhost:3401\/v1\/markets\/17$/);
    if (noaMarket === "down") throw new Error("ECONNREFUSED");
    if (noaMarket === null) return new Response("{}", { status: 404 });
    return Response.json(noaMarket);
  });
  let server: Server, base: string, close: () => void, store: SignStore;
  const complete = async (over: Record<string, unknown> = {}) => {
    const created = await createSignRequest(config, store, {
      ...params,
      ...over,
    } as any);
    const id = created.url.split("/").at(-1)!;
    store.complete(id, {
      market_id: 17,
      account_id: account,
      tx_hashes: ["a", "b"],
      linked: true,
      link_tx_hash: null,
      link_error: null,
    });
    return { id, created };
  };
  const verify = (id: string) =>
    fetch(`${base}/api/sign/${id}/publication/verify`, { method: "POST" });
  beforeAll(async () => {
    store = new SignStore(config);
    const instance = createApp(config, {
      store,
      rpc,
      court,
      signer,
      wasm,
      noaFetch: noaFetch as unknown as typeof fetch,
    });
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

  it("falls back to rendered rules when description is omitted and never alters the spec", async () => {
    const { id, created } = await createSignRequest(
      config,
      store,
      params as any,
    ).then((c) => ({ id: c.url.split("/").at(-1)!, created: c }));
    const request = store.get(id)!;
    expect(request.snapshot!.description).toBe(request.snapshot!.rules);
    // New links publish the human-readable Noa rules (generated here) + footer; the canonical rules stay the spec-derived text.
    expect(request.snapshot!.rules).toContain("Resolves Yes if");
    expect(request.snapshot!.renderer_version).toBe("noa-rules-v1");
    expect(created.noa_rules_generated).toBe(true);
    expect(created.description_is_fallback).toBe(true);
    expect(request.spec_hash).toBe(rendered.spec_hash);
    expect(request.spec_json).toBe(rendered.spec_json);
  });
  it("freezes a supplied description, its digest and survives reload and renderer drift", async () => {
    const created = await createSignRequest(config, store, {
      ...params,
      description: "Plain explanation.",
    } as any);
    const id = created.url.split("/").at(-1)!;
    const first = store.get(id)!;
    expect(first.snapshot).toMatchObject({
      description: "Plain explanation.",
      renderer_version: "noa-rules-v1",
    });
    expect(first.snapshot!.metadata_digest).toBe(created.metadata_digest);
    const reopened = new SignStore(config);
    const second = reopened.get(id)!;
    expect(second.snapshot).toEqual(first.snapshot);
    // Even if the rules text in the row differs from what a new renderer would produce, API serves frozen bytes.
    const db = new DatabaseSync(join(dir, "mcp.sqlite"));
    // (this row is a legacy rules-v1 request: its frozen rules are the canonical text)
    db.prepare("UPDATE sign_requests SET renderer_version = 'rules-v1' WHERE id = ?").run(id);
    db.prepare("UPDATE sign_requests SET rules_text = ? WHERE id = ?").run(
      "FROZEN RULES\n",
      id,
    );
    db.close();
    const api = (await (await fetch(`${base}/api/sign/${id}`)).json()) as any;
    expect(api.rules_markdown).toBe("FROZEN RULES\n");
    expect(api.description).toBe("Plain explanation.");
    expect(api.metadata_digest).toBe(first.snapshot!.metadata_digest);
    reopened.close();
  });
  it("digest covers title, token, outcomes, description and rules", () => {
    const a = buildSnapshot({
      spec_json: rendered.spec_json,
      spec_hash: rendered.spec_hash,
      title: "A",
      token_id: "t.testnet",
      outcomes: ["Yes", "No"],
      description: "d",
    });
    const b = buildSnapshot({
      spec_json: rendered.spec_json,
      spec_hash: rendered.spec_hash,
      title: "A",
      token_id: "t.testnet",
      outcomes: ["Yes", "No"],
      description: "e",
    });
    const c = buildSnapshot({
      spec_json: rendered.spec_json,
      spec_hash: rendered.spec_hash,
      title: "B",
      token_id: "t.testnet",
      outcomes: ["Yes", "No"],
      description: "d",
    });
    expect(
      new Set([a.metadata_digest, b.metadata_digest, c.metadata_digest]).size,
    ).toBe(3);
    expect(() =>
      buildSnapshot({
        spec_json: rendered.spec_json,
        spec_hash: rendered.spec_hash,
        title: "A",
        token_id: "t",
        outcomes: [],
        description: "bad\u0000",
      }),
    ).toThrow("control");
  });
  it("migrates a legacy database: pending gets a snapshot once, completed is legacy_unavailable", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "noacourt-legacy-"));
    const db = new DatabaseSync(join(legacyDir, "mcp.sqlite"));
    db.exec(
      `CREATE TABLE sign_requests (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, params TEXT NOT NULL, spec_json TEXT NOT NULL, spec_hash TEXT NOT NULL, tx_plan TEXT NOT NULL, result TEXT)`,
    );
    const insert = db.prepare(
      "INSERT INTO sign_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const future = new Date(Date.now() + 3600_000).toISOString();
    const legacyParams = JSON.stringify({
      title: "Old",
      outcomes: ["Yes", "No"],
      stake: "1",
      token_id: "point.noamarket.testnet",
    });
    insert.run(
      "L".repeat(22),
      new Date().toISOString(),
      future,
      "pending",
      legacyParams,
      rendered.spec_json,
      rendered.spec_hash,
      "[]",
      null,
    );
    insert.run(
      "C".repeat(22),
      new Date().toISOString(),
      future,
      "completed",
      legacyParams,
      rendered.spec_json,
      rendered.spec_hash,
      "[]",
      JSON.stringify({ market_id: 17, account_id: account }),
    );
    db.close();
    const legacyConfig = { ...config, dataDir: legacyDir };
    const legacyStore = new SignStore(legacyConfig);
    const app = createApp(legacyConfig, {
      store: legacyStore,
      rpc,
      court,
      signer,
      wasm,
      noaFetch: noaFetch as unknown as typeof fetch,
    });
    const s: Server = await new Promise((resolve) => {
      const x = app.app.listen(0, "127.0.0.1", () => resolve(x));
    });
    const origin = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    try {
      const completed = (await (
        await fetch(`${origin}/api/sign/${"C".repeat(22)}`)
      ).json()) as any;
      expect(completed.status).toBe("completed");
      expect(completed.result.market_id).toBe(17);
      expect(completed.publication.state).toBe("legacy_unavailable");
      expect(completed.publication.payload).toBeNull();
      const v = await fetch(
        `${origin}/api/sign/${"C".repeat(22)}/publication/verify`,
        { method: "POST" },
      );
      expect(v.status).toBe(409);
      const pending1 = (await (
        await fetch(`${origin}/api/sign/${"L".repeat(22)}`)
      ).json()) as any;
      expect(pending1.metadata_digest).toMatch(/^sha256:/);
      expect(pending1.description).toBe(pending1.rules_markdown);
      const pending2 = (await (
        await fetch(`${origin}/api/sign/${"L".repeat(22)}`)
      ).json()) as any;
      expect(pending2.metadata_digest).toBe(pending1.metadata_digest);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      app.close();
    }
  });
  it("exposes trusted binding, publication payload and config only from the server", async () => {
    const { id } = await complete({ description: "Explained." });
    const api = (await (await fetch(`${base}/api/sign/${id}`)).json()) as any;
    expect(api.publication).toMatchObject({
      state: "not_started",
      config_status: "enabled",
      market_id: 17,
      creator: account,
      noa: {
        api_url: "http://localhost:3401",
        auth_recipient: "noamarket.testnet",
      },
      payload: {
        market_id: 17,
        title: "NEAR market",
        outcomes: ["Yes", "No"],
        description: "Explained.",
        rules: api.noa_rules,
      },
    });
    expect(api.noa_rules).toContain("Full rules: ");
    expect(api.publication.market_url).toBeNull();
  });
  it("verify: missing keeps state, mismatch -> conflict, match -> published, forged ack ignored", async () => {
    const { id } = await complete({ description: "Explained." });
    const snapshot = store.get(id)!.snapshot!;
    noaMarket = { id: 17, creator: account, description: "", rules: "" };
    let r = (await (await verify(id)).json()) as any;
    expect(r).toMatchObject({ verified: false, reason: "missing" });
    expect(store.get(id)!.publication.state).toBeNull();
    // forged browser acknowledgement
    const forged = await fetch(`${base}/api/sign/${id}/publication/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "published" }),
    });
    expect(forged.status).toBe(400);
    expect(store.get(id)!.publication.state).toBeNull();
    // bounded error text: code mapped to fixed message, free text ignored
    const rep = await fetch(`${base}/api/sign/${id}/publication/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "retryable_error",
        error_code: "<script>x</script>",
      }),
    });
    expect(rep.status).toBe(200);
    expect(store.get(id)!.publication.error).toBeNull();
    noaMarket = {
      id: 17,
      creator: account,
      description: "Something else",
      rules: snapshot.rules,
    };
    r = (await (await verify(id)).json()) as any;
    expect(r).toMatchObject({
      verified: false,
      reason: "mismatch",
      state: "conflict",
    });
    noaMarket = {
      id: 17,
      creator: account,
      description: snapshot.description,
      rules: snapshot.rules,
    };
    r = (await (await verify(id)).json()) as any;
    expect(r).toMatchObject({ verified: true, state: "published" });
    const after = store.get(id)!;
    expect(after.publication.state).toBe("published");
    expect(after.publication.verified_at).toBeTruthy();
    const api = (await (await fetch(`${base}/api/sign/${id}`)).json()) as any;
    expect(api.publication.market_url).toBe("http://localhost:3411/markets/17");
    // published is sticky against browser reports and upstream outages
    await fetch(`${base}/api/sign/${id}/publication/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "conflict" }),
    });
    noaMarket = "down";
    r = (await (await verify(id)).json()) as any;
    expect(store.get(id)!.publication.state).toBe("published");
  });
  it("verify: wrong creator or market id in Noa's row is a conflict, upstream error is retryable", async () => {
    const { id } = await complete();
    const snapshot = store.get(id)!.snapshot!;
    noaMarket = {
      id: 17,
      creator: "mallory.testnet",
      description: snapshot.description,
      rules: snapshot.rules,
    };
    let r = (await (await verify(id)).json()) as any;
    expect(r).toMatchObject({
      verified: false,
      reason: "creator_mismatch",
      state: "conflict",
    });
    noaMarket = {
      id: 99,
      creator: account,
      description: snapshot.description,
      rules: snapshot.rules,
    };
    r = (await (await verify(id)).json()) as any;
    expect(r.reason).toBe("id_mismatch");
    noaMarket = "down";
    r = (await (await verify(id)).json()) as any;
    expect(r).toMatchObject({
      reason: "upstream_error",
      state: "retryable_error",
    });
    expect(store.get(id)!.publication.error).toContain("Noa API");
  });
  it("verify needs a completed request and rate-limits per request id", async () => {
    const pending = await createSignRequest(config, store, params as any);
    const pid = pending.url.split("/").at(-1)!;
    expect((await verify(pid)).status).toBe(409);
    expect((await verify("x".repeat(22))).status).toBe(404);
    const { id } = await complete();
    noaMarket = null;
    noaFetch.mockClear();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await verify(id)).status);
    expect(codes).toEqual([200, 200, 200, 200, 429, 429]);
    expect(noaFetch).toHaveBeenCalledTimes(4);
    // another request id has its own bucket
    const other = await complete();
    expect((await verify(other.id)).status).toBe(200);
  });
  it("coalesces concurrent verifications into one upstream read", async () => {
    const { id } = await complete();
    noaMarket = null;
    noaFetch.mockClear();
    const big = { ...config, publicationVerifyPerMin: 100 };
    void big;
    const results = await Promise.all([verify(id), verify(id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(noaFetch.mock.calls.length).toBeLessThanOrEqual(2);
  });
  const tool = async (name: string, args: unknown) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await response.json()) as any;
    const text = body.result.content[0].text as string;
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: body.result.isError, json, text };
  };
  it("market_create_link accepts description; market_create_link output carries digest", async () => {
    const result = await tool("market_create_link", {
      title: "NEAR market",
      outcomes: ["Yes", "No"],
      stake: "5",
      duration_minutes: 10,
      spec: examples.A1,
      description: "Resolves Yes if NEAR is above the threshold.",
    });
    expect(result.isError).not.toBe(true);
    const request = store.get(result.json.url.split("/").at(-1)!)!;
    expect(request.snapshot!.description).toBe(
      "Resolves Yes if NEAR is above the threshold.",
    );
    expect(result.json.metadata_digest).toBe(request.snapshot!.metadata_digest);
    expect(request.spec_hash).toBe(rendered.spec_hash);
    const omitted = await tool("market_create_link", {
      title: "NEAR market",
      outcomes: ["Yes", "No"],
      stake: "5",
      duration_minutes: 10,
      spec: examples.A1,
    });
    const r2 = store.get(omitted.json.url.split("/").at(-1)!)!;
    expect(r2.snapshot!.description).toBe(r2.snapshot!.rules);
    const bad = await tool("market_create_link", {
      title: "NEAR market",
      outcomes: ["Yes", "No"],
      stake: "5",
      duration_minutes: 10,
      spec: examples.A1,
      description: "x\u0001",
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("control");
  });
  it("market_status exposes publication state and the Noa link once published", async () => {
    const { id } = await complete();
    (rpc.view as any).mockImplementation(async (_c: string, method: string) =>
      method === "get_market"
        ? {
            id: 17,
            status: "Active",
            outcomes: [
              { id: 0, name: "Yes" },
              { id: 1, name: "No" },
            ],
          }
        : null,
    );
    let status = (await tool("market_status", { market_id: 17 })).json;
    expect(status.metadata_publication).toMatchObject({
      state: "not_started",
      noa_market_url: null,
    });
    expect(status.metadata_publication.sign_url).toContain(`/sign/${id}`);
    store.setPublication(id, "published", null, new Date().toISOString());
    status = (await tool("market_status", { market_id: 17 })).json;
    expect(status.metadata_publication).toMatchObject({
      state: "published",
      noa_market_url: "http://localhost:3411/markets/17",
    });
    expect(
      (await tool("market_status", { market_id: 99 })).json
        .metadata_publication ?? null,
    ).toBeNull();
  });
});

describe("publication disabled/invalid deployments", () => {
  const dir = mkdtempSync(join(tmpdir(), "noacourt-pubdis-"));
  const wasmPath = join(dir, "fake.wasm");
  writeFileSync(wasmPath, "fake");
  const base0 = {
    ...baseConfig,
    dataDir: dir,
    resolverWasm: wasmPath,
    publicBaseUrl: "https://noacourtmcp.junstudio.xyz",
    keeperEnabled: false,
    nearNetwork: "testnet",
  } as any;
  const rendered = renderRules(examples.A1);
  const params = {
    spec_json: rendered.spec_json,
    spec_hash: rendered.spec_hash,
    title: "NEAR market",
    outcomes: ["Yes", "No"],
    stake: "5",
    duration_minutes: 10,
  };
  const rpc = {
    view: vi.fn(async (_c: string, method: string) =>
      method === "is_fee_exempt"
        ? true
        : method === "get_user_balance"
          ? "0"
          : method === "get_config"
            ? {}
            : null,
    ),
    txStatus: vi.fn(),
  } as unknown as NearRpc;
  const court = {
    resolverHash: () => null,
    maxAttempts: async () => 4,
    configView: async () => ({}),
  } as unknown as CourtClient;
  const wasm = new WasmRunner(base0, async (_i, mode) =>
    mode === "lint" ? { ok: true, errors: [] } : { outcome: "Yes" },
  );
  async function serve(config: any) {
    const store = new SignStore(config);
    const app = createApp(config, {
      store,
      rpc,
      court,
      signer: { send: vi.fn() } as any,
      wasm,
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    return {
      store,
      origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      stop: async () => {
        await new Promise<void>((r) => server.close(() => r()));
        app.close();
      },
    };
  }
  it("absent config: publication disabled and the create flow still works", async () => {
    const config = {
      ...base0,
      noaApiUrl: "",
      noaAuthRecipient: "",
      noaMarketUrlBase: "",
    };
    const s = await serve(config);
    try {
      const created = await createSignRequest(config, s.store, params as any);
      const id = created.url.split("/").at(-1)!;
      const api = (await (
        await fetch(`${s.origin}/api/sign/${id}`)
      ).json()) as any;
      expect(api.publication).toMatchObject({
        state: "disabled",
        config_status: "disabled",
        noa: null,
        payload: null,
      });
      const plan = await fetch(
        `${s.origin}/api/sign/${id}/plan?account=alice.testnet`,
      );
      expect(plan.status).toBe(200);
      const html = await (await fetch(`${s.origin}/sign/${id}`)).text();
      expect(html).toContain('id="sign-button"');
    } finally {
      await s.stop();
    }
  });
  it("invalid config blocks new links and create transactions", async () => {
    const good = {
      ...base0,
      noaApiUrl: "",
      noaAuthRecipient: "",
      noaMarketUrlBase: "",
    };
    const s = await serve(good);
    const created = await createSignRequest(good, s.store, params as any);
    const id = created.url.split("/").at(-1)!;
    await s.stop();
    const bad = {
      ...base0,
      noaApiUrl: "http://evil.example",
      noaAuthRecipient: "noamarket.testnet",
      noaMarketUrlBase: "https://a.example/markets/",
    };
    await expect(
      createSignRequest(
        bad,
        new SignStore({ ...bad, dataDir: mkdtempSync(join(tmpdir(), "x-")) }),
        params as any,
      ),
    ).rejects.toThrow("publication config invalid");
    const t = await serve(bad);
    try {
      const plan = await fetch(
        `${t.origin}/api/sign/${id}/plan?account=alice.testnet`,
      );
      expect(plan.status).toBe(409);
      expect((await plan.json()).error).toContain("config invalid");
      const api = (await (
        await fetch(`${t.origin}/api/sign/${id}`)
      ).json()) as any;
      expect(api.publication.config_status).toBe("invalid");
    } finally {
      await t.stop();
    }
  });
});
