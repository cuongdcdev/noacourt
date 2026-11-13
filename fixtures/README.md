# E2E fixture templates

The fixture service serves files from `apps/mcp/data/fixtures/` with `Cache-Control: no-store`.
Run `cd e2e && pnpm e2e fixtures` to copy stable templates and update `fixtures/urls.json`.
Live A6/A7/A8/A8n/A9 runs create unique files and verify their served bytes over HTTPS.
A6 rewrites its identity, A7 deletes its file, A8 and A9 rewrite their RSS feeds, and A8n leaves its old item unchanged.
Sources from this service receive the expected `self_declared` label.
Gists were dropped because the gh token lacks Gists permission.

- A6: https://noacourtmcp.junstudio.xyz/fixtures/noacourt-a6.json
- A7: https://noacourtmcp.junstudio.xyz/fixtures/noacourt-a7.json
- A8: https://noacourtmcp.junstudio.xyz/fixtures/noacourt-a8.xml
- A8n: https://noacourtmcp.junstudio.xyz/fixtures/noacourt-a8n.xml
- A9: https://noacourtmcp.junstudio.xyz/fixtures/noacourt-a9.xml
