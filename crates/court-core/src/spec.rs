//! Public ResolutionSpec v1 shape. The engine lints raw JSON to report field-level errors.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolutionSpec {
    pub version: u32,
    pub question: Option<String>,
    pub outcomes: Vec<String>,
    pub observation: Observation,
    pub sources: Vec<SourceSpec>,
    pub aggregate: AggregateSpec,
    pub decide: Value,
    pub outcome_map: BTreeMap<String, String>,
    pub on_unavailable: String,
    pub retry: RetrySpec,
    pub rules_text_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub at: String,
    pub baseline_at: Option<String>,
    pub mode: String,
    pub max_delay: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceSpec {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub request: Value,
    #[serde(default)]
    pub expect: Value,
    #[serde(default)]
    pub extract: Value,
    #[serde(default)]
    pub sanity: Value,
    pub identity: Option<String>,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AggregateSpec {
    pub method: String,
    pub tolerance: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RetrySpec {
    pub max_attempts: u8,
    pub every: String,
}
