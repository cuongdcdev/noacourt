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
export class NearRpc {
  private cursor = 0;
  constructor(
    private config: Config,
    private request: RpcFetch = fetch,
    private delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const urls = this.config.nearRpcUrls;
    let last: unknown;
    for (let attempt = 0; attempt < Math.max(urls.length, 2); attempt++) {
      const url = urls[this.cursor++ % urls.length];
      try {
        const response = await this.request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "noacourt",
            method,
            params,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { result?: T; error?: unknown };
        if (data.error) throw new Error(JSON.stringify(data.error));
        if (data.result === undefined)
          throw new Error("RPC response has no result");
        return data.result;
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

  async txStatus(hash: string, sender: string): Promise<Record<string, any>> {
    return this.call("EXPERIMENTAL_tx_status", {
      tx_hash: hash,
      sender_account_id: sender,
      wait_until: "FINAL",
    });
  }

  async broadcast(signedBytes: Uint8Array): Promise<Record<string, any>> {
    return this.call("broadcast_tx_commit", [
      Buffer.from(signedBytes).toString("base64"),
    ]);
  }
}
