use crate::{decimal, duration, get_str, parse_time, LintContext, LintError, LintReport};
use serde_json::Value;
use serde_json_path::JsonPath;
use std::collections::{BTreeMap, HashSet};
use url::Url;

fn issue(report: &mut LintReport, code: &str, path: impl Into<String>) {
    report.errors.push(LintError {
        code: code.into(),
        path: path.into(),
        message: code.replace('_', " "),
    });
}

pub fn lint(spec_json: &str) -> LintReport {
    lint_with_context(spec_json, &LintContext::default())
}

pub fn lint_with_context(spec_json: &str, context: &LintContext) -> LintReport {
    let mut report = LintReport {
        ok: false,
        errors: Vec::new(),
        labels: BTreeMap::new(),
    };
    let spec: Value = match serde_json::from_str(spec_json) {
        Ok(spec) => spec,
        Err(_) => {
            issue(&mut report, "spec_invalid", "$");
            return report;
        }
    };
    if spec.get("version").and_then(Value::as_u64) != Some(1) {
        issue(&mut report, "version_unsupported", "$.version");
    }
    let outcomes = spec.get("outcomes").and_then(Value::as_array);
    let valid_outcomes = outcomes.is_some_and(|list| {
        (2..=10).contains(&list.len())
            && list
                .iter()
                .all(|item| item.as_str().is_some_and(|s| !s.trim().is_empty()))
            && list.iter().collect::<HashSet<_>>().len() == list.len()
    });
    if !valid_outcomes {
        issue(&mut report, "outcomes_count", "$.outcomes");
    }
    let at_text = get_str(&spec, "/observation/at");
    let at = at_text.and_then(parse_time);
    if at.is_none_or(|value| {
        value.offset() != time::UtcOffset::UTC || !at_text.unwrap_or("").ends_with('Z')
    }) {
        issue(&mut report, "observation_invalid", "$.observation.at");
    }
    if let (Some(close), Some(at)) = (context.market_close, at) {
        if at < close {
            issue(&mut report, "observation_before_close", "$.observation.at");
        }
    }
    let max_delay = get_str(&spec, "/observation/max_delay").and_then(duration);
    if get_str(&spec, "/observation/max_delay").is_some() && max_delay.is_none() {
        issue(
            &mut report,
            "observation_invalid",
            "$.observation.max_delay",
        );
    }
    if !matches!(
        get_str(&spec, "/observation/mode"),
        Some("historical" | "first_fetch_after")
    ) {
        issue(&mut report, "observation_invalid", "$.observation.mode");
    }
    let sources = spec.get("sources").and_then(Value::as_array);
    let mut ids = HashSet::new();
    let mut price_count = 0;
    if let Some(sources) = sources {
        if sources.is_empty() {
            issue(&mut report, "source_params_invalid", "$.sources");
        }
        for (index, source) in sources.iter().enumerate() {
            let path = format!("$.sources[{index}]");
            let id = source.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() || !ids.insert(id) {
                issue(&mut report, "duplicate_source_id", format!("{path}.id"));
            }
            let tool = source.get("tool").and_then(Value::as_str).unwrap_or("");
            let url = match tool {
                "binance_kline" => {
                    price_count += 1;
                    Some("https://data-api.binance.vision".to_string())
                }
                "okx_candle" => {
                    price_count += 1;
                    Some("https://www.okx.com".to_string())
                }
                "coinbase_candle" => {
                    price_count += 1;
                    Some("https://api.exchange.coinbase.com".to_string())
                }
                "coingecko_price" => {
                    price_count += 1;
                    Some("https://api.coingecko.com".to_string())
                }
                "github_repo" => Some("https://api.github.com".to_string()),
                "near_view" => source
                    .pointer("/params/rpcs/0")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| Some("https://rpc.mainnet.near.org".into())),
                "http_json" => get_str(source, "/request/url")
                    .map(str::to_owned)
                    .or_else(|| get_str(source, "/params/request/url").map(str::to_owned)),
                "rss_feed" | "web_text" => get_str(source, "/params/url")
                    .or_else(|| source.get("url").and_then(Value::as_str))
                    .map(str::to_owned),
                _ => {
                    issue(&mut report, "unknown_tool", format!("{path}.tool"));
                    None
                }
            };
            report
                .labels
                .insert(id.into(), effective_label(url.as_deref()));
            let required: &[&str] = match tool {
                "binance_kline" => &["symbol"],
                "okx_candle" => &["instId"],
                "coinbase_candle" => &["product_id"],
                "coingecko_price" => &["id", "vs"],
                "near_view" => &["network", "contract", "method"],
                "github_repo" => &["owner", "repo", "field"],
                "rss_feed" | "web_text" => &["url"],
                _ => &[],
            };
            for key in required {
                let present = if *key == "url" {
                    get_str(source, "/params/url")
                        .or_else(|| source.get("url").and_then(Value::as_str))
                } else {
                    source
                        .get("params")
                        .and_then(|p| p.get(*key))
                        .and_then(Value::as_str)
                };
                if present.is_none_or(str::is_empty) {
                    issue(
                        &mut report,
                        "source_params_invalid",
                        format!("{path}.params.{key}"),
                    );
                }
            }
            if tool == "near_view" {
                if !matches!(
                    get_str(source, "/params/network"),
                    Some("mainnet" | "testnet")
                ) {
                    issue(
                        &mut report,
                        "source_params_invalid",
                        format!("{path}.params.network"),
                    );
                }
                if !source.pointer("/params/args").is_some_and(Value::is_object) {
                    issue(
                        &mut report,
                        "source_params_invalid",
                        format!("{path}.params.args"),
                    );
                }
                if let Some(rpcs) = source.pointer("/params/rpcs").and_then(Value::as_array) {
                    if rpcs.len() < 2 {
                        issue(
                            &mut report,
                            "source_params_invalid",
                            format!("{path}.params.rpcs"),
                        );
                    }
                }
            }
            if tool == "github_repo" && source.pointer("/expect/repo_id").is_none() {
                issue(
                    &mut report,
                    "identity_assert_required",
                    format!("{path}.expect.repo_id"),
                );
            }
            if tool == "http_json" {
                lint_http_json(&mut report, source, &path);
            }
            let snapshot = matches!(tool, "github_repo" | "web_text" | "coingecko_price")
                || tool == "http_json" && get_str(source, "/expect/as_of").is_none()
                || tool == "near_view"
                    && get_str(&spec, "/observation/mode") == Some("first_fetch_after");
            if snapshot && max_delay.is_none() {
                issue(&mut report, "max_delay_required", "$.observation.max_delay");
            }
        }
    } else {
        issue(&mut report, "source_params_invalid", "$.sources");
    }
    let kind = get_str(&spec, "/decide/kind").unwrap_or("");
    if matches!(kind, "threshold" | "buckets" | "change") && price_count == 1 {
        issue(&mut report, "price_needs_two_sources", "$.sources");
    }
    lint_decide(&mut report, &spec, outcomes);
    lint_aggregate(&mut report, &spec);
    if get_str(&spec, "/on_unavailable").is_none_or(|s| {
        s != "void" && !outcomes.is_some_and(|items| items.iter().any(|v| v.as_str() == Some(s)))
    }) {
        issue(&mut report, "on_unavailable_invalid", "$.on_unavailable");
    }
    let attempts = spec.pointer("/retry/max_attempts").and_then(Value::as_u64);
    let every = get_str(&spec, "/retry/every").and_then(duration);
    if attempts.is_none_or(|v| !(1..=10).contains(&v)) || every.is_none() {
        issue(&mut report, "retry_invalid", "$.retry");
    }
    report.ok = report.errors.is_empty();
    report
}

