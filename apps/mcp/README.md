# Noa Court MCP

Standalone Node 22/pnpm server for the ten Noa Court MCP tools, wallet sign links, and the permissionless keeper. It never asks for or stores creator keys. The only server key is the keeper credential configured by `KEEPER_CREDENTIALS`.

## Run

From `apps/mcp`: `pnpm install`, `pnpm build`, `pnpm test`, then `pnpm start` (or `pnpm dev`). Configuration is read from the repository `.env` and process env; see `.env.example`. `/healthz` and `/mcp` listen on `127.0.0.1:3310` by default. The keeper starts when `KEEPER_ENABLED=1`. Default testnet RPCs are FastNEAR, NEAR testnet, and FastNEAR archival (`https://archival-rpc.testnet.fastnear.com`); custom endpoints can be set with `NEAR_RPC_URLS`.

Court configuration and the local/published resolver hashes refresh in the background every `COURT_CONFIG_REFRESH_MS` (60 seconds by default). `/healthz` reports the last successful Court fetch time and last refresh error; an RPC failure leaves the last known config available. The local WASM hash is recalculated when its file modification time or size changes.

`GET` and `HEAD /fixtures/:name` serve files from `DATA_DIR/fixtures` with no caching. Allowed file extensions are `.json`, `.xml`, `.rss`, `.html`, and `.txt`. Files can be edited on disk without restarting the server; the route has a separate 600 requests/minute/IP limit and no write endpoint.

The tools are `court_guide`, `catalog_list`, `catalog_tool`, `source_sample`, `spec_lint`, `spec_simulate`, `rules_render`, `market_create_link`, `market_status`, and `verdict_get`. `market_create_link` stores a request in `data/mcp.sqlite` and returns a QR sign URL. It expires at the earlier of 24 hours or the safe signing deadline. `/sign/<id>` uses wallet-selector with Intear, Meteor, and MyNearWallet on testnet. The wallet page refreshes the transaction plan immediately before signing.

## MCP client setup

- Codex: `codex mcp add noacourt --url https://noacourtmcp.junstudio.xyz/mcp`. In `config.toml`, set `[mcp_servers.noacourt]` and `default_tools_approval_mode = "approve"`.
- Claude.ai: add `https://noacourtmcp.junstudio.xyz/mcp` as a custom connector. Claude Code: `claude mcp add --transport http noacourt https://noacourtmcp.junstudio.xyz/mcp`.
- ChatGPT: enable developer mode and add a connector with URL `https://noacourtmcp.junstudio.xyz/mcp`, without authentication.

The keeper's normal permissionless calls are Court `link_market`, `trigger`, `trigger_request`, `retry_forward`, `void`, `void_unlinked`, and Noa `finalize_resolution`. `submit_keeper_verdict` is used only with `COURT_TRUSTED_KEEPER=1`. Its receipt is marked `tee: false` by Court.

Rejected market links are cached in `data/mcp.sqlite`: permanent Court validation failures stop further link attempts; temporary failures retry after 5, 15, and 60 minutes, then stop. Unlinked markets past their resolution deadline are sent to `void_unlinked` when Court supports it. An unsupported method pauses these probes for one hour.

Keeper `trigger` and `trigger_request` attach 300 TGas to cover the OutLayer execution request and Court callbacks.
They wait until `observation.at` plus `TRIGGER_GRACE_SECONDS` (70 seconds by default), and still respect Court's later `retry_at_ns` when present.

The keeper signs each transaction once, submits it without waiting for execution, and polls its hash with `EXECUTED_OPTIMISTIC`. `TX_POLL_TIMEOUT_MS` (default 90000) and `TX_POLL_INTERVAL_MS` (default 2500) control each polling window. After a polling timeout, it checks the access-key nonce at optimistic finality. A consumed nonce returns `pending` without another transaction; only an unconsumed nonce permits one re-sign. Pending and unknown results are rechecked on the next keeper tick.

## Transaction builder

Import `buildCreateMarketTxs`, `effectiveAttempts`, `requiredResolutionWindowMinutes`, and `parseCreateMarketResult` from `src/lib.ts` or the built package entry. The default retry policy is 5 attempts every 3 minutes. Rules rendering fills missing retry fields before hashing, so the registration payload and displayed rules agree. Court uses the lesser of the spec and Court-configured attempt caps; the builder and sign plan use that same effective count. The builder converts token stake amounts with integer decimal math. `requiredResolutionWindowMinutes(observationAt, expirationEstimateAt, attempts, every)` computes the window from the planned market expiration to **observation.at + attempts × retry.every + 5 minutes + 2 minutes margin**, rounded up and subject to Noa's 10-minute minimum. With 5 attempts every 3 minutes, the deadline floor is 20 minutes after observation; the actual window is longer by the gap from expiration to observation and the 2-minute margin. Both minute and day duration markets use `resolution_window_minutes`, as allowed by Noa. `market_create_link` warns when it raises an explicit shorter window or when less than 10 minutes remain before signing closes. `SIGN_MARGIN_MINUTES` defaults to 3; signing must occur before the deadline displayed on the page, and a plan request after that deadline returns HTTP 409. If the account's Noa internal balance is insufficient, the plan adds `ft_transfer_call` before Court registration and Noa creation. The live signer plan reads Court's `min_deposit`, Noa's `market_creation_fee`, fee exemption, and internal balance through the rotating RPC client.

`market_status` and `verdict_get` include lifecycle guidance, UTC timestamps, transaction hashes and explorer links from the keeper action history in `data/mcp.sqlite`. During the dispute window Court can report `Resolved` while Noa remains `Active`; the keeper finalizes the Noa resolution automatically after the window.
`market_status` accepts an optional `account_id` and returns per-outcome shares, cost basis, and claim eligibility from Noa views. Noa has no cheap exact payout preview or claimed flag; no remaining position can mean either claimed or never held.
When Court's verdict metadata omits an OutLayer request ID, these tools read the latest known trigger transaction's OutLayer `execution_requested` event to find it.

Noa currently charges 0.5 NEAR plus measured storage to non-exempt creators and **does not refund excess attached deposit** (`contracts/src/lib.rs` around `create_market`). The plan adds a 0.1 NEAR storage buffer, so the creator pays that excess. Fee-exempt creators attach zero to `create_market`.

## Deploy

`scripts/start.sh` starts a restart loop with `data/server.pid` and `data/server.log`; `scripts/stop.sh` stops only that PID. `scripts/tunnel-start.sh` runs `tunnel-run-forever.sh` with a restart backoff and stores the wrapper PID in `data/tunnel.pid`; `scripts/tunnel-stop.sh` stops only that wrapper or a legacy direct tunnel process. Both use only `/root/.cloudflared/noacourt-mcp.yml`. Create the named tunnel/config separately before starting it. No tunnel is created by this package.
