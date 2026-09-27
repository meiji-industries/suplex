use crate::platform::system_events::{self, REQUEST_ID};
use axum::{extract::Request, middleware::Next, response::Response};
use serde_json::json;
use std::time::Instant;

pub(super) async fn request(request: Request, next: Next) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let started = Instant::now();
    REQUEST_ID
        .scope(uuid::Uuid::new_v4().to_string(), async move {
            let response = next.run(request).await;
            let status = response.status().as_u16();
            let level = if status >= 500 {
                50
            } else if status >= 400 {
                40
            } else if method == "GET" || method == "HEAD" {
                20
            } else {
                30
            };
            system_events::emit(json!({
                "type":"http", "state":"completed", "level":level,
                "method":method, "url":path, "status":status,
                "durationMs":started.elapsed().as_millis() as u64,
            }));
            response
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        response::IntoResponse,
        routing::{get, post},
    };
    use serde_json::Value;

    #[tokio::test]
    async fn requests_and_failures_are_correlated_without_credentials() {
        let logs = system_events::install_for_test();
        let prefix = format!("/logging-{}", uuid::Uuid::new_v4());
        let router = Router::new()
            .route(&format!("{prefix}/ok"), get(|| async { "ok" }))
            .route(&format!("{prefix}/mutate"), post(|| async { "ok" }))
            .route(
                &format!("{prefix}/fail"),
                get(|| async {
                    crate::shared::public_failure("provider secret=do-not-leak".into())
                        .into_response()
                }),
            )
            .route(
                &format!("{prefix}/reject"),
                get(|| async {
                    crate::shared::public_failure(
                        crate::shared::PublicFailure::new(422, "Rejected").into(),
                    )
                    .into_response()
                }),
            )
            .layer(axum::middleware::from_fn(request));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        for (method, path, expected) in [
            ("GET", "ok", 200),
            ("POST", "mutate", 200),
            ("GET", "fail", 500),
            ("GET", "reject", 422),
        ] {
            let response = client
                .request(
                    method.parse().unwrap(),
                    format!("http://{address}{prefix}/{path}?token=query-secret"),
                )
                .header("cookie", "suplex_session=cookie-secret")
                .header("authorization", "Bearer header-secret")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if expected == 500 {
                assert_eq!(
                    response.json::<Value>().await.unwrap(),
                    json!({"error":"Internal server error"})
                );
            }
        }
        server.abort();
        let raw = std::fs::read_to_string(logs.join("system.log")).unwrap();
        let records: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let requests: Vec<_> = records
            .iter()
            .filter(|record| {
                record["url"]
                    .as_str()
                    .is_some_and(|url| url.starts_with(&prefix))
            })
            .collect();
        assert_eq!(requests.len(), 4);
        for (record, level) in requests.iter().zip([20, 30, 50, 40]) {
            assert_eq!(record["level"], level);
            assert!(record["durationMs"].is_number());
            assert!(record["requestId"].is_string());
            assert!(!record["url"].as_str().unwrap().contains('?'));
        }
        let errors: Vec<_> = records
            .iter()
            .filter(|record| {
                record["type"] == "failure"
                    && requests
                        .iter()
                        .any(|request| request["requestId"] == record["requestId"])
            })
            .collect();
        assert_eq!(errors.len(), 2);
        assert!(errors.iter().any(|error| {
            error["reason"]
                .as_str()
                .unwrap()
                .contains("provider [REDACTED]")
        }));
        assert!(errors.iter().any(|error| error["reason"] == "Rejected"));
        let relevant = format!("{requests:?}{errors:?}");
        for secret in [
            "do-not-leak",
            "query-secret",
            "cookie-secret",
            "header-secret",
        ] {
            assert!(!relevant.contains(secret));
        }
    }
}
