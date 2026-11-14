// Pure, dependency-injected Noa login + publish + verify orchestration.
// Used by the browser sign page (wallet-selector signMessage + window.fetch) and by the
// Node E2E script (key-file signer + Node fetch). No DOM, no storage, no logging of tokens.

export type PublicationErrorCode =
  | "declined"
  | "unsupported"
  | "account_mismatch"
  | "network"
  | "http_401"
  | "http_403"
  | "http_409"
  | "http_429"
  | "http_5xx"
  | "http_4xx"
  | "login_failed"
  | "bad_response"
  | "verify_failed"
  | "other";

export class NoaPublishError extends Error {
  constructor(
    readonly code: PublicationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export type SignedMessage = {
  accountId: string;
  publicKey: string;
  signature: string | Uint8Array;
};
export type SignMessageFn = (params: {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}) => Promise<SignedMessage | void | null>;

export type NoaSession = { accessToken: string; accountId: string };

export type PublicationPayload = {
  market_id: number;
  title: string;
  outcomes: string[];
  token_id: string;
  description: string;
  rules: string;
};

export type ServerVerify = {
  verified: boolean;
  state: string;
  reason?: string;
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(value: string): Uint8Array {
  let n = 0n;
  for (const ch of value) {
    const digit = B58.indexOf(ch);
    if (digit < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of value) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Noa expects base64 signature bytes; wallets differ (base64, ed25519:base58, raw bytes). */
export function normalizeSignature(signature: string | Uint8Array): string {
  if (typeof signature !== "string") return toBase64(signature);
  if (signature.startsWith("ed25519:"))
    return toBase64(base58Decode(signature.slice(8)));
  return signature;
}

export const challengeMessage = (nonceHex: string) =>
  `Login to Noa Market: ${nonceHex}`;

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex))
    throw new NoaPublishError("bad_response", "nonce must be 32 bytes hex");
  return Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
}

export type Deps = {
  fetch: typeof fetch;
  signMessage?: SignMessageFn;
  sleep?: (ms: number) => Promise<void>;
};

async function http(
  deps: Deps,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await deps.fetch(url, init);
  } catch {
    throw new NoaPublishError("network");
  }
}

function statusCode(status: number): PublicationErrorCode {
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 409) return "http_409";
  if (status === 429) return "http_429";
  if (status >= 500) return "http_5xx";
  return "http_4xx";
}

/** NEP-413 login against Noa. recipient is the operator-configured AUTH_RECIPIENT. */
export async function noaLogin(
  deps: Deps,
  options: { apiUrl: string; recipient: string; expectedAccountId: string },
): Promise<NoaSession> {
  if (!deps.signMessage) throw new NoaPublishError("unsupported");
  const challengeResponse = await http(
    deps,
    `${options.apiUrl}/auth/challenge`,
  );
  if (!challengeResponse.ok)
    throw new NoaPublishError(statusCode(challengeResponse.status));
  const challenge = (await challengeResponse.json().catch(() => null)) as {
    nonce?: string;
    message?: string;
  } | null;
  if (
    !challenge?.nonce ||
    challenge.message !== challengeMessage(challenge.nonce)
  )
    throw new NoaPublishError("bad_response", "unexpected login challenge");
  const nonce = hexToBytes(challenge.nonce);
  let signed: SignedMessage | void | null;
  try {
    signed = await deps.signMessage({
      message: challenge.message,
      recipient: options.recipient,
      nonce,
    });
  } catch (error) {
    const text = String((error as Error)?.message ?? error).toLowerCase();
    throw new NoaPublishError(
      /not (supported|implemented)|unsupported|not a function/.test(text)
        ? "unsupported"
        : "declined",
    );
  }
  if (!signed) throw new NoaPublishError("declined");
  if (signed.accountId !== options.expectedAccountId)
    throw new NoaPublishError("account_mismatch");
  const loginResponse = await http(deps, `${options.apiUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: normalizeSignature(signed.signature),
      nonce: challenge.nonce,
    }),
  });
  if (!loginResponse.ok) throw new NoaPublishError("login_failed");
  const login = (await loginResponse.json().catch(() => null)) as {
    access_token?: string;
  } | null;
  if (!login?.access_token) throw new NoaPublishError("bad_response");
  return { accessToken: login.access_token, accountId: signed.accountId };
}

/**
 * POST the frozen metadata. Optional fields (image/embed/category/tags) are intentionally
 * omitted. Returns "created" or "already_published" (Noa's identical-retry 200).
 */
export async function postMetadata(
  deps: Deps,
  options: { apiUrl: string; session: NoaSession; payload: PublicationPayload },
): Promise<"created" | "already_published"> {
  const { payload } = options;
  const response = await http(deps, `${options.apiUrl}/v1/markets`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.session.accessToken}`,
    },
    body: JSON.stringify({
      market_id: payload.market_id,
      title: payload.title,
      outcomes: payload.outcomes,
      token_id: payload.token_id,
      description: payload.description,
      rules: payload.rules,
    }),
  });
  if (!response.ok) throw new NoaPublishError(statusCode(response.status));
  const body = (await response.json().catch(() => null)) as {
    status?: string;
  } | null;
  return body?.status === "already_published" ? "already_published" : "created";
}