fn lint_http_json(report: &mut LintReport, source: &Value, path: &str) {
    let request = source
        .get("request")
        .or_else(|| source.pointer("/params/request"));
    let method = request
        .and_then(|r| r.get("method"))
        .and_then(Value::as_str)
        .unwrap_or("GET");
    let url = request.and_then(|r| r.get("url")).and_then(Value::as_str);
    if !matches!(method, "GET" | "POST") || url.is_none() {
        issue(report, "source_params_invalid", format!("{path}.request"));
    }
    let assertions = source.pointer("/expect/assert").and_then(Value::as_array);
    if get_str(source, "/identity")
        .is_some_and(|identity| !matches!(identity, "asserted" | "url_only"))
    {
        issue(report, "source_params_invalid", format!("{path}.identity"));
    }
    if assertions.is_none_or(Vec::is_empty) && get_str(source, "/identity") != Some("url_only") {
        issue(
            report,
            "identity_assert_required",
            format!("{path}.expect.assert"),
        );
    }
    if let Some(assertions) = assertions {
        for assertion in assertions {
            if assertion.as_str().is_none_or(|s| !valid_assertion(s)) {
                issue(
                    report,
                    "source_params_invalid",
                    format!("{path}.expect.assert"),
                );
            }
        }
    }
    let extract = source.get("extract").unwrap_or(&Value::Null);
    let extract_path = extract.get("path").and_then(Value::as_str);
    if extract_path.is_none() {
        issue(
            report,
            "source_params_invalid",
            format!("{path}.extract.path"),
        );
    }
    for (key, path_value) in [
        ("extract.path", extract_path),
        ("expect.as_of", get_str(source, "/expect/as_of")),
    ] {
        if let Some(query) = path_value {
            if JsonPath::parse(query).is_err() {
                issue(report, "jsonpath_invalid", format!("{path}.{key}"));
            }
            let positional = positional_jsonpath(query);
            if positional
                && !(get_str(source, "/extract/index_reason").is_some_and(|s| !s.trim().is_empty())
                    && extract.get("allow_index").and_then(Value::as_bool) == Some(true))
            {
                issue(
                    report,
                    "positional_index_forbidden",
                    format!("{path}.{key}"),
                );
            }
        }
    }
    if !matches!(
        extract.get("type").and_then(Value::as_str),
        Some("int" | "decimal" | "bool" | "string" | "timestamp")
    ) {
        issue(
            report,
            "source_params_invalid",
            format!("{path}.extract.type"),
        );
    }
    if extract
        .get("decimals")
        .is_some_and(|v| v.as_u64().is_none_or(|n| n > 28))
    {
        issue(
            report,
            "decimal_invalid",
            format!("{path}.extract.decimals"),
        );
    }
    for key in ["min", "max"] {
        if let Some(value) = source.pointer(&format!("/sanity/{key}")) {
            if decimal(value).is_none() {
                issue(report, "decimal_invalid", format!("{path}.sanity.{key}"));
            }
        }
    }
    if let Some(value) = get_str(source, "/sanity/max_change_vs_preflight") {
        if value
            .strip_suffix('x')
            .and_then(|ratio| ratio.parse::<rust_decimal::Decimal>().ok())
            .is_none_or(|ratio| ratio <= rust_decimal::Decimal::ZERO)
        {
            issue(
                report,
                "decimal_invalid",
                format!("{path}.sanity.max_change_vs_preflight"),
            );
        }
    }
}

