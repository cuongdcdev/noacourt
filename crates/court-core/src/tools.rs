use crate::{
    call_timeout, decimal, duration, evidence_hash, format_time, get_str, parse_time, Deps,
    EvidenceItem, HttpError, HttpRequest, HttpResponse, SourceResult, TypedValue,
};
use quick_xml::events::Event;
use quick_xml::Reader;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use serde_json_path::JsonPath;
use std::collections::BTreeMap;
use std::time::Duration as StdDuration;
use time::{format_description::well_known::Rfc2822, Duration, OffsetDateTime};

const JSON_CAP: usize = 2 * 1024 * 1024;
const TEXT_CAP: usize = 1024 * 1024;

fn request(
    deps: &Deps<'_>,
    method: &str,
    url: &str,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
    cap: usize,
) -> Result<HttpResponse, String> {
    let timeout = call_timeout(deps.budget, StdDuration::from_secs(20))
        .ok_or_else(|| "budget_exhausted".to_string())?;
    let insecure = deps.env.get("COURT_ALLOW_INSECURE_LOCALHOST").as_deref() == Some("1")
        && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"));
    if !url.starts_with("https://") && !insecure {
        return Err("transport".into());
    }
    let req = HttpRequest {
        method: method.into(),
        url: url.into(),
        headers,
        body,
        timeout_ms: timeout.as_millis().max(1).min(u64::MAX as u128) as u64,
    };
    let response = deps.http.request(&req).map_err(|e| match e {
        HttpError::Timeout => "http_timeout",
        HttpError::TooLarge => "too_large",
        HttpError::Transport(_) => "transport",
    })?;
    if response.body.len() > cap {
        return Err("too_large".into());
    }
    if response.status == 451 || response.status == 403 && url.contains("binance") {
        return Err("geo_blocked".into());
    }
    if response.status >= 500 {
        return Err("http_5xx".into());
    }
    if response.status >= 400 {
        return Err("http_4xx".into());
    }
    Ok(response)
}

fn json_response(response: &HttpResponse) -> Result<Value, String> {
    serde_json::from_slice(&response.body).map_err(|_| "not_json".into())
}

fn success(
    id: &str,
    value: Option<TypedValue>,
    at: Option<OffsetDateTime>,
    url: String,
    body: &[u8],
) -> SourceResult {
    SourceResult {
        id: id.into(),
        ok: true,
        // Keep Verdict v1 bounded even when a text extraction is used as evidence.
        // The full text stays only in the in-memory evidence item passed to jurors.
        value: value
            .as_ref()
            .map(TypedValue::display)
            .map(|value| value.chars().take(1_024).collect()),
        as_of: at.map(format_time),
        url: Some(url),
        evidence_sha256: Some(evidence_hash(body)),
        error: None,
        typed: value,
        items: Vec::new(),
    }
}

type FetchOutput = (
    Option<TypedValue>,
    Option<OffsetDateTime>,
    Vec<u8>,
    Vec<EvidenceItem>,
);

fn result(id: &str, url: String, answer: Result<FetchOutput, String>) -> SourceResult {
    match answer {
        Ok((value, at, body, items)) => {
            let mut source = success(id, value, at, url, &body);
            source.items = items;
            source
        }
        Err(error) => SourceResult::error(id, &error, Some(url)),
    }
}

fn field<'a>(source: &'a Value, key: &str) -> Option<&'a str> {
    source.get("params")?.get(key)?.as_str()
}

fn query_one<'a>(root: &'a Value, path: &str) -> Result<&'a Value, String> {
    let query = JsonPath::parse(path).map_err(|_| "jsonpath_invalid")?;
    let nodes = query.query(root).all();
    match nodes.len() {
        0 => Err("extract_missing".into()),
        1 => nodes
            .first()
            .copied()
            .ok_or_else(|| "extract_missing".into()),
        _ => Err("extract_not_unique".into()),
    }
}

