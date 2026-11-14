# Tasks

## Implementation status (2026-11-14)

MVP implemented for the hackathon. Ticked boxes are backed by unit tests (`apps/mcp/test/publication.test.ts`, 37 tests; full suite 165 passed on 2026-11-14) and the testnet E2E in `e2e/publish/RESULTS-20261114.md` (markets 87 and 88, Node stub wallet). Unticked boxes were partly done or descoped; the note under each says why. Not verified: a real-wallet browser run of the publication path, the mobile wallet matrix, metadata backfill of old markets, and mainnet activation. The public testnet deployment runs with publication disabled because no public Noa testnet API exists.

Commits:
- `abb7fe4` docs(openspec): propose the change
- `e1e344b` feat(mcp): publish reviewed description and rules to Noa after market creation
- `50d71ae` test(e2e): publish metadata E2E on testnet (markets 87, 88)
- Related, outside this change: `2465efb`, `fc71fac` (NEAR Connect wallets, HOT mainnet-only), `66f6226`, `08f396c` (sign page redesign), `be15db1` (`list_whitelisted_tokens`, minimum stake)

## 1. Reviewed payload and persistence

- [x] 1.1 Add optional explanatory `description` to `market_create_link` input and derive its omission fallback from rendered rules; verify existing callers remain valid and the description never changes executable spec fields.
- [x] 1.2 Freeze the final spec/hash, exact rendered rules, renderer version, description and publication payload digest in the sign request; verify reloads and repeated reads return identical bytes and a later renderer change does not alter an existing snapshot.
- [x] 1.3 Add backward-compatible SQLite publication fields/state and migration; test pending legacy request review, completed legacy request exclusion, existing completed request readability and recovery after the sign-before deadline.
- [ ] 1.4 Review rule rendering for thresholds, buckets, text judging, custom outcome labels, source selection and unavailable policy; add meaningful cases proving published rules agree with the actual spec/outcome map, without changing already registered specs.
  - Not done: only a two-line change to `src/spec/render.ts` (renderer version). No per-decide-kind review of rendered rules was recorded. Left for after the hackathon.
- [x] 1.5 Update tool descriptions, `court_guide` and `skills/noa-court/SKILL.md` to request explanatory prose and review both fields; verify the documented tool input and omitted-description behavior against the implemented schema.

## 2. Creator authentication and environment

- [x] 2.1 Add network-bound Noa API, auth recipient and market URL configuration with fail-closed validation before new signing; test missing values, incorrect network binding and arbitrary destination rejection, and document environment setup in the MCP README.
- [x] 2.2 Implement Noa challenge/login using the creator wallet's NEP-0413 message signature, matching nonce decoding, signature encoding, recipient and null callback URL requirements; verify against the current Noa frontend/auth contract and test invalid/expired challenge responses.
- [ ] 2.3 Keep access tokens in browser memory, renew login after redirects/expiry, and discard sessions on account switch; test that no creator token is persisted in SQLite, storage, logs or request URLs and that only the verified creator can resume publication.
  - Partly done: the token is kept in browser memory only by design and a session for another account is discarded (`publication.test.ts`). No check of browser storage, logs or request URLs was run.
- [ ] 2.4 Add unsupported-wallet/declined-auth states before transaction approval; verify no create transaction is requested on these paths and document the tested Intear/Meteor/MyNearWallet message-signing and redirect compatibility matrix.
  - Partly done: declined/unsupported/wrong-account login never posts and requests no create transaction (unit test). The wallet compatibility matrix was not tested: no real-wallet browser run of the publication path, no mobile wallets. Descoped for hackathon MVP.
- [ ] 2.5 Verify browser-reachable testnet API, CORS origin/Authorization handling and transport compatibility; record exact configuration needs. If a Noa code change is demonstrated necessary, document a narrow cross-repo dependency before changing it; verify no auth weakening or mainnet endpoint probing is introduced.
  - Partly done: CORS and the Authorization header were verified only against a local Noa API (`localhost:3401`). No public Noa testnet API exists, so the public testnet deployment runs with publication disabled. Mainnet needs Noa production `CORS_ORIGINS` to include `https://noacourtmcp.junstudio.xyz`. No Noa code change was made.

