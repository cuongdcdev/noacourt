# Integrate Noa Court

Noa Court resolves a canonical ResolutionSpec through `ai-resolver.noamarket.near` on NEAR mainnet. Any prediction market or contract can use it: a generic consumer requests a verdict with `request_resolution` and reads it back (or receives a callback), without using Noa markets. Noa markets use the same resolver through a market link. Check [the spec reference](SPEC.md) before funding a request; mainnet requests use real NEAR.

> **Status.** The Noa market path is live on mainnet (markets #26 and #27). The generic `request_resolution` path runs the same contract code and was exercised end to end on testnet (`req:1`, below); it has not yet been run on mainnet.

## Generic contract integration

Clone the [Noa Court repository](https://github.com/cuongdcdev/noacourt), then install `near-cli-rs` 0.30 and Node.js with the `apps/mcp` dependencies (`cd apps/mcp && pnpm install`). Prepare a complete valid ResolutionSpec in a local JSON file, updating its observation time and sources. The following uses the saved [price example](../resolver/examples/a1_near_threshold.spec.json) as a starting point. Its fixed date must be moved into the future before a new request. `spec_json` is one JSON **string**, not a nested object. The `canonicalize` package used here is the same dependency as the MCP server; `rules_render` can also supply canonical `spec_json` and `spec_hash`.

```sh
export SIGNER=your-account.near
export SPEC_FILE=/absolute/path/to/your-updated-spec.json
export SPEC_JSON="$(cd apps/mcp && node -e 'const fs=require("node:fs");const canonicalize=require("canonicalize");const spec=JSON.parse(fs.readFileSync(process.env.SPEC_FILE,"utf8"));process.stdout.write(canonicalize(spec));')"
```

This transaction pays at least 0.1 NEAR (the configured minimum; Court keeps its 0.05 NEAR resolution fee plus storage and refunds excess). It returns an ID such as `req:1`. Omit the `callback` or set it to `null` for polling only. For a callback, deploy the consumer method below first and set its account in the arguments.

```sh
near contract call-function as-transaction ai-resolver.noamarket.near request_resolution json-args "$(node -e 'process.stdout.write(JSON.stringify({spec_json:process.env.SPEC_JSON,callback:{contract_id:"consumer.near",method:"on_court_verdict"}}))')" prepaid-gas '100.0 Tgas' attached-deposit '0.1 NEAR' sign-as "$SIGNER" network-config mainnet sign-with-legacy-keychain send
```

`sign-with-legacy-keychain` reads keys in `~/.near-credentials`, as used by the older NEAR CLI; use `sign-with-keychain` instead for a key in the OS keychain. near-cli-rs also supports `sign-with-access-key-file` for an explicit key file.

After `observation.at`, anyone can trigger the request; the permissionless keeper also does this. Use the returned ID in place of `req:1`:

```sh
near contract call-function as-transaction ai-resolver.noamarket.near trigger_request json-args '{"request_id":"req:1"}' prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as "$SIGNER" network-config mainnet sign-with-legacy-keychain send
near contract call-function as-read-only ai-resolver.noamarket.near get_request json-args '{"request_id":"req:1"}' network-config mainnet now
near contract call-function as-read-only ai-resolver.noamarket.near get_verdict json-args '{"id":"req:1"}' network-config mainnet now
```

`get_request` shows `status`, `attempts`, `retry_at_ns`, `last_error`, and `callback_sent`. `get_verdict` returns `null` until a receipt is stored. A resolved request has an outcome, while a retry may have a receipt for the latest attempt. Trigger again when `retry_at_ns` is due, within the attempt limit. The keeper can do this, but has no power to choose outcomes.

For a linked Noa market, call `trigger({"market_id":N})` instead. Replace `42` below with the linked market ID:

```sh
near contract call-function as-transaction ai-resolver.noamarket.near trigger json-args '{"market_id":42}' prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as "$SIGNER" network-config mainnet sign-with-legacy-keychain send
```

Both trigger methods require prepaid gas of at least `outlayer_gas_tgas + min(50, 280 - outlayer_gas_tgas) + 15` TGas. The current mainnet `outlayer_gas_tgas` is 200, so the minimum is **265 TGas**; use **300 TGas** for either method. The current OutLayer `resource_limits.max_execution_seconds` is **150**. Read `get_config` before integrating with a different deployment or after a configuration change.

| Court call                                | Recommended prepaid gas | Attached deposit |
| ----------------------------------------- | ----------------------- | ---------------- |
| `trigger({"market_id":N})`                | 300 TGas                | 0 NEAR           |
| `trigger_request({"request_id":"req:1"})` | 300 TGas                | 0 NEAR           |

### Verified on testnet

The generic flow above was exercised as `req:1`, signed by `user5.noamarket.testnet`: [`request_resolution`](https://testnet.nearblocks.io/txns/EwTtoX8cAJBDUZWJrYnKchPdbnkQa8dnNJCuxnoXwPrZ), then the permissionless keeper's [`trigger_request`](https://testnet.nearblocks.io/txns/2FjTEHWCp6Um7Ro8NSgqGd4ukjz7i2qWAEsxJ1dtP9GA). `get_verdict({"id":"req:1"})` returned `resolved` / `Yes`, value `3.401`, `tee: true`, `submitted_by: "outlayer"`, attempt 2. The testnet resolver is pinned to WASM SHA-256 `a8efb56c2f9fe31c2d857686d8b97179b15d8529a17984bfd31fc3f97ef6ce40`. All first-wave market scenarios (A1–A4, A6–A9) passed; receipts and checks are in [E2E_RESULTS.md](../E2E_RESULTS.md). A6–A9 fixtures were served by the testnet MCP host (now retired) and labelled `self_declared`, outside the verified-source host list.

Court invokes the optional callback once for a final generic result with `{"request_id":"req:1","verdict":<full get_verdict record>}`. It uses 20 TGas, zero deposit, and does not wait for a return value. A minimal near-sdk 5 consumer is:

```rust
use near_sdk::{env, near, require, AccountId};
use near_sdk::serde_json::Value;

#[near(contract_state)]
#[derive(Default)]
pub struct Consumer {
    pub last_request_id: Option<String>,
    pub last_outcome: Option<String>,
}

#[near]
impl Consumer {
    pub fn on_court_verdict(&mut self, request_id: String, verdict: Value) {
        let court: AccountId = "ai-resolver.noamarket.near".parse().unwrap();
        require!(env::predecessor_account_id() == court, "Court callback only");
        require!(verdict["tee"] == true, "TEE verdict required");
        require!(verdict["id"] == request_id, "request mismatch");
        let raw = &verdict["verdict"];
        require!(raw["status"] == "resolved", "no resolved outcome");
        let outcome = raw["outcome"].as_str().expect("outcome missing");
        self.last_request_id = Some(request_id);
        self.last_outcome = Some(outcome.to_string());
    }
}
```

Adapt storage and outcome validation to your own contract. Require `tee == true` and bind the expected Court account, request ID, spec hash, and outcome set. Mainnet Court has `trusted_keeper: null`, so every mainnet receipt comes from the OutLayer TEE callback. A callback is an asynchronous notification: `get_verdict` is the durable read interface.

### Full receipt schema

`get_verdict({"id":"req:1"})` (or `{"id":"noa:42"}`) expands the on-chain record as follows:

```json
{
  "id": "req:1",
  "verdict": {
    "v": 1,
    "resolver_version": "0.1.0",
    "spec_hash": "sha256:<64 hex characters>",
    "mode": "resolve",
    "status": "resolved",
    "outcome": "Yes",
    "outcome_index": 0,
    "value": "3.41",
    "retry_after": null,
    "reason": "threshold 3.41 true",
    "sources": [
      {
        "id": "binance",
        "ok": true,
        "value": "3.41",
        "as_of": "2026-12-01T12:00:00Z",
        "url": "https://data-api.binance.vision/...",
        "evidence_sha256": "<64 hex characters>",
        "error": null
      }
    ],
    "jurors": null
  },
  "tee": true,
  "submitted_by": "outlayer",
  "attempt": 1,
  "received_at_ns": 1796126400000000000,
  "outlayer": {
    "contract": "outlayer.testnet",
    "source": {
      "Project": {
        "project_id": "court-ops.noamarket.testnet/court-resolver",
        "version_key": null
      }
    },
    "secrets_ref": {
      "profile": "default",
      "account_id": "court-ops.noamarket.testnet"
    },
    "deposit": "20000000000000000000000"
  },
  "applied_on_unavailable": false
}
```

The values above illustrate the schema, not a live receipt; read `get_config` for the current OutLayer source and deposit. `id` is the Court item key; `verdict` is the raw resolver JSON, including source evidence hashes and optional juror votes. `tee` distinguishes an accepted OutLayer result from the testnet trusted-keeper fallback or a synthetic exhausted failure. `submitted_by` identifies the submitting path, `attempt` is one-based, and `received_at_ns` is NEAR block time. `outlayer` is null for keeper results and may contain request metadata even when a rejected OutLayer result exhausts attempts and `tee` becomes false; when present, its fields are `contract`, `source`, `secrets_ref`, and `deposit`. `applied_on_unavailable` says Court used the spec's unavailable policy; inspect the item status and `outcome_index` too, since the raw verdict can remain `unresolvable` while Court resolves to a fallback outcome. See [Verdict v1](SPEC.md#canonicalization-lint-and-verdict) for every nested field.

## Noa market integration

Mainnet Noa is `v3.noamarket.near`; Court is `ai-resolver.noamarket.near`; the default stake token is NPOINT `npoint.noamarket.near` (any Noa-whitelisted token works; see `list_whitelisted_tokens`). A creator first calls `register_spec({"spec_json":"<canonical JSON string>"})` on Court with at least 0.1 NEAR and 100 TGas. It returns `sha256:<hex>` and grants **one credit to the paying account**. Then that same account calls Noa `create_market` with `resolver: "ai-resolver.noamarket.near"`, outcomes in the exact spec order, expiration no later than `observation.at`, and the metadata hash below. Finally call Court `link_market({"market_id":N,"spec_hash":null})` with 100 TGas. Anyone can perform this final call when metadata binds the spec; the sign page or keeper normally does it. Check the returned boolean or `get_market`, because a rejected link is logged and may return `false` while the transaction succeeds. `get_credits({"spec_hash":"sha256:<hex>","account_id":"creator.near"})` reports usable creator credits. Another account's `register_spec` credit cannot link this creator's market.

The MCP `market_create_link` tool prepares a wallet URL at `/sign/<id>` (valid for 24 hours). The page uses NEAR Connect with Intear, Meteor (extension, web and mobile app) or HOT Wallet (mainnet only). Its signer plan may first add `ft_transfer_call` to fund Noa's internal NPOINT balance. It then asks the creator's wallet to sign Court `register_spec` and Noa `create_market` as separate transactions, and attempts the permissionless link after creation. The MCP server never handles creator keys. For nonexempt creators, Noa currently charges a creation fee and storage; read the live plan before approving.

### Noa description and rules publication

`market_create_link` takes `noa_rules`, the human-readable resolution rules traders read on Noa (required by the `court_guide` workflow; optional in the schema, and generated deterministically from the spec when omitted), and an optional plain-text `description` (one or two plain sentences of context, not a repeat of the rules; fallback: the Noa rules text). Noa renders `rules` as plain text, so the agent writes it in this exact format:

```
Resolves Yes if the NEAR/USDT 1-minute candle close at 19:28 UTC on 14 Nov 2026 is ≥ 3.10; otherwise No.

Source: Binance NEARUSDT 1m close. OKX NEAR-USDT is the fallback, used only if Binance has no valid price.
If no valid price is available after 5 attempts (every 3 min), the market is voided and all bets are refunded.
```

Rules for `noa_rules`: plain sentences, no markdown, no JSON, no backticks, 40 to 1200 characters; name every outcome label; give the exact observation time in UTC with the date, the threshold (or bucket edges) and the comparison, the sources in plain words (primary and fallback; write a tolerance only for `all_agree`), the retry count and interval, and the void/refund rule when `on_unavailable` is `void` (validation fails without it). Do not write the footer: the server appends `Resolved by Noa Court in an OutLayer TEE. Spec sha256:<hash>` and `Full rules: <PUBLIC_BASE_URL>/spec/<hash>`. At link creation the server freezes, next to the spec, the description, the published rules text (agent text plus footer), the renderer version (`noa-rules-v1`; legacy requests keep `rules-v1` and their bytes), the spec hash and `metadata_digest = sha256(JCS{title, token_id, outcomes, description, rules})`. The digest is an off-chain integrity check, not committed on-chain; `metadata_hash` on `create_market` is unchanged. Retries and reloads always use the frozen bytes. The binding canonical rules (`rules_markdown`, `rules_text_hash`, `spec_hash`) are unchanged and are served publicly at `GET <PUBLIC_BASE_URL>/spec/<sha256 hex>`, read from the Court contract (`get_spec`) with the local store as a labelled fallback.

When the deployment sets `NOA_API_URL`, `NOA_AUTH_RECIPIENT` and `NOA_MARKET_URL_BASE` (mainnet has built-in defaults, testnet has none), the sign page: (1) asks the connected creator wallet for a NEP-413 `signMessage` on Noa's `GET /auth/challenge` message (`Login to Noa Market: <nonce>`, recipient = `NOA_AUTH_RECIPIENT`, `callbackUrl` null) and exchanges it at `POST /auth/login` before any create transaction is requested; (2) after the server verifies creation, `POST {NOA_API_URL}/v1/markets` with `Authorization: Bearer <token>` and body `{market_id, title, outcomes, token_id, description, rules}` (no `market_status`; image/embed/category/tags omitted); (3) calls the same-origin `POST /api/sign/<id>/publication/verify`, where the server reads `GET {NOA_API_URL}/v1/markets/<market_id>` and compares description and rules byte-for-byte. Only that read-back sets `published`. The session token lives in browser memory only.

Noa metadata is write-once and creator-owned: an identical retry returns 200 `already_published`; different content returns 409 (state `conflict`, no automatic retry, nothing is overwritten); another account gets 403. Publication states: `not_started`, `auth_required`, `publishing`, `awaiting_verification`, `published`, `retryable_error`, `conflict`, `legacy_unavailable` (requests created before this feature are never auto-published), `disabled` (not configured). Reopening `/sign/<id>` after completion shows the publication panel with a retry; no second `register_spec`/`create_market` is ever requested. The Noa API's `CORS_ORIGINS` must include the sign-page origin and allow the `Authorization` and `Content-Type` headers. `market_status` returns `metadata_publication` (state, last verified time, Noa market URL once published). Backfilling metadata for markets created before this feature is out of scope.

### metadata_hash behaviour

The `/sign` transaction builder passes `metadata_hash = "noacourt:sha256:<spec_hash hex>"` to Noa `create_market`: in code this is `"noacourt:" + spec_hash`, because `spec_hash` already begins with `sha256:`. This uses Noa's existing free-form `metadata_hash` field; **Noa contract code is unchanged**. Court checks this value against a stored spec, so `link_market({"market_id":N,"spec_hash":null})` is permissionless. The market creator still needs their own unused registration credit; the link also checks Court as resolver, matching ordered outcomes, market state, and expiration at or before `observation.at`.

For a market created in another UI or by CLI with a different or empty `metadata_hash`, the **market creator** can instead sign `link_market({"market_id":N,"spec_hash":"sha256:<hex>"})` (100 TGas, zero deposit). This is an extra creator signature. It works under the same resolver, outcome, expiration, active-market, and creator-credit checks. Current Court and MCP defaults are five attempts every three minutes. Court requires the Noa resolution deadline to cover `observation.at + max_attempts × retry.every + 5m` (20 minutes with those defaults); otherwise linking returns `resolution window too short for retries`. The MCP computes the required resolution window automatically. A metadata value beginning with `noacourt:` cannot use this bypass; an explicit hash must match it.

## MCP for agents

The public endpoint is `https://court.noamarket.xyz/mcp` (stateless Streamable HTTP, no auth, about 60 requests/minute/IP); `https://court.noamarket.xyz/healthz` reports service health. Add it in Claude Code with:

```sh
claude mcp add --transport http noacourt https://court.noamarket.xyz/mcp
```

In Claude.ai or ChatGPT custom connectors, enter the same MCP URL. Availability of custom connectors depends on the client account and settings.

| Tool                 | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `court_guide`        | Drafting workflow, verified hosts, and examples.                            |
| `catalog_list`       | Available source adapters.                                                  |
| `catalog_tool`       | Parameter schema and example for one adapter.                               |
| `source_sample`      | Sample one live source, including raw identity hints.                       |
| `spec_lint`          | Structural and authoritative resolver lint.                                 |
| `spec_simulate`      | Live preflight: “if resolved now.” Text judging may consume NEAR AI budget. |
| `rules_render`       | Human rules plus canonical `spec_json`, `spec_hash`, and rules hash.        |
| `list_whitelisted_tokens` | Noa-whitelisted tokens, decimals, symbol, and minimum stake per outcome count. |
| `market_create_link` | Validated wallet sign URL and QR. The creator picks `token_id` and a custom `stake` (liquidity). |
| `market_status`      | Noa and Court market state, pending resolution, and receipt.                |
| `verdict_get`        | Stored receipt for `market_id` or `request_id`.                             |

Typical prompt: “Use `court_guide`, sample Binance NEAR/USDT and an OKX fallback, draft a two-outcome one-minute close market for a future UTC time, lint and simulate it, show me the rules, then create a wallet sign link for 10 NPOINT.” Another prompt: “Call `verdict_get` for request `req:1` and explain the evidence and TEE flag.” The agent flow is `court_guide` → `source_sample` → `rules_render`/`spec_lint` → `spec_simulate` → `market_create_link` → `market_status`/`verdict_get`. The creator reviews and signs the wallet plan.

## Lifecycle, fees, and events

| Court state      | What happens next                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Linked`         | Registered generic request or linked Noa market; wait until `observation.at`.                                                                          |
| `Pending`        | An attempt is running at OutLayer. A failed execution counts as an attempt.                                                                            |
| `RetryScheduled` | Anyone may trigger when `retry_at_ns` is due and attempts remain.                                                                                      |
| `Resolved`       | Generic callback sent once if configured; Noa outcome forwarded to `resolve_market`. Check `forwarded` (`null`, `true`, or `false`).                   |
| `Unresolvable`   | `on_unavailable: "void"` leaves no outcome. After Noa's resolution deadline, anyone may call Court `void`; generic consumers receive a final callback. |
| `Voided`         | Noa accepted `void_market`; the market has no winning outcome.                                                                                         |

If forwarding fails before the Noa deadline, anyone may call `retry_forward`; after the deadline, `void` may be attempted. A resolved Noa proposal waits through Noa's dispute window; then anyone, including the keeper, calls Noa `finalize_resolution`. Court does not finalize it. On mainnet, market #26 had a 60-minute dispute window; read live Noa config for each market. `register_spec` and `request_resolution` require at least Court's `min_deposit` (currently 0.1 NEAR) and enough for storage plus `resolution_fee` (currently 0.05 NEAR); excess is refunded. Court pays each OutLayer request deposit from its own balance (currently configured to 0.02 NEAR). Read `get_config` rather than assuming these values on another deployment.

Court emits NEP-297 `EVENT_JSON` logs with `standard: "noacourt"` and `version: "1.0.0"`, including `spec_registered`, `market_linked`, `link_rejected`, `triggered`, `verdict_received`, `verdict_rejected`, and `callback_sent` as applicable. The testnet-only `trusted_keeper` fallback can submit a non-TEE verdict, which is recorded with `tee: false`; it must be `null` on mainnet. The normal keeper calls permissionless methods and cannot choose an outcome.
