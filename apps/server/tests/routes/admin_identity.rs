#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::session;
    use crate::{identity::auth as identity_auth, platform::database::{OpenMode, SuplexDatabase}};
    use axum::{body::to_bytes, http::HeaderValue};
    use serde_json::{Value, json};

    #[tokio::test]
    async fn audit_http_filters_nonstring_metadata() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            crate::shared::ids::random_hex_id("suplex_admin_route").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let signed_in = identity_auth::development_sign_in(&mut database, Utc::now()).unwrap();
        database.connection().execute(
            r#"INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES ('audit_fixed', NULL, NULL, 'fixture', NULL, NULL, '{"first":"one","second":"two","skip":1}', '2026-09-24T12:00:00.000Z')"#,
            [],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "https://suplex.example.test:4111".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(session::REQUEST_CLASS_HEADER, HeaderValue::from_static("local"));
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", signed_in.session_token)).unwrap(),
        );
        let response = list_audit(State(state.clone()), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json; charset=utf-8"
        );
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["events"][0]["metadata"],
            json!({"first":"one","second":"two"})
        );
        drop(state);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn legacy_invitation_and_credential_endpoints_are_retired() {
        let (state, _) = crate::http::routes::auth::tests::state();
        let app = crate::http::router(state);
        for path in ["/api/admin/invitations", "/api/admin/credentials"] {
            let (status, _, _) = crate::http::routes::avatars::tests::call(&app, "GET", path, None, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn role_endpoint_changes_roles_and_rejects_the_last_admin() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            crate::shared::ids::random_hex_id("suplex_role_route").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let signed_in = crate::http::routes::auth::tests::verified_sign_in(&mut database, Utc::now()).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_member', 'Member', 'user_member', 'user_member', 'member', 'active', '2026-09-24T12:00:00.000Z', '2026-09-24T12:00:00.000Z', 1)",
            [],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "https://suplex.example.test:4111".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(session::VERIFIED_HTTPS_HEADER, HeaderValue::from_static("1"));
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        headers.insert("origin", HeaderValue::from_static("https://suplex.example.test:4111"));
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", signed_in.session_token)).unwrap(),
        );
        let change = |user_id: &'static str, body: Value| {
            let state = state.clone();
            let headers = headers.clone();
            async move {
                let path = crate::http::validation::test_path(json!({"userId": user_id}))
                    .map_err(|response| *response)
                    .unwrap();
                let body = match crate::http::validation::test_body(
                    &headers,
                    &axum::body::Bytes::from(body.to_string()),
                ) {
                    Ok(body) => body,
                    Err(response) => return *response,
                };
                set_user_role(State(state), headers, path, body).await
            }
        };
        let response = change("user_member", json!({"role": "admin"})).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let response = change("user_member", json!({"role": "member", "companyId": "missing"})).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = change("user_member", json!({"role": "member"})).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        // The signed-in admin is the only active admin now.
        let response = change("user_development", json!({"role": "member"})).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["error"],
            "Suplex must keep at least one admin."
        );
        let response = change("user_member", json!({"role": "owner"})).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        drop(state);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
