use crate::{
    decimal, duration, format_time, get_str, judge, lint, parse_time, tools, Deps, ResolverInput,
    SourceResult, TypedValue, Verdict,
};
use rust_decimal::Decimal;
use serde_json::Value;

pub fn run(input: &ResolverInput, deps: &Deps<'_>) -> Verdict {
    let mut verdict = Verdict::empty(&input.mode, &input.spec_json);
    let spec: Value = match serde_json::from_str(&input.spec_json) {
        Ok(spec) => spec,
        Err(_) => {
            verdict.reason = "spec_invalid: malformed JSON".into();
            return verdict;
        }
    };
    let report = lint::lint(&input.spec_json);
    if input.mode == "lint" {
        verdict.reason = if report.ok {
            "lint: ok".into()
        } else {
            format!("lint: {}", codes(&report))
                .chars()
                .take(200)
                .collect()
        };
        verdict.lint = Some(report);
        return verdict;
    }
    if !matches!(input.mode.as_str(), "resolve" | "simulate") {
        verdict.reason = "mode_invalid".into();
        return verdict;
    }
    if !report.ok {
        verdict.reason = format!("lint: {}", codes(&report))
            .chars()
            .take(200)
            .collect();
        return verdict;
    }
    let now = match input.context.now.as_deref() {
        Some(text) => match parse_time(text) {
            Some(now) => now,
            None => {
                verdict.reason = "input_invalid: context.now".into();
                return verdict;
            }
        },
        None => deps.clock.now(),
    };
    let Some(at) = get_str(&spec, "/observation/at").and_then(parse_time) else {
        verdict.reason = "spec_invalid: observation.at".into();
        return verdict;
    };
    let simulate = input.mode == "simulate";
    if !simulate && now < at {
        verdict.status = "retry_after".into();
        verdict.retry_after = Some(format_time(at));
        verdict.reason = "observation not reached".into();
        return verdict;
    }
    let max_delay = get_str(&spec, "/observation/max_delay").and_then(duration);
    let Some(sources) = spec["sources"].as_array() else {
        verdict.reason = "spec_invalid: sources".into();
        return verdict;
    };
    let Some(kind) = get_str(&spec, "/decide/kind") else {
        verdict.reason = "spec_invalid: decide.kind".into();
        return verdict;
    };
    let window_to = get_str(&spec, "/decide/window/to").and_then(parse_time);
    let mut current = Vec::new();
    let mut baseline = Vec::new();
    for source in sources {
        let mut observed = tools::fetch(source, at, now, simulate, max_delay, deps);
        let undated_text = source["tool"] == "web_text"
            || source["tool"] == "http_json"
                && get_str(source, "/expect/as_of").is_none()
                && get_str(source, "/extract/type") == Some("string");
        if kind == "text_judge" && !simulate && undated_text {
            if let Some(to) = window_to {
                for item in &mut observed.items {
                    item.date = now.min(to);
                }
            }
        }
        current.push(observed);
        if kind == "change" {
            let Some(baseline_at) = get_str(&spec, "/observation/baseline_at").and_then(parse_time)
            else {
                verdict.reason = "spec_invalid: observation.baseline_at".into();
                return verdict;
            };
            baseline.push(tools::fetch(
                source,
                baseline_at,
                now,
                false,
                max_delay,
                deps,
            ));
        }
    }
    verdict.sources = current.clone();
    let result = if kind == "text_judge" {
        if current.iter().any(|source| !source.ok) {
            Err("evidence source failed".into())
        } else {
            let items = current
                .iter()
                .flat_map(|source| source.items.clone())
                .collect::<Vec<_>>();
            let (key, jurors, reason) = judge::panel(&spec["decide"], &items, deps);
            verdict.jurors = if jurors.is_empty() {
                None
            } else {
                Some(jurors)
            };
            key.map(|key| (key, None, reason.clone())).ok_or(reason)
        }
    } else {
        (|| {
            let value = aggregate(&current, &spec["aggregate"])?;
            let baseline_value = if kind == "change" {
                Some(aggregate(&baseline, &spec["aggregate"])?)
            } else {
                None
            };
            let key = decide(&spec["decide"], &value, baseline_value.as_ref())?;
            let receipt = ReceiptContext {
                spec: &spec,
                sources,
                current: &current,
                baseline: &baseline,
                at,
            };
            let left = describe_decision(&receipt, &value, baseline_value.as_ref(), &key)?;
            Ok((key, Some(value.display()), left))
        })()
    };
    match result {
        Ok((key, value, reason)) => {
            let Some(mapped) = spec["outcome_map"][&key].as_str() else {
                verdict.reason = "spec_invalid: outcome_map".into();
                return verdict;
            };
            let index = spec["outcomes"].as_array().and_then(|outcomes| {
                outcomes
                    .iter()
                    .position(|outcome| outcome.as_str() == Some(mapped))
            });
            let Some(index) = index else {
                verdict.reason = "spec_invalid: outcome_map".into();
                return verdict;
            };
            verdict.outcome = Some(mapped.into());
            verdict.outcome_index = Some(index);
            verdict.value = value;
            verdict.reason = if kind == "text_judge" {
                reason.chars().take(200).collect()
            } else {
                receipt_reason(&reason, &key, mapped)
            };
            verdict.status = "resolved".into();
        }
        Err(error) => {
            verdict.reason = error.chars().take(200).collect();
            let attempts = spec["retry"]["max_attempts"].as_u64().unwrap_or(1);
            if u64::from(input.context.attempt) < attempts {
                if let Some(retry_at) = get_str(&spec, "/retry/every")
                    .and_then(duration)
                    .and_then(|delay| now.checked_add(delay))
                {
                    verdict.status = "retry_after".into();
                    verdict.retry_after = Some(format_time(retry_at));
                }
            }
        }
    }
    verdict
}