fn parse_as_of(value: &Value) -> Option<OffsetDateTime> {
    if let Some(text) = value.as_str() {
        return parse_time(text);
    }
    let n = value.as_i64().or_else(|| value.to_string().parse().ok())?;
    let seconds = if n.unsigned_abs() > 100_000_000_000 {
        n / 1000
    } else {
        n
    };
    OffsetDateTime::from_unix_timestamp(seconds).ok()
}

fn typed(value: &Value, kind: &str, decimals: u32) -> Result<TypedValue, String> {
    match kind {
        "int" | "decimal" => {
            if decimals > 28 {
                return Err("decimal_invalid".into());
            }
            let raw = decimal(value).ok_or("type_mismatch")?;
            if kind == "int" && !raw.fract().is_zero() {
                return Err("type_mismatch".into());
            }
            let power = 10_i128.checked_pow(decimals).ok_or("decimal_invalid")?;
            let scale =
                Decimal::try_from_i128_with_scale(power, 0).map_err(|_| "decimal_invalid")?;
            raw.checked_div(scale)
                .map(TypedValue::Decimal)
                .ok_or_else(|| "decimal_invalid".into())
        }
        "bool" => value
            .as_bool()
            .map(TypedValue::Bool)
            .ok_or_else(|| "type_mismatch".into()),
        "string" => value
            .as_str()
            .map(|s| TypedValue::String(s.into()))
            .ok_or_else(|| "type_mismatch".into()),
        "timestamp" => parse_as_of(value)
            .map(|t| TypedValue::String(format_time(t)))
            .ok_or_else(|| "type_mismatch".into()),
        _ => Err("type_mismatch".into()),
    }
}

fn template(input: &str, at: OffsetDateTime) -> String {
    let date = format!("{:04}-{:02}-{:02}", at.year(), at.month() as u8, at.day());
    input
        .replace("{T:YYYY-MM-DD}", &date)
        .replace("{T:YYYYMMDD}", &date.replace('-', ""))
        .replace(
            "{T:unix_ms}",
            &(at.unix_timestamp_nanos() / 1_000_000).to_string(),
        )
        .replace("{T:unix}", &at.unix_timestamp().to_string())
        .replace("{T:iso}", &format_time(at))
}

fn assertion(root: &Value, expression: &str) -> bool {
    if let Some(path) = expression.strip_suffix(" exists") {
        return query_one(root, path).is_ok();
    }
    for operator in [" == ", " != ", " >= ", " <= ", " > ", " < "] {
        if let Some((path, literal)) = expression.split_once(operator) {
            let Ok(actual) = query_one(root, path) else {
                return false;
            };
            let expected: Value = if let Some(quoted) = literal
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
            {
                Value::String(quoted.into())
            } else {
                match serde_json::from_str(literal) {
                    Ok(value) => value,
                    Err(_) => return false,
                }
            };
            if let (Some(left), Some(right)) = (decimal(actual), decimal(&expected)) {
                return match operator.trim() {
                    "==" => left == right,
                    "!=" => left != right,
                    ">=" => left >= right,
                    "<=" => left <= right,
                    ">" => left > right,
                    "<" => left < right,
                    _ => false,
                };
            }
            return match operator.trim() {
                "==" => actual == &expected,
                "!=" => actual != &expected,
                _ => false,
            };
        }
    }
    false
}

