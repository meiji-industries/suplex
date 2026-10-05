#[cfg(test)]
pub(crate) mod tests {
    use crate::http::error::public_failure;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::http::validation::test_body;
    use axum::{
        body::Bytes,
        http::{HeaderValue, header},
    };

    // The handlers validate their body in an extractor; these adapters run
    // that validation for direct calls.
    async fn update_me(state: State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
        match test_body(&headers, &body) {
            Ok(body) => super::update_me(state, headers, body).await,
            Err(response) => *response,
        }
    }

    async fn request_me(State(state): State<AppState>, headers: HeaderMap) -> Response {
        use axum::extract::FromRequestParts;
        let mut request = axum::http::Request::new(());
        *request.headers_mut() = headers;
        let (mut parts, _) = request.into_parts();
        match crate::http::access::SessionUser::from_request_parts(&mut parts, &state).await {
            Ok(user) => me(user).await,
            Err(error) => error.into_response(),
        }
    }

    #[test]
    fn service_failures_share_one_browser_envelope() {
        use crate::{
            identity::IdentityError, platform::PlatformError, projects::ProjectError,
            shared::PublicFailure, tasks::TaskError,
        };
        let public = |error: Box<dyn Error>| public_failure(error);
        assert_eq!(
            public(TaskError::new("Busy", 409).into()),
            PublicFailure::new(409, "Busy")
        );
        assert_eq!(
            public(
                TaskError::Failure {
                    status: 400,
                    code: "cursor_invalid",
                    message: "Bad cursor".into(),
                }
                .into()
            ),
            PublicFailure::new(400, "Bad cursor").with_code("cursor_invalid")
        );
        assert_eq!(
            public(TaskError::Conflict.into()),
            PublicFailure::new(409, "This idempotency key belongs to a different request")
        );
        assert_eq!(
            public(TaskError::Internal("disk".into()).into()),
            PublicFailure::internal()
        );
        assert_eq!(
            public(IdentityError::not_found().into()),
            PublicFailure::new(404, "Not found")
        );
        assert_eq!(
            public(IdentityError::auth("Taken", 409, "membership_duplicate").into()),
            PublicFailure::new(409, "Taken").with_code("membership_duplicate")
        );
        assert_eq!(
            public(ProjectError::new("Not found", 404, Vec::new()).into()),
            PublicFailure::new(404, "Not found").with_findings(json!([]))
        );
        assert_eq!(
            public(PlatformError::invalid_image_data().into()),
            PublicFailure::new(422, "Image data is invalid or too large")
                .with_code("invalid-image-data")
        );
        assert_eq!(public("unknown".into()), PublicFailure::internal());
    }
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::body::to_bytes;

