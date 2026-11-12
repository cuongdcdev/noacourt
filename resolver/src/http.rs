use std::time::{Duration, Instant};

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
use std::io::Read;

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
fn wasi_http_error(
    error: &wasi::http::types::ErrorCode,
    started: Instant,
    timeout: Duration,
) -> String {
    use wasi::http::types::ErrorCode;

    let timed_out = matches!(
        error,
        ErrorCode::DnsTimeout
            | ErrorCode::ConnectionTimeout
            | ErrorCode::ConnectionReadTimeout
            | ErrorCode::ConnectionWriteTimeout
            | ErrorCode::HttpResponseTimeout
    );
    if timed_out || started.elapsed() >= timeout {
        "HTTP request timed out".into()
    } else {
        "HTTP transport failed".into()
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn wasi_elapsed_error(started: Instant, timeout: Duration) -> String {
    if started.elapsed() >= timeout {
        "HTTP request timed out".into()
    } else {
        "HTTP transport failed".into()
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
    response
        .into_reader()
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut || started.elapsed() >= timeout {
                "HTTP request timed out".to_string()
            } else {
                "HTTP body read failed".to_string()
            }
        })?;
    if bytes.len() > max_bytes {
        return Err("HTTP response too large".into());
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

    let started = Instant::now();
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
        outgoing
            .write()
            .map_err(|_| "request body write unavailable")?
            .blocking_write_and_flush(bytes)
            .map_err(|_| "request body write failed")?;
    }
    OutgoingBody::finish(outgoing, None).map_err(|_| "request body finish failed")?;

    let timeout = Duration::from_millis(timeout_ms);
    let timeout_ns = timeout.as_nanos().min(u64::MAX as u128) as u64;
    let options = RequestOptions::new();
    options
        .set_connect_timeout(Some(timeout_ns))
        .map_err(|_| "connect timeout invalid")?;
    options
        .set_first_byte_timeout(Some(timeout_ns))
        .map_err(|_| "first byte timeout invalid")?;
    options
        .set_between_bytes_timeout(Some(timeout_ns))
        .map_err(|_| "between bytes timeout invalid")?;
    let future = outgoing_handler::handle(request, Some(options))
        .map_err(|error| wasi_http_error(&error, started, timeout))?;
    let response_result = match future.get() {
        Some(result) => result,
        None => {
            future.subscribe().block();
            future
                .get()
                .ok_or_else(|| wasi_elapsed_error(started, timeout))?
        }
    };
    let response = response_result
        .map_err(|_| wasi_elapsed_error(started, timeout))?
        .map_err(|error| wasi_http_error(&error, started, timeout))?;
    let status = response.status();
    let incoming = response.consume().map_err(|_| "HTTP body unavailable")?;
    let stream = incoming.stream().map_err(|_| "HTTP stream unavailable")?;
    let mut bytes = Vec::new();
    loop {
        if started.elapsed() >= timeout {
            return Err("HTTP request timed out".into());
        }
        let read_len = (max_bytes.saturating_add(1) - bytes.len()).min(8192) as u64;
        match stream.blocking_read(read_len) {
            Ok(chunk) => {
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
            Err(_) => return Err(wasi_elapsed_error(started, timeout)),
        }
    }
}

#[cfg(all(test, not(all(target_arch = "wasm32", target_os = "wasi"))))]
mod tests {
    use super::is_native_timeout;
    use std::io;

    #[test]
    fn native_timeout_cause_is_distinguished_from_transport() {
        let timeout = io::Error::from(io::ErrorKind::TimedOut);
        let refused = io::Error::from(io::ErrorKind::ConnectionRefused);
        assert!(is_native_timeout(&timeout));
        assert!(!is_native_timeout(&refused));
    }
}