fn positional_jsonpath(query: &str) -> bool {
    let mut bracket = String::new();
    let mut depth = 0_u8;
    let mut quote = None;
    for character in query.chars() {
        if depth == 0 {
            if character == '[' {
                depth = 1;
                bracket.clear();
            }
            continue;
        }
        match quote {
            Some(current) if character == current => quote = None,
            // Colons inside a quoted filter literal are not array slices.
            Some(_) => {}
            None if matches!(character, '\'' | '"') => quote = Some(character),
            None if character == '[' => {
                depth = depth.saturating_add(1);
                bracket.push(character);
            }
            None if character == ']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let content = bracket.trim();
                    if content.contains(':')
                        || content.parse::<i64>().is_ok()
                        || content
                            .strip_prefix('-')
                            .is_some_and(|rest| rest.parse::<i64>().is_ok())
                    {
                        return true;
                    }
                } else {
                    bracket.push(character);
                }
            }
            None => bracket.push(character),
        }
    }
    false
}

fn valid_assertion(text: &str) -> bool {
    text.starts_with('$')
        && (text.ends_with(" exists")
            || [" == ", " != ", " >= ", " <= ", " > ", " < "]
                .iter()
                .any(|op| text.contains(op)))
}

fn lint_decide(report: &mut LintReport, spec: &Value, outcomes: Option<&Vec<Value>>) {
    let kind = get_str(spec, "/decide/kind").unwrap_or("");
    let decide = &spec["decide"];
    let keys: Vec<String> = match kind {
        "threshold" => {
            if !matches!(get_str(spec, "/decide/op"), Some(">=" | ">" | "<=" | "<"))
                || decimal(&decide["value"]).is_none()
            {
                issue(report, "decide_invalid", "$.decide");
            }
            if decimal(&decide["value"]).is_none() {
                issue(report, "decimal_invalid", "$.decide.value");
            }
            vec!["true".into(), "false".into()]
        }
        "buckets" => {
            let edges = decide["edges"].as_array();
            let parsed: Vec<_> = edges.into_iter().flatten().filter_map(decimal).collect();
            if parsed.is_empty()
                || edges.is_none_or(|e| e.len() != parsed.len())
                || parsed
                    .windows(2)
                    .any(|pair| matches!(pair, [left, right] if left >= right))
                || get_str(spec, "/decide/inclusive") != Some("lower")
            {
                issue(report, "buckets_invalid", "$.decide");
            }
            (0..=parsed.len()).map(|i| i.to_string()).collect()
        }
        "equals" => {
            if decide.get("value").is_none() {
                issue(report, "decide_invalid", "$.decide.value");
            }
            vec!["true".into(), "false".into()]
        }
        "bool" => vec!["true".into(), "false".into()],
        "change" => {
            let at = get_str(spec, "/observation/at").and_then(parse_time);
            let baseline = get_str(spec, "/observation/baseline_at").and_then(parse_time);
            if baseline.is_none() || at.is_none() || baseline >= at {
                issue(report, "change_needs_baseline", "$.observation.baseline_at");
            }
            if get_str(spec, "/decide/tie").is_none() {
                issue(report, "decide_invalid", "$.decide.tie");
            }
            vec!["up".into(), "down".into(), "tie".into()]
        }
        "text_judge" => {
            let from = get_str(spec, "/decide/window/from").and_then(parse_time);
            let to = get_str(spec, "/decide/window/to").and_then(parse_time);
            let yes = decide["yes_criteria"].as_array();
            if get_str(spec, "/decide/question").is_none_or(str::is_empty)
                || yes.is_none_or(Vec::is_empty)
                || from.is_none()
                || to.is_none()
                || from >= to
                || !matches!(
                    get_str(spec, "/decide/default_if_no_evidence"),
                    Some("yes" | "no")
                )
            {
                issue(report, "text_judge_invalid", "$.decide");
            }
            if spec["sources"].as_array().is_some_and(|sources| {
                sources.iter().any(|s| {
                    !matches!(
                        s["tool"].as_str(),
                        Some("rss_feed" | "web_text" | "http_json")
                    ) || s["tool"] == "http_json" && get_str(s, "/extract/type") != Some("string")
                })
            }) {
                issue(report, "text_judge_invalid", "$.sources");
            }
            vec!["yes".into(), "no".into()]
        }
        _ => {
            issue(report, "decide_invalid", "$.decide.kind");
            Vec::new()
        }
    };
    let map = spec["outcome_map"].as_object();
    for key in keys {
        if map.and_then(|m| m.get(&key)).is_none() {
            issue(
                report,
                "outcome_map_incomplete",
                format!("$.outcome_map.{key}"),
            );
        }
    }
    if let Some(map) = map {
        for (key, value) in map {
            if !outcomes.is_some_and(|items| items.contains(value)) {
                issue(
                    report,
                    "outcome_map_unknown_outcome",
                    format!("$.outcome_map.{key}"),
                );
            }
        }
        if kind == "change"
            && map.get("tie").and_then(Value::as_str) != get_str(spec, "/decide/tie")
        {
            issue(report, "decide_invalid", "$.decide.tie");
        }
    }
}

