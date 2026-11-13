//! Deterministic ResolutionSpec v1 engine. Decimal values use source text.
pub mod canon;
pub mod engine;
pub mod judge;
pub mod lint;
pub mod spec;
pub mod tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const VERSION: &str = "0.1.0";

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub headers: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub enum HttpError {
    Timeout,
    Transport(String),
    TooLarge,
}

pub trait Http {
    fn request(&self, req: &HttpRequest) -> Result<HttpResponse, HttpError>;
}

pub trait Clock {
    fn now(&self) -> OffsetDateTime;
}

/// Monotonic time left for the entire resolver invocation.
pub trait Budget {
    fn remaining(&self) -> std::time::Duration;
}

/// Leave time to serialize and return a Verdict after the last network call.
pub fn call_timeout(
    budget: &dyn Budget,
    normal: std::time::Duration,
) -> Option<std::time::Duration> {
    let remaining = budget.remaining();
    if remaining < std::time::Duration::from_secs(3) {
        return None;
    }
    let allowed = normal.min(remaining.saturating_sub(std::time::Duration::from_secs(5)));
    (!allowed.is_zero()).then_some(allowed)
}

pub trait Llm {
    fn chat(&self, model: &str, system: &str, user: &str) -> Result<String, String>;
}

pub trait Env {
    fn get(&self, name: &str) -> Option<String>;
}

pub struct Deps<'a> {
    pub http: &'a dyn Http,
    pub clock: &'a dyn Clock,
    pub budget: &'a dyn Budget,
    pub llm: &'a dyn Llm,
    pub env: &'a dyn Env,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ResolverInput {
    pub mode: String,
    pub spec_json: String,
    #[serde(default)]
    pub context: InputContext,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct InputContext {
    pub request_id: Option<String>,
    #[serde(default = "one")]
    pub attempt: u8,
    pub now: Option<String>,
}

fn one() -> u8 {
    1
}

#[derive(Clone, Debug, Serialize)]
pub struct LintError {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct LintReport {
    pub ok: bool,
    pub errors: Vec<LintError>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct LintContext {
    pub market_close: Option<OffsetDateTime>,
    pub now: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceResult {
    pub id: String,
    pub ok: bool,
    pub value: Option<String>,
    pub as_of: Option<String>,
    pub url: Option<String>,
    pub evidence_sha256: Option<String>,
    pub error: Option<String>,
    #[serde(skip)]
    pub typed: Option<TypedValue>,
    #[serde(skip)]
    pub items: Vec<EvidenceItem>,
}

impl SourceResult {
    pub fn error(id: &str, code: &str, url: Option<String>) -> Self {
        Self {
            id: id.into(),
            ok: false,
            value: None,
            as_of: None,
            url,
            evidence_sha256: None,
            error: Some(code.into()),
            typed: None,
            items: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum TypedValue {
    Decimal(rust_decimal::Decimal),
    Bool(bool),
    String(String),
}

impl TypedValue {
    pub fn display(&self) -> String {
        match self {
            Self::Decimal(value) => value.normalize().to_string(),
            Self::Bool(value) => value.to_string(),
            Self::String(value) => value.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct EvidenceItem {
    pub reference: String,
    pub date: OffsetDateTime,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct JurorResult {
    pub model: String,
    pub answer: String,
    pub confidence: f64,
    pub quotes: Vec<String>,
    pub item_ref: String,
    pub valid: bool,
    pub invalid_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Verdict {
    pub v: u8,
    pub resolver_version: String,
    pub spec_hash: String,
    pub mode: String,
    pub status: String,
    pub outcome: Option<String>,
    pub outcome_index: Option<usize>,
    pub value: Option<String>,
    pub retry_after: Option<String>,
    pub reason: String,
    pub sources: Vec<SourceResult>,
    pub jurors: Option<Vec<JurorResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lint: Option<LintReport>,
}

impl Verdict {
    pub fn empty(mode: &str, spec_json: &str) -> Self {
        Self {
            v: 1,
            resolver_version: VERSION.into(),
            spec_hash: spec_hash(spec_json),
            mode: mode.into(),
            status: "unresolvable".into(),
            outcome: None,
            outcome_index: None,
            value: None,
            retry_after: None,
            reason: String::new(),
            sources: Vec::new(),
            jurors: None,
            lint: None,
        }
    }
}

pub fn spec_hash(spec_json: &str) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(spec_json.as_bytes()))
    )
}

pub fn evidence_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn parse_time(text: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(text, &Rfc3339).ok()
}

pub fn format_time(value: OffsetDateTime) -> String {
    let value = value.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        value.month() as u8,
        value.day(),
        value.hour(),
        value.minute(),
        value.second()
    )
}

pub fn decimal(value: &Value) -> Option<rust_decimal::Decimal> {
    use std::str::FromStr;
    match value {
        Value::Number(n) => rust_decimal::Decimal::from_str(&n.to_string()).ok(),
        Value::String(s) => rust_decimal::Decimal::from_str(s).ok(),
        _ => None,
    }
}

pub fn duration(text: &str) -> Option<time::Duration> {
    let split = text.find(|c: char| !c.is_ascii_digit())?;
    let number = text[..split].parse::<i64>().ok()?;
    if number <= 0 {
        return None;
    }
    let factor = match &text[split..] {
        "s" => 1,
        "m" => 60,
        "h" => 3_600,
        "d" => 86_400,
        _ => return None,
    };
    number.checked_mul(factor).map(time::Duration::seconds)
}

pub fn get_str<'a>(value: &'a Value, path: &str) -> Option<&'a str> {
    value.pointer(path).and_then(Value::as_str)
}
