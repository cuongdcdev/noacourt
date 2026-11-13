# Noa Court

Noa Court lets a market creator lock a resolution rule into a canonical JSON spec before trading, preflight it against real sources, and receive a source-backed outcome from a resolver running through OutLayer on NEAR testnet. The Court contract stores the spec and receipt, checks the verdict, and forwards Noa market outcomes; a generic request and callback interface serves other contracts. The MCP server helps agents draft, sample, lint, simulate, and prepare a wallet sign link.

## Try it

1. Open [service health](https://noacourtmcp.junstudio.xyz/healthz) → see the MCP service status.
2. Add `https://noacourtmcp.junstudio.xyz/mcp` to Claude Code with `claude mcp add --transport http noacourt https://noacourtmcp.junstudio.xyz/mcp`; prompt: “Use court_guide, sample NEAR/USDT from Binance and OKX, draft and simulate a future two-outcome Court market, then show the rules and a wallet sign link.” → see a preflight verdict and `/sign/<id>` URL. The wallet signs only after you review the plan.
3. Open the A1 price-market receipt <!-- E2E:A1 -->[market 67](https://testnet.nearblocks.io/txns/GtfMBy2GmCKKNLjBGbNm7Wppf3VTnZ8ydB92bMrBsDWs)<!-- /E2E:A1 --> and <!-- E2E:A1_TX -->[resolution transaction](https://testnet.nearblocks.io/txns/GtfMBy2GmCKKNLjBGbNm7Wppf3VTnZ8ydB92bMrBsDWs)<!-- /E2E:A1_TX -->, then the A8 text-judge [market 79 resolution](https://testnet.nearblocks.io/txns/7JnWtdYRhPK5muTsUMC27Bg8nyhd8zBFNsTXhFGR28DL) on NearBlocks → see OutLayer verdicts and Noa `resolve_market` in the transaction receipts. Query the stored Court verdicts below to see their evidence and `tee` flags.
4. Read [E2E results](E2E_RESULTS.md) → inspect scenario outcomes, transaction hashes, and independent checks.
5. Follow [integration steps](docs/INTEGRATE.md) → request a generic verdict or create a Noa market.

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
- A8 rerun, market 78: OutLayer execution failed twice and returned null. Court rejected the null, and the market was [voided](https://testnet.nearblocks.io/txns/9uRxS8JUQHuK9a4L9foWgYySgsHSX3nurkToArzkUgsx) without a wrong outcome. The failure is under investigation.
- A8n, market 74: no in-window post resolved No through `default_if_no_evidence`, without calling jurors; [trigger and resolution](https://testnet.nearblocks.io/txns/6vNnXRHexjnu1W699kqsLiSUnYgoDWuYiN9MFgnmTdFB).
- A9, market 75: a prompt-injection-only post resolved No after three agreeing jurors; the injection phrase was flagged; [trigger and resolution](https://testnet.nearblocks.io/txns/D4zeVBo7kT8nTmtftaqf4HdFFK8NQZorLxJXQEyjDZYw).
- [Generic request `req:1`](docs/INTEGRATE.md#verified-on-testnet): [`request_resolution` transaction](https://testnet.nearblocks.io/txns/EwTtoX8cAJBDUZWJrYnKchPdbnkQa8dnNJCuxnoXwPrZ) and [keeper trigger](https://testnet.nearblocks.io/txns/2FjTEHWCp6Um7Ro8NSgqGd4ukjz7i2qWAEsxJ1dtP9GA); final verdict Yes, value `3.401`, attempt 2, `tee: true`.

The configured resolver is pinned to WASM SHA-256 `a8efb56c2f9fe31c2d857686d8b97179b15d8529a17984bfd31fc3f97ef6ce40`. A6–A9 fixtures are served by the MCP host at `https://noacourtmcp.junstudio.xyz/fixtures/<name>` and labelled `self_declared`; that host is outside the verified-source list.

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

## Noa link and trust status

The `/sign` page supplies Noa's existing free-form `metadata_hash` as `"noacourt:sha256:<spec_hash hex>"` (`"noacourt:" + spec_hash`, where `spec_hash` already contains `sha256:`). Noa contract code is unchanged. This binds the market to a stored spec, allowing anyone to call Court `link_market`. The market creator must first pay for their own registration credit; another account's credit cannot be used. A market made elsewhere with a different or empty metadata hash can still link when its creator signs `link_market({"market_id":N,"spec_hash":"sha256:<hex>"})`, subject to the same resolver, outcome, expiration, and credit checks. See [metadata_hash behaviour](docs/INTEGRATE.md#metadata_hash-behaviour).

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
| `E2E_RESULTS.md`       | Testnet E2E evidence when the harness run is recorded.                               |

## Build and test

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

Run MCP checks from its standalone Node 22/pnpm package:

```sh
cd apps/mcp
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

See the [Court](contracts/court/README.md), [resolver](resolver/README.md), and [MCP](apps/mcp/README.md) READMEs for local runtime details.
