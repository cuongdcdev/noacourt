## 1. Fixtures
- [ ] 1.1 Create secret gists via `gh gist create` for A6/A7 JSON and A8/A9 RSS; store raw URLs in `fixtures/README.md` and STATE.md.

## 2. Harness
- [ ] 2.1 `e2e/` runner, accounts from ~/.near-credentials/testnet (never print keys), live price fetch for thresholds.
- [ ] 2.2 Scenarios A1, A2, A3, A4, A6, A7, A8, A8n, A9 per design.
- [ ] 2.3 Independent checks + result recording (`E2E_RESULTS.md`).
- [ ] 2.4 Run first wave; fix forward via the owning change; rerun until all pass or a blocker is documented.

## 3. Docs
- [ ] 3.1 docs/SPEC.md, docs/INTEGRATE.md, llms.txt.
- [ ] 3.2 README.md (do X → see Y), mention sibling project Fulfil (rules Q-015) and closed-source Noa core.
- [ ] 3.3 MCP connector smoke from a real client (Claude Code `claude mcp add --transport http`), record transcript excerpt.
