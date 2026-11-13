# Noa Court contract

Standalone NEAR contract for ResolutionSpec registration, Noa market resolution, and generic resolution requests. It uses `near-sdk =5.29.1`; the workspace in this directory is independent of the repository root. No network deployment is part of this project.

## Build and test

Run from `contracts/court`:

```sh
cargo test --lib
cargo near build non-reproducible-wasm
./tests/build-test-deps.sh
NEAR_SANDBOX_BIN_PATH=/tmp/claude-0/w1/sandbox-bin/near-sandbox-wrapper \
  cargo test --test sandbox -- --ignored --nocapture --test-threads=1
```

The optimized Court artifact is `target/near/noa_court.wasm`. The build script also creates optimized WASM for both test stubs. The ignored sandbox test uses `near-workspaces` 0.22.1 and a local sandbox only.

## Public JSON interface

Amounts passed as `U128` are **decimal strings in yoctoNEAR**. Times in Noa market JSON are **plain JSON numbers in nanoseconds**. The `spec_json` argument is a string containing the exact canonical spec bytes; it is never reserialized before hashing. The examples below are complete argument objects, with `sha256:<hex>` standing for the 64-character hash returned by `register_spec`.

| Method | Exact example JSON arguments | Attached deposit | Recommended gas |
| --- | --- | --- | --- |
| `init` | `{"owner":"owner.testnet","noa_contract":"v3.noamarket.testnet","outlayer_contract":"outlayer.testnet","resolver_source":{"Project":{"project_id":"owner.testnet/court","version_key":null}},"secrets_ref":{"profile":"court","account_id":"owner.testnet"},"treasury":"treasury.testnet","min_deposit":"100000000000000000000000","max_attempts":3}` | 0 | 80 TGas |
| `register_spec` | `{"spec_json":"{\"version\":1,\"outcomes\":[\"Yes\",\"No\"],\"observation\":{\"at\":\"2026-11-13T10:00:00Z\"},\"on_unavailable\":\"void\",\"retry\":{\"max_attempts\":3,\"every\":\"5m\"}}"}` | At least `min_deposit` and storage cost plus `resolution_fee`; excess refunded | 100 TGas |
| `link_market` | `{"market_id":42,"spec_hash":null}` | 0 | 100 TGas |
| `trigger` | `{"market_id":42}` | 0 | 220 TGas at default configuration |
| `retry_forward` | `{"market_id":42}` | 0 | 80 TGas |
| `void` | `{"market_id":42}` | 0 | 80 TGas |
| `void_unlinked` | `{"market_id":66}` | 0 | 80 TGas |
| `request_resolution` | `{"spec_json":"{\"version\":1,\"outcomes\":[\"Yes\",\"No\"],\"observation\":{\"at\":\"2026-11-13T10:00:00Z\"},\"on_unavailable\":\"void\"}","callback":{"contract_id":"consumer.testnet","method":"on_court_verdict"}}` | Same rule as `register_spec` | 100 TGas |
| `trigger_request` | `{"request_id":"req:1"}` | 0 | 220 TGas at default configuration |
| `submit_keeper_verdict` | `{"id":"noa:42","verdict_json":"{\"v\":1,\"resolver_version\":\"0.1.0\",\"spec_hash\":\"sha256:<hex>\",\"mode\":\"resolve\",\"status\":\"resolved\",\"outcome\":\"Yes\",\"outcome_index\":0}"}` | 0 | 100 TGas |
| `get_spec` | `{"spec_hash":"sha256:<hex>"}` | View | View |
| `get_credits` | `{"spec_hash":"sha256:<hex>","account_id":"user1.noamarket.testnet"}` | View | View |
| `get_market` | `{"market_id":42}` | View | View |
| `get_request` | `{"request_id":"req:1"}` | View | View |
| `get_verdict` | `{"id":"noa:42"}` or `{"id":"req:1"}` | View | View |
| `get_config` | `{}` | View | View |
| `set_resolver_source` | `{"resolver_source":{"Project":{"project_id":"owner.testnet/court","version_key":null}}}` | Exactly 1 yoctoNEAR | 30 TGas |
| `set_secrets_ref` | `{"secrets_ref":{"profile":"court","account_id":"owner.testnet"}}` | Exactly 1 yoctoNEAR | 30 TGas |
| `set_min_deposit` | `{"min_deposit":"100000000000000000000000"}` | Exactly 1 yoctoNEAR | 30 TGas |
| `set_trusted_keeper` | `{"trusted_keeper":"keeper.testnet"}` | Exactly 1 yoctoNEAR | 30 TGas |
| `set_outlayer_params` | `{"resource_limits":{"max_instructions":10000000000,"max_memory_mb":128,"max_execution_seconds":60},"outlayer_deposit":"10000000000000000000000","outlayer_gas_tgas":100,"resolution_fee":"50000000000000000000000"}` | Exactly 1 yoctoNEAR | 30 TGas |
| `set_owner` | `{"owner":"new-owner.testnet"}` | Exactly 1 yoctoNEAR | 30 TGas |
| `withdraw` | `{"token":null,"amount":"1000000000000000000000000"}` (NEAR) or `{"token":"token.testnet","amount":"1000"}` (NEP-141) | Exactly 1 yoctoNEAR | 50 TGas |

All setters and `withdraw` are owner-only. `set_secrets_ref` and `set_trusted_keeper` accept `null` to clear the value. Individual fields of `set_outlayer_params` may be `null` to retain their current values. `set_outlayer_params` accepts OutLayer gas from 20 through 250 TGas. `withdraw` sends funds to the configured treasury. NEAR withdrawals preserve a storage allowance plus 0.1 NEAR reserve. FT withdrawals send `ft_transfer` with 1 yoctoNEAR; the token must be a standard NEP-141 contract. Withdrawing Court's internal balance on Noa is not implemented.

