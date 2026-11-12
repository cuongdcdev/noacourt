# Noa Court — architecture and shared interfaces

Noa Court is a verifiable resolver for prediction markets on NEAR. A market creator describes
the question; an agent compiles it into a **ResolutionSpec** (JSON). At resolution time a pinned
WASM module runs inside an **OutLayer TEE**, fetches the declared sources, and decides the outcome
with deterministic code (or a 3-juror NEAR AI panel for text questions). The **Court contract**
accepts a verdict only from the OutLayer callback and forwards it to the market.

Noa market is the first integration. Any other contract can use the generic
`request_resolution` / `get_verdict` interface (see `docs/INTEGRATE.md`).

This file is the contract between components. Change it only through an OpenSpec change.

## 1. Components

| Path | What | Lang |
|---|---|---|
| `crates/court-core` | ResolutionSpec types, canonical hash, lint, source adapters, decide, Verdict | Rust lib (std) |
| `resolver/` | `resolver.wasm`: wasm32-wasip2 binary wrapping court-core; reads input JSON on stdin, writes Verdict JSON on stdout | Rust |
| `contracts/court` | Court contract deployed at `ai-resolver.noamarket.testnet` | Rust, near-sdk 5 |
| `apps/mcp` | Remote MCP server + `/sign/<id>` page + keeper loop, served at `https://noacourtmcp.junstudio.xyz` | TypeScript, Node 22 |
| `fixtures/` | Test evidence we control (published as GitHub gists) | JSON/RSS |

Trust split (owner rule, kent-notes 2026-11-12): only fetch → extract → decide must be verifiable,
so only that runs in OutLayer. Drafting, lint, simulation, sign links and the keeper run off-chain,
and the keeper has no power over outcomes.

## 2. Flow

```
create (one wallet approval, 2 txs batched by /sign page):
  tx1 Court.register_spec(spec_json)            + deposit (storage + prepaid resolve fee)
  tx2 Noa.create_market(..., resolver = Court, metadata_hash = "noacourt:<spec_hash>")
  then anyone (sign page, else keeper) calls Court.link_market(market_id)
       Court reads Noa.get_market → checks resolver == Court, metadata_hash matches a stored spec,
       outcomes equal spec.outcomes, market.expiration <= spec.observation.at

resolve:
  keeper → Court.trigger(market_id)   (permissionless; keeper only pays gas)
  Court → outlayer.request_execution(source = pinned resolver, input_data = ResolverInput, secrets_ref)
  OutLayer TEE runs resolver.wasm → Verdict JSON → callback Court.on_verdict
  resolved      → Noa.resolve_market(market_id, outcome_index) + 1 yocto
  retry_after   → schedule; keeper triggers again (max attempts from config)
  unresolvable  → mark; after Noa resolution_deadline anyone calls Court.void(market_id) → Noa.void_market
  keeper → Noa.finalize_resolution(market_id) after dispute window

generic (non-Noa):
  caller → Court.request_resolution(spec_json, callback?) + deposit → request_id
  same OutLayer path → verdict stored → get_verdict(request_id); optional callback
  caller_contract.<method>({request_id, verdict})
```

## 3. ResolutionSpec v1

Spec is passed and stored as a **JSON string** (`spec_json`). `spec_hash = "sha256:" + hex(sha256(utf8 bytes of spec_json))`.
Tools that produce specs MUST emit canonical JSON (RFC 8785 JCS) so the same spec always has the same hash.

```jsonc
{
  "version": 1,
  "question": "Will NEAR/USDT close >= 3.40 on the 1m candle at 2026-11-13T10:00Z?",
  "outcomes": ["Yes", "No"],                       // must equal the market's outcomes, same order
  "observation": {
    "at": "2026-11-13T10:00:00Z",                  // RFC 3339 UTC
    "baseline_at": null,                           // required only for decide.kind = "change"
    "mode": "historical",                          // historical | first_fetch_after
    "max_delay": "30m"                             // how long after `at` a fetch is still valid
  },
  "sources": [ { "id": "binance", "tool": "binance_kline", "params": {}, "expect": {}, "extract": {}, "label": "verified" } ],
  "aggregate": { "method": "primary_then_fallback", "tolerance": "0.5%" },   // primary_then_fallback | median | all_agree
  "decide": { "kind": "threshold", "op": ">=", "value": "3.40" },
  "outcome_map": { "true": "Yes", "false": "No" },   // covers every decide result
  "on_unavailable": "void",                          // "void" or an outcome name
  "retry": { "max_attempts": 3, "every": "5m" },
  "rules_text_hash": "sha256:..."                    // hash of rules text rendered from this spec
}
```

