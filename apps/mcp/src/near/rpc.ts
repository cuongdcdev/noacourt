import type { Config } from "../config.js";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly causeDetail?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type RpcFetch = typeof fetch;
const errorText = (error: unknown): string =>
  error instanceof RpcError
    ? `${error.message} ${error.causeDetail instanceof Error ? error.causeDetail.message : JSON.stringify(error.causeDetail ?? "")}`
    : error instanceof Error
      ? error.message
      : String(error);
const unsupportedMethod = (error: unknown): boolean =>
  /MethodNotFound|MethodResolveError|method not found|unknown method/i.test(
    errorText(error),
  );
const knownTransaction = (error: unknown): boolean =>
  /already processed|already exists|duplicate|known transaction|InvalidNonce/i.test(
    errorText(error),
  );
export class NearRpc {
  private cursor = 0;
  constructor(
    private config: Config,
    private request: RpcFetch = fetch,
    private delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async callEndpoint<T>(
    url: string,
    method: string,
    params: unknown,
  ): Promise<T> {
    const response = await this.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "noacourt", method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (body.trim().toUpperCase() === "DEPRECATED")
      throw new Error("RPC endpoint deprecated");
    const data = JSON.parse(body) as { result?: T; error?: unknown };
    if (data.error) throw new Error(JSON.stringify(data.error));
    if (
      typeof data.result === "string" &&
      data.result.toUpperCase() === "DEPRECATED"
    )
      throw new Error("RPC endpoint deprecated");
    if (data.result === undefined)
      throw new Error("RPC response has no result");
    return data.result;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const urls = this.config.nearRpcUrls;
    let last: unknown;
    for (let attempt = 0; attempt < Math.max(urls.length, 2); attempt++) {
      const url = urls[this.cursor++ % urls.length];
      try {
        return await this.callEndpoint<T>(url, method, params);
      } catch (error) {
        last = error;
        if (attempt + 1 < Math.max(urls.length, 2))
          await this.delay(Math.min(100 * 2 ** attempt, 1000));
      }
    }
    throw new RpcError(
      `NEAR RPC ${method} failed across ${urls.length} endpoint(s)`,
      Math.max(urls.length, 2),
      last,
    );
  }

  async submitSigned(signedBytes: Uint8Array): Promise<void> {
    const encoded = Buffer.from(signedBytes).toString("base64");
    const urls = this.config.nearRpcUrls;
    let last: unknown;
    for (let attempt = 0; attempt < Math.max(urls.length, 2); attempt++) {
      const url = urls[this.cursor++ % urls.length];
      try {
        await this.callEndpoint(url, "send_tx", {
          signed_tx_base64: encoded,
          wait_until: "NONE",
        });
        return;
      } catch (error) {
        if (knownTransaction(error)) return;
        if (unsupportedMethod(error)) {
          try {
            await this.callEndpoint(url, "broadcast_tx_async", [encoded]);
            return;
          } catch (fallbackError) {
            if (knownTransaction(fallbackError)) return;
            last = fallbackError;
          }
        } else {
          last = error;
        }
        if (attempt + 1 < Math.max(urls.length, 2))
          await this.delay(Math.min(100 * 2 ** attempt, 1000));
      }
    }
    throw new RpcError(
      `NEAR RPC submit failed across ${urls.length} endpoint(s)`,
      Math.max(urls.length, 2),
      last,
    );
  }

  async accessKeyNonce(
    accountId: string,
    publicKey: string,
  ): Promise<{ nonce: bigint; complete: boolean }> {
    const urls = this.config.nearRpcUrls;
    const start = this.cursor;
    this.cursor += urls.length;
    const params = {
      request_type: "view_access_key",
      account_id: accountId,
      public_key: publicKey,
      finality: "optimistic",
    };
    const results = await Promise.allSettled(
      urls.map((_, index) =>
        this.callEndpoint<{ nonce: number | string }>(
          urls[(start + index) % urls.length],
          "query",
          params,
        ),
      ),
    );
    const nonces = results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<{ nonce: number | string }> =>
          result.status === "fulfilled",
      )
      .map((result) => BigInt(result.value.nonce));
    if (nonces.length === 0)
      throw new RpcError(
        "NEAR RPC access-key nonce check failed",
        urls.length,
        results.find((result) => result.status === "rejected"),
      );
    return {
      nonce: nonces.reduce((highest, nonce) =>
        nonce > highest ? nonce : highest,
      ),
      complete: nonces.length === urls.length,
    };
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

  async txStatus(
    hash: string,
    sender: string,
    waitUntil: "FINAL" | "EXECUTED_OPTIMISTIC" = "FINAL",
  ): Promise<Record<string, any>> {
    try {
      return await this.call("EXPERIMENTAL_tx_status", {
        tx_hash: hash,
        sender_account_id: sender,
        wait_until: waitUntil,
      });
    } catch (error) {
      if (!unsupportedMethod(error)) throw error;
      return this.call("tx", [hash, sender]);
    }
  }
}
