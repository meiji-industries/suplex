#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::validation::{test_body, test_path};
    use axum::{body::Bytes, extract::Path};
    use serde_json::{Value, json};

    // The handlers validate their params and body in extractors; these
    // adapters run that validation for direct calls.
    async fn invite_user(state: State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
        match test_body(&headers, &body) {
            Ok(body) => super::invite_user(state, headers, body).await,
            Err(response) => *response,
        }
    }

    async fn revoke_credential(state: State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
        match test_path(json!({"credentialId": id})) {
            Ok(path) => super::revoke_credential(state, headers, path).await,
            Err(response) => *response,
        }
    }

    async fn revoke_user(state: State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
        match test_path(json!({"userId": id})) {
            Ok(path) => super::revoke_user(state, headers, path).await,
            Err(response) => *response,
        }
    }
    use crate::http::session;
    use crate::shared::time::now_millis_rfc3339;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{body::to_bytes, http::HeaderValue};

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
    async fn invitation_body_validation_precedes_csrf_and_admin_routes_preserve_raw_order() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            crate::shared::ids::random_hex_id("suplex_admin_route").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let signed_in = identity_auth::development_sign_in(&mut database, Utc::now()).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "https://suplex.example.test:4111".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", signed_in.session_token)).unwrap(),
        );
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        let invalid = invite_user(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"displayName":42}"#),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let no_origin = invite_user(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"displayName":"API member"}"#),
        )
        .await;
        assert_eq!(no_origin.status(), StatusCode::FORBIDDEN);
        headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        let created = invite_user(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"displayName":"API member"}"#),
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let raw =
            String::from_utf8(to_bytes(created.into_body(), 4096).await.unwrap().to_vec()).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let token = value["token"].as_str().unwrap();
        let user_id = value["user"]["id"].as_str().unwrap();
        let expires_at = value["expiresAt"].as_str().unwrap();
        assert!(token.starts_with("invite_v1_user_"));
        assert_eq!(token.len(), "invite_v1_user_".len() + 43);
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(expires_at)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            expires_at
        );
        assert!(expires_at.ends_with('Z'));
        assert_eq!(
            raw.replace(token, "TOKEN")
                .replace(user_id, "user_ID")
                .replace(expires_at, "TIMESTAMP"),
            r#"{"token":"TOKEN","kind":"user","expiresAt":"TIMESTAMP","user":{"id":"user_ID","displayName":"API member","username":"user_v1_user_ID","avatarSeed":"user_v1_user_ID","role":"member","status":"pending","companyIds":[]}}"#
        );
        assert_eq!(
            list_users(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            list_invitations(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        let credential_id = crate::shared::ids::random_hex_id("credential").unwrap();
        state.with_database(|database| database.connection().execute(
            "INSERT INTO suplex_credentials (id, user_id, credential_id, public_key, counter, transports, created_at) VALUES (?1, ?2, 'route-member-passkey', X'00', 0, '[]', ?3)",
            rusqlite::params![credential_id, user_id, now_millis_rfc3339()],
        )).unwrap();
        assert_eq!(
            list_credentials(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            revoke_credential(
                State(state.clone()),
                headers.clone(),
                Path(credential_id.clone())
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            revoke_credential(State(state.clone()), headers.clone(), Path(credential_id))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            list_audit(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            revoke_user(
                State(state.clone()),
                headers.clone(),
                Path(user_id.to_owned())
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            revoke_user(State(state), headers, Path(user_id.to_owned()))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