`register_spec` gives one prepaid credit for the exact spec hash to the account that pays its deposit. `link_market` is permissionless, but consumes a credit belonging to the **Noa market creator**. It rejects a market whose creator has no credit with `creator has no credit for spec`, even if another account registered the same spec. Use `get_credits` to check an account's spendable balance. `get_spec.credits` is a legacy aggregate counter for information only; it does not authorize linking. Credits paid before the per-payer ledger was introduced cannot be attributed safely after a code-only upgrade, so those historical credits are not spendable through `get_credits`; their payers must register again.

`link_market` accepts an explicit `spec_hash` for a market whose metadata does not start with `noacourt:` only when called by the market creator. When metadata does start with `noacourt:`, any caller may link, and an explicit hash must match it. Its callback logs a `link_rejected` event and returns `false` on validation failure. At least 60 TGas prepaid is required.

The Noa resolution deadline must be at least `observation.at + effective_max_attempts × retry.every + 5 minutes`, where `effective_max_attempts` is the smaller of Court's configured maximum and the spec's retry maximum. When the spec has no `retry`, this link check uses a five-minute retry interval for each configured attempt. A shorter window is rejected with `resolution window too short for retries`; the market creator keeps their credit. Equality at the boundary is accepted.

`void_unlinked` is permissionless for a Noa market with Court as resolver that has no Court `Item`. It requires at least 80 TGas and reads Noa's market before forwarding `void_market` with exactly 1 yoctoNEAR. The market must still be `Active`, unlinked, and past its resolution deadline. Invalid cases return `false` from the private validation callback with a `void_unlinked_rejected` event; the final callback emits `void_unlinked` with `success: true` or `false`. No Court state is created. Noa can reject a void when it has a pending resolution proposal, which is not visible in `get_market`.

`trigger` and `trigger_request` require the observation time, retry time, attempt limit, contract balance, and gas checks to pass. At default settings they require at least 165 TGas prepaid; attach 220 TGas to allow margin. The OutLayer request uses `response_format: "Json"`, Court as payer, and the exact stored `spec_json` in `ResolverInput`. The default resource limits are 10 billion instructions, 128 MB, 60 seconds. OutLayer deposit defaults to 0.01 NEAR, resolution fee to 0.05 NEAR, and the recommended minimum registration deposit is 0.1 NEAR. The minimum is supplied explicitly at initialization.

## State and receipts

Markets begin `Linked`, become `Pending` per attempt, then `RetryScheduled`, `Resolved`, or `Unresolvable`. An OutLayer promise failure counts as an attempt and leaves the item `RetryScheduled` with `last_error` set. Anyone can call `void` after the Noa deadline for a nonfinal market, making it `Voided` after Noa confirms. A resolved market records `forwarded: null` while Noa is processing, then `true` or `false`; anyone can call `retry_forward` when it is `false` and the deadline has not passed. If forwarding failed and the deadline has passed, anyone can instead call `void`. Noa may still reject that call if it has a pending resolution proposal; a failed void call preserves Court's prior state so it can be retried. Generic requests follow the same states without a Noa deadline or forwarding step.

If the OutLayer promise fails, returns empty bytes, or returns JSON `null`, `last_error` and the `verdict_rejected` event use the exact reason `outlayer_execution_failed`. The attempt and retry or exhaustion rules are unchanged. An OutLayer `{ "success": false, "error": "..." }` wrapper keeps its `outlayer: <error>` reason; other malformed outputs keep their parser reasons.

The latest verdict record contains the full parsed Verdict JSON, `tee`, submitter, attempt, reception time, OutLayer request metadata, and `applied_on_unavailable`. A generic callback receives `{"request_id":"req:1","verdict":<that full record>}` once on a final outcome. An exhausted failed execution stores a synthetic unresolvable record with `tee: false` and its error reason. The callback has 20 TGas and no return callback. Events use NEP-297 `EVENT_JSON` logs under standard `noacourt`, version `1.0.0`.

Only the private `on_verdict` method consumes OutLayer results. A sequence number rejects stale callbacks. `submit_keeper_verdict` is a **testnet-only** fallback; set `trusted_keeper` to `null` before any mainnet deployment. Its receipts have `tee: false` and `submitted_by: "keeper:<account>"` so consumers can distinguish them from TEE output.

## Safe choices where the spec is silent

- Specs are capped at 16 KiB and callback results at 32 KiB. Only the minimal spec fields needed for on-chain checks are parsed; source and decide semantics remain the pinned resolver's job.
- Outcome names must be nonempty and unique, and market outcome IDs must match their zero-based positions. A linked market must be `Active`, have Court as resolver, and have a deadline after expiration.
- The UTC parser accepts `Z` or `+00:00`, with up to nine fractional second digits, and rejects invalid dates and pre-1970 dates. Duration units are `s`, `m`, `h`, and `d`.
- Generic requests consume the credit paid in their call. Re-registering an existing spec adds another payer-owned credit without charging for duplicate spec bytes. A market link consumes one credit from the market creator, regardless of who calls `link_market`.
- Retrying after an invalid verdict uses `retry.every`; absent `retry` means immediate retry. Exhaustion follows `on_unavailable`. If `on_unavailable` names an outcome, the stored raw verdict remains visible with `applied_on_unavailable: true`.
- Court does not finalize Noa's resolution proposal. Noa's separate `finalize_resolution` remains a permissionless downstream step after its dispute window.
