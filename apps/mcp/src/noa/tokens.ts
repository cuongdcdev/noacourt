import type { Config } from "../config.js";
import type { NearRpc } from "../near/rpc.js";
import {
  atomicToHuman,
  ceilAtomicToHuman,
  minimumStakeAtomic,
} from "./stake.js";

export type WhitelistedToken = {
  token_id: string;
  decimals: number;
  is_active: boolean;
  min_b_shares_fp: string;
  min_trade_amount?: string;
};
const TTL_MS = 60_000;
const DEFAULT_SAFETY_BPS = 9500;

/** Cached reads of Noa's token whitelist, safety_bps and NEP-148 metadata (60 s). */
export function createTokenReader(
  config: Config,
  rpc: NearRpc,
  now: () => number = Date.now,
) {
  let list: { at: number; tokens: WhitelistedToken[] } | undefined;
  let safety: { at: number; bps: number } | undefined;
  const meta = new Map<
    string,
    { at: number; value: { symbol: string | null; name: string | null } }
  >();

  async function whitelist(): Promise<WhitelistedToken[]> {
    if (list && now() - list.at < TTL_MS) return list.tokens;
    const tokens = await rpc.view<WhitelistedToken[]>(
      config.noaContract,
      "get_whitelisted_tokens",
      {},
    );
    if (!Array.isArray(tokens)) throw new Error("unexpected whitelist result");
    list = { at: now(), tokens };
    return tokens;
  }
  async function safetyBps(): Promise<number> {
    if (safety && now() - safety.at < TTL_MS) return safety.bps;
    let bps = DEFAULT_SAFETY_BPS;
    try {
      const cfg = await rpc.view<{ safety_bps?: number }>(
        config.noaContract,
        "get_config",
        {},
      );
      if (Number.isInteger(cfg?.safety_bps) && cfg.safety_bps! > 0)
        bps = cfg.safety_bps!;
    } catch {
      /* contract default */
    }
    safety = { at: now(), bps };
    return bps;
  }
  async function metadata(tokenId: string) {
    const hit = meta.get(tokenId);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    let value: { symbol: string | null; name: string | null } = {
      symbol: null,
      name: null,
    };
    try {
      const m = await rpc.view<{ symbol?: string; name?: string }>(
        tokenId,
        "ft_metadata",
        {},
      );
      value = {
        symbol: typeof m?.symbol === "string" ? m.symbol : null,
        name: typeof m?.name === "string" ? m.name : null,
      };
    } catch {
      /* best effort */
    }
    meta.set(tokenId, { at: now(), value });
    return value;
  }
  /** Exact minimum stake (atomic) for a token and outcome count; null if unreachable. */
  async function minStakeAtomic(
    token: WhitelistedToken,
    outcomeCount: number,
  ): Promise<bigint | null> {
    return minimumStakeAtomic({
      decimals: token.decimals,
      outcomeCount,
      safetyBps: await safetyBps(),
      minBSharesFp: BigInt(token.min_b_shares_fp),
    });
  }
  async function describe(outcomeCount: number) {
    const tokens = await whitelist();
    return Promise.all(
      tokens.map(async (token) => {
        const [m, min] = await Promise.all([
          metadata(token.token_id),
          minStakeAtomic(token, outcomeCount),
        ]);
        return {
          token_id: token.token_id,
          symbol: m.symbol,
          name: m.name,
          decimals: token.decimals,
          is_active: token.is_active,
          min_trade_amount:
            token.min_trade_amount !== undefined
              ? atomicToHuman(BigInt(token.min_trade_amount), token.decimals)
              : null,
          min_stake: min === null ? null : ceilAtomicToHuman(min, token.decimals),
          default: token.token_id === config.marketToken,
        };
      }),
    );
  }
  return { whitelist, safetyBps, metadata, minStakeAtomic, describe };
}
