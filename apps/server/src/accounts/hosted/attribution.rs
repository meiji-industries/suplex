//! First-touch campaign attribution for a new Suplex account. A visit to an
//! entry route (`/download`, `/start`, `/start/email`, `/auth/start`) that
//! carries UTM parameters, ad click IDs, or a referrer from another site
//! keeps them in a first-party cookie next to `suplex_visitor`. A login
//! attempt also keeps them, so a magic link opened in another browser still
//! has them. A signup stores them on the new account (`account_attribution`).
//!
//! Only the five UTM values, the referring hostname, and the five ad click
//! IDs are kept, each bounded and limited to a safe alphabet; a path or query
//! of the referrer is never kept. Click IDs are kept only when the request
//! query has `consent=granted` and the request has no `DNT: 1` or
//! `Sec-GPC: 1` header. `DNT: 1` keeps nothing. Each value is first touch: a
//! later visit can add a click ID that is missing, but never replaces a
//! value. UTM values and the referrer stay one touch: a later visit adds
//! them only when the cookie has none.

use axum::{
    http::{HeaderMap, header},
    response::Response,
};
use serde_json::{Map, Value, json};

pub const ATTRIBUTION_COOKIE: &str = "suplex_attribution";
pub const UTM: [&str; 5] = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
];
pub const REFERRING_DOMAIN: &str = "referring_domain";
/// Google Ads (`gclid`, `gbraid`, `wbraid`), Microsoft Ads, and Meta click IDs.
pub const CLICK_IDS: [&str; 5] = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid"];
/// Every field, in storage order.
pub const FIELDS: [&str; 11] = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    REFERRING_DOMAIN,
    "gclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "fbclid",
];
const MAX_VALUE: usize = 64;
/// Real click IDs are about 100 characters; this leaves room for longer ones.
const MAX_CLICK_ID: usize = 256;
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

/// A click ID: 1 to 256 letters, digits, or `._~-`. A longer value is
/// dropped, never cut, because a cut ID matches no click.
fn click_id(value: &str) -> Option<String> {
    let value = value.trim();
    ((1..=MAX_CLICK_ID).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b)))
    .then(|| value.to_owned())
}

fn is_click_id(key: &str) -> bool {
    CLICK_IDS.contains(&key)
}

/// The known field `key` with a valid `value`.
fn field(key: &str, value: &str) -> Option<(&'static str, String)> {
    let key = FIELDS.into_iter().find(|known| *known == key)?;
    let value = if key == REFERRING_DOMAIN {
        hostname(value)?
    } else if is_click_id(key) {
        click_id(value)?
    } else {
        utm_value(value)?
    };
    Some((key, value))
}

/// `DNT: 1` or `Sec-GPC: 1`.
pub fn privacy_signal(headers: &HeaderMap) -> bool {
    ["dnt", "sec-gpc"]
        .into_iter()
        .any(|name| headers.get(name).is_some_and(|value| value == "1"))
}

/// The first `consent` value of `query`.
fn consent(query: Option<&str>) -> Option<String> {
    url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .find(|(key, _)| key == "consent")
        .map(|(_, value)| value.into_owned())
}

/// Click IDs are kept only with `consent=granted` and no privacy signal.
pub fn click_ids_allowed(headers: &HeaderMap, query: Option<&str>) -> bool {
    !privacy_signal(headers) && consent(query).as_deref() == Some("granted")
}

impl Attribution {
    /// The UTM parameters of `query`, its click IDs when `click_ids` is true,
    /// and the hostname of `referer`, unless that is `own_host`.
    pub fn observe(
        query: Option<&str>,
        referer: Option<&str>,
        own_host: Option<&str>,
        click_ids: bool,
    ) -> Self {
        let mut attribution = Self::default();
        for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
            if key == REFERRING_DOMAIN || (!click_ids && is_click_id(&key)) {
                continue;
            }
            if let Some((key, value)) = field(&key, &value) {
                attribution.add(key, value);
            }
        }
        let referrer = referer
            .and_then(|referer| url::Url::parse(referer).ok())
            .and_then(|url| url.host_str().and_then(hostname))
            .filter(|host| own_host.is_none_or(|own| !own.eq_ignore_ascii_case(host)));
        if let Some(referrer) = referrer {
            attribution.add(REFERRING_DOMAIN, referrer);
        }
        attribution
    }

    /// Known fields with valid values. The first value of a repeated key wins.
    pub fn from_pairs<K: AsRef<str>, V: AsRef<str>>(
        pairs: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        let mut attribution = Self::default();
        for (key, value) in pairs {
            if let Some((key, value)) = field(key.as_ref(), value.as_ref()) {
                attribution.add(key, value);
            }
        }
        attribution
    }

    /// Parses `encode` output, checking every value again.
    pub fn decode(raw: &str) -> Self {
        Self::from_pairs(url::form_urlencoded::parse(raw.as_bytes()))
    }

    /// URL-encoded pairs, for the cookie and the login attempt.
    pub fn encode(&self) -> String {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in &self.0 {
            serializer.append_pair(key, value);
        }
        serializer.finish()
    }

    fn add(&mut self, key: &'static str, value: String) {
        if self.get(key).is_none() {
            self.0.push((key, value));
        }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(known, _)| *known == key)
            .map(|(_, value)| value.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn has_campaign(&self) -> bool {
        self.0.iter().any(|(key, _)| !is_click_id(key))
    }

    /// Adds what `later` has and this does not. UTM values and the referrer
    /// come as one touch, only when this has none of them; each click ID
    /// comes alone. No value is replaced.
    pub fn merge(&mut self, later: &Self) {
        let campaign = !self.has_campaign();
        for (key, value) in &later.0 {
            if campaign || is_click_id(key) {
                self.add(key, value.clone());
            }
        }
    }

    /// Removes the click IDs.
    pub fn without_click_ids(mut self) -> Self {
        self.0.retain(|(key, _)| !is_click_id(key));
        self
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
        let attribution = Self::decode(raw);
        (!attribution.is_empty()).then_some(attribution)
    }

    /// The cookie for a signup request. A privacy signal removes the click IDs.
    pub fn for_signup(headers: &HeaderMap) -> Option<Self> {
        let attribution = Self::from_cookie(headers)?;
        let attribution = if privacy_signal(headers) {
            attribution.without_click_ids()
        } else {
            attribution
        };
        (!attribution.is_empty()).then_some(attribution)
    }

    /// Event properties: the UTM names and `referring_domain`. Click IDs
    /// are not sent to PostHog; they stay on the account row.
    pub fn properties(&self) -> Map<String, Value> {
        self.0
            .iter()
            .filter(|(key, _)| !is_click_id(key))
            .map(|(key, value)| ((*key).to_owned(), json!(value)))
            .collect()
    }
}

