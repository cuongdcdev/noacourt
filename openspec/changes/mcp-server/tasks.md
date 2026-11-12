## 1. Server
- [x] 1.1 Scaffold `apps/mcp` (pnpm, TS, Node 22, vitest). Config from env (`.env` in mvp-noacourt; never log secrets).
- [x] 1.2 MCP Streamable HTTP `/mcp` + `/healthz`; tools per spec, schemas with zod.
- [x] 1.3 wasmtime runner for lint/simulate; report wasm sha256 vs Court `get_config`.
- [x] 1.4 rules_render template + canonical spec_json + spec_hash.
- [x] 1.5 source_sample (proxy one adapter call through resolver simulate of a single-source spec) + suggested asserts.
- [x] 1.6 Rate limit + NEAR AI spend cap counter.
- [x] 1.7 Tests: tools happy/error paths (mock wasmtime + mock RPC).

## 2. Sign flow
- [x] 2.1 Pending store (SQLite), market_create_link, QR PNG.
- [x] 2.2 `/sign/<id>` page with wallet-selector (Intear, Meteor, MyNearWallet; testnet), batch sign, result parsing, link_market call.
- [x] 2.3 Verify headless that the page renders and builds the correct tx args (unit test on arg builder; screenshot not required).

## 3. Keeper
- [x] 3.1 Loop: link / trigger / trigger_request / void / finalize; JSON log.
- [x] 3.2 trusted_keeper mode (off by default; env `COURT_TRUSTED_KEEPER=1`): run resolver.wasm locally in resolve mode and submit_keeper_verdict.

## 4. Deploy
- [x] 4.1 New named tunnel `noacourt-mcp` with its own config `~/.cloudflared/noacourt-mcp.yml` → localhost:3310; `cloudflared tunnel route dns noacourt-mcp noacourtmcp.junstudio.xyz`. Do NOT edit `~/.cloudflared/config.yml` or other tunnels.
- [x] 4.2 Run server + tunnel under pm2 (or nohup scripts in `apps/mcp/scripts/`), names `noacourt-mcp`, `noacourt-tunnel`.
- [x] 4.3 Smoke: `curl https://noacourtmcp.junstudio.xyz/healthz`, MCP initialize + tools/list via the public URL; record in STATE.md.