fn source_field(source: &Value) -> &'static str {
    if matches!(
        source["tool"].as_str(),
        Some("binance_kline" | "okx_candle" | "coinbase_candle")
    ) {
        if get_str(source, "/params/field") == Some("open") {
            "open"
        } else {
            "close"
        }
    } else {
        "value"
    }
}

fn source_phrase(sources: &[Value], results: &[SourceResult], aggregate: &Value) -> String {
    let used: Vec<_> = sources
        .iter()
        .zip(results)
        .filter(|(_, result)| result.typed.is_some())
        .collect();
    let field = used
        .first()
        .map(|(source, _)| source_field(source))
        .filter(|first| {
            used.iter()
                .all(|(source, _)| source_field(source) == *first)
        })
        .unwrap_or("value");
    let source = match aggregate["method"].as_str().unwrap_or("") {
        "median" => format!("median of {} sources", used.len()),
        "all_agree" => format!("all_agree {} sources", used.len()),
        _ => used
            .first()
            .map(|(_, result)| result.id.clone())
            .unwrap_or_else(|| "source".into()),
    };
    format!("{source} {field}")
}

fn receipt_value(value: &TypedValue) -> String {
    match value {
        TypedValue::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
        _ => value.display(),
    }
}

struct ReceiptContext<'a> {
    spec: &'a Value,
    sources: &'a [Value],
    current: &'a [SourceResult],
    baseline: &'a [SourceResult],
    at: time::OffsetDateTime,
}