pub fn fetch(
    source: &Value,
    at: OffsetDateTime,
    now: OffsetDateTime,
    simulate: bool,
    max_delay: Option<Duration>,
    deps: &Deps<'_>,
) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    if call_timeout(deps.budget, StdDuration::from_secs(20)).is_none() {
        return SourceResult::error(id, "budget_exhausted", None);
    }
    let tool = source["tool"].as_str().unwrap_or("");
    let target = if simulate { now } else { at };
    let snapshot = matches!(tool, "github_repo" | "web_text" | "coingecko_price")
        || tool == "http_json" && get_str(source, "/expect/as_of").is_none()
        || tool == "near_view" && source.pointer("/params/block_id").is_none();
    if !simulate
        && snapshot
        && max_delay.is_some_and(|delay| at.checked_add(delay).is_none_or(|end| now > end))
    {
        return SourceResult::error(id, "stale", None);
    }
    match tool {
        "binance_kline" => candle_binance(source, target, now, simulate, deps),
        "okx_candle" => candle_okx(source, target, now, simulate, deps),
        "coinbase_candle" => candle_coinbase(source, target, now, simulate, deps),
        "coingecko_price" => coingecko(source, target, simulate, deps),
        "near_view" => near_view(source, now, deps),
        "github_repo" => github(source, target, deps),
        "http_json" => http_json(source, target, at, now, simulate, max_delay, deps),
        "rss_feed" => feed(source, target, deps),
        "web_text" => web_text(source, now, deps),
        _ => SourceResult::error(id, "unknown_tool", None),
    }
}

fn interval_ms(interval: &str) -> Option<i64> {
    let secs = duration(interval)?.whole_seconds();
    secs.checked_mul(1_000)
}

fn candle_binance(
    source: &Value,
    at: OffsetDateTime,
    now: OffsetDateTime,
    simulate: bool,
    deps: &Deps<'_>,
) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let symbol = field(source, "symbol").unwrap_or("");
    let interval = field(source, "interval").unwrap_or("1m");
    let Some(width) = interval_ms(interval) else {
        return SourceResult::error(id, "source_params_invalid", None);
    };
    let ms = at.unix_timestamp_nanos() / 1_000_000;
    let now_ms = now.unix_timestamp_nanos() / 1_000_000;
    let query = if simulate {
        format!("symbol={symbol}&interval={interval}&limit=3")
    } else {
        format!(
            "symbol={symbol}&interval={interval}&startTime={}&endTime={}&limit=3",
            ms - width as i128,
            ms + width as i128
        )
    };
    let mut url = format!("https://data-api.binance.vision/api/v3/klines?{query}");
    let mut response = request(deps, "GET", &url, BTreeMap::new(), Vec::new(), JSON_CAP);
    if matches!(response, Err(ref e) if matches!(e.as_str(), "transport" | "http_timeout" | "http_5xx" | "geo_blocked"))
    {
        url = format!("https://api.binance.com/api/v3/klines?{query}");
        response = request(deps, "GET", &url, BTreeMap::new(), Vec::new(), JSON_CAP);
    }
    result(
        id,
        url,
        response.and_then(|response| {
            let root = json_response(&response)?;
            let rows = root.as_array().ok_or("not_json")?;
            let row = rows
                .iter()
                .filter(|row| {
                    let open = row.get(0).and_then(Value::as_i64).map(i128::from);
                    let close = row.get(6).and_then(Value::as_i64).map(i128::from);
                    match (open, close) {
                        (Some(open), Some(close)) if simulate => {
                            close < now_ms && open + i128::from(width) <= now_ms
                        }
                        (Some(open), Some(close)) => open <= ms && ms <= close,
                        _ => false,
                    }
                })
                .max_by_key(|row| row.get(0).and_then(Value::as_i64))
                .ok_or("candle_not_found")?;
            let open = row.get(0).and_then(Value::as_i64).ok_or("not_json")?;
            let close = row.get(6).and_then(Value::as_i64).ok_or("not_json")?;
            if !simulate
                && (i128::from(close) >= now_ms || i128::from(open) + i128::from(width) > now_ms)
            {
                return Err("candle_not_closed".into());
            }
            let field_index = if field(source, "field") == Some("open") {
                1
            } else {
                4
            };
            let value = typed(row.get(field_index).ok_or("type_mismatch")?, "decimal", 0)?;
            let as_of = OffsetDateTime::from_unix_timestamp(open / 1000).ok();
            Ok((Some(value), as_of, response.body, Vec::new()))
        }),
    )
}

