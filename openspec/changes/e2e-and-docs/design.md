## Context
Accounts and decisions: `private/STATE.md`. Interfaces: `docs/ARCHITECTURE.md`. Market creation goes through the same arg builder as the sign page, but the harness signs with test keys from `~/.near-credentials/testnet` (test-only; the MCP server never does this).

## Scenarios (first wave)
| id | market | expected |
|---|---|---|
| A1 | NEAR/USDT 1m close at T+10 >= live price at creation (binance_kline, fallback okx_candle) | resolved Yes/No matching an independent check of Binance data |
| A2 | BTC/USDT at T+15 in 3 buckets around creation price ±0.1% | resolved, bucket matches independent check |
| A3 | BTC/USDT Up/Down: close at T+15 vs baseline at creation (decide change) | resolved up/down/tie matches check |
| A4 | NPOINT ft_balance_of(user3) >= 10,500 at T+10 (near_view) — harness transfers 1,000 NPOINT to user3 before T | Yes |
| A6 | gist JSON `$.score >= 50` with assert `$.id == 'noa-test-1'`; harness edits id after preflight | never resolves; retries then Unresolvable → void |
| A7 | gist JSON deleted before T | Unresolvable → void |
| A8 | text_judge on gist RSS: post "Kent ships Noa Court v2" published inside window | Yes (3/3 jurors) |
| A8n | same, no post | No by default_if_no_evidence |
| A9 | text_judge with injection-only post | not Yes |
Market durations: 10 min (A6/A7 may use 5 min + longer retry). Each market: user1 creates (fee-exempt), user2 buys outcome 0, user4 buys outcome 1, small amounts.

## Decisions
- Harness in TypeScript (reuse apps/mcp arg builders) with vitest-free plain runner `pnpm e2e <scenario|all>`; writes `e2e/results/<timestamp>.json` and appends a row per market to `E2E_RESULTS.md` (market_id, spec_hash, tx hashes for create/link/trigger/OutLayer/resolve/finalize/claim, verdict, tee flag, independent check).
- Independent check for price scenarios queries Binance/OKX directly from the harness, not via the resolver.
- NEAR AI spend counted; stop text_judge scenarios at cap.
