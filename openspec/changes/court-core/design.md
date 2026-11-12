## Context
Source of truth for formats: `docs/ARCHITECTURE.md` §3 (spec, tools, decide kinds, lint) and §4 (resolver I/O, Verdict, text_judge). Product background: `SESSION_HANDOFF.md` §4–§7. Owner decisions: `private/STATE.md`.

## Goals / Non-Goals
Goals: identical behaviour in TEE and simulate; never guess (any failure → retry_after / unresolvable); decimal math only.
Non-goals: pagination, OAuth, CSV/XML, web_search, near_token, JS-rendered pages.

## Decisions
- Crates: `serde_json`, `rust_decimal`, `serde_json_path` (RFC 9535), `sha2`, `feed-rs` only if it builds for wasip2 (else a minimal RSS/Atom parser), `time` for RFC 3339.
- HTTP: court-core defines a small `Http` trait; `resolver/` implements it with the wasi:http client used by OutLayer apps (follow https://skills.outlayer.ai/building-outlayer-apps/SKILL.md; working reference workers in `../mvp-fulfil/workers/token-verifier`). Native tests use a mock `Http` with recorded fixtures.
- Clock: `context.now` if given, else WASI wall clock.
- Positional JSONPath indexes (`[0]`, `[-1]`) are rejected by lint unless `extract.allow_index: true` with `index_reason`.
- Candle tools select the candle whose `[open_time, close_time]` contains `observation.at` (exact, by timestamp), not the latest.
- text_judge models from env `COURT_JUROR_MODELS` (comma list, default 3 NEAR AI open models), key from env/secret `NEAR_AI_API`, endpoint `https://cloud-api.near.ai/v1/chat/completions` (OpenAI-compatible). Juror output forced JSON. Confidence threshold 0.7, 3/3 agreement.
- Build: `cargo build -p resolver --target wasm32-wasip2 --release`; publish sha256 of the wasm in `resolver/WASM_SHA256`.

## Risks / Trade-offs
- OutLayer testnet single executor → retries; mitigated by Court retry and testnet-only trusted_keeper (court-contract change).
- NEAR AI reachability from inside OutLayer unverified → spike task 1 decides; if blocked, text_judge works in simulate/trusted_keeper only and this is documented.
- Binance 451 from some egress → fallback venues OKX/Coinbase + `geo_blocked` code.
