# Tasks

## 1. Reviewed payload and persistence

- [ ] 1.1 Add optional explanatory `description` to `market_create_link` input and derive its omission fallback from rendered rules; verify existing callers remain valid and the description never changes executable spec fields.
- [ ] 1.2 Freeze the final spec/hash, exact rendered rules, renderer version, description and publication payload digest in the sign request; verify reloads and repeated reads return identical bytes and a later renderer change does not alter an existing snapshot.
- [ ] 1.3 Add backward-compatible SQLite publication fields/state and migration; test pending legacy request review, completed legacy request exclusion, existing completed request readability and recovery after the sign-before deadline.
- [ ] 1.4 Review rule rendering for thresholds, buckets, text judging, custom outcome labels, source selection and unavailable policy; add meaningful cases proving published rules agree with the actual spec/outcome map, without changing already registered specs.
- [ ] 1.5 Update tool descriptions, `court_guide` and `skills/noa-court/SKILL.md` to request explanatory prose and review both fields; verify the documented tool input and omitted-description behavior against the implemented schema.

## 2. Creator authentication and environment

- [ ] 2.1 Add network-bound Noa API, auth recipient and market URL configuration with fail-closed validation before new signing; test missing values, incorrect network binding and arbitrary destination rejection, and document environment setup in the MCP README.
- [ ] 2.2 Implement Noa challenge/login using the creator wallet's NEP-0413 message signature, matching nonce decoding, signature encoding, recipient and null callback URL requirements; verify against the current Noa frontend/auth contract and test invalid/expired challenge responses.
- [ ] 2.3 Keep access tokens in browser memory, renew login after redirects/expiry, and discard sessions on account switch; test that no creator token is persisted in SQLite, storage, logs or request URLs and that only the verified creator can resume publication.
- [ ] 2.4 Add unsupported-wallet/declined-auth states before transaction approval; verify no create transaction is requested on these paths and document the tested Intear/Meteor/MyNearWallet message-signing and redirect compatibility matrix.
- [ ] 2.5 Verify browser-reachable testnet API, CORS origin/Authorization handling and transport compatibility; record exact configuration needs. If a Noa code change is demonstrated necessary, document a narrow cross-repo dependency before changing it; verify no auth weakening or mainnet endpoint probing is introduced.

## 3. Publication and recovery

- [ ] 3.1 Extend completion handling to expose the trusted market ID/creator/network/spec binding for publication; add rejection tests for wrong market, account, contract, network, resolver and metadata hash without weakening existing transaction verification.
- [ ] 3.2 Publish the frozen Noa metadata payload from the browser with creator authorization; test first publish, byte-identical retry, optional-field normalization and prevention of clearing pre-existing nonempty metadata inadvertently.
- [ ] 3.3 Add a bounded server-side read-back verification action using only configured Noa destinations and the verified request binding; test matching success, stale/missing data, mismatched content, forged browser acknowledgements, rate limits and repeated verification calls.
- [ ] 3.4 Add independent publication state and UI recovery for network failures, 401, 409, 429, 5xx and lost responses; verify reauthentication and retries preserve payload/market ID and submit no additional register/create transactions.
- [ ] 3.5 Revise completed-request rendering so metadata retry remains available after reload, wallet redirect and signing expiry; verify creation, linking and publication are reported separately and the configured market link resolves to the correct market.
- [ ] 3.6 Document publication/recovery, immutable metadata conflicts, configuration limitations and the separate legacy-backfill boundary in `apps/mcp/README.md` and `docs/INTEGRATE.md`; verify the documented requests and states against implementation tests.

## 4. Integration acceptance

- [ ] 4.1 Run MCP typecheck, unit/integration tests, production bundle build and formatting checks; retain existing sign-plan, hash, expiry, wallet completion and keeper regressions and record fresh command results.
- [ ] 4.2 Run a fresh local/testnet browser flow with a creator test wallet: review description/rules, NEP-0413 login, sign creation, publish, server read-back and Noa market-page display; verify exact content, creator/spec identity and zero service-role/private-key exposure. Follow browser notice and test-wallet instructions.
- [ ] 4.3 Exercise recovery after creation by interrupting the publish response or API availability, reloading and authenticating again; prove one on-chain market, one unchanged metadata payload, successful eventual read-back and preserved Noa write-once behavior.
- [ ] 4.4 Exercise at least one actual mobile/redirect wallet flow and negative cases for wrong creator/account switch, conflict and stale read-back; distinguish wallet limitations from harness failures and record any unsupported combinations instead of claiming universal support.
- [ ] 4.5 Review the final diff for scope and unchanged contract/resolver behavior; record testnet market/transaction references and verification evidence without secrets, then obtain PM acceptance before declaring implementation complete.

## Workflow follow-up

- The owner will implement this change. Planning completion is not implementation completion; leave these checkboxes open until backed by evidence.
- Deploy/restart and mainnet activation follow the applicable repository authorization rules and are not performed by this proposal.
- Archive only after implementation and acceptance; reconcile the earlier unarchived MCP sign-flow specification without overwriting its unrelated requirements.
