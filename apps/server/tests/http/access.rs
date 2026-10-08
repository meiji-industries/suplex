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
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                remote_access_boundary,
            ))
            .layer(axum::middleware::from_fn(cookie_refresh))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .into_future(),
        );
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
        assert_eq!(response.status(), 403);
        assert_eq!(response.headers().get_all(header::SET_COOKIE).iter().count(), 0);
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
            tokio::spawn(axum::serve(listener, crate::http::router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future());
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
            .post(format!("http://{address}/api/account/logout"))
            .header("host", "localhost:4111")
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

    #[tokio::test]
    async fn remote_access_always_rejects_automatic_cookies() {
        let (state, path) = crate::http::routes::auth::tests::state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, crate::http::router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future());
        let client = reqwest::Client::new();
        let automatic = client.get(format!("http://{address}/api/auth/me"))
            .header("host", "localhost:4111")
            .send().await.unwrap();
        assert_eq!(automatic.status(), 200);
        let cookie = automatic.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap()
            .split(';').next().unwrap().to_owned();
        let serve = client.get(format!("http://{address}/api/auth/me"))
            .header("host", "suplex.example.test:4111")
            .header("x-forwarded-host", "suplex.example.test:4111")
            .header("x-forwarded-proto", "https")
            .header("x-forwarded-for", "100.64.0.2")
            .header("cookie", cookie)
            .send().await.unwrap();
        let serve_status = serve.status();
        let serve_has_cookie = serve.headers().contains_key(header::SET_COOKIE);
        let serve_body = serve.text().await.unwrap();
        assert_eq!(serve_status, 401, "{serve_body}");
        assert!(!serve_has_cookie);
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn foreign_origin_without_cookie_cannot_use_automatic_access() {
        let (state, path) = crate::http::routes::auth::tests::state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, crate::http::router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future());
        let response = reqwest::Client::new().put(format!("http://{address}/api/admin/access"))
            .header("host", "remote.example.test:4111")
            .header("origin", "https://foreign.example.test")
            .json(&serde_json::json!({"externalHttpsOrigin":null}))
            .send().await.unwrap();
        assert_eq!(response.status(), 403);
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn insecure_https_origin_is_rejected_without_changing_policy() {
        let (mut state, path) = crate::http::routes::auth::tests::state();
        state.session_config.reachable_address = "http://127.0.0.1:4111".into();
        let before = state
            .with_database(|database| crate::identity::remote_access_repository::external_https_origin(database))
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                crate::http::router(state.clone())
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .into_future(),
        );
        let response = reqwest::Client::new()
            .put(format!("http://{address}/api/admin/access"))
            .header("host", "localhost:4111")
            .header("origin", "http://localhost:4111")
            .json(&serde_json::json!({
                "externalHttpsOrigin": "http://remote.example.test"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(
            state
                .with_database(|database| crate::identity::remote_access_repository::external_https_origin(database))
                .unwrap(),
            before
        );
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(path);
    }
}
