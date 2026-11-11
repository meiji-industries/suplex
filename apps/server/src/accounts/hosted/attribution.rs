//! First-touch campaign attribution for `account_signed_up`. The first visit
//! to an entry route (`/download`, `/start`, `/auth/start`) that carries UTM
//! parameters or a referrer from another site keeps them in a first-party
//! cookie next to `suplex_visitor`. A signup reads the cookie. Only the five
//! UTM values and the referring hostname are kept, each bounded and limited to
//! a safe alphabet; a path or query of the referrer is never kept. `DNT: 1`
//! keeps nothing.

use axum::{
    http::{HeaderMap, header},
    response::Response,
};
use serde_json::{Map, Value, json};

pub const ATTRIBUTION_COOKIE: &str = "suplex_attribution";
const UTM: [&str; 5] = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
];
const REFERRING_DOMAIN: &str = "referring_domain";
const MAX_VALUE: usize = 64;
/// Thirty days.
const MAX_AGE: u32 = 30 * 24 * 60 * 60;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attribution(Vec<(&'static str, String)>);

/// A UTM value: 1 to 64 letters, digits, spaces, or `._~+-`.
fn utm_value(value: &str) -> Option<String> {
    let value = value.trim();
    ((1..=MAX_VALUE).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" ._~+-".contains(&b)))
    .then(|| value.to_owned())
}

/// A hostname: lowercase letters, digits, dots, and hyphens.
fn hostname(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    ((1..=253).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b)))
    .then_some(value)
}

fn known(key: &str) -> Option<&'static str> {
    UTM.into_iter()
        .chain([REFERRING_DOMAIN])
        .find(|known| *known == key)
}

impl Attribution {
    /// The UTM parameters of `query` and the hostname of `referer`, unless that is `own_host`.
    pub fn observe(query: Option<&str>, referer: Option<&str>, own_host: Option<&str>) -> Self {
        let mut fields = Vec::new();
        for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
            if let (Some(key), Some(value)) =
                (UTM.into_iter().find(|utm| *utm == key), utm_value(&value))
                && !fields.iter().any(|(known, _)| *known == key)
            {
                fields.push((key, value));
            }
        }
        let referrer = referer
            .and_then(|referer| url::Url::parse(referer).ok())
            .and_then(|url| url.host_str().and_then(hostname))
            .filter(|host| own_host.is_none_or(|own| !own.eq_ignore_ascii_case(host)));
        if let Some(referrer) = referrer {
            fields.push((REFERRING_DOMAIN, referrer));
        }
        Self(fields)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The cookie this browser holds, with every value checked again.
    pub fn from_cookie(headers: &HeaderMap) -> Option<Self> {
        let raw = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(name, _)| *name == ATTRIBUTION_COOKIE)
            .map(|(_, value)| value)?;
        let fields = url::form_urlencoded::parse(raw.as_bytes())
            .filter_map(|(key, value)| {
                let key = known(&key)?;
                let value = if key == REFERRING_DOMAIN {
                    hostname(&value)?
                } else {
                    utm_value(&value)?
                };
                Some((key, value))
            })
            .collect::<Vec<_>>();
        (!fields.is_empty()).then_some(Self(fields))
    }

    fn cookie_value(&self) -> String {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in &self.0 {
            serializer.append_pair(key, value);
        }
        serializer.finish()
    }

    /// Event properties: the UTM names and `referring_domain`.
    pub fn properties(&self) -> Map<String, Value> {
        self.0
            .iter()
            .map(|(key, value)| ((*key).to_owned(), json!(value)))
            .collect()
    }
}

/// Keeps the first attribution this browser brought. A later visit never replaces it.
pub fn remember(origin: &str, headers: &HeaderMap, query: Option<&str>, response: &mut Response) {
    if headers.get("dnt").is_some_and(|value| value == "1")
        || Attribution::from_cookie(headers).is_some()
    {
        return;
    }
    let own_host = url::Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned));
    let referer = headers
        .get(header::REFERER)
        .and_then(|value| value.to_str().ok());
    let attribution = Attribution::observe(query, referer, own_host.as_deref());
    if attribution.is_empty() {
        return;
    }
    let secure = if origin.starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{ATTRIBUTION_COOKIE}={}; Max-Age={MAX_AGE}; Path=/; HttpOnly; SameSite=Lax{secure}",
        attribution.cookie_value()
    );
    if let Ok(cookie) = cookie.parse() {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_bounded_utm_values_and_only_the_referrer_host() {
        let attribution = Attribution::observe(
            Some(
                "utm_source=newsletter&utm_medium=email&utm_campaign=launch%20week&utm_content=%3Cscript%3E&gclid=abc&utm_term=a",
            ),
            Some("https://News.Example.com/path/to/post?ref=ada@example.com"),
            Some("suplex.sh"),
        );
        assert_eq!(
            Value::Object(attribution.properties()),
            json!({
                "utm_source": "newsletter",
                "utm_medium": "email",
                "utm_campaign": "launch week",
                "utm_term": "a",
                "referring_domain": "news.example.com",
            })
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("{ATTRIBUTION_COOKIE}={}", attribution.cookie_value())
                .parse()
                .unwrap(),
        );
        assert_eq!(Attribution::from_cookie(&headers), Some(attribution));
        assert!(
            Attribution::observe(None, Some("https://suplex.sh/start"), Some("suplex.sh"))
                .is_empty()
        );
        let long = format!("utm_source={}", "a".repeat(65));
        assert!(Attribution::observe(Some(&long), None, None).is_empty());
    }

    #[test]
    fn a_forged_cookie_keeps_only_valid_fields() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("{ATTRIBUTION_COOKIE}=utm_source=ok&email=ada%40example.com&referring_domain=bad%2Fpath")
                .parse()
                .unwrap(),
        );
        assert_eq!(
            Value::Object(Attribution::from_cookie(&headers).unwrap().properties()),
            json!({"utm_source": "ok"})
        );
    }
}
