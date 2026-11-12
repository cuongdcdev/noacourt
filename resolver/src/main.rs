use court_core::{
    Clock, Deps, Env, Http, HttpError, HttpRequest, HttpResponse, LintError, LintReport, Llm,
    ResolverInput, Verdict,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use time::OffsetDateTime;

struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

struct ProcessEnv;
impl Env for ProcessEnv {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

struct NetworkHttp;
impl Http for NetworkHttp {
    fn request(&self, req: &HttpRequest) -> Result<HttpResponse, HttpError> {
        let headers: Vec<_> = req
            .headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let response = resolver::http::request(
            &req.method,
            &req.url,
            &headers,
            if req.body.is_empty() {
                None
            } else {
                Some(&req.body)
            },
            req.timeout_ms,
            2 * 1024 * 1024,
        )
        .map_err(|error| {
            if error.contains("timed out") {
                HttpError::Timeout
            } else if error.contains("too large") {
                HttpError::TooLarge
            } else {
                HttpError::Transport(error)
            }
        })?;
        Ok(HttpResponse {
            status: response.status,
            body: response.body,
            headers: BTreeMap::new(),
        })
    }
}

struct NearAi<'a> {
    http: &'a dyn Http,
    env: &'a dyn Env,
}

impl Llm for NearAi<'_> {
    fn chat(&self, model: &str, system: &str, user: &str) -> Result<String, String> {
        let key = self.env.get("NEAR_AI_API").ok_or("secret_missing")?;
        let body = json!({
            "model": model,
            "messages": [
                {"role":"system","content":system},
                {"role":"user","content":user}
            ],
            "response_format":{"type":"json_object"},
            "temperature":0,
            "max_tokens":1500
        })
        .to_string()
        .into_bytes();
        let mut headers = BTreeMap::new();
        headers.insert("Authorization".into(), format!("Bearer {key}"));
        headers.insert("Content-Type".into(), "application/json".into());
        let req = HttpRequest {
            method: "POST".into(),
            url: "https://cloud-api.near.ai/v1/chat/completions".into(),
            headers,
            body,
            timeout_ms: 28_000,
        };
        let response = self.http.request(&req).map_err(|error| match error {
            HttpError::Timeout => "llm_timeout",
            HttpError::Transport(_) => "llm_transport",
            HttpError::TooLarge => "llm_bad_response",
        })?;
        if response.status != 200 {
            return Err(format!("llm_http_{}", response.status));
        }
        let root: Value = serde_json::from_slice(&response.body).map_err(|_| "llm_bad_response")?;
        root.pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "empty_response".into())
    }
}

fn process(input: &str) -> Verdict {
    let parsed: ResolverInput = match serde_json::from_str(input) {
        Ok(input) => input,
        Err(_) => {
            let mut verdict = Verdict::empty("resolve", "");
            verdict.spec_hash.clear();
            verdict.reason = "input_invalid".into();
            return verdict;
        }
    };
    let http = NetworkHttp;
    let clock = SystemClock;
    let env = ProcessEnv;
    let llm = NearAi {
        http: &http,
        env: &env,
    };
    let deps = Deps {
        http: &http,
        clock: &clock,
        llm: &llm,
        env: &env,
    };
    court_core::engine::run(&parsed, &deps)
}

fn encode_verdict(mut verdict: Verdict) -> String {
    let line = match serde_json::to_string(&verdict) {
        Ok(line) => line,
        Err(_) => return serialization_error_line(),
    };
    if line.len() < 16 * 1024 {
        return line;
    }
    verdict.status = "unresolvable".into();
    verdict.outcome = None;
    verdict.outcome_index = None;
    verdict.value = None;
    verdict.retry_after = None;
    verdict.reason = "verdict_too_large".into();
    verdict.sources.clear();
    verdict.jurors = None;
    verdict.mode = verdict.mode.chars().take(16).collect();
    if verdict.lint.is_some() {
        verdict.lint = Some(LintReport {
            ok: false,
            errors: vec![LintError {
                code: "verdict_too_large".into(),
                path: "$".into(),
                message: "verdict exceeded output limit".into(),
            }],
            labels: BTreeMap::new(),
        });
    }
    serde_json::to_string(&verdict).unwrap_or_else(|_| serialization_error_line())
}

