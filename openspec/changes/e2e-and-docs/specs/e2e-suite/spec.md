## Purpose
Reproducible end-to-end runs on NEAR testnet that prove each resolution path works and record verifiable evidence.

## ADDED Requirements

### Requirement: Full lifecycle
Each happy-path scenario SHALL go create → link → bet → trigger → OutLayer verdict → resolve_market → finalize → claim with every tx hash recorded.

#### Scenario: A1 NEAR threshold
- **WHEN** scenario A1 runs to completion
- **THEN** the Noa market is finalized with the outcome equal to the harness's independent Binance check and E2E_RESULTS.md has a row with all tx hashes

### Requirement: Failure paths never resolve wrongly
Scenarios with broken identity or missing sources SHALL end voided, never resolved.

#### Scenario: A6 identity change
- **WHEN** the fixture id changes after preflight
- **THEN** the market is voided and no resolve_market tx exists

### Requirement: TEE flag honesty
Results SHALL record whether each verdict came from OutLayer (tee=true) or the testnet trusted keeper (tee=false).

#### Scenario: Fallback used
- **WHEN** a verdict was submitted by the trusted keeper
- **THEN** its row shows tee=false
