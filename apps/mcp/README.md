# Noa Court MCP

Standalone Node 22/pnpm server for the ten Noa Court MCP tools, wallet sign links, and the permissionless keeper. It never asks for or stores creator keys. The only server key is the keeper credential configured by `KEEPER_CREDENTIALS`.

## Run

From `apps/mcp`: `pnpm install`, `pnpm build`, `pnpm test`, then `pnpm start` (or `pnpm dev`). Configuration is read from the repository `.env` and process env; see `.env.example`. `/healthz` and `/mcp` listen on `127.0.0.1:3310` by default. The keeper starts when `KEEPER_ENABLED=1`. Default testnet RPCs are FastNEAR, NEAR testnet, and NEAR archival; custom endpoints can be set with `NEAR_RPC_URLS`.

`GET` and `HEAD /fixtures/:name` serve files from `DATA_DIR/fixtures` with no caching. Allowed file extensions are `.json`, `.xml`, `.rss`, `.html`, and `.txt`. Files can be edited on disk without restarting the server; the route has a separate 600 requests/minute/IP limit and no write endpoint.

The tools are `court_guide`, `catalog_list`, `catalog_tool`, `source_sample`, `spec_lint`, `spec_simulate`, `rules_render`, `market_create_link`, `market_status`, and `verdict_get`. `market_create_link` stores a 24-hour request in `data/mcp.sqlite` and returns a QR sign URL. `/sign/<id>` uses wallet-selector with Intear, Meteor, and MyNearWallet on testnet.

The keeper's normal permissionless calls are Court `link_market`, `trigger`, `trigger_request`, `retry_forward`, `void`, `void_unlinked`, and Noa `finalize_resolution`. `submit_keeper_verdict` is used only with `COURT_TRUSTED_KEEPER=1`. Its receipt is marked `tee: false` by Court.

Rejected market links are cached in `data/mcp.sqlite`: permanent Court validation failures stop further link attempts; temporary failures retry after 5, 15, and 60 minutes, then stop. Unlinked markets past their resolution deadline are sent to `void_unlinked` when Court supports it. An unsupported method pauses these probes for one hour.

Keeper `trigger` and `trigger_request` attach 300 TGas to cover the OutLayer execution request and Court callbacks.
They wait until `observation.at` plus `TRIGGER_GRACE_SECONDS` (70 seconds by default), and still respect Court's later `retry_at_ns` when present.

## Transaction builder

Import `buildCreateMarketTxs` and `parseCreateMarketResult` from `src/lib.ts` or the built package entry. The builder converts NPOINT stake amounts with integer decimal math. If the account's Noa internal balance is insufficient, it adds `ft_transfer_call` before Court registration and Noa creation. The live signer plan reads Court's `min_deposit`, Noa's `market_creation_fee`, fee exemption, and internal balance through the rotating RPC client.

Noa currently charges 0.5 NEAR plus measured storage to non-exempt creators and **does not refund excess attached deposit** (`contracts/src/lib.rs` around `create_market`). The plan adds a 0.1 NEAR storage buffer, so the creator pays that excess. Fee-exempt creators attach zero to `create_market`.

## Deploy

`scripts/start.sh` starts a restart loop with `data/server.pid` and `data/server.log`; `scripts/stop.sh` stops only that PID. `scripts/tunnel-start.sh` runs `tunnel-run-forever.sh` with a restart backoff and stores the wrapper PID in `data/tunnel.pid`; `scripts/tunnel-stop.sh` stops only that wrapper or a legacy direct tunnel process. Both use only `/root/.cloudflared/noacourt-mcp.yml`. Create the named tunnel/config separately before starting it. No tunnel is created by this package.
