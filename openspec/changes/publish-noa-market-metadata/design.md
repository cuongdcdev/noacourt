# Design

## Context

See `proposal.md` for motivation. Observed implementation boundaries:

- `apps/mcp/src/sign/txBuilder.ts` creates Court `register_spec` and Noa `create_market`, with `metadata_hash = noacourt:<spec_hash>`; it sends no prose metadata to Noa.
- `apps/mcp/src/spec/render.ts` renders `rules_markdown`, adds `rules_text_hash` to the canonical spec and returns `spec_hash`. `sign/service.ts` and `sign/store.ts` retain the canonical JSON and pending/completed request; `sign/page/main.ts` displays rules and verifies wallet results through the completion route.
- Noa `apps/indexer/src/api/api.ts` provides creator-authenticated `POST /v1/markets`. It permits a first metadata publish, accepts an identical retry and returns 409 for a changed payload after publication. It verifies on-chain creation/creator for a new DB row. It does not verify that prose matches Court's spec.
- Noa `apps/indexer/src/api/auth.ts` exposes `GET /auth/challenge` and `POST /auth/login`. Login verifies a one-use challenge, NEP-0413 and a FullAccess key before returning a session. The server signs/verifies its configured `AUTH_RECIPIENT` with a null NEP-0413 `callbackUrl`; a wallet connection is insufficient.
- Noa `market-info.tsx` reads API `description`/`rules` and renders React text with preserved newlines. It does not derive prose from Court or render arbitrary HTML.
- Existing completed change `mcp-server` describes transaction/linking behavior; canonical specs are not yet archived. Its older 24-hour expiry wording is not the current safe-signing deadline implementation. Preserve current signing safety and add independent publication recovery.

## Goals / Non-Goals

**Goals:** Make reviewed metadata visible in Noa for newly created MCP markets, preserve identity/hash binding, and recover partial completion without duplicate creation. Keep the creator's authenticated Noa request in the browser; the MCP server only persists public publication data and verifies read-back.

**Non-Goals:** New contract fields, resolver changes, automatic historic repair, a metadata editing API, unattended keeper publication, a Noa service-role key in MCP, or a new Markdown/HTML renderer in Noa. Creation and off-chain publication cannot be one atomic transaction; the UI must represent partial success honestly. Mainnet activation is not included.

## Decisions

### 1. Store description alongside the spec; derive rules deterministically

Add an optional `description` to the MCP market-create input and request model, not to the executable ResolutionSpec. Agent instructions request a concise plain-text explanation of the exact final spec; omission falls back to rendered rules to preserve caller compatibility. Show description and rules together before signing. There is no claim that code can prove arbitrary AI prose is semantically equivalent: creator review remains necessary, while the spec-derived rules identify the operative resolution terms.

Compute rules from the finalized canonical spec and freeze the exact bytes, renderer version, `rules_text_hash`, `spec_json` and `spec_hash`. Store a separate metadata payload digest covering description and rules; do not change the on-chain hash format or pretend this digest is committed on-chain. The operator controls the stored snapshot, so later Noa content must be checked against it.

Any edit before approval creates a new draft/snapshot. Once a wallet plan has been approved, the payload is immutable. On retry, do not rerun AI or use a newer renderer to replace frozen rules. Validate renderer coverage for the actual outcome labels, decision kind and unavailable policy; do not publish contradictory `Yes` text for a non-Yes mapping. Use safe plain text/newlines compatible with Noa's current display.

Alternative rejected: AI independently writes both binding rules and spec, then regenerates prose after creation. It permits silent semantic drift and makes idempotent retries unreliable.

### 2. Authenticate the creator in the sign page, before new create transactions

Reuse Noa's challenge/login protocol with browser `signMessage`, not the transaction signature and not wallet connection state. Add operator-supplied, network-bound public configuration for Noa API base, auth recipient and market URL base. Obtain a challenge, decode its 32-byte nonce, sign the exact message/recipient, and submit the existing login body `{accountId, publicKey, signature, nonce}` with the expected signature encoding. Verify parity against Noa's existing frontend/auth implementation rather than inventing protocol details.

Acquire the session before requesting new create transactions, so missing configuration, declined login or an unsupported wallet is detected before funds are spent. Recheck the account before signing and publication. Use the short-lived access token in browser memory only; do not store access/refresh tokens in sign-request SQLite, server logs, URLs or persistent browser storage. After redirect/reload/session expiry, renew creator authentication as needed. A completed market remains recoverable even when the creator must sign another login challenge.

Noa currently verifies `callbackUrl: null`. Test supported wallet modules (Intear, Meteor, MyNearWallet) against that exact constraint, including mobile redirects. An incompatible message-signing flow must show a supported-wallet path; do not silently weaken nonce/account/recipient verification or claim universal wallet compatibility. A demonstrated need for a Noa auth change is a scoped follow-up dependency, not permission to bypass the current API.

### 3. Browser publishes; server verifies public read-back

