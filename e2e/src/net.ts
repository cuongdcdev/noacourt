import { RPC_URLS, UA } from "./constants.js";

export class TransientRpcError extends Error {}

class RpcAttemptError extends Error {
  constructor(
    message: string,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
  }
}

export function rpcBackoffMs(
  retryIndex: number,
  retryAfter: string | null,
  nowMs = Date.now(),
): number {
  const exponential = Math.min(30_000, 500 * 2 ** retryIndex);
  if (!retryAfter) return exponential;
  const seconds = Number(retryAfter);
  const headerMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(retryAfter) - nowMs;
  return Number.isFinite(headerMs) && headerMs >= 0
    ? Math.max(exponential, headerMs)
    : exponential;
}

function isTransientRequestError(error: unknown): boolean {
  if (error instanceof RpcAttemptError || error instanceof TransientRpcError)
    return true;
  if (error instanceof TypeError || (error as any)?.name === "TimeoutError")
    return true;
  return /429|rate.limit|too many requests|timeout|temporarily unavailable/i.test(
    String(error),
  );
}

export async function getJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`GET ${new URL(url).host}: HTTP ${response.status}`);
  return response.json();
}

export async function livePrice(
  symbol: string,
): Promise<{ value: string; venue: "binance" | "okx" }> {
  try {
    const data = await getJson(
      `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
    );
    if (!/^\d+(?:\.\d+)?$/.test(String(data.price)))
      throw new Error("Invalid Binance price");
    return { value: String(data.price), venue: "binance" };
  } catch {
    const instId = symbol.replace("USDT", "-USDT");
    const data = await getJson(
      `https://www.okx.com/api/v5/market/ticker?instId=${instId}`,
    );
    const value = String(data.data?.[0]?.last ?? "");
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid OKX price");
    return { value, venue: "okx" };
  }
}

export class Rpc {
  private cursor = 0;

  async call<T>(
    method: string,
    params: unknown,
    attempts = Math.max(8, RPC_URLS.length * 2),
  ): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      const url = RPC_URLS[this.cursor++ % RPC_URLS.length];
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": UA },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "noacourt-e2e",
            method,
            params,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const message = `RPC HTTP ${response.status}`;
          if (response.status === 429 || response.status >= 500)
            throw new RpcAttemptError(
              message,
              response.headers.get("retry-after"),
            );
          throw new Error(message);
        }
        const body = (await response.json()) as { result?: T; error?: unknown };
        if (body.error) {
          const message = JSON.stringify(body.error);
          if (isTransientRequestError(new Error(message)))
            throw new RpcAttemptError(message);
          throw new Error(message);
        }
        if (body.result === undefined)
          throw new Error("RPC response missing result");
        return body.result;
      } catch (error) {
        if (!isTransientRequestError(error)) throw error;
        last = error;
        if (i + 1 < attempts)
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              rpcBackoffMs(
                i,
                error instanceof RpcAttemptError ? error.retryAfter : null,
              ),
            ),
          );
      }
    }
    throw new TransientRpcError(
      `RPC ${method} failed across ${RPC_URLS.length} URLs: ${String(last)}`,
    );
  }

  async view<T>(
    accountId: string,
    methodName: string,
    args: unknown,
  ): Promise<T> {
    const result = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "final",
    });
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }

  async status(hash: string, signer: string): Promise<any> {
    // One short request per poll. The next poll rotates to another RPC.
    return this.call(
      "EXPERIMENTAL_tx_status",
      {
        tx_hash: hash,
        sender_account_id: signer,
        wait_until: "NONE",
      },
      1,
    );
  }

  async broadcast(bytes: Uint8Array): Promise<any> {
    // The caller may retry these identical bytes; their hash and nonce never change.
    const url = RPC_URLS[this.cursor++ % RPC_URLS.length];
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "noacourt-e2e",
        method: "broadcast_tx_async",
        params: [Buffer.from(bytes).toString("base64")],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Broadcast HTTP ${response.status}`);
    const body = (await response.json()) as { result?: any; error?: unknown };
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  }
}

export async function candle(
  symbol: string,
  at: string,
  venue: "binance" | "okx",
): Promise<{ value: string; openMs: number; venue: string; url: string }> {
  const ms = Date.parse(at);
  if (venue === "binance") {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${ms - 60_000}&endTime=${ms + 60_000}&limit=3`;
    const rows = (await getJson(url)) as any[][];
    const row = rows.find(
      (item) => Number(item[0]) <= ms && ms <= Number(item[6]),
    );
    if (!row || Number(row[6]) >= Date.now())
      throw new Error("Binance candle not closed");
    return { value: String(row[4]), openMs: Number(row[0]), venue, url };
  }
  const instId = symbol.replace("USDT", "-USDT");
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1m&limit=100&after=${ms + 60_000}&before=${ms - 60_000}`;
  const rows = (await getJson(url)).data as string[][];
  const row = rows.find(
    (item) => Number(item[0]) <= ms && ms < Number(item[0]) + 60_000,
  );
  if (!row || row[8] !== "1" || Number(row[0]) + 60_000 > Date.now())
    throw new Error("OKX candle not closed");
  return { value: row[4], openMs: Number(row[0]), venue, url };
}
