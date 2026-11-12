## Why
A Noa market's resolver can never change, and `resolve_market` needs 1 yoctoNEAR (function-call keys cannot attach deposit), so the resolver must be a contract. That contract must accept outcomes only from the pinned OutLayer execution so the keeper and operators cannot decide outcomes.

## What Changes
- New NEAR contract `contracts/court`, deployed to `ai-resolver.noamarket.testnet`.
- Spec registry, Noa market linking via `metadata_hash = "noacourt:<spec_hash>"`, permissionless trigger, OutLayer `request_execution` + callback, forwarding to Noa `resolve_market` / `void_market`.
- Generic `request_resolution` / `get_verdict` (+ optional callback) for non-Noa integrators.
- Testnet-only `trusted_keeper` fallback, flagged `tee: false`.
- Interface fixed in `docs/ARCHITECTURE.md` §5.

## Capabilities
### New Capabilities
- `court-contract`: on-chain registry, resolution lifecycle, verdict storage and integration surface.

### Modified Capabilities
(none)

## Impact
New `contracts/court`. Calls `v3.noamarket.testnet` (read-only source at `/workspaces/devcontainer-projects/noamarket-monorepo/contracts/src/lib.rs`, do not modify) and `outlayer.testnet`.