After existing completion verification proves the successful market creation, retrieve its trusted ID and creator. Verify the current network, Noa contract, resolver and `metadata_hash` match the frozen request. The browser submits `POST /v1/markets` to the configured API with its creator bearer session.

The frozen payload consists of known `title`, `token_id`, ordered outcome names, description and rendered rules. Bind the verified `market_id` after creation; include a verified creation hash only if used by the current API contract. Do not accept a caller-selected market ID or network destination. Do not send `market_status`; lifecycle remains chain-owned. Omit unsupported optional category/image/tag fields rather than inventing values. Audit Noa's current normalization of omitted fields: its image/embed fields default to null. If existing nonempty metadata would be changed by the actual normalized request, stop for conflict/review rather than silently clearing it.

Add a bounded same-origin publication-verification action for the sign request. It accepts no creator token and no arbitrary destination URL. The server reads the configured Noa market endpoint, compares the frozen description/rules and bound market identity, then stores a verified result. Rate-limit this action and reuse/coalesce bounded reads to prevent a sign URL from becoming an unbounded upstream fetch source. Never trust a client `published: true` acknowledgement.

Alternative rejected: MCP server receives/stores broad DB or service-role authority. Existing creator auth already provides the required publication boundary.

### 4. Separate creation, linking and publication state

Keep the existing chain-completion/keeper semantics. Add publication state such as `not_started`, `auth_required`, `publishing`, `awaiting_verification`, `published`, `retryable_error`, `conflict`, and `legacy_unavailable`, with bounded safe error details and last verification time. The exact enum names can vary; the externally visible distinctions cannot.

The persisted record binds request ID, verified creator/market/transaction, immutable metadata snapshot and publication state. Persist it before the first publish attempt. No new chain write is an allowed transition out of a completed request. A successful creation page must still offer metadata recovery; the current early return/button removal for `completed` requests must be revised.

Recovery after lost responses first reads Noa metadata. Matching content means verify success; empty/unpublished content allows an identical POST after creator authentication; 401 means renew login; 409/different content means stop with a conflict. Rate limits, network errors and server errors permit bounded retries with backoff. Do not repeatedly re-sign login challenges or loop automatically on 401/409. No browser JWT is needed to read back public market data.

Signing-window expiry prohibits new transactions, but must not erase completed-request metadata or recovery UI. No cleanup policy may purge a nonterminal publication snapshot as though it were an abandoned unsigned request. A later retention policy for verified publications is outside this change.

### 5. Environment boundary and Noa changes

Default integration target is testnet. Configuration must explicitly bind API, auth recipient, frontend URL and contract network; do not infer that `localhost`, the MCP host or the browser origin is the auth recipient. The Noa API CORS allowlist must admit the exact sign-page origin and the Authorization header/methods. A public HTTPS sign page cannot directly call a plain HTTP local API from every browser; use an authorized HTTPS testnet endpoint or a matching local test setup. Do not silently proxy auth tokens through an arbitrary host to bypass these constraints.

Expected Noa work is configuration only: CORS and reachable API/recipient settings. Its existing metadata endpoint and market display should suffice. Document any real cross-repo incompatibility before changing the monorepo, and follow that repository's OpenSpec/auth/UI rules if a separate change is required. Do not probe/deploy public Noa mainnet as part of local testing.

## Risks / Trade-offs

- [AI explanation diverges from executable spec] → Render operative rules from spec, show both before approval, keep description explanatory, and test representative wording/labels.
- [The market exists before metadata is public] → Show partial completion, preserve exact payload, retry idempotently; do not promise atomic publication or trading suspension.
- [Wallet or browser cannot complete Noa login] → Capability/error UX before creation, explicit wallet test matrix and renewed auth after redirect where needed.
- [Noa metadata is immutable after first publish] → Freeze all bytes before signing, detect conflicts and never regenerate/rewrite on retry.
- [API cache delays read-back] → Bound retries, retain awaiting-verification state and reconcile later without duplicate creation.
- [Existing legacy requests lack reviewed descriptions] → Do not auto-publish them; retain current request readability and require a separately reviewed repair workflow.
- [Sign-link viewers can ask the server to verify] → Bind to the already verified market and immutable payload, use configured destinations only, and limit public verification requests.

## Migration Plan

1. Add backward-compatible SQLite fields/schema migration for metadata snapshots and publication state. Pending legacy requests without a snapshot must receive a fresh deterministic snapshot and review before signing; completed legacy requests remain `legacy_unavailable` rather than auto-published.
2. Add input/config validation, auth, publication and recovery to the MCP sign flow. Preserve all existing create/link regression tests.
3. Verify local testnet API configuration and CORS, then run authenticated browser E2E with the creator test wallet and a mobile/redirect-capable wallet flow. Deployment/restart authorization is handled separately from this planning change.
4. Enable new sign requests only with valid Noa integration settings; configuration errors fail before new transactions. Record unsupported wallet combinations explicitly.
5. Rollback disables new publication actions without deleting snapshots or rolling back on-chain markets/Noa metadata. Retain state so a corrected build can resume. Noa's immutable metadata must not be overwritten as a rollback mechanism.
