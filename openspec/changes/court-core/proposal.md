## Why
Noa Court needs one deterministic engine that lints a ResolutionSpec, fetches the declared sources, and decides an outcome, and the exact same bytes must run in OutLayer TEE (resolve) and in the MCP server (simulate). Without a single pinned engine, "simulate" and "resolve" can disagree and the TEE attestation proves nothing about the rules the creator saw.

## What Changes
- New Rust library `crates/court-core`: ResolutionSpec v1 types, spec hash, lint, source adapters, aggregate, decide (threshold, buckets, equals, bool, change, text_judge), Verdict v1.
- New `resolver/` binary built for `wasm32-wasip2` (`resolver.wasm`), stdin ResolverInput → stdout Verdict, modes `lint|simulate|resolve`.
- text_judge: 3 NEAR AI Cloud jurors with verbatim-quote and time-window checks.
- Spike first: prove a wasip2 job on OutLayer **testnet** can fetch Binance/OKX and POST to NEAR AI Cloud.
- Interfaces are fixed by `docs/ARCHITECTURE.md` §3–§4.

## Capabilities
### New Capabilities
- `resolution-spec`: spec format, hashing and lint rules.
- `resolver-engine`: source fetching, aggregation, decision, Verdict output, text_judge.

### Modified Capabilities
(none)

## Impact
New code only: `crates/court-core`, `resolver/`, root `Cargo.toml` workspace. Consumed by `contracts/court` (Verdict schema) and `apps/mcp` (wasm + lint).
