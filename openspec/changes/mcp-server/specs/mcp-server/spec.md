## Purpose
Public MCP endpoint that lets any LLM client draft, lint, simulate and package Noa Court markets without holding user keys.

## ADDED Requirements

### Requirement: Tools
The server SHALL expose court_guide, catalog_list, catalog_tool, source_sample, spec_lint, spec_simulate, rules_render, market_create_link, market_status and verdict_get over MCP Streamable HTTP at /mcp without authentication.

#### Scenario: Client lists tools
- **WHEN** an MCP client initializes and lists tools
- **THEN** all ten tools are returned with JSON schemas

### Requirement: Same engine as resolution
spec_lint and spec_simulate SHALL execute the same resolver.wasm whose sha256 is reported in the response, and the response SHALL state whether it matches the Court contract's configured resolver.

#### Scenario: Simulate A1
- **WHEN** spec_simulate runs a NEAR/USDT threshold spec
- **THEN** it returns a Verdict with mode simulate, a value, an outcome and wasm_sha256

### Requirement: No custody
The server SHALL never request, accept or store user private keys; all user writes SHALL be returned as a sign link.

#### Scenario: Create market
- **WHEN** market_create_link is called with a linted spec
- **THEN** it returns an https sign URL and a QR image, and no transaction is sent by the server on the user's behalf

### Requirement: Rate limiting
The server SHALL limit requests per IP and SHALL refuse simulate calls needing NEAR AI once the configured spend cap is reached.

#### Scenario: Burst
- **WHEN** one IP exceeds the per-minute limit
- **THEN** the server returns a rate-limit error for further calls in that window
