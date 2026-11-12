## Why
The product claim ("spec-locked, preflighted, TEE-resolved markets") is only credible with real testnet markets resolved end to end, including the failure paths, and with docs that let other agents and developers use the infrastructure (Noa and non-Noa markets).

## What Changes
- E2E harness `e2e/` that creates real fast markets on `v3.noamarket.testnet` with NPOINT (`point.noamarket.testnet`), bets from user accounts, waits for keeper resolution, finalizes, claims, and checks results.
- Controlled fixtures published as secret GitHub gists (gh CLI, account already logged in).
- Docs: `README.md` (do X → see Y), `docs/INTEGRATE.md` (generic request_resolution / get_verdict / callback, MCP usage, sign flow), `docs/SPEC.md` (ResolutionSpec reference), `llms.txt`, `E2E_RESULTS.md`.

## Capabilities
### New Capabilities
- `e2e-suite`: reproducible end-to-end market scenarios with recorded evidence.
- `integration-docs`: documentation for integrators and agents.

### Modified Capabilities
(none)

## Impact
New `e2e/`, `fixtures/`, docs. Writes testnet transactions only.
