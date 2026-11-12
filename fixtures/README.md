# E2E fixture templates

These files are inputs for the testnet E2E harness. Run `cd e2e && pnpm e2e fixtures` to publish static secret gists and replace this file with their raw URLs. The command also writes `fixtures/gists.json`.

Live A6/A7/A8/A8n/A9 runs create new per-run secret gists, so editing or deleting a fixture never affects another run. `a6-original.json` and `a7-original.json` begin with the asserted identity. `a6-mutated.json` breaks that identity. The RSS templates contain an old item plus the scenario-specific post. `{{PUB_DATE}}` is filled at mutation time.