fn candle_okx(
    source: &Value,
    at: OffsetDateTime,
    now: OffsetDateTime,
    simulate: bool,
    deps: &Deps<'_>,
) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let inst = field(source, "instId").unwrap_or("");
    let bar = field(source, "bar").unwrap_or("1m");
    let Some(width) = interval_ms(bar) else {
        return SourceResult::error(id, "source_params_invalid", None);
    };
    let ms = at.unix_timestamp_nanos() / 1_000_000;
    let now_ms = now.unix_timestamp_nanos() / 1_000_000;
    let endpoint = if simulate {
        "candles"
    } else {
        "history-candles"
    };
    let mut url =
        format!("https://www.okx.com/api/v5/market/{endpoint}?instId={inst}&bar={bar}&limit=100");
    if !simulate {
        url.push_str(&format!(
            "&after={}&before={}",
            ms + i128::from(width),
            ms - i128::from(width)
        ));
    }
    result(
        id,
        url.clone(),
        request(deps, "GET", &url, BTreeMap::new(), Vec::new(), JSON_CAP).and_then(|response| {
            let root = json_response(&response)?;
            if root["code"] != "0" {
                return Err("transport".into());
            }
            let rows = root["data"].as_array().ok_or("not_json")?;
            let row = rows
                .iter()
                .filter(|row| {
                    let open = row
                        .get(0)
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<i64>().ok())
                        .map(i128::from);
                    let Some(open) = open else { return false };
                    let end = open + i128::from(width);
                    let confirmed = row.get(8).and_then(Value::as_str) == Some("1");
                    if simulate {
                        confirmed && end <= now_ms
                    } else {
                        open <= ms && ms < end
                    }
                })
                .max_by_key(|row| {
                    row.get(0)
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<i64>().ok())
                })
                .ok_or("candle_not_found")?;
            let open = row
                .get(0)
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or("not_json")?;
            if !simulate
                && (row.get(8).and_then(Value::as_str) != Some("1")
                    || i128::from(open) + i128::from(width) > now_ms)
            {
                return Err("candle_not_closed".into());
            }
            let field_index = if field(source, "field") == Some("open") {
                1
            } else {
                4
            };
            let value = typed(row.get(field_index).ok_or("type_mismatch")?, "decimal", 0)?;
            Ok((
                Some(value),
                OffsetDateTime::from_unix_timestamp(open / 1000).ok(),
                response.body,
                Vec::new(),
            ))
        }),
    )
}

fn candle_coinbase(
    source: &Value,
    at: OffsetDateTime,
    now: OffsetDateTime,
    simulate: bool,
    deps: &Deps<'_>,
) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let product = field(source, "product_id").unwrap_or("");
    let granularity = source
        .pointer("/params/granularity")
        .and_then(Value::as_i64)
        .unwrap_or(60);
    if granularity <= 0 {
        return SourceResult::error(id, "source_params_invalid", None);
    }
    let sec = at.unix_timestamp();
    let now_sec = now.unix_timestamp();
    let mut url = format!(
        "https://api.exchange.coinbase.com/products/{product}/candles?granularity={granularity}"
    );
    if !simulate {
        url.push_str(&format!(
            "&start={}&end={}",
            i128::from(sec) - i128::from(granularity),
            i128::from(sec) + i128::from(granularity)
        ));
    }
    result(
        id,
        url.clone(),
        request(deps, "GET", &url, BTreeMap::new(), Vec::new(), JSON_CAP).and_then(|response| {
            let root = json_response(&response)?;
            let rows = root.as_array().ok_or("not_json")?;
            let row = rows
                .iter()
                .filter(|row| {
                    let Some(open) = row.get(0).and_then(Value::as_i64) else {
                        return false;
                    };
                    let Some(end) = open.checked_add(granularity) else {
                        return false;
                    };
                    if simulate {
                        end <= now_sec
                    } else {
                        open <= sec && sec < end
                    }
                })
                .max_by_key(|row| row.get(0).and_then(Value::as_i64))
                .ok_or("candle_not_found")?;
            let open = row.get(0).and_then(Value::as_i64).ok_or("not_json")?;
            if !simulate
                && open
                    .checked_add(granularity)
                    .is_none_or(|end| end > now_sec)
            {
                return Err("candle_not_closed".into());
            }
            let field_index = if field(source, "field") == Some("open") {
                3
            } else {
                4
            };
            let value = typed(row.get(field_index).ok_or("type_mismatch")?, "decimal", 0)?;
            Ok((
                Some(value),
                OffsetDateTime::from_unix_timestamp(open).ok(),
                response.body,
                Vec::new(),
            ))
        }),
    )
}

