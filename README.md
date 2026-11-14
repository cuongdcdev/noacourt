# Noa Court

**Problem.** A prediction market is only as fair as whoever resolves it. On most markets that is the creator or the operator. An AI resolver that runs on its own server can't be checked: nobody sees which page it read, which rule it applied, or whether it ran at all. Vague rules ("will X happen soon?") cause disputes after money is already at stake.

**What Noa Court does.** It is an AI resolver for [Noa market](https://noamarket.xyz), a live prediction market on NEAR. Before trading opens, the rule is locked as a hashed JSON spec, and its sources are tested against real data. At observation time a pinned WASM resolver runs inside an OutLayer TEE. It fetches the sources, extracts the value and decides by deterministic code; text questions go to three NEAR AI Cloud jurors who must all agree. When evidence is missing, changed or ambiguous, the market is voided and bettors are refunded. A Court contract on NEAR checks the verdict, keeps a receipt and resolves the Noa market.

Noa Court lets a market creator lock a resolution rule into a canonical JSON spec before trading, preflight it against real sources, and receive a source-backed outcome from a resolver running through OutLayer on NEAR testnet. The Court contract stores the spec and receipt, checks the verdict, and forwards Noa market outcomes; a generic request and callback interface serves other contracts. The MCP server helps agents draft, sample, lint, simulate, and prepare a wallet sign link.

## Try it

1. Open [service health](https://noacourtmcp.junstudio.xyz/healthz) → see the MCP service status.
2. Add `https://noacourtmcp.junstudio.xyz/mcp` to Claude Code with `claude mcp add --transport http noacourt https://noacourtmcp.junstudio.xyz/mcp`; prompt: “Use court_guide, sample NEAR/USDT from Binance and OKX, draft and simulate a future two-outcome Court market, then show the rules and a wallet sign link.” → see a preflight verdict and `/sign/<id>` URL. The wallet signs only after you review the plan.
3. Open the A1 price-market receipt <!-- E2E:A1 -->[market 67](https://testnet.nearblocks.io/txns/GtfMBy2GmCKKNLjBGbNm7Wppf3VTnZ8ydB92bMrBsDWs)<!-- /E2E:A1 --> and <!-- E2E:A1_TX -->[resolution transaction](https://testnet.nearblocks.io/txns/GtfMBy2GmCKKNLjBGbNm7Wppf3VTnZ8ydB92bMrBsDWs)<!-- /E2E:A1_TX -->, then the A8 text-judge [market 79 resolution](https://testnet.nearblocks.io/txns/7JnWtdYRhPK5muTsUMC27Bg8nyhd8zBFNsTXhFGR28DL) on NearBlocks → see OutLayer verdicts and Noa `resolve_market` in the transaction receipts. Query the stored Court verdicts below to see their evidence and `tee` flags.
4. Open the sign link from step 2 in a browser → see the review-first sign page in Noa's market layout: rules generated from the spec, sources with their `verified` / `self_declared` labels, the OutLayer TEE resolver, and the exact transactions (`Court.register_spec`, `Noa.create_market`). Connect a testnet wallet through NEAR Connect (Intear or Meteor) to sign. After creation the page asks for a NEP-413 signature and publishes the reviewed description and rules to the Noa market page ([publish E2E, markets 87–88](e2e/publish/RESULTS-20261114.md)).
5. Read [E2E results](E2E_RESULTS.md) → inspect scenario outcomes, transaction hashes, and independent checks. [Market 86](e2e/mcp-agent/run-20261113T093809Z.md) was created end to end by a Codex CLI agent that used only the public MCP server: 11 MCP calls and no shell commands.
6. Follow [integration steps](docs/INTEGRATE.md) → request a generic verdict or create a Noa market.

For agents, read the [Noa Court skill](skills/noa-court/SKILL.md) ([hosted copy](https://noacourtmcp.junstudio.xyz/docs/SKILL.md)). For NEAR token price, market cap and FDV questions, follow the [Intear and JustHoot recipes](docs/NEAR_TOKENS.md) ([hosted copy](https://noacourtmcp.junstudio.xyz/docs/NEAR_TOKENS.md)); one source is the default, with a two-source median offered only as an optional choice.

Live market ID: <!-- E2E:A1_ID -->67<!-- /E2E:A1_ID -->.

```sh
near contract call-function as-read-only ai-resolver.noamarket.testnet get_verdict json-args '{"id":"noa:67"}' network-config testnet now
near contract call-function as-read-only ai-resolver.noamarket.testnet get_verdict json-args '{"id":"noa:79"}' network-config testnet now
```

## Live evidence

All first-wave scenarios in [E2E_RESULTS.md](E2E_RESULTS.md) passed. Their Court verdicts have `tee: true` and `submitted_by: "outlayer"`:

- [A1, market 67](E2E_RESULTS.md): NEAR/USDT threshold → No. The first attempt retried because the candle had not closed; the [second trigger](https://testnet.nearblocks.io/txns/GtfMBy2GmCKKNLjBGbNm7Wppf3VTnZ8ydB92bMrBsDWs) resolved it. The [creation](https://testnet.nearblocks.io/txns/EUkohRdRE3mwvSScTe1BUqHfXKVm8CC33aVozMsLVNWF), [keeper link](https://testnet.nearblocks.io/txns/BeDq3T2vXBRx9MXZ4RnXN2gcXzgwtyDGcNWsRK1gGwoU), [first trigger](https://testnet.nearblocks.io/txns/F9Vnr7LReUPce96ANZMqZQboYkR3jJGwvqvRkbWWPN1m), [finalization](https://testnet.nearblocks.io/txns/6kWLDoBw8prE6FS8Beb4gQKSzoiwL8dbSh2W4HpNypsL), and [claim](https://testnet.nearblocks.io/txns/92W5cP3cF7uzwKVZ21QS1yJqLW3EZR2ajfdUypPugmEn) are also recorded.
- A8, market 79: a 15-minute RSS `text_judge` market with real opposing bets—user2 [bet Yes](https://testnet.nearblocks.io/txns/7tNvi2wiReAeSjpUnRemSc1pHhqCzsjmHQqwBjr9toUj), user4 [bet No](https://testnet.nearblocks.io/txns/2WKsnVpmNtyc2Rwd1sturW1HCntjTshMHEnhWRuVqaKP). Three NEAR AI jurors agreed on Yes inside the TEE; the [trigger transaction](https://testnet.nearblocks.io/txns/7JnWtdYRhPK5muTsUMC27Bg8nyhd8zBFNsTXhFGR28DL) contains the OutLayer verdict and Noa resolution (`tee: true`). The proposal was [finalized](https://testnet.nearblocks.io/txns/5YESzkVyunsctNaPLPAEypvUonT9NHxfgH8qGyLHbdiL), and the winner [claimed](https://testnet.nearblocks.io/txns/FiUEfZpBLifAVS6r9d3bTfrWWwy1EQsKaniCENHFAkHN).
- [A2, market 68](E2E_RESULTS.md): BTC price buckets → Flat.
- [A3, market 69](E2E_RESULTS.md): BTC price change → Up.
- [A4, market 70](E2E_RESULTS.md): NPOINT `ft_balance_of` through `near_view` → Yes.
- A6, market 76: a changed JSON identity failed its assertion on all three attempts (`assert_failed`); the market never resolved, became `Unresolvable`, and was [voided](https://testnet.nearblocks.io/txns/BVuv2dZF6pWSLmY5JFYsSZ11rNdzCJ7wkEfoPQiLHm1A). Bettors were refunded.
- A7, market 77: the deleted source returned `http_4xx` on all three attempts; the market became `Unresolvable` and was [voided](https://testnet.nearblocks.io/txns/3NbFB8K2giB7yxxFyfUCcunjNWd2Etfw2kvn2xzPYREW).
- A8, market 73: an in-window RSS post resolved Yes after three agreeing NEAR AI jurors inside the TEE; [trigger and resolution](https://testnet.nearblocks.io/txns/HMUwVHVvegxTKANcMiGvToiynC32BdRid28q9A1skBNt).
- A8 rerun, market 78: OutLayer execution failed twice and returned null. Court rejected the null, and the market was [voided](https://testnet.nearblocks.io/txns/9uRxS8JUQHuK9a4L9foWgYySgsHSX3nurkToArzkUgsx) without a wrong outcome. Cause: a slow juror call could outlive OutLayer's time limit. Resolver v2 added a 90-second run budget with guest-enforced HTTP timeouts. The A8 regression rerun, [market 82](E2E_RESULTS.md), then resolved Yes with 3 jurors and `tee: true`.
- A8n, market 74: no in-window post resolved No through `default_if_no_evidence`, without calling jurors; [trigger and resolution](https://testnet.nearblocks.io/txns/6vNnXRHexjnu1W699kqsLiSUnYgoDWuYiN9MFgnmTdFB).
- A9, market 75: a prompt-injection-only post resolved No after three agreeing jurors; the injection phrase was flagged; [trigger and resolution](https://testnet.nearblocks.io/txns/D4zeVBo7kT8nTmtftaqf4HdFFK8NQZorLxJXQEyjDZYw).
- [Generic request `req:1`](docs/INTEGRATE.md#verified-on-testnet): [`request_resolution` transaction](https://testnet.nearblocks.io/txns/EwTtoX8cAJBDUZWJrYnKchPdbnkQa8dnNJCuxnoXwPrZ) and [keeper trigger](https://testnet.nearblocks.io/txns/2FjTEHWCp6Um7Ro8NSgqGd4ukjz7i2qWAEsxJ1dtP9GA); final verdict Yes, value `3.401`, attempt 2, `tee: true`.

The configured resolver is now pinned to WASM SHA-256 `39e5a6ceb7160e1b8eda6f294ff249d00dfe7d250f088848fb64ea1f0c3f6d8c` (resolver v3, [`resolver/WASM_SHA256`](resolver/WASM_SHA256)); `bash scripts/build-resolver.sh` reproduces it. Markets 67–79 ran on the earlier pin `a8efb56c2f9fe31c2d857686d8b97179b15d8529a17984bfd31fc3f97ef6ce40`. Each receipt records the version it ran. [Service health](https://noacourtmcp.junstudio.xyz/healthz) shows that the served, published and Court-pinned hashes match. A6–A9 fixtures are served by the MCP host at `https://noacourtmcp.junstudio.xyz/fixtures/<name>` and labelled `self_declared`; that host is outside the verified-source list.

## How it works

```text
Agent + creator wallet
  │ draft → sample → lint → simulate → /sign/<id>
  ▼
MCP server ── creator signs ──► Court.register_spec ──► Noa.create_market
  │                                  │                         │
  └── permissionless keeper ───────► Court.link_market ◄──────┘
                                     │ trigger after observation.at
                                     ▼
                             outlayer.testnet
                             configured resolver.wasm
                             fetch → extract → decide
                                     │ Verdict v1 callback
                                     ▼
                              Court receipt ──► Noa resolution
                                     └─────────► generic callback / get_verdict
```

The verifiable fetch, extract, and decide path runs in an OutLayer TEE for normal resolution. Drafting, source sampling, lint, simulation, wallet links, and the permissionless keeper run off chain. A keeper can trigger, link, retry, void, and finalize eligible operations; it cannot choose the outcome. Court validates the resolver's spec hash and outcome before recording a receipt. For text questions, the resolver asks three NEAR AI jurors to judge untrusted evidence and requires three valid agreeing votes. See the [spec reference](docs/SPEC.md) and [architecture](docs/ARCHITECTURE.md).

## What NEAR does here

| NEAR piece | Role in Noa Court | Evidence |
| --- | --- | --- |
| [OutLayer](https://outlayer.ai) TEE (`outlayer.testnet`) | Runs the pinned `resolver.wasm` for fetch → extract → decide. Court calls `request_execution` on chain and accepts a verdict only from the OutLayer callback (yield/resume). The NEAR AI key is a sealed OutLayer secret that only Court and the ops account can use. | `get_verdict` → `tee: true`, `submitted_by: "outlayer"`, `outlayer.source.version_key` |
| NEAR AI Cloud | Three juror models (`z-ai/glm-5.3-flash`, `Qwen/Qwen3.6-35B-A3B-FP8`, `deepseek/deepseek-v4.1-flash`) judge text evidence inside the TEE. A verdict needs 3 valid, agreeing votes with confidence ≥ 0.7, and each vote quotes its evidence. | `get_verdict {"id":"noa:82"}` → `jurors[]` with quotes |
| Court contract (`ai-resolver.noamarket.testnet`) | Stores the spec by hash, takes registration credits, links Noa markets via `metadata_hash`, checks the verdict's spec hash and outcome, keeps the receipt, calls Noa `resolve_market` or `void_market`, and serves a generic `request_resolution` + callback to other contracts. | [contract README](contracts/court/README.md) |
| Noa market (`v3.noamarket.testnet`) | The existing LMSR prediction market. Its unchanged code accepts Court as the market's resolver. | trigger transactions in [E2E results](E2E_RESULTS.md) |
| NEAR Connect + NEP-413 | Wallet signing on the `/sign` page (Intear, Meteor; HOT on mainnet). A NEP-413 message signature authorises publishing the reviewed rules to Noa. | [MCP README](apps/mcp/README.md) |
| FastFS | Serves the exact resolver bytes that OutLayer runs, addressed by SHA-256. | [`resolver/WASM_SHA256`](resolver/WASM_SHA256) |

## Noa link and trust status

The `/sign` page supplies Noa's existing free-form `metadata_hash` as `"noacourt:sha256:<spec_hash hex>"` (`"noacourt:" + spec_hash`, where `spec_hash` already contains `sha256:`). Noa contract code is unchanged. This binds the market to a stored spec, allowing anyone to call Court `link_market`. The market creator must first pay for their own registration credit; another account's credit cannot be used. A market made elsewhere with a different or empty metadata hash can still link when its creator signs `link_market({"market_id":N,"spec_hash":"sha256:<hex>"})`, subject to the same resolver, outcome, expiration, and credit checks. Current testnet and MCP retry defaults are five attempts every three minutes; the Noa resolution window must extend through `observation.at + max_attempts × retry.every + 5m` (20 minutes with those defaults). MCP computes the required window. See [metadata_hash behaviour](docs/INTEGRATE.md#metadata_hash-behaviour).

The deployment is **testnet only**: Court `ai-resolver.noamarket.testnet`, Noa `v3.noamarket.testnet`, NPOINT `point.noamarket.testnet` (18 decimals), and OutLayer project `court-ops.noamarket.testnet/court-resolver` on `outlayer.testnet`. The current Court configuration gives OutLayer 200 TGas and a 150-second execution limit; `trigger` and `trigger_request` need at least 265 TGas prepaid, so callers should use 300 TGas ([formula and commands](docs/INTEGRATE.md#generic-contract-integration)). A testnet-only `trusted_keeper` fallback can submit a verdict when OutLayer is unavailable; Court marks that receipt `tee: false`. It must be disabled (`null`) on mainnet. Consumers requiring TEE execution should check `tee == true`. The current receipt, not the diagram, is the evidence for any individual market.

Noa's market core contract is **closed source** and predates this hackathon. Only Noa Court in this repository—court-core, resolver, Court contract, and MCP server—is open source. The sibling hackathon project is [Fulfil](https://github.com/cuongdcdev/fullfil) ([site](https://fulfil.junstudio.xyz)). The [Noa Court repository](https://github.com/cuongdcdev/noacourt) contains this documentation and code.

## Repository layout

| Path                   | Purpose                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `crates/court-core/`   | Spec types, canonicalization, lint, source tools, decision engine, juror validation. |
| `resolver/`            | WASI Preview 2 wrapper, build, and saved examples.                                   |
| `contracts/court/`     | NEAR Court contract, method reference, and sandbox tests.                            |
| `apps/mcp/`            | MCP tools, sign page, and permissionless keeper.                                     |
| `docs/SPEC.md`         | ResolutionSpec v1 and Verdict v1 reference.                                          |
| `docs/INTEGRATE.md`    | Generic and Noa integration guide.                                                   |
| `docs/ARCHITECTURE.md` | Component interfaces and architecture.                                               |
| `E2E_RESULTS.md`       | Recorded testnet E2E evidence.                                                       |

## Hackathon disclosure

- **Built at NEAR HACKATHON**, 2026-11-12 to 2026-11-14. Everything in this repository was written during the hackathon. The sign-page and publish features were added on 2026-11-14.
- **Pre-existing and not judged:** Noa market itself (its contracts, frontend and API). Noa launched before the hackathon and stays closed source. Noa Court doesn't change Noa's contract code; it uses Noa's existing `resolver` and `metadata_hash` fields.
- **Network:** all evidence above is from NEAR testnet. Mainnet launch on Noa is being prepared; the planned mainnet Court account is `ai-resolver.noamarket.near`. `trusted_keeper` will be `null` there, so every mainnet verdict comes from OutLayer.
- **Libraries:**
  - Rust: `near-sdk`, `serde`/`serde_json`, `serde_json_path` (RFC 9535 JSONPath), `rust_decimal`, `quick-xml`, `time`, `url`, `wasi`.
  - Node: `@modelcontextprotocol/sdk`, `near-api-js`, `@hot-labs/near-connect`, `express`, `zod`, `canonicalize`, `qrcode`.
  - Tests: `near-workspaces`, `vitest`.
  - AI coding assistants (Claude Code, Codex) wrote much of the code under human review.
- **Sibling project** (rules Q-015): [Fulfil](https://github.com/cuongdcdev/fullfil), an independent second submission by the same author.
- **Suggested tracks:** Privacy & Private AI (TEE + NEAR AI Cloud jurors), Unstoppable DeFi (prediction-market resolution), Open Innovation.

## Get the code

Clone the public repository:

```sh
git clone https://github.com/cuongdcdev/noacourt.git && cd noacourt
```

Run each command block from the repository root in a fresh shell.

From the repository root, run the resolver build and saved lint example:

```sh
bash scripts/build-resolver.sh
/root/.wasmtime/bin/wasmtime run -S http target/wasm32-wasip2/release/resolver.wasm < resolver/examples/a1_near_threshold.lint.input.json
```

Run Court contract unit tests and build from its standalone workspace:

```sh
cd contracts/court
cargo test --lib
cargo near build non-reproducible-wasm
```

Start the MCP server from its standalone Node 22/pnpm package, or run its checks:

```sh
cd apps/mcp && pnpm install && pnpm build && pnpm start
```

```sh
cd apps/mcp && pnpm typecheck && pnpm test
```

Run the E2E harness dry run from its package:

```sh
cd e2e && pnpm install && pnpm e2e A1 --dry-run
```

See the [Court](contracts/court/README.md), [resolver](resolver/README.md), and [MCP](apps/mcp/README.md) READMEs for local runtime details.
