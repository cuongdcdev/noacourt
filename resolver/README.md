# Noa Court resolver

The release binary is a WASI Preview 2 guest. It reads one JSON object from stdin and writes exactly one Verdict v1 JSON line to stdout. `resolver_version` is the package version (`0.1.0`).

```json
{"mode":"resolve|simulate|lint","spec_json":"<exact ResolutionSpec JSON string>","context":{"request_id":"req:7","attempt":1,"now":"2026-11-13T10:01:00Z"}}
```

`context.now` is optional; the WASI wall clock is used when absent. Attempt numbers are one based. Malformed input emits an unresolvable Verdict with `spec_hash: ""` and `reason: "input_invalid"`. A parsed but invalid `spec_json` is still hashed byte for byte.

Modes:

- `lint` returns an unresolvable Verdict with `reason: "lint: ok"` or lint codes and an extra `lint` object containing `ok`, `errors`, and effective `labels`.
- `simulate` fetches current or latest available data and ignores the observation gate. The `{T:...}` templates in `http_json` use the current time.
- `resolve` waits until `observation.at`, then fetches historical or snapshot data. Missing inputs and failed source checks produce `retry_after` until `retry.max_attempts`, then `unresolvable`.

Verdict fields, in order: `v`, `resolver_version`, `spec_hash`, `mode`, `status`, `outcome`, `outcome_index`, `value`, `retry_after`, `reason`, `sources`, `jurors`. Values are normalized decimal strings without exponent or redundant trailing zeroes. Timestamps are UTC RFC 3339 at seconds precision.

`http_json.extract.decimals` scales a base-unit integer or decimal as `raw / 10^decimals`. JSON numeric text is parsed directly to `Decimal`, without a binary float round trip. `text_judge.default_if_no_evidence` is the result key `yes` or `no`, which is then mapped by `outcome_map`. `median` requires at least half of declared sources to succeed; `all_agree` requires every source and uses a percentage tolerance relative to the smaller absolute value, or a plain decimal absolute tolerance.

In resolve mode, a candle must be closed before its value can decide an outcome. An in-progress candle reports `candle_not_closed` and follows the retry policy. Undated `web_text` and `http_json` string evidence fetched within `observation.max_delay` is dated at the earlier of fetch time and `text_judge.window.to`; this represents the first fetch after the observation time. Simulate mode dates it at the current time. When no evidence is in the window, `jurors` is `null` because no model was called.

NEAR AI juror requests have a 28 second HTTP timeout. A juror retries once after `llm_timeout`, `llm_transport`, `llm_http_429`, an HTTP 5xx response, or `empty_response`, provided a full request still fits inside the panel's 120 second wall-clock budget. The budget reserves the 28 second request timeout and uses the resolver's WASI clock, independently of `context.now`. Juror `invalid_reason` retains these error codes; `bad_json` means the model returned content that was not valid juror JSON.

## Build and run

```sh
bash scripts/build-resolver.sh
/root/.wasmtime/bin/wasmtime run -S http target/wasm32-wasip2/release/resolver.wasm < resolver/examples/a1_near_threshold.lint.input.json
/root/.wasmtime/bin/wasmtime run -S http target/wasm32-wasip2/release/resolver.wasm < resolver/examples/a1_near_threshold.simulate.input.json
/root/.wasmtime/bin/wasmtime run -S http --env NEAR_AI_API target/wasm32-wasip2/release/resolver.wasm < input.json
```

`-S http` enables outbound WASI HTTP. The optional spike remains runnable with `echo '{"skip_llm":true}' | /root/.wasmtime/bin/wasmtime run -S http target/wasm32-wasip2/release/spike.wasm`.

The build script uses Rust 1.96.0 and `--locked`. It remaps repository, Cargo registry, and toolchain source paths before hashing the release WASM. The toolchain pin is in `resolver/rust-toolchain.toml`; the script invokes `cargo +1.96.0` from the repository root so it does not affect the standalone Court contract.

## Environment

| Name | Purpose |
|---|---|
| `NEAR_AI_API` | Bearer key for NEAR AI Cloud jurors; never printed. |
| `COURT_JUROR_MODELS` | Three comma separated model IDs; defaults to `z-ai/glm-5.3-flash,Qwen/Qwen3.6-35B-A3B-FP8,deepseek/deepseek-v4.1-flash`. |
| `GITHUB_TOKEN` | Optional GitHub API bearer token. |
| `COURT_ALLOW_INSECURE_LOCALHOST` | Set to `1` to permit `http://127.0.0.1` or `http://localhost` fixture URLs. |
| Any `http_json.request.auth.secret` name | Sealed secret resolved via environment and inserted into the configured header. |

## Source error codes

| Code | Meaning |
|---|---|
| `http_4xx`, `http_5xx`, `geo_blocked` | HTTP status failure; Binance 403/451 is geo blocked. |
| `http_timeout`, `transport`, `too_large` | Timeout, transport failure, or response above cap. |
| `not_json`, `assert_failed`, `as_of_missing`, `stale` | JSON parse, identity, timestamp, or observation window failure. |
| `extract_missing`, `extract_not_unique`, `type_mismatch` | JSONPath extraction or type failure. |
| `sanity_failed`, `secret_missing` | Sanity bound or configured secret missing. |
| `rpc_disagree`, `candle_not_found`, `candle_not_closed` | NEAR RPC disagreement, no exact candle, or an exact candle that is still in progress. |

See [examples](examples/README.md) for the saved inputs and output commands.
