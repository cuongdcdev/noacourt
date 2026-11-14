# NEAR token markets

Use the existing `http_json` source to resolve NEAR token price, market capitalization, or FDV markets. No new Court contract method or resolver adapter is required. Start with `court_guide`, inspect a live `source_sample`, lint and simulate the complete spec, render its rules, then let the creator review and sign. A successful simulation is a current preview, not a guarantee that the source will remain available at resolution.

## Validation status (2026-11-14)

The supplied Intear market-cap and JustHoot price recipes passed pinned-WASM lint and live-source simulation. Live testnet requests `req:4` (Intear) and `req:5` (JustHoot) each exhausted five attempts with `outlayer_execution_failed`. Both ended `Unresolvable`, with synthetic `tee: false` records, empty source evidence and no outcome. OutLayer logged an execution promise failure without resolver output, so the underlying cause is undetermined. **Successful live TEE retrieval from these providers has not yet been demonstrated.** Do not present the dry-run results as successful TEE validation. The private test record is `e2e/results/2026-11-14-near-token-generic-live.json`.

## Choose the question and source

The default is **one source: Intear OR JustHoot**, including price questions. A second source is optional. Identify the token by its full NEAR contract account ID, not its symbol.

Example: “Is HOOT's market capitalization in USD, as reported by Intear at the first valid observation after T, at least $2 million?” Include the exact token account, source, metric, USD unit, threshold/operator, observation time and maximum delay in the rules.

Use `first_fetch_after` with an explicit `max_delay` for these current-value endpoints. They do not prove that a threshold was ever reached before T. Retries may observe a later value inside the declared window. Do not claim an exact historical market cap or an intraday maximum from a current snapshot.

| Metric                    | Intear           | JustHoot                                                             |
| ------------------------- | ---------------- | -------------------------------------------------------------------- |
| USD price per whole token | `price_usd`      | `price_usd`                                                          |
| Market cap in USD         | `market_cap_usd` | `market_cap_usd`                                                     |
| FDV in USD                | `fdv_usd`        | Not available in the verified response; do not substitute market cap |

Already denominated USD values use decimal extraction without token-decimal scaling. `market_cap` is not interchangeable with `market_cap_usd`.

## Intear recipe

Reference: [HTTP API](https://docs.intear.tech/api/guides/http/), [token field definitions](https://docs.intear.tech/api/reference/token-fields/).

Request a fixed field list:

```text
https://api.intea.rs/tokens?ids=hoot-8ecf65.launchpad.justhoot.near&fields=price_usd,market_cap_usd,fdv_usd
```

The response is columnar: `columns`, `rows`, `total`, `missing`, `height`, and `timestamp_millis`. `account_id` is always the first column. For this request, pin all four expected column names and the returned token account ID before extracting the metric. Require exactly one token row. A positional path is justified here only by the documented column layout and those runtime assertions; set `extract.allow_index: true` and explain the layout in `extract.index_reason`.

With the field list above, price is `$.rows[0][1]`, market cap is `$.rows[0][2]`, and FDV is `$.rows[0][3]`. Changing the requested field order requires changing the assertions and path together. Use `expect.as_of: "$.timestamp_millis"` to check the indexed snapshot time against the observation window; this is not a guarantee of a recent trade.

Intear defines market cap using its circulating supply and FDV using its total supply. Its supply definitions account for known burns and, for circulating supply, known locked balances. These definitions belong in the source-specific rules. Intear reports zero valuation when it has no price: require a positive `price_usd` before using either price or valuation. Do not interpret missing pricing as a valid zero outcome.

## JustHoot recipe

Verified example endpoint:

```text
https://api.justhoot.fun/api/tokens/hoot-8ecf65.launchpad.justhoot.near
```

Assert `$.token.id` equals the intended token account. Extract `$.price_usd` or `$.market_cap_usd` as decimal, and require a positive price. Sample the requested token first: the verified HOOT response does not establish coverage of every NEAR token or launchpad.

The response includes `last_trade_at`, but this is the time of a trade, not a response valuation timestamp. Do not use it as `expect.as_of`. Declare snapshot semantics with `first_fetch_after` and `max_delay`. The verified response does not include FDV; use Intear for FDV questions.

## Optional two-source median

The agent may suggest `aggregate.method: "median"` when the creator wants both APIs. Get explicit agreement on the composite metric and show each sampled value first. For two successful numeric sources the resolver's median is their arithmetic mean. Its existing quorum allows one successful source out of two, so the result can use that single source when the other fails; disclose this and do not promise both are mandatory.

Do not average unlike metrics or silently switch between market cap and FDV. Market cap definitions can differ across providers. During a HOOT sample on 2026-11-14, Intear and JustHoot both reported about $1.04M market cap; numerical proximity alone does not establish equivalent supply methodology. Use a single named source when equivalence cannot be established. The default remains one source.

## Failure handling and validation

- Assert token identity and schema; missing, null, ambiguous or invalid values are source failures.
- Reject unknown-price zero rather than resolving it as a real zero. Allow normal market movements; do not add an arbitrary maximum change bound that invalidates a genuine memecoin rally.
- Use bounded retries and `on_unavailable: "void"` unless the creator explicitly chooses another policy.
- Show the sampled metric, source, identity, units, rules and simulated outcome before creating a sign link.
- Live source coverage and API availability must be checked per token. A source label is not a guarantee of accurate economics; TEE execution proves the fetch/decision path, not the truth of a provider's supply estimate.

The existing two-source lint requirement for dedicated price adapters is unchanged. These NEAR token recipes use `http_json` and permit a single source by default.
