## Context
Interface: `docs/ARCHITECTURE.md` §2, §5. Verdict JSON: §4. Proven OutLayer on-chain pattern to copy from (same owner): `../mvp-fulfil/contracts/escrow/src/lib.rs` (`ext_outlayer::request_execution`, SecretsRef, callback parsing) and test stub `../mvp-fulfil/contracts/test-stubs/mock-outlayer`. Noa methods: `create_market` lib.rs:1019, `get_market` :1333, `resolve_market` :1671 (resolver only, 1 yocto, after expiration, before resolution_deadline, once), `finalize_resolution` :1715, `void_market` :1747.

## Decisions
- near-sdk 5.x, borsh state, JSON ABI. Store spec_json as String keyed by spec_hash (computed on-chain with env::sha256).
- link_market: cross-contract `get_market` → callback validates: resolver == current_account, metadata_hash == "noacourt:"+spec_hash (or caller == market.creator with explicit spec_hash), outcomes equal spec.outcomes, market expiration <= observation.at. Parse only the minimal fields needed from spec_json (outcomes, observation.at, retry) with serde_json in contract.
- trigger: require linked, `now >= observation.at`, no pending request, retry time passed, attempts < max. Attach OutLayer deposit from contract balance (prepaid by register deposit). Input = ResolverInput JSON with `mode: "resolve"`, `context.request_id = "noa:<id>"`, attempt.
- on_verdict (#[private]): on promise failure → keep state retryable (attempt counted). Parse Verdict; reject if spec_hash mismatch or mode != resolve. resolved → `resolve_market(market_id, outcome_index)` with 1 yocto, store verdict; retry_after → RetryScheduled(t); unresolvable → Unresolvable.
- void(market_id): permissionless if Unresolvable (or attempts exhausted) and Noa deadline passed → `void_market`.
- Generic requests reuse the same pipeline keyed `req:<n>`; optional callback `contract_id.method({request_id, verdict})` fire-and-forget with fixed gas.
- Fees: deposit min (config, default 0.1 NEAR testnet); OutLayer cost per attempt from contract balance; solver fees from Noa finalize land in Court's internal Noa balance (withdraw later; out of scope beyond owner `withdraw`).
- trusted_keeper: Option<AccountId>, owner-set; `submit_keeper_verdict(id, verdict_json)` only by it; stored verdict `tee=false`. Documented as testnet-only.

## Risks
- Gas for get_market callback with large markets: request ≥ 100 TGas for link, ≥ 150 TGas for trigger; measure and record.