    pub(crate) fn state() -> (AppState, std::path::PathBuf) {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let filename = std::env::temp_dir().join(format!(
            "suplex_auth_route_{}_{}_{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let config = session::SessionConfig {
            port: 4111,
            reachable_address: "https://suplex.example.test:4111".to_owned(),
            tailscale_exposure: "serve".to_owned(),
        };
        (AppState::new(database, config), filename)
    }

    pub(crate) fn require_remote_login(state: &AppState) {
        state
            .with_database(|database| {
                crate::identity::remote_access_repository::set_external_https_origin(
                    database,
                    Some("https://suplex.example.test:4111"),
                )
            })
            .unwrap();
    }

    pub(crate) fn verified_sign_in(database: &mut SuplexDatabase, now: chrono::DateTime<Utc>) -> crate::platform::database::DatabaseResult<auth::AuthResult> {
        let mut result = auth::development_sign_in(database, now)?;
        result.session_token = verified_session(database, &result.user.id, now)?;
        Ok(result)
    }

    pub(crate) fn verified_session(database: &SuplexDatabase, user_id: &str, now: chrono::DateTime<Utc>) -> crate::platform::database::DatabaseResult<String> {
        let id = if user_id == "user_development" { "user_67e55044-10b1-426f-9247-bb680e5fe0c8".to_owned() } else { format!("user_{}", uuid::Uuid::new_v4()) };
        if user_id == "user_development" {
            crate::accounts::link(database, &crate::accounts::wire::HostedAccount { id: id.clone(), email: "owner@example.com".into(), name: None }, &"k".repeat(43))?;
        } else {
            database.connection().execute("INSERT OR REPLACE INTO suplex_account_users (user_id, account_id, email) VALUES (?1, ?2, ?3)", rusqlite::params![user_id, id, format!("{user_id}@example.com")])?;
        }
        let token = auth::create_session(database, user_id, now)?;
        database.connection().execute("INSERT INTO suplex_account_sessions (token_hash, account_id) VALUES (?1, ?2)", rusqlite::params![crate::shared::hash::sha256_hex(&token), id])?;
        Ok(token)
    }

    pub(crate) fn operator_account(state: &AppState, now: chrono::DateTime<Utc>) -> String {
        state
            .with_database(|database| {
                auth::development_sign_in(database, now)?;
                let owner = crate::accounts::wire::HostedAccount { id: "user_67e55044-10b1-426f-9247-bb680e5fe0c8".into(), email: "owner@example.com".into(), name: None };
                crate::accounts::link(database, &owner, &"k".repeat(43))?;
                crate::accounts::members::accept(database, &owner, now)
            })
            .unwrap()
    }

    #[tokio::test]
    async fn status_cookie_and_sign_out_follow_existing_order() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        headers.insert(
            session::REQUEST_CLASS_HEADER,
            HeaderValue::from_static("local"),
        );
        let response = status(State(state.clone()), headers.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookies = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(cookies.len(), 2);
        assert!(cookies[0].starts_with("sid_v1=session_v1_"));
        assert!(cookies[1].starts_with("csrf_v1="));
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({ "required": false, "authenticated": true })
        );

        let without_cookie = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(without_cookie.status(), StatusCode::UNAUTHORIZED);
        let session_cookie = cookies[0].split(';').next().unwrap();
        headers.insert("cookie", HeaderValue::from_str(session_cookie).unwrap());
        let current = request_me(State(state.clone()), headers.clone()).await;
        let current_body = to_bytes(current.into_body(), 4096).await.unwrap();
        assert_eq!(
            current_body,
            r#"{"user":{"id":"user_development","displayName":"Operator","title":"","username":"operator@suplex.local","avatarSeed":"operator@suplex.local","role":"admin","status":"active","companyIds":[]}}"#
        );
        let wrong_origin = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        let signed_out = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(signed_out.status(), StatusCode::OK);
        assert_eq!(
            signed_out
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            3
        );
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        headers.remove(session::REQUEST_CLASS_HEADER);
        let after = request_me(State(state.clone()), headers).await;
        assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn passkey_endpoints_are_retired() {
        let (state, _) = state();
        let app = crate::http::router(state);
        for path in ["/api/auth/options", "/api/auth/verify", "/api/auth/passkeys/options", "/api/auth/invitation/options"] {
            let (status, _, _) = crate::http::routes::avatars::tests::call(&app, "POST", path, None, Some(json!({}))).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn profile_body_validation_precedes_csrf_and_session() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        headers.insert(
            session::REQUEST_CLASS_HEADER,
            HeaderValue::from_static("local"),
        );
        let signin = status(State(state.clone()), headers.clone()).await;
        let cookie = signin
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        headers.insert("cookie", HeaderValue::from_str(&cookie).unwrap());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let invalid = update_me(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let invalid_body = to_bytes(invalid.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&invalid_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-custom", "field": ".", "message": "Request value is invalid" }] })
        );
        let wrong_type = update_me(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"username":42}"#),
        )
        .await;
        assert_eq!(wrong_type.status(), StatusCode::BAD_REQUEST);
        let wrong_type_body = to_bytes(wrong_type.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&wrong_type_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".username", "message": "Request value is invalid" }] })
        );
        let missing = update_me(State(state.clone()), headers.clone(), Bytes::new()).await;
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        let missing_body = to_bytes(missing.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&missing_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".", "message": "Request value is invalid" }] })
        );
        let mut text_headers = headers.clone();
        text_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        let text = update_me(
            State(state.clone()),
            text_headers,
            Bytes::from_static(b"hello"),
        )
        .await;
        assert_eq!(text.status(), StatusCode::BAD_REQUEST);
        let text_body = to_bytes(text.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&text_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".", "message": "Request value is invalid" }] })
        );
        let valid = Bytes::from_static(
            br#"{"displayName":"\uFEFFUpdated Operator\uFEFF","username":"\uFEFFupdated-operator\uFEFF","avatarSeed":"\uFEFFupdated-avatar\uFEFF","title":" CTO "}"#,
        );
        let wrong_origin = update_me(State(state.clone()), headers.clone(), valid.clone()).await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        headers.insert("origin", HeaderValue::from_static("http://localhost:4111"));
        let updated = update_me(State(state.clone()), headers.clone(), valid).await;
        assert_eq!(updated.status(), StatusCode::OK);
        let body = to_bytes(updated.into_body(), 4096).await.unwrap();
        assert_eq!(
            body,
            r#"{"user":{"id":"user_development","displayName":"Updated Operator","title":"CTO","username":"updated-operator","avatarSeed":"updated-avatar","role":"admin","status":"active","companyIds":[]}}"#
        );
        headers.remove("cookie");
        headers.remove("origin");
        headers.remove(session::REQUEST_CLASS_HEADER);
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        let anonymous = update_me(
            State(state.clone()),
            headers,
            Bytes::from_static(br#"{"displayName":"Other"}"#),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