fn coingecko(source: &Value, at: OffsetDateTime, simulate: bool, deps: &Deps<'_>) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let coin = field(source, "id").unwrap_or("");
    let vs = field(source, "vs").unwrap_or("");
    let url = if simulate {
        format!("https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies={vs}")
    } else {
        format!(
            "https://api.coingecko.com/api/v3/coins/{coin}/history?date={:02}-{:02}-{:04}",
            at.day(),
            at.month() as u8,
            at.year()
        )
    };
    result(
        id,
        url.clone(),
        request(deps, "GET", &url, BTreeMap::new(), Vec::new(), JSON_CAP).and_then(|response| {
            let root = json_response(&response)?;
            let value = if simulate {
                &root[coin][vs]
            } else {
                &root["market_data"]["current_price"][vs]
            };
            let value = typed(value, "decimal", 0)?;
            Ok((Some(value), Some(at), response.body, Vec::new()))
        }),
    )
}

fn github(source: &Value, at: OffsetDateTime, deps: &Deps<'_>) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let owner = field(source, "owner").unwrap_or("");
    let repo = field(source, "repo").unwrap_or("");
    let name = field(source, "field").unwrap_or("");
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let mut headers = BTreeMap::new();
    headers.insert("Accept".into(), "application/vnd.github+json".into());
    if let Some(token) = deps.env.get("GITHUB_TOKEN") {
        headers.insert("Authorization".into(), format!("Bearer {token}"));
    }
    result(
        id,
        url.clone(),
        request(deps, "GET", &url, headers, Vec::new(), JSON_CAP).and_then(|response| {
            let root = json_response(&response)?;
            if root["id"] != source["expect"]["repo_id"] {
                return Err("assert_failed".into());
            }
            let value = &root[name];
            let kind = if value.is_boolean() {
                "bool"
            } else if value.is_string() {
                "string"
            } else {
                "decimal"
            };
            Ok((
                Some(typed(value, kind, 0)?),
                Some(at),
                response.body,
                Vec::new(),
            ))
        }),
    )
}