fn serialization_error_line() -> String {
    r#"{"v":1,"resolver_version":"0.1.0","spec_hash":"","mode":"resolve","status":"unresolvable","outcome":null,"outcome_index":null,"value":null,"retry_after":null,"reason":"serialization_failed","sources":[],"jurors":null}"#.into()
}

fn main() {
    let mut input = String::new();
    let _ = io::stdin().read_to_string(&mut input);
    let mut verdict = process(&input);
    verdict.resolver_version = env!("CARGO_PKG_VERSION").into();
    let line = encode_verdict(verdict);
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn oversized_verdict_is_bounded_and_never_resolved() {
        let mut verdict = Verdict::empty("resolve", "{}");
        verdict.status = "resolved".into();
        verdict.outcome = Some("Yes".into());
        verdict.reason = "x".repeat(20_000);
        let encoded = encode_verdict(verdict);
        let parsed: Value = serde_json::from_str(&encoded).unwrap();
        assert!(encoded.len() < 16 * 1024);
        assert_eq!(parsed["status"], "unresolvable");
        assert!(parsed["outcome"].is_null());
    }

    struct TestEnv {
        key: bool,
    }
    impl Env for TestEnv {
        fn get(&self, name: &str) -> Option<String> {
            (self.key && name == "NEAR_AI_API").then(|| "never-print-this-key".into())
        }
    }

    struct TestHttp {
        result: Result<HttpResponse, HttpError>,
        timeout_ms: Cell<u64>,
    }
    impl Http for TestHttp {
        fn request(&self, req: &HttpRequest) -> Result<HttpResponse, HttpError> {
            self.timeout_ms.set(req.timeout_ms);
            self.result.clone()
        }
    }

    #[test]
    fn near_ai_returns_distinct_safe_errors_and_uses_28_second_timeout() {
        let cases = [
            (Err(HttpError::Timeout), "llm_timeout"),
            (
                Err(HttpError::Transport("response body and secret".into())),
                "llm_transport",
            ),
            (
                Ok(HttpResponse {
                    status: 429,
                    body: b"quota response".to_vec(),
                    headers: BTreeMap::new(),
                }),
                "llm_http_429",
            ),
            (
                Ok(HttpResponse {
                    status: 503,
                    body: b"server response".to_vec(),
                    headers: BTreeMap::new(),
                }),
                "llm_http_503",
            ),
            (
                Ok(HttpResponse {
                    status: 200,
                    body: b"not json".to_vec(),
                    headers: BTreeMap::new(),
                }),
                "llm_bad_response",
            ),
            (
                Ok(HttpResponse {
                    status: 200,
                    body: br#"{"choices":[{"message":{"content":null}}]}"#.to_vec(),
                    headers: BTreeMap::new(),
                }),
                "empty_response",
            ),
        ];
        for (result, expected) in cases {
            let http = TestHttp {
                result,
                timeout_ms: Cell::new(0),
            };
            let env = TestEnv { key: true };
            let llm = NearAi {
                http: &http,
                env: &env,
            };
            let error = llm.chat("model", "system", "user").unwrap_err();
            assert_eq!(error, expected);
            assert_eq!(http.timeout_ms.get(), 28_000);
            assert!(!error.contains("never-print-this-key"));
            assert!(!error.contains("quota response"));
            assert!(!error.contains("server response"));
        }
        let http = TestHttp {
            result: Err(HttpError::Timeout),
            timeout_ms: Cell::new(0),
        };
        let env = TestEnv { key: false };
        let llm = NearAi {
            http: &http,
            env: &env,
        };
        assert_eq!(
            llm.chat("model", "system", "user").unwrap_err(),
            "secret_missing"
        );
        assert_eq!(http.timeout_ms.get(), 0);
    }
}