/// Keeps the first attribution this browser brought and returns what the
/// browser holds after this request. A later visit adds only missing values.
/// `consent=denied` or a privacy signal removes kept click IDs.
pub fn remember(
    origin: &str,
    headers: &HeaderMap,
    query: Option<&str>,
    response: &mut Response,
) -> Attribution {
    let existing = Attribution::from_cookie(headers).unwrap_or_default();
    let mut next = existing.clone();
    if privacy_signal(headers) || consent(query).as_deref() == Some("denied") {
        next = next.without_click_ids();
    }
    if headers.get("dnt").is_none_or(|value| value != "1") {
        let own_host = url::Url::parse(origin)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned));
        let referer = headers
            .get(header::REFERER)
            .and_then(|value| value.to_str().ok());
        next.merge(&Attribution::observe(
            query,
            referer,
            own_host.as_deref(),
            click_ids_allowed(headers, query),
        ));
    }
    if next == existing {
        return next;
    }
    let secure = if origin.starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    let age = if next.is_empty() { 0 } else { MAX_AGE };
    let cookie = format!(
        "{ATTRIBUTION_COOKIE}={}; Max-Age={age}; Path=/; HttpOnly; SameSite=Lax{secure}",
        next.encode()
    );
    if let Ok(cookie) = cookie.parse() {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    const GCLID: &str = "Cj0KCQiA-example_click.id~1";

    fn cookie_headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("{ATTRIBUTION_COOKIE}={value}").parse().unwrap(),
        );
        headers
    }

    fn set_cookie(response: &Response) -> Option<String> {
        response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .find(|value| value.starts_with(ATTRIBUTION_COOKIE))
    }

    #[test]
    fn keeps_bounded_utm_values_and_only_the_referrer_host() {
        let attribution = Attribution::observe(
            Some(
                "utm_source=newsletter&utm_medium=email&utm_campaign=launch%20week&utm_content=%3Cscript%3E&gclid=abc&utm_term=a&referring_domain=forged.example",
            ),
            Some("https://News.Example.com/path/to/post?ref=ada@example.com"),
            Some("suplex.sh"),
            false,
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
        // Without consent the click ID is dropped.
        assert_eq!(attribution.get("gclid"), None);
        let headers = cookie_headers(&attribution.encode());
        assert_eq!(Attribution::from_cookie(&headers), Some(attribution));
        assert!(
            Attribution::observe(
                None,
                Some("https://suplex.sh/start"),
                Some("suplex.sh"),
                true
            )
            .is_empty()
        );
        let long = format!("utm_source={}", "a".repeat(65));
        assert!(Attribution::observe(Some(&long), None, None, true).is_empty());
    }

    #[test]
    fn keeps_valid_click_ids_with_consent_through_the_cookie() {
        let query = format!(
            "gclid={GCLID}&gbraid=gb-1&wbraid=wb-1&msclkid=ms.1&fbclid=fb_1&utm_source=ads&gclid=second"
        );
        let attribution = Attribution::observe(Some(&query), None, None, true);
        for (key, value) in [
            ("gclid", GCLID),
            ("gbraid", "gb-1"),
            ("wbraid", "wb-1"),
            ("msclkid", "ms.1"),
            ("fbclid", "fb_1"),
            ("utm_source", "ads"),
        ] {
            assert_eq!(attribution.get(key), Some(value), "{key}");
        }
        // Click IDs are not PostHog properties.
        assert_eq!(
            Value::Object(attribution.properties()),
            json!({"utm_source": "ads"})
        );
        let headers = cookie_headers(&attribution.encode());
        assert_eq!(Attribution::from_cookie(&headers), Some(attribution));

        let longest = "a".repeat(256);
        assert_eq!(
            Attribution::observe(Some(&format!("gclid={longest}")), None, None, true).get("gclid"),
            Some(longest.as_str())
        );
        for bad in [
            "a".repeat(257),
            "has space".into(),
            "a%2Fb".into(),
            "a+b".into(),
            "".into(),
        ] {
            assert!(
                Attribution::observe(Some(&format!("gclid={bad}")), None, None, true).is_empty(),
                "{bad}"
            );
        }
    }

    #[test]
    fn click_ids_need_granted_consent_and_no_privacy_signal() {
        let mut headers = HeaderMap::new();
        assert!(click_ids_allowed(&headers, Some("consent=granted")));
        assert!(!click_ids_allowed(&headers, None));
        assert!(!click_ids_allowed(&headers, Some("consent=denied")));
        assert!(!click_ids_allowed(
            &headers,
            Some("consent=denied&consent=granted")
        ));
        headers.insert("sec-gpc", "1".parse().unwrap());
        assert!(!click_ids_allowed(&headers, Some("consent=granted")));
        let mut headers = HeaderMap::new();
        headers.insert("dnt", "1".parse().unwrap());
        assert!(!click_ids_allowed(&headers, Some("consent=granted")));

        let origin = "https://suplex.sh";
        let query = format!("gclid={GCLID}&utm_source=ads");
        // No consent: UTM only.
        let mut response = Response::default();
        let kept = remember(origin, &HeaderMap::new(), Some(&query), &mut response);
        assert_eq!(kept.encode(), "utm_source=ads");
        // Sec-GPC: UTM only, as today.
        let mut headers = HeaderMap::new();
        headers.insert("sec-gpc", "1".parse().unwrap());
        let mut response = Response::default();
        let granted = format!("{query}&consent=granted");
        let kept = remember(origin, &headers, Some(&granted), &mut response);
        assert_eq!(kept.encode(), "utm_source=ads");
        // DNT: nothing.
        let mut headers = HeaderMap::new();
        headers.insert("dnt", "1".parse().unwrap());
        let mut response = Response::default();
        assert!(remember(origin, &headers, Some(&granted), &mut response).is_empty());
        assert_eq!(set_cookie(&response), None);
        // Consent: both.
        let mut response = Response::default();
        let kept = remember(origin, &HeaderMap::new(), Some(&granted), &mut response);
        assert_eq!(kept.get("gclid"), Some(GCLID));
        assert!(set_cookie(&response).unwrap().contains("Max-Age=2592000"));
    }

    #[test]
    fn a_utm_only_cookie_gains_click_ids_without_replacing_values() {
        let origin = "https://suplex.sh";
        let headers = cookie_headers("utm_source=first&utm_campaign=one&gclid=kept-1");
        let mut response = Response::default();
        let kept = remember(
            origin,
            &headers,
            Some("utm_source=second&utm_medium=cpc&gclid=new-1&fbclid=fb-1&consent=granted"),
            &mut response,
        );
        assert_eq!(
            kept.encode(),
            "utm_source=first&utm_campaign=one&gclid=kept-1&fbclid=fb-1"
        );
        assert!(set_cookie(&response).unwrap().starts_with(
            "suplex_attribution=utm_source=first&utm_campaign=one&gclid=kept-1&fbclid=fb-1;"
        ));
        // Nothing new: no Set-Cookie.
        let mut response = Response::default();
        remember(origin, &headers, Some("utm_source=other"), &mut response);
        assert_eq!(set_cookie(&response), None);
        // A withdrawn choice removes the kept click IDs.
        let mut response = Response::default();
        let kept = remember(origin, &headers, Some("consent=denied"), &mut response);
        assert_eq!(kept.encode(), "utm_source=first&utm_campaign=one");
        assert!(set_cookie(&response).unwrap().contains("utm_campaign=one;"));
        // A cookie with only click IDs removed is cleared.
        let mut response = Response::default();
        remember(
            origin,
            &cookie_headers("gclid=a"),
            Some("consent=denied"),
            &mut response,
        );
        assert!(set_cookie(&response).unwrap().contains("Max-Age=0"));
    }

    #[test]
    fn a_forged_cookie_keeps_only_valid_fields() {
        let headers = cookie_headers(
            "utm_source=ok&email=ada%40example.com&referring_domain=bad%2Fpath&gclid=bad%20id&fbclid=fb-ok",
        );
        let attribution = Attribution::from_cookie(&headers).unwrap();
        assert_eq!(attribution.encode(), "utm_source=ok&fbclid=fb-ok");
        assert_eq!(
            Value::Object(attribution.properties()),
            json!({"utm_source": "ok"})
        );
        let mut gpc = headers.clone();
        gpc.insert("sec-gpc", "1".parse().unwrap());
        assert_eq!(
            Attribution::for_signup(&gpc).unwrap().encode(),
            "utm_source=ok"
        );
    }
}