fn lint_aggregate(report: &mut LintReport, spec: &Value) {
    let method = get_str(spec, "/aggregate/method");
    if !matches!(
        method,
        Some("primary_then_fallback" | "median" | "all_agree")
    ) {
        issue(report, "aggregate_invalid", "$.aggregate.method");
    }
    if let Some(tolerance) = get_str(spec, "/aggregate/tolerance") {
        let value = tolerance.strip_suffix('%').unwrap_or(tolerance);
        if value.parse::<rust_decimal::Decimal>().is_err() {
            issue(report, "decimal_invalid", "$.aggregate.tolerance");
        }
    } else if method == Some("all_agree") {
        issue(report, "aggregate_invalid", "$.aggregate.tolerance");
    }
}

pub fn effective_label(url: Option<&str>) -> String {
    let host = url
        .and_then(|s| Url::parse(s).ok())
        .and_then(|u| u.host_str().map(str::to_owned));
    let verified = matches!(
        host.as_deref(),
        Some(
            "api.binance.com"
                | "data-api.binance.vision"
                | "www.okx.com"
                | "okx.com"
                | "api.exchange.coinbase.com"
                | "api.coinbase.com"
                | "api.coingecko.com"
                | "api.github.com"
                | "rpc.mainnet.near.org"
                | "rpc.testnet.near.org"
                | "archival-rpc.mainnet.near.org"
                | "archival-rpc.testnet.near.org"
                | "free.rpc.fastnear.com"
                | "rpc.mainnet.fastnear.com"
                | "test.rpc.fastnear.com"
                | "near-testnet.lava.build"
                | "near.lava.build"
        )
    );
    if verified {
        "verified"
    } else {
        "self_declared"
    }
    .into()
}