fn describe_decision(
    receipt: &ReceiptContext<'_>,
    value: &TypedValue,
    baseline_value: Option<&TypedValue>,
    key: &str,
) -> Result<String, String> {
    let decide = &receipt.spec["decide"];
    let source = source_phrase(receipt.sources, receipt.current, &receipt.spec["aggregate"]);
    let actual = receipt_value(value);
    match get_str(decide, "/kind").unwrap_or("") {
        "threshold" => {
            let op = get_str(decide, "/op").ok_or("decide_invalid")?;
            let threshold = decimal(&decide["value"])
                .ok_or("decimal_invalid")?
                .normalize();
            Ok(format!("{source} {actual} {op} threshold {threshold}"))
        }
        "buckets" => {
            let edges = decide["edges"].as_array().ok_or("decide_invalid")?;
            let index = key.parse::<usize>().map_err(|_| "decide_invalid")?;
            let edge = |position: usize| -> Result<String, String> {
                edges
                    .get(position)
                    .and_then(decimal)
                    .map(|value| value.normalize().to_string())
                    .ok_or_else(|| "decide_invalid".into())
            };
            let interval = if index == 0 {
                format!("(-inf, {})", edge(0)?)
            } else if index == edges.len() {
                format!("[{}, +inf)", edge(index - 1)?)
            } else {
                format!("[{}, {})", edge(index - 1)?, edge(index)?)
            };
            Ok(format!("{source} {actual} in bucket {index} {interval}"))
        }
        "equals" => {
            let expected = if matches!(value, TypedValue::Decimal(_)) {
                decimal(&decide["value"])
                    .map(|number| number.normalize().to_string())
                    .unwrap_or_else(|| decide["value"].to_string())
            } else {
                decide["value"].to_string()
            };
            Ok(format!("{source} {actual} == {expected}"))
        }
        "bool" => Ok(format!("{source} {actual}")),
        "change" => {
            let previous = baseline_value.ok_or("decide_invalid")?;
            let baseline_at = get_str(receipt.spec, "/observation/baseline_at")
                .and_then(parse_time)
                .ok_or("decide_invalid")?;
            let baseline_source = source_phrase(
                receipt.sources,
                receipt.baseline,
                &receipt.spec["aggregate"],
            );
            let baseline_label = if baseline_source == source {
                String::new()
            } else {
                format!("{baseline_source} ")
            };
            Ok(format!(
                "{source} {actual} at {} vs {baseline_label}{} at baseline {}",
                format_time(receipt.at),
                receipt_value(previous),
                format_time(baseline_at)
            ))
        }
        _ => Err("decide_invalid".into()),
    }
}

fn receipt_reason(left: &str, key: &str, outcome: &str) -> String {
    let tail = format!(" → {key} → {outcome}");
    let available = 200_usize.saturating_sub(tail.len());
    if left.len() <= available {
        return format!("{left}{tail}");
    }
    let prefix_limit = available.saturating_sub("…".len());
    let prefix: String = left
        .chars()
        .scan(0_usize, |used, character| {
            let next = *used + character.len_utf8();
            (next <= prefix_limit).then(|| {
                *used = next;
                character
            })
        })
        .collect();
    format!("{prefix}…{tail}")
}

