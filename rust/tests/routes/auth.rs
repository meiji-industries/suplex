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
    async fn invitation_options(state: State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
        match test_body(&headers, &body) {
            Ok(body) => super::invitation_options(state, headers, body).await,
            Err(response) => *response,
        }
    }

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

    pub(crate) fn require_passkeys(state: &AppState) {
        state
            .with_database(|database| {
                crate::identity::remote_access_repository::update(
                    database,
                    crate::identity::remote_access_repository::RemoteAccessPolicy::Passkeys {
                        external_https_origin: Some(
                            "https://suplex.example.test:4111".to_owned(),
                        ),
                    },
                )
            })
            .unwrap();
    }

    pub(crate) fn operator_passkey(state: &AppState, now: chrono::DateTime<Utc>) -> String {
        state
            .with_database(|database| {
                auth::development_sign_in(database, now)?;
                auth::create_session(database, "user_development", now)
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
    async fn ceremony_body_validation_precedes_csrf_and_consumes_no_challenge() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("sid_v1=session_v1_fake"),
        );
        let malformed = invitation_options(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"token":42}"#),
        )
        .await;
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
        let malformed_body = to_bytes(malformed.into_body(), 4096).await.unwrap();
        assert_eq!(
            malformed_body,
            r#"{"error":"Invalid request","findings":[{"code":"invalid-invalid_type","field":".token","message":"Request value is invalid"}]}"#
        );
        let csrf = invitation_options(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"token":"invalid"}"#),
        )
        .await;
        assert_eq!(csrf.status(), StatusCode::FORBIDDEN);
        let mut authentication_headers = HeaderMap::new();
        authentication_headers.insert(session::VERIFIED_HTTPS_HEADER, HeaderValue::from_static("1"));
        authentication_headers.insert("origin", HeaderValue::from_static("https://suplex.example.test:4111"));
        let no_credentials = authentication_options(State(state.clone()), authentication_headers).await;
        assert_eq!(no_credentials.status(), StatusCode::BAD_REQUEST);
        let no_credentials_body = to_bytes(no_credentials.into_body(), 1024).await.unwrap();
        assert_eq!(no_credentials_body, r#"{"error":"No passkey is enrolled"}"#);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn signed_fresh_passkey_over_isolated_tcp_listener() {
        use chrono::Duration;
        use rusqlite::params;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        use crate::identity::webauthn::test_support::synthetic;

        async fn post(address: std::net::SocketAddr, path: &str, body: String) -> String {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            let request = format!(
                "POST {path} HTTP/1.1\r\nHost: suplex.example.test:4111\r\nOrigin: https://suplex.example.test:4111\r\nX-Forwarded-Host: suplex.example.test:4111\r\nX-Forwarded-Proto: https\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            String::from_utf8(response).unwrap()
        }
        fn body(response: &str) -> serde_json::Value {
            serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
        }

        let (state, filename) = state();
        let token = format!("invite_v1_user_{}", "A".repeat(43));
        let now = Utc::now();
        state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_existing', 'Fixture member', 'user_v1_user_existing', 'user_v1_user_existing', 'member', 'pending', ?1, ?1, 1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at, metadata_json) VALUES ('invitation_tcp', ?1, 'user', 'Fixture member', 'user_existing', ?2, ?3, '{}')", params![crate::shared::hash::sha256_hex(&token), (now + Duration::days(1)).to_rfc3339(), now.to_rfc3339()]).unwrap();
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, crate::http::router(server_state).into_make_service_with_connect_info::<std::net::SocketAddr>())
                .await
                .unwrap();
        });
        let offered = post(
            address,
            "/api/auth/invitation/options",
            json!({"token":token}).to_string(),
        )
        .await;
        assert!(offered.starts_with("HTTP/1.1 200 OK\r\n"), "{offered}");
        let offered = body(&offered);
        let signed = synthetic(&json!({
            "mode":"register", "options":offered["options"],
            "origin":"https://suplex.example.test:4111"
        }));
        let enrolled = post(
            address,
            "/api/auth/invitation/verify",
            json!({
                "token":token, "challengeId":offered["challengeId"], "response":signed["response"]
            })
            .to_string(),
        )
        .await;
        assert!(enrolled.starts_with("HTTP/1.1 200 OK\r\n"), "{enrolled}");
        assert!(
            enrolled.contains("set-cookie: sid_v1=session_v1_"),
            "{enrolled}"
        );
        assert!(enrolled.contains("set-cookie: csrf_v1="), "{enrolled}");
        assert!(enrolled.ends_with(r#"{"user":{"id":"user_existing","displayName":"Fixture member","title":"","username":"user_v1_user_existing","avatarSeed":"user_v1_user_existing","role":"member","status":"active","companyIds":[]}}"#), "{enrolled}");
        let authentication = post(address, "/api/auth/options", "{}".into()).await;
        assert!(
            authentication.starts_with("HTTP/1.1 200 OK\r\n"),
            "{authentication}"
        );
        let authentication = body(&authentication);
        let assertion = synthetic(&json!({
            "mode":"authenticate", "options":authentication["options"],
            "origin":"https://suplex.example.test:4111",
            "credentialId":signed["credentialId"],
            "token":signed["token"]
        }));
        let signed_in = post(
            address,
            "/api/auth/verify",
            json!({
                "challengeId":authentication["challengeId"], "response":assertion["response"]
            })
            .to_string(),
        )
        .await;
        assert!(signed_in.starts_with("HTTP/1.1 200 OK\r\n"), "{signed_in}");
        assert!(signed_in.ends_with(r#"{"user":{"id":"user_existing","displayName":"Fixture member","title":"","username":"user_v1_user_existing","avatarSeed":"user_v1_user_existing","role":"member","status":"active","companyIds":[]}}"#), "{signed_in}");
        let counter: u32 = state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT counter FROM suplex_credentials WHERE credential_id = ?1",
                    [signed["credentialId"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!(counter, 1);
        let detached_token = format!("invite_v1_user_{}", "B".repeat(43));
        state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_detached', 'Detached member', 'user_v1_user_detached', 'user_v1_user_detached', 'member', 'pending', ?1, ?1, 1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at, metadata_json) VALUES ('invitation_detached', ?1, 'user', 'Detached member', 'user_detached', ?2, ?3, '{}')", params![crate::shared::hash::sha256_hex(&detached_token), (now + Duration::days(1)).to_rfc3339(), now.to_rfc3339()]).unwrap();
        });
        let detached_options = state.with_database(|database| {
            ceremony::begin_registration(
                database,
                "user",
                &detached_token,
                WebAuthnSite {
                    origin: "https://suplex.example.test:4111",
                    rp_id: "suplex.example.test",
                },
                now,
            )
            .unwrap()
        });
        let detached_signed = synthetic(&json!({
            "mode":"register", "options":detached_options.options,
            "origin":"https://suplex.example.test:4111"
        }));
        let detached_state = state.clone();
        let detached = tokio::task::spawn_blocking(move || {
            run_registration_ceremony(RegistrationAttempt {
                state: detached_state,
                kind: "user",
                token: detached_token,
                challenge_id: detached_options.challenge_id,
                response: PreparedCredential {
                    shape_valid: true,
                    payload: Some(detached_signed["response"].clone()),
                },
                origin: "https://suplex.example.test:4111".into(),
                rp_id: "suplex.example.test".into(),
                secure_cookie: true,
            })
        });
        drop(detached);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let active: bool = state.with_database(|database| {
                    database
                        .connection()
                        .query_row(
                            "SELECT status = 'active' FROM suplex_users WHERE id = 'user_detached'",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap()
                });
                if active {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
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