pub fn http_json(
    source: &Value,
    target: OffsetDateTime,
    at: OffsetDateTime,
    now: OffsetDateTime,
    simulate: bool,
    max_delay: Option<Duration>,
    deps: &Deps<'_>,
) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let req = source
        .get("request")
        .or_else(|| source.pointer("/params/request"))
        .unwrap_or(&Value::Null);
    let url = template(req["url"].as_str().unwrap_or(""), target);
    let mut headers = BTreeMap::new();
    if let Some(values) = req["headers"].as_object() {
        for (key, value) in values {
            if let Some(value) = value.as_str() {
                headers.insert(key.clone(), template(value, target));
            }
        }
    }
    if let Some(secret_name) = req["auth"]["secret"].as_str() {
        let Some(secret) = deps.env.get(secret_name) else {
            return SourceResult::error(id, "secret_missing", Some(url));
        };
        let name = req["auth"]["header"].as_str().unwrap_or("Authorization");
        let prefix = req["auth"]["prefix"].as_str().unwrap_or("");
        headers.insert(name.into(), format!("{prefix}{secret}"));
    }
    let method = req["method"].as_str().unwrap_or("GET");
    let body = match &req["body"] {
        Value::Null => Vec::new(),
        Value::String(value) => template(value, target).into_bytes(),
        value => template(&value.to_string(), target).into_bytes(),
    };
    let mut output = result(
        id,
        url.clone(),
        request(deps, method, &url, headers, body, JSON_CAP).and_then(|response| {
            let expected_status = source["expect"]["status"].as_u64().unwrap_or(200) as u16;
            if response.status != expected_status {
                return Err("assert_failed".into());
            }
            let root = json_response(&response)?;
            if source["expect"]["assert"].as_array().is_some_and(|values| {
                values
                    .iter()
                    .any(|v| !v.as_str().is_some_and(|s| assertion(&root, s)))
            }) {
                return Err("assert_failed".into());
            }
            let as_of = if let Some(path) = get_str(source, "/expect/as_of") {
                let node = query_one(&root, path).map_err(|_| "as_of_missing")?;
                let parsed = parse_as_of(node).ok_or("as_of_missing")?;
                if !simulate
                    && (parsed < at
                        || max_delay.is_some_and(|delay| {
                            at.checked_add(delay).is_none_or(|end| parsed > end)
                        }))
                {
                    return Err("stale".into());
                }
                Some(parsed)
            } else {
                Some(now)
            };
            let path = get_str(source, "/extract/path").ok_or("extract_missing")?;
            let node = query_one(&root, path)?;
            let kind = get_str(source, "/extract/type").unwrap_or("");
            let raw_decimals = source["extract"]["decimals"].as_u64().unwrap_or(0);
            let decimals = u32::try_from(raw_decimals).map_err(|_| "decimal_invalid")?;
            let value = typed(node, kind, decimals)?;
            if let TypedValue::Decimal(number) = &value {
                if decimal(&source["sanity"]["min"]).is_some_and(|min| *number < min) {
                    return Err("sanity_failed".into());
                }
                if decimal(&source["sanity"]["max"]).is_some_and(|max| *number > max) {
                    return Err("sanity_failed".into());
                }
                if let Some(limit) = get_str(source, "/sanity/max_change_vs_preflight")
                    .and_then(|s| s.strip_suffix('x'))
                    .and_then(|s| s.parse::<Decimal>().ok())
                {
                    if let Some(previous) = decimal(&source["sanity"]["preflight_value"]) {
                        if previous.is_zero()
                            || limit <= Decimal::ZERO
                            || previous.checked_mul(limit).is_none_or(|max| *number > max)
                            || previous.checked_div(limit).is_none_or(|min| *number < min)
                        {
                            return Err("sanity_failed".into());
                        }
                    }
                }
            }
            let items = if kind == "string" {
                vec![EvidenceItem {
                    reference: format!("{id}:0"),
                    date: as_of.unwrap_or(target),
                    text: value.display(),
                }]
            } else {
                Vec::new()
            };
            Ok((Some(value), as_of, response.body, items))
        }),
    );
    if output.ok && output.as_of.is_none() {
        output.as_of = Some(format_time(target));
    }
    output
}

fn default_rpcs(network: &str) -> Vec<String> {
    let names = if network == "testnet" {
        [
            "https://test.rpc.fastnear.com",
            "https://rpc.testnet.near.org",
            "https://archival-rpc.testnet.near.org",
            "https://near-testnet.lava.build",
        ]
    } else {
        [
            "https://free.rpc.fastnear.com",
            "https://rpc.mainnet.near.org",
            "https://archival-rpc.mainnet.near.org",
            "https://near.lava.build",
        ]
    };
    names.into_iter().map(str::to_owned).collect()
}

