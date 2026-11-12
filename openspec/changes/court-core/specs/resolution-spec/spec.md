## Purpose
Defines the ResolutionSpec v1 format, its content hash, and the static lint rules that every client and the resolver apply before a market is accepted.

## ADDED Requirements

### Requirement: Spec hash
The system SHALL identify a spec by `"sha256:" + hex(sha256(spec_json bytes))` and SHALL provide a canonicalizer that emits RFC 8785 JSON so equal specs produce equal hashes.

#### Scenario: Same spec, different key order
- **WHEN** two JSON documents with the same content but different key order are canonicalized
- **THEN** both produce identical bytes and identical spec_hash

### Requirement: Lint
The system SHALL reject a spec with a list of machine-readable errors when any rule in docs/ARCHITECTURE.md §3 "Lint rules" fails, and SHALL return no errors for a valid spec.

#### Scenario: Price market with one source
- **WHEN** a threshold spec on a price tool declares only one source
- **THEN** lint returns error `price_needs_two_sources`

#### Scenario: Overlapping buckets
- **WHEN** bucket edges are not strictly ascending
- **THEN** lint returns error `buckets_invalid`

#### Scenario: http_json without identity
- **WHEN** an http_json source has no assert and identity is not `url_only`
- **THEN** lint returns error `identity_assert_required`

#### Scenario: outcome_map gap
- **WHEN** outcome_map lacks a key that decide can produce
- **THEN** lint returns error `outcome_map_incomplete`

### Requirement: Source labels
The system SHALL label each source `verified` when its host is in the verified domain list and `self_declared` otherwise, regardless of the label the author wrote.

#### Scenario: Gist source
- **WHEN** a source URL host is gist.githubusercontent.com
- **THEN** its effective label is `self_declared`
