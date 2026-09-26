#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refresh_cookies_survive_a_domain_rejection() {
        let (state, path) = crate::http::routes::auth::tests::state();
        let app = axum::Router::new()
            .route(
                "/",
                axum::routing::get(|SessionUser(_): SessionUser| async {
                    Err::<(), ApiError>(PublicFailure::new(409, "Rejected").into())
                }),
            )
            .layer(axum::middleware::from_fn(cookie_refresh))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/"))
            .header("host", "localhost:4111")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 409);
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            2
        );
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"error":"Rejected"})
        );
        let response = client
            .get(format!("http://{address}/"))
            .header("host", "untrusted.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn extractor_refreshes_cookies_and_csrf_keeps_its_failure_envelope() {
        let (state, path) = crate::http::routes::auth::tests::state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, crate::http::router(state.clone())).into_future());
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/auth/me"))
            .header("host", "localhost:4111")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            2
        );
        let response = client
            .post(format!("http://{address}/api/auth/options"))
            .header("origin", "https://untrusted.example")
            .header("cookie", "sid_v1=present")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"error":"request_origin_invalid"})
        );
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(path);
    }
}