### decide kinds (all except text_judge are deterministic, decimal math, no floats)

| kind | params | result key for outcome_map |
|---|---|---|
| `threshold` | `op` in `>= > <= <`, `value` (decimal string) | `"true"` / `"false"` |
| `buckets` | `edges` ascending decimals, `inclusive: "lower"` (bucket i = [e(i-1), e(i))) | `"0".."n"` bucket index |
| `equals` | `value` (string/decimal/bool) | `"true"` / `"false"` |
| `bool` | — (extracted value must be bool) | `"true"` / `"false"` |
| `change` | `tie` outcome name; compares value at `at` vs `baseline_at` | `"up"` / `"down"` / `"tie"` |
| `text_judge` | `question`, `yes_criteria[]`, `no_criteria[]`, `default_if_no_evidence` ("No"), `window {from,to}` | `"yes"` / `"no"` |

### Tools (catalog v1)

| tool | params | notes |
|---|---|---|
| `binance_kline` | `symbol`, `interval` ("1m"), uses `data-api.binance.vision` then `api.binance.com`; value = candle **close** of the candle containing `at` (or `open` via `field`) | geo-block → error `geo_blocked` |
| `okx_candle` | `instId` ("NEAR-USDT"), `bar` ("1m") | fallback venue for minute markets |
| `coinbase_candle` | `product_id` ("NEAR-USD"), `granularity` 60 | fallback venue |
| `coingecko_price` | `id`, `vs` | day-level only (no minute granularity on free API) |
| `near_view` | `network`, `contract`, `method`, `args`, `rpcs` (≥2, must agree) | uses block at/after `at` when `mode = historical` is not possible → `first_fetch_after` |
| `github_repo` | `owner`, `repo`, `field` (stargazers_count…); identity assert on repo `id` | snapshot |
| `http_json` | see SESSION_HANDOFF §6 (`request`, `expect.assert[]`, `identity`, `extract.path` RFC 9535, no positional index, `type`, `decimals`, `sanity`) | core tool |
| `rss_feed` | `url`, item filter (window) | evidence for text_judge |
| `web_text` | `url` (static HTML, scripts/tags stripped) | evidence for text_judge |

Source `label`: `verified` when the host is in the verified list (Binance api + data-api.binance.vision,
OKX, Coinbase, CoinGecko, api.github.com, NEAR RPC), else `self_declared` (shown in rules and receipt).

### Lint rules (code, run by MCP, CLI and resolver mode=lint)
observation.at after market close; buckets cover the line without overlap; snapshot tools need
`max_delay`; price markets need ≥2 sources; `http_json` needs ≥1 identity assert or `identity: "url_only"`;
outcome_map covers every decide result; `change` needs `baseline_at < at`; outcomes 2..10.

## 4. Resolver I/O (`resolver.wasm`)

Input (OutLayer `input_data`, stdin):
```jsonc
{ "mode": "resolve" | "simulate" | "lint",
  "spec_json": "<exact string>",
  "context": { "request_id": "noa:42" | "req:7", "attempt": 1, "now": "2026-11-13T10:01:00Z" | null } }
```
`now` null → use the WASI clock. `simulate` ignores "observation not reached" and uses the latest data
("if resolved now → X"). `resolve` returns `retry_after` when `now < at`.

Output (stdout) — **Verdict v1**:
```jsonc
{ "v": 1, "resolver_version": "0.1.0", "spec_hash": "sha256:...", "mode": "resolve",
  "status": "resolved" | "retry_after" | "unresolvable",
  "outcome": "Yes" | null, "outcome_index": 0 | null,
  "value": "3.4123" | null,                       // aggregated extracted value (decimal string) if any
  "retry_after": "2026-11-13T10:06:00Z" | null,
  "reason": "binance close 3.4123 >= 3.40",
  "sources": [ { "id": "binance", "ok": true, "value": "3.4123", "as_of": "...", "url": "...",
                 "evidence_sha256": "...", "error": null | "geo_blocked" | "assert_failed" | "http_4xx" | ... } ],
  "jurors": null | [ { "model": "...", "answer": "yes|no|unclear", "confidence": 0.9, "quotes": ["..."],
                       "item_ref": "...", "valid": true, "invalid_reason": null } ] }
```
Never guesses: any failed step → `retry_after` (if attempts remain and time allows) else `unresolvable`,
and the contract applies `on_unavailable`.

