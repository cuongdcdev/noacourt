# Noa Court MCP

Standalone Node 22/pnpm server for the ten Noa Court MCP tools, wallet sign links, and the permissionless keeper. It never asks for or stores creator keys. The only server key is the keeper credential configured by `KEEPER_CREDENTIALS`.

## Run

From `apps/mcp`: `pnpm install`, `pnpm build`, `pnpm test`, then `pnpm start` (or `pnpm dev`). Configuration is read from the repository `.env` and process env; see `.env.example`. `/healthz` and `/mcp` listen on `127.0.0.1:3310` by default. The keeper starts when `KEEPER_ENABLED=1`. Default testnet RPCs are FastNEAR, NEAR testnet, and FastNEAR archival (`https://archival-rpc.testnet.fastnear.com`); custom endpoints can be set with `NEAR_RPC_URLS`.

Court configuration and the local/published resolver hashes refresh in the background every `COURT_CONFIG_REFRESH_MS` (60 seconds by default). `/healthz` reports the last successful Court fetch time and last refresh error; an RPC failure leaves the last known config available. The local WASM hash is recalculated when its file modification time or size changes.

`GET` and `HEAD /fixtures/:name` serve files from `DATA_DIR/fixtures` with no caching. Allowed file extensions are `.json`, `.xml`, `.rss`, `.html`, and `.txt`. Files can be edited on disk without restarting the server; the route has a separate 600 requests/minute/IP limit and no write endpoint.

The tools are `court_guide`, `catalog_list`, `catalog_tool`, `source_sample`, `spec_lint`, `spec_simulate`, `rules_render`, `market_create_link`, `market_status`, and `verdict_get`. `market_create_link` stores a request in `data/mcp.sqlite` and returns a QR sign URL. It expires at the earlier of 24 hours or the safe signing deadline. `/sign/<id>` uses NEAR Connect (`@hot-labs/near-connect`, same vendored build as Noa Market) with Intear, Meteor (extension, web and mobile app) and HOT Wallet. The wallet page refreshes the transaction plan immediately before signing.

## Noa description and rules publication

`market_create_link` takes an optional plain-text `description` (max 4000 characters, no control characters); omitted means the rendered rules. It never alters the spec or `spec_hash`. The link stores a frozen snapshot (description, exact rules text, renderer version `rules-v1`, spec hash, `metadata_digest`) in new nullable `sign_requests` columns, added by an automatic migration. The sign page shows description, rules, spec hash and digest before signing. Legacy pending rows get one deterministic snapshot on first read; legacy completed rows report `legacy_unavailable` and are never published.

| Env var                      | Meaning                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `NOA_API_URL`                | Noa API base the browser publishes to and the server reads back (mainnet default `https://noamarket.xyz/api-proxy`).             |
| `NOA_AUTH_RECIPIENT`         | NEP-413 recipient; must equal Noa's `AUTH_RECIPIENT` (mainnet default `noamarket.near`; testnet recipients must end `.testnet`). |
| `NOA_MARKET_URL_BASE`        | Market page prefix; `<base><market_id>` is the published link (mainnet default `https://noamarket.xyz/markets/`).                |
| `PUBLICATION_VERIFY_PER_MIN` | Read-back requests per sign request and IP per minute (default 12).                                                              |

URLs must be `https` (or `http` on localhost/127.0.0.1) without credentials, query or fragment. If none of the three is set (the testnet default) publication is **disabled**: the sign page shows a banner and the create flow is unchanged. If any is set, all three must be valid; otherwise the config is invalid and new links and create transactions are refused with a visible error. The browser only receives these values from the server.

Local run against a Noa API on `http://localhost:3401` (frontend on 3411): `PUBLIC_BASE_URL` must still be HTTPS for link creation; set `NOA_API_URL=http://localhost:3401 NOA_AUTH_RECIPIENT=noamarket.testnet NOA_MARKET_URL_BASE=http://localhost:3411/markets/`. Noa's `CORS_ORIGINS` must include the exact sign-page origin (for example `http://localhost:3310`) and the API must accept the `Authorization` and `Content-Type` headers. An HTTPS sign page cannot call a plain-HTTP remote API (mixed content); localhost is exempt.

Publication states (`GET /api/sign/<id>` → `publication.state`, `market_status.metadata_publication`): `not_started`, `auth_required`, `publishing`, `awaiting_verification`, `published`, `retryable_error`, `conflict`, `legacy_unavailable`, `disabled`. `POST /api/sign/<id>/publication/verify` (no body, no token) reads the configured Noa market and compares description and rules byte-for-byte; only it can set `published`. `POST /api/sign/<id>/publication/report` lets the page persist progress with a fixed error code, never `published`. Noa metadata is write-once: identical retry is 200 `already_published`, different content is 409 (`conflict`, stop, never overwritten), a different account is 403. Recovery order: read-back first; missing leads to login (if needed) and the identical POST; 401 renews login once; 409/403 stop; 429/5xx/network get bounded backoff. Creation is never repeated. The reopened sign page of a completed request always shows the publication panel.

Wallets: NEAR Connect with Intear (vendor-hosted executor), Meteor (extension, web and mobile app) and HOT Wallet (self-hosted executors in `static/wallets/`, provenance in `static/wallets/SOURCES.md`). NEP-413 `signMessage` is called without `callbackUrl`, matching Noa's `callbackUrl: null` verification. A mobile/redirect wallet matrix is untested. Other wallets, metadata backfill of old markets and mainnet activation are out of scope.

`e2e/publish/run.ts <sign-request-id> <creator-key-file>` is a Node "stub wallet": it signs the Noa login with a testnet key file (read in-process, never printed), publishes through the same `noaPublish` module and calls the verify endpoint.

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
