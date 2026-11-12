## 1. Fixtures
- [ ] 1.1 (BLOCKED 2026-11-12: gh fine-grained PAT lacks Gists permission, HTTP 403; harness code ready) Create secret gists via `gh gist create` for A6/A7 JSON and A8/A9 RSS; store raw URLs in `fixtures/README.md` and STATE.md.

## 2. Harness
- [x] 2.1 `e2e/` runner, accounts from ~/.near-credentials/testnet (never print keys), live price fetch for thresholds.
- [x] 2.2 Scenarios A1, A2, A3, A4, A6, A7, A8, A8n, A9 per design.
- [x] 2.3 Independent checks + result recording (`E2E_RESULTS.md`).
- [ ] 2.4 (PARTIAL 2026-11-12: A1-A4 PASS tee=true, markets 67-70; A6/A7/A8/A8n/A9 blocked on gist permission, see STATE "## e2e results") Run first wave; fix forward via the owning change; rerun until all pass or a blocker is documented.

## 3. Docs
- [x] 3.1 docs/SPEC.md, docs/INTEGRATE.md, llms.txt.
- [x] 3.1b Document the metadata_hash behaviour (owner request): the /sign page passes `metadata_hash = "noacourt:sha256:<spec_hash>"` to Noa `create_market`; Noa code is unchanged; Court.link_market is permissionless because of it; fallback = creator-only `link_market(id, spec_hash)` (extra signature); markets created elsewhere with another metadata_hash still work via the fallback. Put it in docs/INTEGRATE.md and README.md.
- [x] 3.2 README.md (do X → see Y), mention sibling project Fulfil (rules Q-015) and closed-source Noa core.
- [x] 3.3 MCP connector smoke from a real client (Claude Code `claude mcp add --transport http`), record transcript excerpt.
