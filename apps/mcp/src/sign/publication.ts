import type { Config } from "../config.js";
import { jcs, sha256 } from "../spec/canonical.js";
import { RENDERER_VERSION, renderRules } from "../spec/render.js";

/** Mainnet-only built-in defaults. Testnet has no hosted Noa API, so no default. */
export const MAINNET_NOA_DEFAULTS = {
  apiUrl: "https://noamarket.xyz/api-proxy",
  authRecipient: "noamarket.near",
  marketUrlBase: "https://noamarket.xyz/markets/",
};

export const PUBLICATION_STATES = [
  "not_started",
  "auth_required",
  "publishing",
  "awaiting_verification",
  "published",
  "retryable_error",
  "conflict",
  "legacy_unavailable",
  "disabled",
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];
/** States a browser may report; `published` is only ever set by server read-back. */
export const REPORTABLE_STATES = [
  "auth_required",
  "publishing",
  "awaiting_verification",
  "retryable_error",
  "conflict",
] as const;

/** Fixed, safe messages: clients send a code, never free text. */
export const ERROR_MESSAGES: Record<string, string> = {
  declined: "Noa login was declined in the wallet.",
  unsupported: "This wallet cannot sign the Noa login message (NEP-413).",
  account_mismatch: "The wallet account is not the market creator.",
  network: "Could not reach the Noa API (network or CORS error).",
  http_401: "Noa rejected the login session.",
  http_403:
    "Noa says this account is not the market creator; sign in with the creator account.",
  http_409: "Noa already holds different metadata for this market.",
  http_429: "Noa rate-limited the request; retry later.",
  http_5xx: "Noa API is unavailable; retry later.",
  http_4xx: "Noa rejected the metadata request.",
  login_failed: "Noa login failed.",
  bad_response: "Unexpected response from Noa.",
  verify_failed: "Read-back verification failed.",
  other: "Publication failed.",
};

export type PublicationConfig =
  | { status: "disabled"; reason: string }
  | { status: "invalid"; error: string }
  | {
      status: "enabled";
      apiUrl: string;
      authRecipient: string;
      marketUrlBase: string;
    };

