#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use axum::{body::to_bytes, http::HeaderValue};

    use super::*;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };

    #[tokio::test]
    async fn retired_stub_checks_session_role_and_csrf_before_not_found() {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-unported-route-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed),
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('stub_member', 'Member', 'user_v1_stub_member', 'member', 'active', ?1, ?1, 1)",
            [now.to_rfc3339()],
        ).unwrap();
        let member_hash = crate::shared::hash::sha256_hex(b"stub_member_token");
        database.connection().execute(
            "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('stub_member_session', ?1, 'stub_member', ?2, ?3, 1)",
            rusqlite::params![member_hash, (now + chrono::Duration::days(1)).to_rfc3339(), now.to_rfc3339()],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "https://suplex.example.test:4113".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4113"));
        assert_eq!(
            guarded(&state, &headers, &Method::GET, Access::Administrator).status(),
            StatusCode::UNAUTHORIZED
        );
        headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=stub_member_token"),
        );
        assert_eq!(
            guarded(&state, &headers, &Method::GET, Access::Administrator).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            guarded(&state, &headers, &Method::GET, Access::Authenticated).status(),
            StatusCode::NOT_FOUND
        );
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        assert_eq!(
            guarded(&state, &headers, &Method::POST, Access::Administrator).status(),
            StatusCode::FORBIDDEN
        );
        headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4113"),
        );
        let response = guarded(&state, &headers, &Method::POST, Access::Administrator);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["error"],
            "Not found"
        );
        drop(state);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn every_known_unported_route_requires_a_session_then_returns_501() {
        let (state, filename) = auth::tests::state();
        let admin = state
            .with_database(|database| identity_auth::development_sign_in(database, Utc::now()))
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, crate::http::router(state)).into_future());
        let client = reqwest::Client::new();
        let cookie = format!("sid_v1={}", admin.session_token);
        let parameter = regex::Regex::new(r"\{[^}]+\}").unwrap();
        for (method, path, _) in ROUTES {
            let path = parameter.replace_all(path, "x");
            let request = |cookie: Option<&str>| {
                let request = client
                    .request(method.clone(), format!("http://{address}{path}"))
                    .header("origin", "https://suplex.example.test:4111");
                match cookie {
                    Some(cookie) => request.header("cookie", cookie),
                    None => request,
                }
            };
            let anonymous = request(None).send().await.unwrap();
            assert_eq!(
                anonymous.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
            let signed_in = request(Some(&cookie)).send().await.unwrap();
            assert_eq!(
                signed_in.status(),
                StatusCode::NOT_FOUND,
                "{method} {path}"
            );
            assert_eq!(
                signed_in.json::<serde_json::Value>().await.unwrap(),
                serde_json::json!({
                    "error": "Experimental Rust backend has not ported this route",
                    "code": "experimental_not_ported",
                }),
                "{method} {path}"
            );
        }
        server.abort();
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