## 3. Publication and recovery

- [x] 3.1 Extend completion handling to expose the trusted market ID/creator/network/spec binding for publication; add rejection tests for wrong market, account, contract, network, resolver and metadata hash without weakening existing transaction verification.
- [x] 3.2 Publish the frozen Noa metadata payload from the browser with creator authorization; test first publish, byte-identical retry, optional-field normalization and prevention of clearing pre-existing nonempty metadata inadvertently.
- [x] 3.3 Add a bounded server-side read-back verification action using only configured Noa destinations and the verified request binding; test matching success, stale/missing data, mismatched content, forged browser acknowledgements, rate limits and repeated verification calls.
- [x] 3.4 Add independent publication state and UI recovery for network failures, 401, 409, 429, 5xx and lost responses; verify reauthentication and retries preserve payload/market ID and submit no additional register/create transactions.
- [ ] 3.5 Revise completed-request rendering so metadata retry remains available after reload, wallet redirect and signing expiry; verify creation, linking and publication are reported separately and the configured market link resolves to the correct market.
  - Partly done: the publication panel is rendered for completed requests and `market_status` reports the state separately (`e2e/publish/RESULTS-20261114.md`, steps 3 and 4e). Reload and wallet-redirect recovery were not exercised in a real browser.
- [x] 3.6 Document publication/recovery, immutable metadata conflicts, configuration limitations and the separate legacy-backfill boundary in `apps/mcp/README.md` and `docs/INTEGRATE.md`; verify the documented requests and states against implementation tests.

## 4. Integration acceptance

- [ ] 4.1 Run MCP typecheck, unit/integration tests, production bundle build and formatting checks; retain existing sign-plan, hash, expiry, wallet completion and keeper regressions and record fresh command results.
  - Partly done: on 2026-11-14 `vitest run` passed (10 files, 165 tests) and `tsc --noEmit` passed. Production bundle build and formatting checks were not re-run in this pass (the bundle was built in a scratch directory for the E2E run).
- [ ] 4.2 Run a fresh local/testnet browser flow with a creator test wallet: review description/rules, NEP-0413 login, sign creation, publish, server read-back and Noa market-page display; verify exact content, creator/spec identity and zero service-role/private-key exposure. Follow browser notice and test-wallet instructions.
  - Not done: the publication path ran only with the Node stub wallet (`e2e/publish/run.ts`), not a real browser wallet. Needs a real-wallet run and PM acceptance.
- [ ] 4.3 Exercise recovery after creation by interrupting the publish response or API availability, reloading and authenticating again; prove one on-chain market, one unchanged metadata payload, successful eventual read-back and preserved Noa write-once behavior.
  - Partly done: API outage, restart and re-publish on market 88 produced one market, one payload and a verified read-back, and write-once conflict behavior was shown (`RESULTS-20261114.md`, 4a, 4b, 4e). It used the stub wallet and a new process, not a browser reload.
- [ ] 4.4 Exercise at least one actual mobile/redirect wallet flow and negative cases for wrong creator/account switch, conflict and stale read-back; distinguish wallet limitations from harness failures and record any unsupported combinations instead of claiming universal support.
  - Not done: no mobile or redirect wallet flow was run. Wrong-creator, conflict and rate-limit cases were covered at the Noa API layer only. Descoped for hackathon MVP.
- [ ] 4.5 Review the final diff for scope and unchanged contract/resolver behavior; record testnet market/transaction references and verification evidence without secrets, then obtain PM acceptance before declaring implementation complete.
  - Not done: needs PM acceptance. Evidence so far: `e2e/publish/RESULTS-20261114.md` (markets 87 and 88).

## Workflow follow-up

- Planning completion is not implementation completion; checkboxes stay open until backed by evidence.
- Deploy/restart and mainnet activation follow the applicable repository authorization rules and are not performed by this proposal.
- Archive only after implementation and acceptance; reconcile the earlier unarchived MCP sign-flow specification without overwriting its unrelated requirements.
