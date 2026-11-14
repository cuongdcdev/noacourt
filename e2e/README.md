# [Noa Court](https://github.com/cuongdcdev/noacourt) testnet E2E harness

Node 22 and pnpm are required. The runner creates real testnet markets only when run without `--dry-run`.

```sh
cd e2e
pnpm install
pnpm typecheck
pnpm test
pnpm e2e wave1 --dry-run
pnpm e2e A1
pnpm e2e A2,A3,A4
pnpm e2e A1 --tag "regression 2026-11-13"
pnpm e2e wave1
pnpm e2e resume results/<timestamp>-A1.json
pnpm e2e rerow results/<timestamp>-A1.json
```

Comma-separated targets such as `A2,A3,A4` run concurrently in one process with a five-second stagger.

`A1` is the smoke test. `all` and `wave1` run all scenarios concurrently with a five-second stagger. Every scenario spec allows up to five attempts, three minutes apart. The dry run fetches live prices and read-only testnet views, builds exact `register_spec` and `create_market` calls, and lints every canonical spec with the local resolver WASM. It never signs transactions or writes fixture files. The `fixtures` subcommand copies stable templates into the configured fixture directory and writes their URLs to `fixtures/urls.json` and `fixtures/README.md`. Actual A6/A7/A8/A8n/A9 runs create a unique file per run and verify its served bytes over HTTPS. A6 rewrites the JSON identity, A7 deletes its file, A8 adds an in-window launch item, A8n leaves only an old item, and A9 adds an instruction-only item. `--tag` adds text to the result row notes.

| Scenario | What it proves                                                  |
| -------- | --------------------------------------------------------------- |
| A1       | NEAR 1m close meets or misses a live threshold                  |
| A2       | BTC close maps to a lower-inclusive three-bucket range          |
| A3       | BTC close compares with the creation-minute baseline            |
| A4       | NPOINT balance view observes a 1,000 NPOINT transfer            |
| A6       | Changed JSON identity retries, becomes unresolvable, then voids |
| A7       | Deleted JSON source retries, becomes unresolvable, then voids   |
| A8       | Three text jurors agree on a dated launch post                  |
| A8n      | No in-window RSS evidence returns the default No without jurors |
| A9       | Prompt-injection-only RSS evidence never yields Yes             |
| NEGW     | Short resolution window is permanently rejected, then voided    |

The harness reads **testnet-only** keys from `~/.near-credentials/testnet/<account>.json` at signing time. Keys are never printed or written into results. Keep `e2e/results/` private: its JSON files include signed transaction hashes, full public verdict records, fixture URLs, and recovery state. If a process stops, resume the saved JSON file; the sender polls an uncertain transaction by its persisted hash instead of signing a replacement. `rerow` refreshes only the existing results-table row from a saved file and sends no transaction. Never run two harness processes at once: signer nonce serialization is process-local.

The keeper is expected to link, trigger, void, retry forwarding, and finalize. The runner makes a permissionless fallback call only after the relevant action is over three minutes late and marks it `fallback` in the result. It records keeper hashes from `apps/mcp/data/keeper.log` when that log is available and tries the NearBlocks API when it is not. OutLayer and Noa receipt outcomes are stored when RPC transaction status exposes them. The `tee` flag comes from Court `get_verdict`, so trusted-keeper verdicts remain marked `false`.

Environment variables:

| Variable                | Default                                      | Purpose                                                        |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `NEAR_RPC_URLS`         | Three testnet RPCs                           | Comma-separated RPC rotation list for views, sends, and status |
| `WASMTIME_BIN`          | `/root/.wasmtime/bin/wasmtime`               | Local resolver lint binary                                     |
| `E2E_FIXTURE_DIR`       | `<repo>/apps/mcp/data/fixtures`              | Directory served by the MCP fixture endpoint                   |
| `E2E_FIXTURE_BASE_URL`  | `https://noacourtmcp.junstudio.xyz/fixtures` | HTTPS URL for fixture verification and specs                   |
| `E2E_NEAR_AI_CAP_USD`   | `5`                                          | Cap on estimated juror spend                                   |
| `E2E_NEAR_AI_PRIOR_USD` | `0`                                          | Estimated NEAR AI spend elsewhere, added before the cap check  |

Each run writes `e2e/results/<UTC timestamp>-<scenario>.json` after each step and appends one row to root `E2E_RESULTS.md` when checked. A failed run preserves its state for `resume`; it does not create a second market. The independent check fetches the same candle directly from Binance or OKX, queries the NPOINT contract, or checks final Court and Noa states as appropriate. A8/A9 never call `spec_simulate` because it would spend NEAR AI budget.
