## Why
Creators use their own LLM (Claude.ai, ChatGPT, Claude Code, Grok) to draft markets. A public remote MCP server lets that LLM lint, simulate with the exact pinned resolver, render rules, and produce a wallet sign link, without Noa holding user keys or paying AI credit. A keeper is needed so markets get triggered and finalized without anyone watching.

## What Changes
- New `apps/mcp` (TypeScript, Node 22): MCP Streamable HTTP endpoint `/mcp`, no auth, per-IP rate limit.
- `/sign/<id>` page: wallet-selector (Intear, Meteor, MyNearWallet; testnet) signs 2 txs in one approval (Court.register_spec + Noa.create_market), then calls link_market; QR for mobile.
- Keeper loop inside the same process using `court-ops.noamarket.testnet`: link, trigger, void, finalize.
- Public deploy at `https://noacourtmcp.junstudio.xyz` via a new named cloudflared tunnel.

## Capabilities
### New Capabilities
- `mcp-server`: tools and their contracts.
- `sign-flow`: sign link, QR, two-tx approval, linking.
- `keeper`: automated permissionless operations.

### Modified Capabilities
(none)

## Impact
New `apps/mcp`, new tunnel config `~/.cloudflared/noacourt-mcp.yml` (never edit `~/.cloudflared/config.yml` or other tunnels' files).
