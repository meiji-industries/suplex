//! Bounded, same-origin provider requests (`src/integrations/provider-http.ts`).

use std::{error::Error, time::Duration};

use serde_json::Value;

pub use super::issue_tracker::ProviderHttpFailure;

pub type ProviderResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub const MAXIMUM_BYTES: usize = 8 * 1024 * 1024;

/// A client that never follows redirects and stops after 30 seconds.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .expect("provider HTTP client")
}

/// `boundedProviderResponse`: a successful body no larger than `maximum`.
pub async fn bounded_response(
    mut response: reqwest::Response,
    maximum: usize,
) -> ProviderResult<Vec<u8>> {
    if !response.status().is_success() {
        return Err(Box::new(ProviderHttpFailure {
            status: response.status().as_u16(),
        }));
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > maximum)
    {
        return Err("The provider response is too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > maximum {
            return Err("The provider response is too large".into());
        }
    }
    Ok(bytes)
}

/// `providerBytes`: only same-origin URLs ever receive the credential.
pub async fn provider_bytes(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &url::Url,
    origin: &str,
    authorization: &str,
    body: Option<(Vec<u8>, String)>,
) -> ProviderResult<Vec<u8>> {
    if url.origin().ascii_serialization() != origin
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("The provider returned an unsafe URL".into());
    }
    let mut request = client
        .request(method, url.clone())
        .header("Accept", "application/json")
        .header("Authorization", authorization);
    if let Some((bytes, content_type)) = body {
        request = request.header("Content-Type", content_type).body(bytes);
    }
    bounded_response(request.send().await?, MAXIMUM_BYTES).await
}

/// `providerJson`: an empty body is JSON `null`.
pub async fn provider_json(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &url::Url,
    origin: &str,
    authorization: &str,
    body: Option<(Vec<u8>, String)>,
) -> ProviderResult<Value> {
    let bytes = provider_bytes(client, method, url, origin, authorization, body).await?;
    Ok(if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)?
    })
}

#[cfg(test)]
mod tests {
    use axum::{Router, http::StatusCode, routing::get};

    use super::*;

    #[tokio::test]
    async fn requests_stay_on_origin_fail_on_status_and_bound_the_body() {
        let app = Router::new()
            .route("/ok", get(|| async { r#"{"ok":true}"# }))
            .route("/empty", get(|| async { "" }))
            .route("/denied", get(|| async { StatusCode::FORBIDDEN }))
            .route("/large", get(|| async { "x".repeat(MAXIMUM_BYTES + 1) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = client();
        let url = |path: &str| url::Url::parse(&format!("{origin}{path}")).unwrap();
        let get = |path: &'static str| {
            let http = http.clone();
            let origin = origin.clone();
            let url = url(path);
            async move {
                provider_json(&http, reqwest::Method::GET, &url, &origin, "Bearer t", None).await
            }
        };
        assert_eq!(get("/ok").await.unwrap(), serde_json::json!({"ok": true}));
        assert_eq!(get("/empty").await.unwrap(), Value::Null);
        let denied = get("/denied").await.unwrap_err();
        assert_eq!(
            denied
                .downcast_ref::<ProviderHttpFailure>()
                .map(|failure| failure.status),
            Some(403)
        );
        assert_eq!(
            get("/large").await.unwrap_err().to_string(),
            "The provider response is too large"
        );
        let other = url::Url::parse("https://example.com/ok").unwrap();
        let unsafe_url = provider_json(
            &http,
            reqwest::Method::GET,
            &other,
            &origin,
            "Bearer t",
            None,
        )
        .await;
        assert_eq!(
            unsafe_url.unwrap_err().to_string(),
            "The provider returned an unsafe URL"
        );
        server.abort();
    }
}
