## Purpose
Turns a drafted market into one wallet approval on desktop or mobile and links the created market to its spec.

## ADDED Requirements

### Requirement: Two transactions, one approval
The sign page SHALL request the wallet to sign Court.register_spec and Noa.create_market (resolver = Court, metadata_hash = "noacourt:" + spec_hash) together.

#### Scenario: Successful creation
- **WHEN** the user approves in the wallet
- **THEN** the page shows both tx hashes, the new market_id, and the market becomes linked within one keeper cycle

### Requirement: Mobile QR
market_create_link SHALL return a QR code encoding the sign URL.

#### Scenario: Scan on phone
- **WHEN** the QR is scanned
- **THEN** the sign page opens with the same pending request

### Requirement: Expiry
Pending sign requests SHALL expire after 24 hours.

#### Scenario: Old link
- **WHEN** an expired sign URL is opened
- **THEN** the page shows "expired" and offers no transaction