text_judge: 3 NEAR AI Cloud models (`COURT_JUROR_MODELS`), key from OutLayer sealed secret `NEAR_AI_API`.
Evidence is passed as data (never in system prompt), HTML/script stripped, length-capped. A vote is
valid only if every quote is a verbatim substring of the evidence bytes and `item_ref` date is inside
the window. Resolve only if 3/3 valid votes agree with confidence ≥ 0.7; otherwise `retry_after`, and after
`retry.max_attempts` → `on_unavailable`.

## 5. Court contract interface

```
init(owner, noa_contract, outlayer_contract, resolver_source: Value, secrets_ref: Option<SecretsRef>,
     treasury, min_deposit: U128, max_attempts: u8)
register_spec(spec_json) payable -> spec_hash        // stores spec; deposit >= min_deposit; refund excess
link_market(market_id, spec_hash: Option<String>) -> Promise
    // permissionless when Noa market.metadata_hash == "noacourt:<spec_hash>";
    // if metadata_hash is not ours, only the market creator may call it with an explicit spec_hash
trigger(market_id) -> Promise                        // permissionless; observation reached, no pending req
on_verdict(...) #[private]                           // OutLayer callback; parses Verdict; checks spec_hash
void(market_id) -> Promise                           // permissionless; after Noa resolution_deadline, if unresolvable
request_resolution(spec_json, callback: Option<{contract_id, method}>) payable -> request_id   // generic
trigger_request(request_id)                          // permissionless, generic
views: get_spec(spec_hash), get_market(market_id), get_request(request_id), get_verdict(request_id|"noa:<id>"),
       get_config()
owner: set_trusted_keeper(Option<AccountId>)  // TESTNET-ONLY fallback, see below
       set_resolver_source, set_secrets_ref, set_min_deposit, withdraw(token, amount) → treasury
```
States per market/request: `Registered → Pending(attempt) → {Resolved | RetryScheduled(t) | Unresolvable} → Voided`.
Testnet-only fallback: if `trusted_keeper` is set, that account may call `submit_keeper_verdict(id, verdict_json)`;
the stored verdict gets `"tee": false` and receipts show "not TEE-attested". Must be unset (None) for mainnet.

All verdicts (full Verdict JSON + OutLayer request info) are stored on-chain for the receipt.

## 6. MCP server tools (Streamable HTTP, no auth, rate limited per IP)

| tool | purpose |
|---|---|
| `court_guide` | how to draft a spec (the skill rules), catalog, verified domains, integration guide link |
| `catalog_list` / `catalog_tool` | tool schemas |
| `source_sample` | call one source now, return raw response excerpt + suggested identity asserts |
| `spec_lint` | lint |
| `spec_simulate` | run the pinned `resolver.wasm` (same sha256 as Court config) with wasmtime, mode=simulate |
| `rules_render` | rules text from spec (template) + `rules_text_hash`; returns canonical `spec_json` + `spec_hash` |
| `market_create_link` | params (title, outcomes, token, stake, duration, spec_json, creator?) → `https://noacourtmcp.junstudio.xyz/sign/<id>` + QR (PNG data URL) |
| `market_status` | Noa market + Court state + latest verdict |
| `verdict_get` | receipt for a market or generic request |

The server holds no user keys. Its own keeper key (`court-ops.noamarket.testnet`) can only call
permissionless methods.

## 7. Networks and accounts (testnet phase)

| Role | Account |
|---|---|
| Noa market contract | `v3.noamarket.testnet` (owner `noamarket.testnet`) |
| Court | `ai-resolver.noamarket.testnet` |
| Keeper + OutLayer project owner | `court-ops.noamarket.testnet` |
| Market token | `point.noamarket.testnet` (NPOINT, 18 decimals) |
| Test creators/bettors | `user1..user5.noamarket.testnet` |
| OutLayer | `outlayer.testnet`, API `https://testnet-api.outlayer.ai` |
