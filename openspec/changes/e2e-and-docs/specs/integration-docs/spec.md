## Purpose
Documentation that lets agents and developers create Noa Court markets and integrate Court resolution into other contracts.

## ADDED Requirements

### Requirement: Integrator guide
docs/INTEGRATE.md SHALL show, with copy-paste near CLI commands against testnet, how a non-Noa contract calls request_resolution, reads get_verdict, and receives the callback, including the Verdict schema.

#### Scenario: Follow the guide
- **WHEN** a developer runs the documented commands
- **THEN** they obtain a verdict for a sample spec on testnet

### Requirement: Judge-ready README
README.md SHALL list "do X → see Y" steps (MCP URL, sample prompts, live market ids, tx links, E2E_RESULTS) and state that Noa core is closed source and only Court is open.

#### Scenario: Agent reviewer
- **WHEN** an AI reviewer reads README.md
- **THEN** it can reach the MCP endpoint and one resolved market's receipt in under 5 steps
