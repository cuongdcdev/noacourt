## Purpose
The Court contract is the on-chain resolver account: it stores specs, links them to markets, requests pinned OutLayer executions, and forwards only OutLayer-produced verdicts to markets or integrators.

## ADDED Requirements

### Requirement: Spec registration
The contract SHALL store a spec_json keyed by its sha256 when the attached deposit is at least the configured minimum, and refund any excess beyond storage plus prepaid resolution fee.

#### Scenario: Insufficient deposit
- **WHEN** register_spec is called with less than min_deposit
- **THEN** the call panics and nothing is stored

### Requirement: Market linking
The contract SHALL link a Noa market to a stored spec only if the market's resolver is the Court account, the market metadata_hash equals "noacourt:" + spec_hash (or the caller is the market creator passing spec_hash), the outcomes are identical, and the market closes no later than observation.at.

#### Scenario: Wrong resolver
- **WHEN** link_market targets a market whose resolver is another account
- **THEN** the market is not linked and the reason is logged

#### Scenario: Outcome mismatch
- **WHEN** the market outcomes differ from spec.outcomes
- **THEN** the market is not linked

### Requirement: Permissionless trigger
Anyone SHALL be able to trigger resolution of a linked market once observation.at has passed and no request is pending; the caller SHALL have no influence on the outcome.

#### Scenario: Too early
- **WHEN** trigger is called before observation.at
- **THEN** the call panics

#### Scenario: Double trigger
- **WHEN** trigger is called while a request is pending
- **THEN** the call panics

### Requirement: Verdict only from OutLayer
The contract SHALL accept a verdict only through its private OutLayer callback (or the testnet trusted_keeper method when configured), and SHALL reject verdicts whose spec_hash differs from the linked spec.

#### Scenario: Spec hash mismatch
- **WHEN** the OutLayer output carries a different spec_hash
- **THEN** the verdict is rejected and the market stays retryable

#### Scenario: Resolved verdict
- **WHEN** a valid resolved verdict arrives
- **THEN** the contract calls the market's resolve_market with the verdict outcome_index and 1 yoctoNEAR and stores the verdict

### Requirement: Retry and void
The contract SHALL schedule retries for retry_after verdicts up to the configured attempts and SHALL allow anyone to void an unresolvable market after the market's resolution deadline.

#### Scenario: Unresolvable then void
- **WHEN** a market is Unresolvable and the Noa resolution deadline has passed
- **THEN** void(market_id) calls the market's void_market

### Requirement: Generic integration
The contract SHALL accept request_resolution(spec_json, callback) from any account with sufficient deposit, run the same pipeline, expose the verdict through get_verdict, and invoke the optional callback with {request_id, verdict}.

#### Scenario: External integrator
- **WHEN** a non-Noa contract requests resolution and the verdict resolves
- **THEN** get_verdict returns the full Verdict and the callback method is called once

### Requirement: Testnet trusted keeper flag
When trusted_keeper is set, verdicts submitted by it SHALL be stored with tee=false and shown as not TEE-attested in every view.

#### Scenario: Keeper verdict visibility
- **WHEN** get_verdict returns a keeper-submitted verdict
- **THEN** the response contains tee=false