fn codes(report: &crate::LintReport) -> String {
    report
        .errors
        .iter()
        .map(|error| error.code.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

pub fn aggregate(sources: &[SourceResult], config: &Value) -> Result<TypedValue, String> {
    let method = config["method"].as_str().unwrap_or("");
    let good: Vec<_> = sources
        .iter()
        .filter_map(|source| source.typed.as_ref())
        .collect();
    if good.is_empty() {
        return Err(sources
            .iter()
            .find_map(|source| source.error.clone())
            .unwrap_or_else(|| "no source value".into()));
    }
    match method {
        "primary_then_fallback" => good
            .first()
            .map(|value| (*value).clone())
            .ok_or_else(|| "no source value".into()),
        "median" => {
            if good.len() < sources.len().div_ceil(2) {
                return Err("insufficient sources".into());
            }
            let mut numbers: Vec<Decimal> = good
                .iter()
                .map(|v| match v {
                    TypedValue::Decimal(n) => Ok(*n),
                    _ => Err("type_mismatch"),
                })
                .collect::<Result<_, _>>()?;
            numbers.sort();
            let middle = numbers.len() / 2;
            let value = if numbers.len().is_multiple_of(2) {
                let left = numbers
                    .get(middle.saturating_sub(1))
                    .ok_or("aggregate_invalid")?;
                let right = numbers.get(middle).ok_or("aggregate_invalid")?;
                left.checked_add(*right)
                    .and_then(|sum| sum.checked_div(Decimal::TWO))
                    .ok_or("aggregate_invalid")?
            } else {
                *numbers.get(middle).ok_or("aggregate_invalid")?
            };
            Ok(TypedValue::Decimal(value))
        }
        "all_agree" => {
            if good.len() != sources.len() {
                return Err("sources_disagree".into());
            }
            let tolerance_text = config["tolerance"].as_str().unwrap_or("0");
            let tolerance = if let Some(percent) = tolerance_text.strip_suffix('%') {
                percent
                    .parse::<Decimal>()
                    .map_err(|_| "aggregate_invalid")?
                    .checked_div(Decimal::from(100))
                    .ok_or("aggregate_invalid")?
            } else {
                tolerance_text
                    .parse::<Decimal>()
                    .map_err(|_| "aggregate_invalid")?
            };
            for left in &good {
                for right in &good {
                    match (left, right) {
                        (TypedValue::Decimal(a), TypedValue::Decimal(b)) => {
                            let bound = a
                                .abs()
                                .min(b.abs())
                                .checked_mul(tolerance)
                                .ok_or("sources_disagree")?;
                            let bound = if tolerance_text.ends_with('%') {
                                bound
                            } else {
                                tolerance
                            };
                            if a.checked_sub(*b).ok_or("sources_disagree")?.abs() > bound {
                                return Err("sources_disagree".into());
                            }
                        }
                        _ if left != right => return Err("sources_disagree".into()),
                        _ => {}
                    }
                }
            }
            good.first()
                .map(|value| (*value).clone())
                .ok_or_else(|| "no source value".into())
        }
        _ => Err("aggregate_invalid".into()),
    }
}

pub fn decide(
    decide: &Value,
    value: &TypedValue,
    baseline: Option<&TypedValue>,
) -> Result<String, String> {
    let kind = decide["kind"].as_str().unwrap_or("");
    match kind {
        "threshold" => {
            let TypedValue::Decimal(actual) = value else {
                return Err("type_mismatch".into());
            };
            let expected = decimal(&decide["value"]).ok_or("decimal_invalid")?;
            let matched = match decide["op"].as_str().unwrap_or("") {
                ">=" => *actual >= expected,
                ">" => *actual > expected,
                "<=" => *actual <= expected,
                "<" => *actual < expected,
                _ => return Err("decide_invalid".into()),
            };
            Ok(matched.to_string())
        }
        "buckets" => {
            let TypedValue::Decimal(actual) = value else {
                return Err("type_mismatch".into());
            };
            let edges = decide["edges"].as_array().ok_or("decide_invalid")?;
            Ok(edges
                .iter()
                .take_while(|edge| decimal(edge).is_some_and(|n| *actual >= n))
                .count()
                .to_string())
        }
        "equals" => {
            let expected = &decide["value"];
            let matched = match value {
                TypedValue::Decimal(actual) => decimal(expected).is_some_and(|n| n == *actual),
                TypedValue::Bool(actual) => expected.as_bool() == Some(*actual),
                TypedValue::String(actual) => expected.as_str() == Some(actual),
            };
            Ok(matched.to_string())
        }
        "bool" => match value {
            TypedValue::Bool(value) => Ok(value.to_string()),
            _ => Err("type_mismatch".into()),
        },
        "change" => {
            let (TypedValue::Decimal(current), Some(TypedValue::Decimal(previous))) =
                (value, baseline)
            else {
                return Err("type_mismatch".into());
            };
            Ok(if current > previous {
                "up"
            } else if current < previous {
                "down"
            } else {
                "tie"
            }
            .into())
        }
        _ => Err("decide_invalid".into()),
    }
}