const ACCOUNT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function checkUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error(`${name} must be https (or http on localhost)`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must not contain credentials, query or fragment`);
  return url.toString();
}

export function resolvePublicationConfig(
  config: Pick<
    Config,
    "nearNetwork" | "noaApiUrl" | "noaAuthRecipient" | "noaMarketUrlBase"
  >,
): PublicationConfig {
  const mainnet = config.nearNetwork === "mainnet";
  const defaults = mainnet
    ? MAINNET_NOA_DEFAULTS
    : { apiUrl: "", authRecipient: "", marketUrlBase: "" };
  const apiUrl = config.noaApiUrl || defaults.apiUrl;
  const authRecipient = config.noaAuthRecipient || defaults.authRecipient;
  const marketUrlBase = config.noaMarketUrlBase || defaults.marketUrlBase;
  if (!apiUrl && !authRecipient && !marketUrlBase)
    return { status: "disabled", reason: "not_configured" };
  try {
    if (!apiUrl || !authRecipient || !marketUrlBase)
      throw new Error(
        "NOA_API_URL, NOA_AUTH_RECIPIENT and NOA_MARKET_URL_BASE must all be set",
      );
    const suffix = mainnet ? ".near" : ".testnet";
    if (
      !ACCOUNT.test(authRecipient) ||
      authRecipient.length > 64 ||
      !authRecipient.endsWith(suffix)
    )
      throw new Error(
        `NOA_AUTH_RECIPIENT must be a NEAR account ending in ${suffix} for ${config.nearNetwork}`,
      );
    const api = checkUrl("NOA_API_URL", apiUrl).replace(/\/+$/, "");
    const market = checkUrl("NOA_MARKET_URL_BASE", marketUrlBase);
    return {
      status: "enabled",
      apiUrl: api,
      authRecipient,
      marketUrlBase: market.endsWith("/") ? market : `${market}/`,
    };
  } catch (error) {
    return { status: "invalid", error: (error as Error).message };
  }
}

export type MetadataSnapshot = {
  description: string;
  rules: string;
  renderer_version: string;
  spec_hash: string;
  metadata_digest: string;
};

const MAX_DESCRIPTION = 4000;

export function normalizeDescription(
  description: string | undefined,
  rules: string,
): string {
  if (description === undefined || description.trim() === "") return rules;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description))
    throw new Error(
      "description must be plain text without control characters",
    );
  if (description.length > MAX_DESCRIPTION)
    throw new Error(
      `description must be at most ${MAX_DESCRIPTION} characters`,
    );
  return description;
}

export function metadataDigest(input: {
  title: string;
  token_id: string;
  outcomes: string[];
  description: string;
  rules: string;
}): string {
  return sha256(
    jcs({
      title: input.title,
      token_id: input.token_id,
      outcomes: input.outcomes,
      description: input.description,
      rules: input.rules,
    }),
  );
}

export function buildSnapshot(input: {
  spec_json: string;
  spec_hash: string;
  title: string;
  token_id: string;
  outcomes: string[];
  description?: string;
}): MetadataSnapshot {
  const rules = renderRules(input.spec_json).rules_markdown;
  const description = normalizeDescription(input.description, rules);
  return {
    description,
    rules,
    renderer_version: RENDERER_VERSION,
    spec_hash: input.spec_hash,
    metadata_digest: metadataDigest({
      title: input.title,
      token_id: input.token_id,
      outcomes: input.outcomes,
      description,
      rules,
    }),
  };
}

export type PublicationRecord = {
  state: PublicationState | null;
  error: string | null;
  verified_at: string | null;
};

type RequestLike = {
  id: string;
  status: string;
  params: Record<string, any>;
  snapshot: MetadataSnapshot | null;
  publication: PublicationRecord;
  result: Record<string, any> | null;
};

/** Externally visible publication view; derived, never trusting client claims. */
export function publicationView(
  config: Config,
  request: RequestLike,
  tokenFallback = config.marketToken,
) {
  const pub = resolvePublicationConfig(config);
  const stored = request.publication.state ?? "not_started";
  let state: PublicationState;
  if (!request.snapshot) state = "legacy_unavailable";
  else if (pub.status !== "enabled" && stored !== "published")
    state = "disabled";
  else state = stored;
  const marketId = request.result?.market_id;
  const completed = request.status === "completed" && marketId !== undefined;
  const enabled = pub.status === "enabled";
  return {
    state,
    error: request.publication.error,
    last_verified_at: request.publication.verified_at,
    config_status: pub.status,
    config_error: pub.status === "invalid" ? pub.error : undefined,
    config_reason: pub.status === "disabled" ? pub.reason : undefined,
    market_id: completed ? marketId : null,
    creator: completed ? (request.result?.account_id ?? null) : null,
    market_url:
      enabled && completed && state === "published"
        ? `${pub.marketUrlBase}${marketId}`
        : null,
    noa: enabled
      ? {
          api_url: pub.apiUrl,
          auth_recipient: pub.authRecipient,
          market_url_base: pub.marketUrlBase,
        }
      : null,
    payload:
      enabled && completed && request.snapshot
        ? {
            market_id: marketId,
            title: request.params.title,
            outcomes: request.params.outcomes,
            token_id: request.params.token_id ?? tokenFallback,
            description: request.snapshot.description,
            rules: request.snapshot.rules,
          }
        : null,
  };
}

export type VerifyResult = {
  verified: boolean;
  state: PublicationState;
  reason?:
    | "missing"
    | "mismatch"
    | "creator_mismatch"
    | "id_mismatch"
    | "upstream_error";
};

type Store = {
  setPublication(
    id: string,
    state: PublicationState,
    error: string | null,
    verifiedAt?: string | null,
  ): void;
  get(id: string): RequestLike | null;
};

const inflight = new Map<string, Promise<VerifyResult>>();

/** Read the configured Noa market endpoint and compare with the frozen snapshot. */
export function verifyPublication(
  config: Config,
  store: Store,
  request: RequestLike,
  fetchImpl: typeof fetch,
): Promise<VerifyResult> {
  const existing = inflight.get(request.id);
  if (existing) return existing;
  const run = doVerify(config, store, request, fetchImpl).finally(() =>
    inflight.delete(request.id),
  );
  inflight.set(request.id, run);
  return run;
}

async function doVerify(
  config: Config,
  store: Store,
  request: RequestLike,
  fetchImpl: typeof fetch,
): Promise<VerifyResult> {
  const pub = resolvePublicationConfig(config);
  const marketId = request.result?.market_id;
  if (pub.status !== "enabled" || !request.snapshot || marketId === undefined)
    throw new Error(
      "publication verification is not available for this request",
    );
  const current = () =>
    store.get(request.id)?.publication.state ?? "not_started";
  const fail = (
    state: PublicationState,
    reason: NonNullable<VerifyResult["reason"]>,
    error: string,
  ): VerifyResult => {
    if (current() !== "published" && reason !== "missing")
      store.setPublication(request.id, state, error);
    return { verified: false, state: current(), reason };
  };
  let market: Record<string, any> | null;
  try {
    const response = await fetchImpl(
      `${pub.apiUrl}/v1/markets/${encodeURIComponent(String(marketId))}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      },
    );
    if (response.status === 404) market = null;
    else if (!response.ok)
      return fail("retryable_error", "upstream_error", ERROR_MESSAGES.http_5xx);
    else {
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error("response too large");
      market = JSON.parse(text);
    }
  } catch {
    return fail("retryable_error", "upstream_error", ERROR_MESSAGES.network);
  }
  if (!market || typeof market !== "object")
    return fail(
      "awaiting_verification",
      "missing",
      "Metadata not visible in Noa yet.",
    );
  if (market.id !== undefined && String(market.id) !== String(marketId))
    return fail("conflict", "id_mismatch", "Noa returned a different market.");
  if (market.creator && market.creator !== request.result?.account_id)
    return fail(
      "conflict",
      "creator_mismatch",
      "Noa market creator differs from the verified creator.",
    );
  const description = market.description ?? null;
  const rules = market.rules ?? null;
  if (
    description === request.snapshot.description &&
    rules === request.snapshot.rules
  ) {
    const at = new Date().toISOString();
    store.setPublication(request.id, "published", null, at);
    return { verified: true, state: "published" };
  }
  if (!description && !rules)
    return fail(
      "awaiting_verification",
      "missing",
      "Metadata not visible in Noa yet.",
    );
  return fail("conflict", "mismatch", ERROR_MESSAGES.http_409);
}
