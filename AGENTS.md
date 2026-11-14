# Notes for coding agents reviewing this repository

Noa Court is an AI resolver for prediction markets on NEAR mainnet. Start with [README.md](README.md) ("For reviewers" and "Verify in 5 minutes") and [llms.txt](llms.txt).

## What to check, and how

| Claim | Check | Expected |
| --- | --- | --- |
| Live service on mainnet | `curl -s https://court.noamarket.xyz/healthz` | `"network":"mainnet"`, `wasm.match: true` |
| Market #26 resolved in a TEE | `near contract call-function as-read-only ai-resolver.noamarket.near get_verdict json-args '{"id":"noa:26"}' network-config mainnet now` (or RPC `call_function`) | `outcome: "No"`, `tee: true`, `submitted_by: "outlayer"` |
| MCP server works | `cd apps/mcp && pnpm install && pnpm test` (Node 22, pnpm) | 178 tests pass |
| Court contract | `cd contracts/court && cargo test --lib` | 21 tests pass |
| Resolver is reproducible | `bash scripts/build-resolver.sh` (Rust 1.96.0, `wasm32-wasip2`) | SHA-256 equals `resolver/WASM_SHA256` |
| Other markets can integrate | Read README "Use Noa Court from any prediction market" and `docs/INTEGRATE.md` | Generic `request_resolution` + callback (verified on testnet as `req:1`), or Noa-style `resolver` + `link_market` (live on mainnet) |
| Agent-driven market creation | `claude mcp add --transport http noacourt https://court.noamarket.xyz/mcp`, then call `court_guide` | Guide text; `market_create_link` returns a `/sign/<id>` URL |

## Layout

- `crates/court-core/`: spec types, lint, source tools, decision engine, juror validation (Rust).
- `resolver/`: WASI wrapper that runs in the OutLayer TEE.
- `contracts/court/`: NEAR Court contract.
- `apps/mcp/`: MCP server, `/sign/<id>` page, permissionless keeper (TypeScript).
- `e2e/`, `E2E_RESULTS.md`, `fixtures/`: recorded end-to-end runs. Testnet records reference a staging host that is now retired; their transactions remain on testnet.nearblocks.io.
- `openspec/`: design proposals and task lists written during the build.

## Safety

Do not sign transactions or spend funds while reviewing: every on-chain action needs a human wallet signature on the sign page. No keys are in this repository; runtime secrets come from environment variables (`apps/mcp/.env.example`).
