## 1. Contract
- [x] 1.1 Scaffold `contracts/court` (near-sdk 5, cargo-near build, reproducible build settings like `../mvp-fulfil/contracts/escrow`).
- [x] 1.2 State, init, config, owner methods (set_resolver_source, set_secrets_ref, set_min_deposit, set_trusted_keeper, withdraw).
- [x] 1.3 register_spec + get_spec.
- [x] 1.4 link_market (+ creator fallback with explicit spec_hash) with get_market callback.
- [x] 1.5 trigger → request_execution → on_verdict; resolve_market / retry / unresolvable.
- [x] 1.6 void.
- [x] 1.7 request_resolution / trigger_request / get_verdict / callback.
- [x] 1.8 submit_keeper_verdict (trusted_keeper only, tee=false).
- [x] 1.9 Views: get_market, get_request, get_verdict, get_config.

## 2. Tests
- [x] 2.1 Unit tests for every spec scenario.
- [x] 2.2 near-workspaces (sandbox) integration: deploy mock Noa (minimal stub with get_market/resolve_market/void_market) + mock OutLayer (adapt `../mvp-fulfil/contracts/test-stubs/mock-outlayer`) → full lifecycle resolved / retry / void / generic callback.
- [x] 2.3 Record gas for link/trigger/callback in `contracts/court/GAS.md`.

## 3. Deploy (testnet)
- [x] 3.1 Deploy to `ai-resolver.noamarket.testnet` (key in ~/.near-credentials/testnet), init with noa=v3.noamarket.testnet, outlayer=outlayer.testnet, resolver_source from court-core task 3.4, secrets_ref from court-core 1.4, treasury=court-ops.noamarket.testnet.
- [x] 3.2 Record contract hash + init tx in `private/STATE.md`.
