## Context
Tools and flow: `docs/ARCHITECTURE.md` §2, §6, §7. Resolver wasm and lint come from court-core (`resolver/target/.../resolver.wasm` + `resolver/WASM_SHA256`). Court interface §5.

## Decisions
- `@modelcontextprotocol/sdk` Streamable HTTP (stateless mode), Express/Hono server, single process; port 3310 (check free).
- Lint and simulate both execute `resolver.wasm` via the `wasmtime` CLI subprocess (`-S http`, timeout 60 s), passing `NEAR_AI_API` from `.env` only for text_judge simulate. `spec_simulate` returns the wasm sha256 and whether it equals Court's configured resolver.
- `rules_render` is a deterministic template (no LLM) → markdown rules incl. source labels ("verified" / "self-declared, may be controlled by the creator"), boundary operators, on_unavailable, preflight flag.
- `court_guide` returns the drafting rules from SESSION_HANDOFF §6 "Quy tắc trong skill" (English), catalog, verified domains, example specs (A1, A2, A6, A8 from `private/STATE.md`/e2e change).
- `market_create_link` stores a pending sign request (SQLite file `apps/mcp/data/`, 24 h TTL) with fully built tx args; returns URL + QR PNG data URL. Rejects specs that fail lint.
- Sign page: static HTML + bundled `@near-wallet-selector` (modules: intear-wallet, meteor-wallet, my-near-wallet), network testnet; `signAndSendTransactions` [register_spec, create_market(metadata_hash="noacourt:"+hash, resolver=Court)]; parse market_id from create_market result; then server calls link_market with keeper key. Shows tx links (testnet nearblocks).
- Rate limit: 60 req/min/IP for tools, 10 simulate/min/IP, global NEAR AI simulate budget counter (stop at configured $ cap, default $5 overnight).
- Keeper: every 30 s: list Court markets/requests (views) → link unlinked (from Noa markets with our resolver + noacourt metadata), trigger due, void eligible, finalize_resolution after dispute window (Noa view). Idempotent; logs JSON lines to `apps/mcp/data/keeper.log`.
- Process: run under pm2 if installed (else nohup + restart script) with name `noacourt-mcp`.

## Risks
- wallet-selector Intear/Meteor testnet support may be incomplete → MyNearWallet testnet is the guaranteed path; record findings.
