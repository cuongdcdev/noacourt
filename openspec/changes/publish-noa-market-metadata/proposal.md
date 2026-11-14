# Proposal

## Why

Markets created through the Court MCP sign flow retain their resolution spec on Court but leave Noa's `description` and `rules` empty. The Noa market page reads those off-chain fields, so traders cannot read the reviewed resolution terms even after the market has been indexed.

## What Changes

- Accept an agent-authored human description alongside the ResolutionSpec, and derive authoritative human-readable rules from the final spec using `rules_render`.
- Freeze and display the reviewed description, rendered rules, spec hash and metadata payload before wallet transaction approval.
- Add creator authentication against Noa's existing NEP-0413 endpoints in the sign page; publish metadata to Noa's existing API with the creator's session after verified market creation.
- Persist publication progress separately from successful chain creation; resume/retry the identical metadata payload without creating a second market or regenerating text.
- Verify publication through a read-back and surface actionable authentication, configuration, unavailable API and immutable-metadata conflict states.
- Document network-specific API/recipient configuration and the sign-origin CORS prerequisite, and verify the resulting Noa UI on testnet.

## Capabilities

### New Capabilities

- `noa-metadata-publication`: Reviewed metadata preparation, creator-authorized publication, recovery and verified display for markets created by Court's MCP sign flow.

### Modified Capabilities

None in the canonical spec inventory: `openspec/specs` is currently empty. This change extends the implemented flow described in `openspec/changes/mcp-server/specs/sign-flow/spec.md`; it does not replace its transaction/linking requirements or copy its historical expiry assumptions.

## Impact

- Primary repo: `apps/mcp` tool input, sign request persistence, sign page/auth integration, configuration and tests; MCP docs/skill guidance.
- Noa dependency: existing `GET /auth/challenge`, `POST /auth/login`, creator-authenticated `POST /v1/markets` and read-only market retrieval. Noa API already enforces creator ownership and write-once metadata with identical retry support.
- Noa deployment configuration may need the MCP sign origin in `CORS_ORIGINS`. A demonstrated auth or API incompatibility requires a narrowly documented follow-up; this change does not authorize weakening Noa auth or making unrelated monorepo edits.
- No Court/Noa contract, resolver WASM, keeper authority or DB access privilege changes. No automatic metadata backfill for old markets and no mainnet rollout in this change.
