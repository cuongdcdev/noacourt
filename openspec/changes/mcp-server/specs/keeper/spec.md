## Purpose
Background worker that performs only permissionless Court and Noa calls so markets progress without manual action.

## ADDED Requirements

### Requirement: Permissionless only
The keeper SHALL only call link_market, trigger, trigger_request, void and Noa finalize_resolution, and SHALL never submit outcomes (except submit_keeper_verdict when testnet trusted_keeper mode is explicitly enabled).

#### Scenario: Due market
- **WHEN** a linked market's observation.at has passed and nothing is pending
- **THEN** the keeper calls trigger within 60 seconds

#### Scenario: Dispute window over
- **WHEN** a proposed resolution's dispute window has passed
- **THEN** the keeper calls finalize_resolution
