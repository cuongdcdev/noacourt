#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
use std::io::Read;
#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
use std::time::{Duration, Instant};

#[cfg(any(test, all(target_arch = "wasm32", target_os = "wasi")))]
fn timeout_ns(timeout_ms: u64) -> u64 {
    timeout_ms.saturating_mul(1_000_000)
}

#[cfg(any(test, all(target_arch = "wasm32", target_os = "wasi")))]
fn deadline_ns(start_ns: u64, timeout_ms: u64) -> u64 {
    start_ns.saturating_add(timeout_ns(timeout_ms))
}

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
fn is_native_timeout(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(cause) = current {
        if cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::TimedOut)
        {
            return true;
        }
        current = cause.source();
    }
    false
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn wasi_http_error(error: &wasi::http::types::ErrorCode, deadline: u64) -> String {
    use wasi::http::types::ErrorCode;

    let timed_out = matches!(
        error,
        ErrorCode::DnsTimeout
            | ErrorCode::ConnectionTimeout
            | ErrorCode::ConnectionReadTimeout
            | ErrorCode::ConnectionWriteTimeout
            | ErrorCode::HttpResponseTimeout
    );
    if timed_out || wasi::clocks::monotonic_clock::now() >= deadline {
        "HTTP request timed out".into()
    } else {
        "HTTP transport failed".into()
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn wasi_elapsed_error(deadline: u64) -> String {
    if wasi::clocks::monotonic_clock::now() >= deadline {
        "HTTP request timed out".into()
    } else {
        "HTTP transport failed".into()
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn wasi_wait_ready(pollable: &wasi::io::poll::Pollable, deadline: u64) -> Result<(), String> {
    use wasi::clocks::monotonic_clock;
    use wasi::io::poll;

    let timer = monotonic_clock::subscribe_instant(deadline);
    loop {
        if monotonic_clock::now() >= deadline {
            return Err("HTTP request timed out".into());
        }
        let ready = poll::poll(&[pollable, &timer]);
        if ready.contains(&1) || monotonic_clock::now() >= deadline {
            return Err("HTTP request timed out".into());
        }
        if ready.contains(&0) {
            return Ok(());
        }
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

pub fn request(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout_ms: u64,
    max_bytes: usize,
) -> Result<HttpResponse, String> {
    if timeout_ms == 0 || max_bytes == 0 {
        return Err("invalid request limits".into());
    }
    if method != "GET" && method != "POST" {
        return Err("unsupported method".into());
    }
    let local = std::env::var("COURT_ALLOW_INSECURE_LOCALHOST").as_deref() == Ok("1")
        && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"));
    if !url.starts_with("https://") && !local {
        return Err("HTTPS is required".into());
    }
    #[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
    {
        wasi_request(method, url, headers, body, timeout_ms, max_bytes)
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
    {
        native_request(method, url, headers, body, timeout_ms, max_bytes)
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
fn native_request(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout_ms: u64,
    max_bytes: usize,
) -> Result<HttpResponse, String> {
    let started = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(timeout)
        .timeout_read(timeout)
        .build();
    let mut req = agent.request(method, url).set("User-Agent", USER_AGENT);
    for (name, value) in headers {
        req = req.set(name, value);
    }
    let result = match body {
        Some(bytes) => req.send_bytes(bytes),
        None => req.call(),
    };
    let response = match result {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(error)) => {
            return Err(
                if is_native_timeout(&error) || started.elapsed() >= timeout {
                    "HTTP request timed out"
                } else {
                    "HTTP transport failed"
                }
                .into(),
            );
        }
    };
    let status = response.status();
    let mut bytes = Vec::new();
    let mut reader = response.into_reader();
    let mut chunk = [0_u8; 8192];
    loop {
        if started.elapsed() >= timeout {
            return Err("HTTP request timed out".into());
        }
        let limit = (max_bytes.saturating_add(1) - bytes.len()).min(chunk.len());
        let read = reader.read(&mut chunk[..limit]).map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut || started.elapsed() >= timeout {
                "HTTP request timed out".to_string()
            } else {
                "HTTP body read failed".to_string()
            }
        })?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > max_bytes {
            return Err("HTTP response too large".into());
        }
    }
    Ok(HttpResponse {
        status,
        body: bytes,
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn wasi_request(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout_ms: u64,
    max_bytes: usize,
) -> Result<HttpResponse, String> {
    use wasi::http::outgoing_handler;
    use wasi::http::types::{
        Headers, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
    };
    use wasi::io::streams::StreamError;

    let deadline = deadline_ns(wasi::clocks::monotonic_clock::now(), timeout_ms);
    let parsed = url::Url::parse(url).map_err(|_| "invalid URL")?;
    let scheme = if parsed.scheme() == "https" {
        Scheme::Https
    } else {
        Scheme::Http
    };
    let fields = Headers::new();
    fields
        .set(&"User-Agent".into(), &[USER_AGENT.into()])
        .map_err(|_| "invalid User-Agent")?;
    for (name, value) in headers {
        fields
            .set(&(*name).into(), &[(*value).into()])
            .map_err(|_| "invalid HTTP header")?;
    }
    let request = OutgoingRequest::new(fields);
    let method = if method == "GET" {
        Method::Get
    } else {
        Method::Post
    };
    request.set_method(&method).map_err(|_| "invalid method")?;
    request
        .set_scheme(Some(&scheme))
        .map_err(|_| "invalid scheme")?;
    request
        .set_authority(Some(parsed.authority()))
        .map_err(|_| "invalid authority")?;
    let path = match parsed.query() {
        Some(query) => format!("{}?{query}", parsed.path()),
        None => parsed.path().to_string(),
    };
    request
        .set_path_with_query(Some(&path))
        .map_err(|_| "invalid request path")?;
    let outgoing = request.body().map_err(|_| "request body unavailable")?;
    if let Some(bytes) = body {
        let writable = outgoing
            .write()
            .map_err(|_| "request body write unavailable")?;
        let writable_pollable = writable.subscribe();
        let mut remaining = bytes;
        while !remaining.is_empty() {
            if wasi::clocks::monotonic_clock::now() >= deadline {
                return Err("HTTP request timed out".into());
            }
            let capacity = writable
                .check_write()
                .map_err(|_| wasi_elapsed_error(deadline))?;
            if capacity == 0 {
                wasi_wait_ready(&writable_pollable, deadline)?;
                continue;
            }
            let count = remaining
                .len()
                .min(usize::try_from(capacity).unwrap_or(usize::MAX))
                .min(4096);
            writable
                .write(&remaining[..count])
                .map_err(|_| wasi_elapsed_error(deadline))?;
            remaining = &remaining[count..];
        }
        writable.flush().map_err(|_| wasi_elapsed_error(deadline))?;
        wasi_wait_ready(&writable_pollable, deadline)?;
        writable
            .check_write()
            .map_err(|_| wasi_elapsed_error(deadline))?;
    }
    OutgoingBody::finish(outgoing, None).map_err(|_| "request body finish failed")?;

    let timeout_ns = timeout_ns(timeout_ms);
    let options = RequestOptions::new();
    let _ = options.set_connect_timeout(Some(timeout_ns));
    let _ = options.set_first_byte_timeout(Some(timeout_ns));
    let _ = options.set_between_bytes_timeout(Some(timeout_ns));
    let future = outgoing_handler::handle(request, Some(options))
        .map_err(|error| wasi_http_error(&error, deadline))?;
    let future_pollable = future.subscribe();
    let response_result = loop {
        if wasi::clocks::monotonic_clock::now() >= deadline {
            return Err("HTTP request timed out".into());
        }
        if let Some(result) = future.get() {
            break result;
        }
        wasi_wait_ready(&future_pollable, deadline)?;
    };
    let response = response_result
        .map_err(|_| wasi_elapsed_error(deadline))?
        .map_err(|error| wasi_http_error(&error, deadline))?;
    let status = response.status();
    let incoming = response.consume().map_err(|_| "HTTP body unavailable")?;
    let stream = incoming.stream().map_err(|_| "HTTP stream unavailable")?;
    let stream_pollable = stream.subscribe();
    let mut bytes = Vec::new();
    loop {
        if wasi::clocks::monotonic_clock::now() >= deadline {
            return Err("HTTP request timed out".into());
        }
        let read_len = (max_bytes.saturating_add(1) - bytes.len()).min(8192) as u64;
        match stream.read(read_len) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    wasi_wait_ready(&stream_pollable, deadline)?;
                    continue;
                }
                bytes.extend_from_slice(&chunk);
                if bytes.len() > max_bytes {
                    return Err("HTTP response too large".into());
                }
            }
            Err(StreamError::Closed) => {
                return Ok(HttpResponse {
                    status,
                    body: bytes,
                })
            }
            Err(_) => return Err(wasi_elapsed_error(deadline)),
        }
    }
}

#[cfg(all(test, not(all(target_arch = "wasm32", target_os = "wasi"))))]
mod tests {
    use super::{deadline_ns, is_native_timeout, timeout_ns};
    use std::io;

    #[test]
    fn native_timeout_cause_is_distinguished_from_transport() {
        let timeout = io::Error::from(io::ErrorKind::TimedOut);
        let refused = io::Error::from(io::ErrorKind::ConnectionRefused);
        assert!(is_native_timeout(&timeout));
        assert!(!is_native_timeout(&refused));
    }

    #[test]
    fn http_timeout_deadline_arithmetic_is_saturating() {
        assert_eq!(timeout_ns(20_000), 20_000_000_000);
        assert_eq!(deadline_ns(100, 20_000), 20_000_000_100);
        assert_eq!(deadline_ns(u64::MAX - 1, 20_000), u64::MAX);
        assert_eq!(timeout_ns(u64::MAX), u64::MAX);
    }
}
