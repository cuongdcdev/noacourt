## 1. Spike (gates the rest)
- [ ] 1.1 Minimal wasip2 app: GET data-api.binance.vision kline, GET OKX candle, POST cloud-api.near.ai chat completion; prints JSON. Build for wasm32-wasip2.
- [ ] 1.2 Run it locally with wasmtime (`-S http`) and record the exact command in `resolver/README.md`.
- [ ] 1.3 Deploy as OutLayer testnet project owned by court-ops.noamarket.testnet (`OUTLAYER_NETWORK=testnet` ALWAYS) and execute it once via the on-chain `request_execution` path from court-ops (attach the documented deposit); record tx hash, output, egress behaviour (Binance 451?), NEAR AI reachability in `private/STATE.md` "Spike results".
- [ ] 1.4 Seal `NEAR_AI_API` (from `mvp-noacourt/.env`, never print) as an OutLayer testnet secret for this project; record the secrets_ref (profile/account) in STATE.md.

## 2. court-core
- [ ] 2.1 Cargo workspace members: crates/court-core, resolver, contracts/court (contract may be added by another agent; keep root Cargo.toml minimal).
- [ ] 2.2 Spec types + RFC 8785 canonicalizer + spec_hash.
- [ ] 2.3 Lint with error codes per spec; unit tests per rule.
- [ ] 2.4 Adapters: binance_kline, okx_candle, coinbase_candle, coingecko_price, near_view (2 RPCs agree), github_repo, http_json (assert, as_of, extract, type, decimals, sanity), rss_feed, web_text. Tests with recorded fixtures (`crates/court-core/tests/fixtures`).
- [ ] 2.5 aggregate + decide (all kinds incl. change) + outcome_map; boundary tests.
- [ ] 2.6 text_judge panel with verbatim-quote check, window check, injection wrapper; tests with a mocked LLM.
- [ ] 2.7 Verdict v1 serializer; golden tests.

## 3. resolver.wasm
- [ ] 3.1 stdin ResolverInput → stdout Verdict, modes lint/simulate/resolve.
- [ ] 3.2 Release build, write `resolver/WASM_SHA256`; script `scripts/build-resolver.sh`.
- [ ] 3.3 Live smoke (local wasmtime): simulate A1 NEAR threshold spec and a text_judge spec against a local fixture; save outputs under `resolver/examples/`.
- [ ] 3.4 Deploy final resolver to the OutLayer testnet project; record version/source identifier for Court `resolver_source` in STATE.md.
