## Purpose

Ensure markets created through Court's MCP sign flow publish their reviewed human-readable description and resolution rules to Noa without weakening creator authorization or changing the bound resolution spec.

## ADDED Requirements

### Requirement: Reviewed immutable metadata

The system SHALL show and freeze the description, spec-derived rules, spec hash and publication payload before transaction approval. AI-authored description SHALL be explanatory; rendered rules SHALL express the final spec. Retries SHALL use the frozen payload, not newly generated text.

#### Scenario: Agent supplies description

- **WHEN** an agent prepares a market with a description and a valid spec
- **THEN** the sign page shows both the description and rules derived from that spec for creator review
- **AND** the persisted metadata snapshot identifies the exact spec hash used for creation

#### Scenario: Legacy caller omits description

- **WHEN** a supported caller omits the new optional description input
- **THEN** the system uses the rendered rules as a deterministic description fallback and shows the resulting payload before signing

#### Scenario: Description conflicts with rules

- **WHEN** the creator notices contradictory explanatory text during review
- **THEN** the flow permits returning to a new draft before signing
- **AND** the system does not silently treat the description as a replacement for spec-derived rules

### Requirement: Creator-scoped Noa authentication

The sign page SHALL obtain a Noa session through its existing NEP-0413 flow for the account that creates the market. Connecting a wallet or approving a transaction SHALL NOT be treated as Noa login. The flow SHALL NOT require creator keys, Noa service-role credentials or persistent server storage of creator session tokens.

#### Scenario: Correct creator signs login

- **WHEN** the selected creator wallet signs the configured Noa authentication challenge
- **THEN** the sign page can use the returned session to publish metadata for that creator's verified market

#### Scenario: Wallet lacks message signing or user declines

- **WHEN** the wallet cannot complete NEP-0413 or the creator declines authentication
- **THEN** the page explains that metadata publication needs creator authentication
- **AND** before market creation it offers authentication retry or another supported wallet without submitting create transactions

#### Scenario: Account changes or session expires

- **WHEN** the selected wallet account changes or Noa rejects an expired session
- **THEN** the stale session is discarded and publication requires authentication as the verified market creator
- **AND** a completed market is not recreated

### Requirement: Verified chain-to-metadata binding

The system SHALL publish only after verifying a successful creation transaction, market ID, creator, target contract/network and Court metadata hash against the frozen request. The sign page SHALL publish with the creator's session to the configured Noa API; neither an arbitrary client market ID nor a claimed success flag SHALL establish this binding.

#### Scenario: Confirmed creation

- **WHEN** the verified market matches the reviewed request and signing account
- **THEN** publication sends its actual market ID, title, token, ordered outcome names, frozen description and frozen rules to Noa

#### Scenario: Mismatched receipt or market

- **WHEN** the submitted receipt belongs to another network, contract, creator or spec hash
- **THEN** metadata publication is rejected for that request
- **AND** no record is marked as published based on those inputs

### Requirement: Independent publication lifecycle

The system SHALL track metadata publication separately from chain creation and Court linking. Reloads, redirects and duplicate completion calls SHALL recover the verified market and immutable payload. Expiry of the original signing window SHALL prohibit new creation transactions but SHALL NOT erase publication recovery for an already verified market.

#### Scenario: API unavailable after creation

- **WHEN** creation succeeds but Noa cannot store metadata
- **THEN** the UI reports that the market exists and metadata is pending or failed, with its market ID and a retry action
- **AND** retry does not register another spec or create another market

#### Scenario: Page reload after publication timeout

- **WHEN** the creator reopens a completed request after an uncertain publish response
- **THEN** the flow first reconciles stored Noa metadata and resumes publication for the same market if necessary
- **AND** authentication can be renewed without changing the reviewed payload

### Requirement: Write-once API compatibility

Publication SHALL respect Noa's creator-owned, write-once metadata semantics. Identical retries SHALL be treated as idempotent success. Conflicting published content SHALL be reported as a conflict without overwriting it. Fields outside the reviewed payload SHALL NOT be invented or unintentionally cleared.

#### Scenario: First publish and identical retry

- **WHEN** Noa accepts the payload or reports the identical payload already published
- **THEN** the flow proceeds to read-back verification for the same market

#### Scenario: Existing different metadata

- **WHEN** Noa reports a conflict or the stored metadata differs from the reviewed payload
- **THEN** the flow shows a conflict requiring review and stops automatic retries
- **AND** it does not regenerate text, bypass the lock or overwrite existing content

### Requirement: Verified publication acknowledgement

The system SHALL mark metadata published only after a read-back from the configured trusted Noa API matches the frozen description and rules for the verified market. A browser acknowledgement alone SHALL NOT establish success. UI text SHALL distinguish market creation, Court linking and metadata publication outcomes.

#### Scenario: Matching read-back

- **WHEN** Noa's market response contains the reviewed description and rules
- **THEN** publication is marked verified and the page provides the configured Noa market link

#### Scenario: Stale or missing API read-back

- **WHEN** a publish response succeeds but bounded read-back attempts return stale or absent fields
- **THEN** publication remains awaiting verification rather than falsely marked complete
- **AND** retry can reconcile it without another creation transaction

### Requirement: Environment and browser compatibility

The flow SHALL use operator-configured API, auth-recipient and market URLs bound to the selected network. User-supplied arbitrary destinations SHALL NOT receive sessions or drive server read-back. Browser origin and transport failures SHALL be surfaced before new transaction signing where detectable.

#### Scenario: Incorrect environment or unreachable browser endpoint

- **WHEN** required configuration is missing, network binding is inconsistent, CORS denies the sign origin or the browser blocks mixed content
- **THEN** the page reports the configuration failure and does not start new create transactions
- **AND** it preserves recovery access for any already created market

#### Scenario: Existing legacy completed request

- **WHEN** a completed request predates the immutable metadata snapshot
- **THEN** it remains readable as legacy and is not silently published with newly invented description or rules
- **AND** historical repair remains a separately reviewed operation