fn near_view(source: &Value, at: OffsetDateTime, deps: &Deps<'_>) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let params = &source["params"];
    let rpcs: Vec<String> = params["rpcs"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| default_rpcs(params["network"].as_str().unwrap_or("mainnet")));
    let args = serde_json::to_vec(&params["args"]).unwrap_or_default();
    let mut query = json!({
        "request_type": "call_function",
        "account_id": params["contract"],
        "method_name": params["method"],
        "args_base64": base64_encode(&args),
        "finality": "final",
    });
    if let Some(block) = params.get("block_id") {
        if let Some(object) = query.as_object_mut() {
            object.remove("finality");
        }
        query["block_id"] = block.clone();
    }
    let body = json!({"jsonrpc":"2.0","id":"court","method":"query","params":query})
        .to_string()
        .into_bytes();
    let mut answers: Vec<(TypedValue, Vec<u8>, String)> = Vec::new();
    for url in &rpcs {
        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".into(), "application/json".into());
        for _ in 0..3 {
            let response = request(deps, "POST", url, headers.clone(), body.clone(), JSON_CAP);
            let response = match response {
                Ok(response) => response,
                Err(error) if error == "budget_exhausted" => {
                    return SourceResult::error(id, "budget_exhausted", Some(url.clone()));
                }
                Err(_) => continue,
            };
            let Ok(root) = json_response(&response) else {
                continue;
            };
            let Some(bytes) = root.pointer("/result/result").and_then(Value::as_array) else {
                continue;
            };
            let raw: Result<Vec<u8>, _> = bytes
                .iter()
                .filter_map(Value::as_u64)
                .map(u8::try_from)
                .collect();
            let Ok(raw) = raw else { continue };
            if raw.len() != bytes.len() {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
                continue;
            };
            let selected = if let Some(path) = get_str(source, "/extract/path") {
                let Ok(value) = query_one(&value, path) else {
                    continue;
                };
                value
            } else {
                &value
            };
            let kind = get_str(source, "/extract/type").unwrap_or(if selected.is_boolean() {
                "bool"
            } else if selected.is_string() {
                "string"
            } else {
                "decimal"
            });
            let Ok(decimals) = u32::try_from(source["extract"]["decimals"].as_u64().unwrap_or(0))
            else {
                continue;
            };
            let Ok(value) = typed(selected, kind, decimals) else {
                continue;
            };
            answers.push((value, response.body, url.clone()));
            break;
        }
    }
    if answers.len() < 2 {
        return SourceResult::error(id, "transport", rpcs.first().cloned());
    }
    let Some(first) = answers.first() else {
        return SourceResult::error(id, "transport", rpcs.first().cloned());
    };
    if answers.iter().any(|answer| answer.0 != first.0) {
        return SourceResult::error(id, "rpc_disagree", rpcs.first().cloned());
    }
    let Some((value, body, url)) = answers.into_iter().next() else {
        return SourceResult::error(id, "transport", rpcs.first().cloned());
    };
    success(id, Some(value), Some(at), url, &body)
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in bytes.chunks(3) {
        let Some(first) = chunk.first() else { continue };
        let n = ((*first as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        result.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        result.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        result.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    result
}

fn feed(source: &Value, at: OffsetDateTime, deps: &Deps<'_>) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let url = field(source, "url")
        .or_else(|| source["url"].as_str())
        .unwrap_or("")
        .to_string();
    result(
        id,
        url.clone(),
        request(deps, "GET", &url, BTreeMap::new(), Vec::new(), TEXT_CAP).and_then(|response| {
            let mut reader = Reader::from_reader(response.body.as_slice());
            reader.config_mut().trim_text(true);
            let mut items = Vec::new();
            let mut current = BTreeMap::<String, String>::new();
            let mut inside = false;
            let mut tag = String::new();
            loop {
                match reader.read_event() {
                    Ok(Event::Start(e)) => {
                        let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                        if name == "item" || name == "entry" {
                            inside = true;
                            current.clear();
                        }
                        if inside && name == "link" {
                            if let Some(Ok(attribute)) = e.attributes().find(|attribute| {
                                attribute.as_ref().is_ok_and(|a| a.key.as_ref() == b"href")
                            }) {
                                current.insert(
                                    "link".into(),
                                    attribute
                                        .unescape_value()
                                        .map_err(|_| "not_json")?
                                        .into_owned(),
                                );
                            }
                        }
                        tag = name;
                    }
                    Ok(Event::Empty(e)) if inside => {
                        let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                        if name == "link" {
                            if let Some(Ok(attribute)) = e.attributes().find(|attribute| {
                                attribute.as_ref().is_ok_and(|a| a.key.as_ref() == b"href")
                            }) {
                                current.insert(
                                    "link".into(),
                                    attribute
                                        .unescape_value()
                                        .map_err(|_| "not_json")?
                                        .into_owned(),
                                );
                            }
                        }
                    }
                    Ok(Event::Text(e)) if inside => {
                        let text = e.unescape().map_err(|_| "not_json")?.into_owned();
                        current.entry(tag.clone()).or_default().push_str(&text);
                    }
                    Ok(Event::End(e)) => {
                        let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                        if name == "item" || name == "entry" {
                            let date = ["pubDate", "published", "updated"].iter().find_map(|key| {
                                current.get(*key).and_then(|value| {
                                    parse_time(value)
                                        .or_else(|| OffsetDateTime::parse(value, &Rfc2822).ok())
                                })
                            });
                            if let Some(date) = date {
                                let title = current.get("title").cloned().unwrap_or_default();
                                let body = ["description", "summary", "content", "encoded"]
                                    .iter()
                                    .find_map(|key| current.get(*key))
                                    .cloned()
                                    .unwrap_or_default();
                                let reference = current
                                    .get("guid")
                                    .or_else(|| current.get("id"))
                                    .or_else(|| current.get("link"))
                                    .cloned()
                                    .unwrap_or_else(|| format!("{id}:{}", items.len()));
                                items.push(EvidenceItem {
                                    reference,
                                    date,
                                    text: strip_html(&format!("{title} {body}")),
                                });
                            }
                            inside = false;
                        }
                        tag.clear();
                    }
                    Ok(Event::Eof) => break,
                    Err(_) => return Err("not_json".into()),
                    _ => {}
                }
            }
            Ok((None, Some(at), response.body, items))
        }),
    )
}

fn web_text(source: &Value, at: OffsetDateTime, deps: &Deps<'_>) -> SourceResult {
    let id = source["id"].as_str().unwrap_or("");
    let url = field(source, "url")
        .or_else(|| source["url"].as_str())
        .unwrap_or("")
        .to_string();
    result(
        id,
        url.clone(),
        request(deps, "GET", &url, BTreeMap::new(), Vec::new(), TEXT_CAP).and_then(|response| {
            let body = String::from_utf8(response.body.clone()).map_err(|_| "type_mismatch")?;
            let text = strip_html(&body);
            let items = vec![EvidenceItem {
                reference: format!("{id}:0"),
                date: at,
                text,
            }];
            Ok((None, Some(at), response.body, items))
        }),
    )
}

pub fn strip_html(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        let Some(rest) = lower.get(index..) else {
            break;
        };
        if rest.starts_with("<script") || rest.starts_with("<style") {
            let close = if rest.starts_with("<script") {
                "</script>"
            } else {
                "</style>"
            };
            if let Some(end) = rest.find(close) {
                index += end + close.len();
                continue;
            }
        }
        if input.as_bytes().get(index) == Some(&b'<') {
            if let Some(end) = input.get(index..).and_then(|rest| rest.find('>')) {
                index += end + 1;
                output.push(' ');
                continue;
            }
        }
        let Some(ch) = input.get(index..).and_then(|rest| rest.chars().next()) else {
            break;
        };
        output.push(ch);
        index += ch.len_utf8();
    }
    let output = output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}