export type PublishState =
  | "auth_required"
  | "publishing"
  | "awaiting_verification"
  | "published"
  | "retryable_error"
  | "conflict";

export type RecoverOptions = {
  apiUrl: string;
  recipient: string;
  creator: string;
  payload: PublicationPayload;
  /** Same-origin server read-back; the only source of truth for "published". */
  verify: () => Promise<ServerVerify>;
  /** Persist a non-terminal progress state server-side (code only, never free text). */
  report?: (state: PublishState, code?: PublicationErrorCode) => Promise<void>;
  session?: NoaSession | null;
  maxAttempts?: number;
  verifyAttempts?: number;
  backoffMs?: number;
};

export type RecoverResult = {
  state: PublishState;
  code?: PublicationErrorCode;
  session: NoaSession | null;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read-back first; if missing, login (if needed) + identical POST; 401 renews login once;
 * 409/403 stop; 429/5xx/network get bounded exponential backoff. Never loops on 401/409.
 */
export async function recoverPublication(
  deps: Deps,
  options: RecoverOptions,
): Promise<RecoverResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const report = options.report ?? (async () => {});
  const maxAttempts = options.maxAttempts ?? 3;
  const verifyAttempts = options.verifyAttempts ?? 3;
  const backoff = options.backoffMs ?? 1500;
  let session = options.session ?? null;
  if (session && session.accountId !== options.creator) session = null;

  const readBack = async (): Promise<ServerVerify | null> => {
    try {
      return await options.verify();
    } catch {
      return null;
    }
  };
  const done = (state: PublishState, code?: PublicationErrorCode) => ({
    state,
    code,
    session,
  });

  const first = await readBack();
  if (first?.verified) return done("published");
  if (first?.state === "conflict" && first.reason !== "missing") {
    await report("conflict", "http_409");
    return done("conflict", "http_409");
  }

  let relogged = false;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      if (!session) {
        await report("auth_required");
        session = await noaLogin(deps, {
          apiUrl: options.apiUrl,
          recipient: options.recipient,
          expectedAccountId: options.creator,
        });
      }
      await report("publishing");
      await postMetadata(deps, {
        apiUrl: options.apiUrl,
        session,
        payload: options.payload,
      });
      break;
    } catch (error) {
      const code =
        error instanceof NoaPublishError ? error.code : ("other" as const);
      if (code === "http_401" && !relogged) {
        relogged = true;
        session = null;
        continue;
      }
      if (code === "http_409") {
        const check = await readBack();
        if (check?.verified) return done("published");
        await report("conflict", code);
        return done("conflict", code);
      }
      if (code === "http_401" || code === "http_403") session = null;
      if (
        [
          "declined",
          "unsupported",
          "account_mismatch",
          "http_401",
          "http_403",
          "login_failed",
        ].includes(code)
      ) {
        await report("auth_required", code);
        return done("auth_required", code);
      }
      const retryable = ["network", "http_429", "http_5xx"].includes(code);
      if (retryable && attempt < maxAttempts) {
        await sleep(backoff * 2 ** (attempt - 1));
        continue;
      }
      await report("retryable_error", code);
      return done("retryable_error", code);
    }
  }

  for (let i = 0; i < verifyAttempts; i += 1) {
    const check = await readBack();
    if (check?.verified) return done("published");
    if (check?.state === "conflict") {
      await report("conflict", "http_409");
      return done("conflict", "http_409");
    }
    if (i < verifyAttempts - 1) await sleep(backoff);
  }
  await report("awaiting_verification");
  return done("awaiting_verification");
}
