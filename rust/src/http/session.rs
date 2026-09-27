use axum::http::HeaderMap;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use getrandom::fill as rand_bytes;

use crate::{
    identity::auth::{self, AuthUser},
    platform::database::{DatabaseResult, SuplexDatabase},
};

pub const SESSION_COOKIE_NAME: &str = "sid_v1";
pub const LEGACY_SESSION_COOKIE_NAME: &str = "suplex_session";
pub const CSRF_COOKIE_NAME: &str = "csrf_v1";
pub const CSRF_HEADER_NAME: &str = "x-csrf-v1";

#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub port: u16,
    pub reachable_address: String,
    pub tailscale_exposure: String,
}

pub struct SessionUser {
    pub user: Option<AuthUser>,
    pub set_cookies: Vec<String>,
}

pub(crate) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut lines = headers.get_all("cookie").iter();
    let line = lines.next()?;
    // Fastify passes a repeated Cookie header as an array to @fastify/cookie,
    // whose parser yields no cookie names for that input.
    if lines.next().is_some() {
        return None;
    }
    line.to_str().ok()?.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then(|| decode_cookie_value(value.trim()))
    })
}

fn decode_cookie_value(value: &str) -> String {
    if !value.contains('%') {
        return value.to_owned();
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let Some((high, low)) = bytes.get(index + 1).zip(bytes.get(index + 2)) else {
                return value.to_owned();
            };
            let Some((high, low)) = hex_digit(*high).zip(hex_digit(*low)) else {
                return value.to_owned();
            };
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_owned())
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub fn is_loopback_host(config: &SessionConfig, host: Option<&str>) -> bool {
    let host = host.unwrap_or_default().to_ascii_lowercase();
    [
        format!("localhost:{}", config.port),
        format!("127.0.0.1:{}", config.port),
        format!("[::1]:{}", config.port),
    ]
    .contains(&host)
}

pub fn is_trusted_network_request(config: &SessionConfig, headers: &HeaderMap) -> bool {
    if headers.contains_key("tailscale-user-login") {
        return true;
    }
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    if is_loopback_host(config, host) {
        return true;
    }
    if config.tailscale_exposure != "direct" {
        return false;
    }
    let Ok(reachable) = url::Url::parse(&config.reachable_address) else {
        return false;
    };
    let Some(reachable_host) = reachable.host_str() else {
        return false;
    };
    let reachable_host = match reachable.port() {
        Some(port) => format!("{reachable_host}:{port}"),
        None => reachable_host.to_owned(),
    };
    host.is_some_and(|host| host.eq_ignore_ascii_case(&reachable_host))
}

pub fn set_session_cookies(
    config: &SessionConfig,
    session_token: &str,
    secure_override: Option<bool>,
) -> DatabaseResult<Vec<String>> {
    let secure = secure_override.unwrap_or(config.reachable_address.starts_with("https:"));
    let security = if secure { "; Secure" } else { "" };
    let mut csrf_bytes = [0_u8; 32];
    rand_bytes(&mut csrf_bytes)?;
    let csrf_token = URL_SAFE_NO_PAD.encode(csrf_bytes);
    Ok(vec![
        format!(
            "{SESSION_COOKIE_NAME}={session_token}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax{security}"
        ),
        format!(
            "{CSRF_COOKIE_NAME}={csrf_token}; Max-Age=604800; Path=/; SameSite=Strict{security}"
        ),
    ])
}

pub fn clear_session_cookies() -> Vec<String> {
    [
        SESSION_COOKIE_NAME,
        LEGACY_SESSION_COOKIE_NAME,
        CSRF_COOKIE_NAME,
    ]
    .into_iter()
    .map(|name| format!("{name}=; Max-Age=0; Path=/"))
    .collect()
}

pub fn session_user(
    database: &mut SuplexDatabase,
    headers: &HeaderMap,
    config: Option<&SessionConfig>,
    now: DateTime<Utc>,
) -> DatabaseResult<SessionUser> {
    let current_token = cookie(headers, SESSION_COOKIE_NAME).unwrap_or_default();
    if let Some(user) = auth::get_user_by_session(database, &current_token, now)? {
        return Ok(SessionUser {
            user: Some(user),
            set_cookies: Vec::new(),
        });
    }
    if let Some(config) = config
        && is_trusted_network_request(config, headers)
    {
        let signed_in = auth::development_sign_in(database, now)?;
        return Ok(SessionUser {
            user: Some(signed_in.user),
            set_cookies: set_session_cookies(config, &signed_in.session_token, Some(false))?,
        });
    }
    let legacy_token = cookie(headers, LEGACY_SESSION_COOKIE_NAME).unwrap_or_default();
    let user = auth::get_user_by_session(database, &legacy_token, now)?;
    let set_cookies = match (user.as_ref(), config) {
        (Some(_), Some(config)) => auth::rollover_legacy_session(database, &legacy_token, now)?
            .map(|replacement| set_session_cookies(config, &replacement, None))
            .transpose()?
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(SessionUser { user, set_cookies })
}

pub fn csrf_allowed(
    config: &SessionConfig,
    headers: &HeaderMap,
    method: &str,
    exempt: bool,
) -> bool {
    if exempt || matches!(method, "GET" | "HEAD" | "OPTIONS") {
        return true;
    }
    if cookie(headers, SESSION_COOKIE_NAME)
        .unwrap_or_default()
        .is_empty()
        && cookie(headers, LEGACY_SESSION_COOKIE_NAME)
            .unwrap_or_default()
            .is_empty()
    {
        return true;
    }
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    if let Ok(reachable) = url::Url::parse(&config.reachable_address)
        && origin.is_some_and(|origin| origin == reachable.origin().ascii_serialization())
    {
        return true;
    }
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    if is_loopback_host(config, host)
        && [
            format!("http://localhost:{}", config.port),
            format!("http://127.0.0.1:{}", config.port),
            format!("http://[::1]:{}", config.port),
        ]
        .iter()
        .any(|allowed| origin == Some(allowed))
    {
        return true;
    }
    let token = headers
        .get(CSRF_HEADER_NAME)
        .and_then(|value| value.to_str().ok());
    let expected = cookie(headers, CSRF_COOKIE_NAME);
    token.is_some_and(|token| token.len() >= 32 && Some(token) == expected.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;
    use axum::http::HeaderValue;

    fn config() -> SessionConfig {
        SessionConfig {
            port: 4111,
            reachable_address: "https://suplex.example.test:4111".to_owned(),
            tailscale_exposure: "serve".to_owned(),
        }
    }

    #[test]
    fn trust_and_csrf_preserve_missing_cookie_behavior() {
        let config = config();
        let mut headers = HeaderMap::new();
        assert!(csrf_allowed(&config, &headers, "POST", false));
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        assert!(is_trusted_network_request(&config, &headers));
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        assert!(!is_trusted_network_request(&config, &headers));
        let mut direct = config.clone();
        direct.tailscale_exposure = "direct".to_owned();
        assert!(is_trusted_network_request(&direct, &headers));
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        headers.insert("cookie", HeaderValue::from_static("sid_v1=token"));
        assert!(!csrf_allowed(&config, &headers, "POST", false));
        headers.insert("origin", HeaderValue::from_static("http://localhost:4111"));
        assert!(csrf_allowed(&config, &headers, "POST", false));
        headers.insert("origin", HeaderValue::from_static("https://elsewhere.test"));
        assert!(!csrf_allowed(&config, &headers, "POST", false));
        headers.insert(
            "x-csrf-v1",
            HeaderValue::from_static("12345678901234567890123456789012"),
        );
        headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=token; csrf_v1=12345678901234567890123456789012"),
        );
        assert!(csrf_allowed(&config, &headers, "POST", false));
        assert!(csrf_allowed(&config, &headers, "POST", true));
    }

    #[test]
    fn session_lookup_keeps_trusted_sign_in_before_legacy_rollover() {
        let filename =
            std::env::temp_dir().join(format!("suplex_session_{}.sqlite", std::process::id()));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        let result = session_user(&mut database, &headers, Some(&config()), now).unwrap();
        assert_eq!(result.user.unwrap().id, "user_development");
        assert_eq!(result.set_cookies.len(), 2);
        assert!(result.set_cookies[0].contains("sid_v1=session_v1_"));
        assert!(!result.set_cookies[0].contains("Secure"));
        let session_token = result.set_cookies[0]
            .split(';')
            .next()
            .unwrap()
            .strip_prefix("sid_v1=")
            .unwrap();
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={session_token}")).unwrap(),
        );
        let existing = session_user(&mut database, &headers, Some(&config()), now).unwrap();
        assert_eq!(existing.user.unwrap().id, "user_development");
        assert!(existing.set_cookies.is_empty());
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        let encoded = format!(
            "sid_v1={}",
            session_token.replace("session_v1_", "session%5Fv1%5F")
        );
        headers.insert("cookie", HeaderValue::from_str(&encoded).unwrap());
        assert_eq!(
            session_user(&mut database, &headers, Some(&config()), now)
                .unwrap()
                .user
                .unwrap()
                .id,
            "user_development"
        );
        headers.append("cookie", HeaderValue::from_static("other=value"));
        assert!(
            session_user(&mut database, &headers, Some(&config()), now)
                .unwrap()
                .user
                .is_none()
        );
        headers.remove("cookie");
        let no_reply = session_user(&mut database, &headers, None, now).unwrap();
        assert!(no_reply.user.is_none());
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
