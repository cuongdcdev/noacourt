use resolver::http::{request, HttpResponse};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::time::Instant;

const BINANCE_DATA: &str =
    "https://data-api.binance.vision/api/v3/klines?symbol=NEARUSDT&interval=1m&limit=2";
const BINANCE_API: &str =
    "https://api.binance.com/api/v3/klines?symbol=NEARUSDT&interval=1m&limit=1";
const OKX: &str = "https://www.okx.com/api/v5/market/candles?instId=NEAR-USDT&bar=1m&limit=2";
const NEAR_AI: &str = "https://cloud-api.near.ai/v1/chat/completions";
const TIMEOUT_MS: u64 = 20_000;
const MAX_BYTES: usize = 256 * 1024;

fn preview(bytes: &[u8], max: usize) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(max)]).into_owned()
}

fn get(url: &str, preview_bytes: usize) -> (Value, Option<HttpResponse>) {
    let started = Instant::now();
    match request("GET", url, &[], None, TIMEOUT_MS, MAX_BYTES) {
        Ok(response) => {
            let result = json!({
                "status": response.status,
                "ms": started.elapsed().as_millis(),
                "body_preview": preview(&response.body, preview_bytes),
            });
            (result, Some(response))
        }
        Err(error) => (
            json!({"error": error, "ms": started.elapsed().as_millis()}),
            None,
        ),
    }
}

fn env_value(name: &str) -> Value {
    std::env::var(name).map_or(Value::Null, Value::String)
}

fn llm(key: &str) -> Value {
    let model = std::env::var("SPIKE_MODEL").unwrap_or_else(|_| "z-ai/glm-5.3-flash".into());
    let payload = json!({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with exactly the JSON {\"ok\":true}"}],
        "max_tokens": 20,
        "temperature": 0,
    });
    let body = payload.to_string();
    let authorization = format!("Bearer {key}");
    let started = Instant::now();
    let result = request(
        "POST",
        NEAR_AI,
        &[
            ("Authorization", authorization.as_str()),
            ("Content-Type", "application/json"),
        ],
        Some(body.as_bytes()),
        TIMEOUT_MS,
        MAX_BYTES,
    );
    match result {
        Ok(response) => {
            let content = serde_json::from_slice::<Value>(&response.body)
                .ok()
                .and_then(|json| {
                    json.pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .map(|content| content.chars().take(200).collect::<String>());
            json!({
                "status": response.status,
                "ms": started.elapsed().as_millis(),
                "content": content,
            })
        }
        Err(error) => json!({"error": error, "ms": started.elapsed().as_millis()}),
    }
}

fn run() -> Value {
    let mut input = String::new();
    let input_error = io::stdin().read_to_string(&mut input).err();
    let parsed = if input.trim().is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_str::<Value>(&input)
    };
    let skip_llm = parsed
        .as_ref()
        .ok()
        .and_then(|json| json.get("skip_llm"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let key = std::env::var("NEAR_AI_API").ok();
    let mut output = json!({
        "env": {
            "OUTLAYER_EXECUTION_TYPE": env_value("OUTLAYER_EXECUTION_TYPE"),
            "NEAR_NETWORK_ID": env_value("NEAR_NETWORK_ID"),
            "NEAR_SENDER_ID": env_value("NEAR_SENDER_ID"),
            "NEAR_BLOCK_HEIGHT": env_value("NEAR_BLOCK_HEIGHT"),
            "NEAR_AI_API_present": key.is_some(),
        }
    });
    if input_error.is_some() {
        output["input_error"] = json!("stdin read failed");
    } else if parsed.is_err() {
        output["input_error"] = json!("invalid JSON");
    }

    let (mut data, response) = get(BINANCE_DATA, 300);
    if let Some(response) = response {
        let close = serde_json::from_slice::<Value>(&response.body)
            .ok()
            .and_then(|json| {
                json.as_array()
                    .and_then(|candles| candles.last())
                    .and_then(|candle| candle.get(4))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        data["last_close"] = json!(close);
    }
    output["binance_data"] = data;
    output["binance_api"] = get(BINANCE_API, 200).0;
    output["okx"] = get(OKX, 300).0;
    output["near_ai"] = if skip_llm {
        json!({"skipped": "skip_llm requested"})
    } else if let Some(key) = key {
        llm(&key)
    } else {
        json!({"skipped": "no NEAR_AI_API"})
    };
    output
}

fn main() {
    println!("{}", run());
    io::stdout().flush().expect("stdout flush failed");
}
