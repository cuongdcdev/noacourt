# Saved WASM runs

- `a1_near_threshold.spec.json`: canonical JCS A1 spec; `a1_near_threshold.spec_hash` is the hash of the exact JSON without the file's final newline.
- `a1_near_threshold.lint.input.json` and `.lint.output.json`: lint mode.
- `a1_near_threshold.simulate.input.json` and `.simulate.output.json`: live Binance/OKX simulate run. The output is a point in time sample.
- `a1_near_threshold.resolve_before.input.json` and `.resolve_before.output.json`: observation gate.
- `text_judge_fixture.spec.json`, `.simulate.input.json`, `.simulate.output.json`: local RSS fixture; all items fall outside the declared window, so the default No outcome is selected without a juror call.
- `fixtures/launch.xml`, `text_judge_live.spec.json`, `text_judge_live.simulate.input.json`: operator juror fixture and canonical spec. `text_judge_live.simulate.output.json` records an earlier operator run and is retained as historical evidence.

Commands used from the repository root:

```sh
/root/.wasmtime/bin/wasmtime run -S http target/wasm32-wasip2/release/resolver.wasm < resolver/examples/a1_near_threshold.lint.input.json > resolver/examples/a1_near_threshold.lint.output.json
/root/.wasmtime/bin/wasmtime run -S http target/wasm32-wasip2/release/resolver.wasm < resolver/examples/a1_near_threshold.simulate.input.json > resolver/examples/a1_near_threshold.simulate.output.json
/root/.wasmtime/bin/wasmtime run -S http target/wasm32-wasip2/release/resolver.wasm < resolver/examples/a1_near_threshold.resolve_before.input.json > resolver/examples/a1_near_threshold.resolve_before.output.json
python3 -m http.server 8765 --bind 127.0.0.1 --directory crates/court-core/tests/fixtures
# In another terminal:
COURT_ALLOW_INSECURE_LOCALHOST=1 /root/.wasmtime/bin/wasmtime run -S http --env COURT_ALLOW_INSECURE_LOCALHOST target/wasm32-wasip2/release/resolver.wasm < resolver/examples/text_judge_fixture.simulate.input.json > resolver/examples/text_judge_fixture.simulate.output.json
```

The text judge fixture is HTTP only on loopback. Production rejects non HTTPS URLs.

Operator live juror run (serve the fixture in one terminal, then run Wasmtime in another):

The default juror models are `z-ai/glm-5.3-flash,Qwen/Qwen3.6-35B-A3B-FP8,deepseek/deepseek-v4.1-flash`.

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory resolver/examples/fixtures
COURT_ALLOW_INSECURE_LOCALHOST=1 /root/.wasmtime/bin/wasmtime run -S http --env NEAR_AI_API --env COURT_ALLOW_INSECURE_LOCALHOST target/wasm32-wasip2/release/resolver.wasm < resolver/examples/text_judge_live.simulate.input.json
```
