#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::validation::test_body;
    use axum::body::Bytes;
    use serde_json::Value;

    async fn create(state: State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
        match test_body(&headers, &body) {
            Ok(body) => super::create(state, headers, body).await,
            Err(response) => *response,
        }
    }
    use crate::http::session;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::{
        body::to_bytes,
        http::{HeaderValue, header},
    };

    #[tokio::test]
    async fn profile_response_keeps_zod_field_order() {
        let response = respond_profile(
            Ok(serde_json::from_value(json!({
                "id": "profile_fixed", "name": "Fixed", "role": "worker",
                "avatarSeed": "0123456789abcdef0123456789abcdef", "provider": "codex",
                "model": "gpt-6-sol", "reasoningLevel": "medium", "serviceTier": "priority",
                "providerInstanceId": null, "archivedAt": null,
                "createdAt": "2026-09-24T00:00:00.000Z", "updatedAt": "2026-09-24T00:00:00.000Z"
            }))
            .unwrap()),
            StatusCode::OK,
        );
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            body,
            r#"{"provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"priority","providerInstanceId":null,"name":"Fixed","role":"worker","avatarSeed":"0123456789abcdef0123456789abcdef","id":"profile_fixed","archivedAt":null,"createdAt":"2026-09-24T00:00:00.000Z","updatedAt":"2026-09-24T00:00:00.000Z"}"#
        );
    }

    #[tokio::test]
    async fn profile_validation_precedes_origin_and_session_checks() {
        let filename = std::env::temp_dir().join(format!(
            "suplex_profile_route_{}_{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
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
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            "origin",
            HeaderValue::from_static("https://wrong.example.test"),
        );
        let invalid = create(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(invalid.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "Invalid request");
        assert!(
            body["findings"]
                .as_array()
                .is_some_and(|findings| !findings.is_empty())
        );
        let query = list(
            State(state.clone()),
            headers.clone(),
            RawQuery(Some("includeArchived=true&includeArchived=true".to_owned())),
        )
        .await;
        assert_eq!(query.status(), StatusCode::BAD_REQUEST);
        headers.insert("cookie", HeaderValue::from_static("sid_v1=invalid"));
        let valid = create(
            State(state.clone()),
            headers,
            Bytes::from_static(br#"{"provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"priority","name":"Profile","role":"worker","avatarSeed":"0123456789abcdef0123456789abcdef"}"#),
        ).await;
        assert_eq!(valid.status(), StatusCode::FORBIDDEN);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn admins_set_role_defaults_and_members_read_them() {
        let (state, filename) = super::super::auth::tests::state();
        let now = Utc::now();
        let admin = crate::http::routes::auth::tests::operator_account(&state, now);
        let (member, worker) = state.with_database(|database| {
            let input = ProfileInput {
                name: "Spare Worker".to_owned(),
                role: "worker".to_owned(),
                avatar_seed: "0123456789abcdef0123456789abcdef".to_owned(),
                provider: "codex".to_owned(),
                model: "gpt-6-sol".to_owned(),
                reasoning_level: "medium".to_owned(),
                service_tier: "default".to_owned(),
                provider_instance_id: None,
            };
            let worker = agent_profiles::create(database, "user_development", &input, now).unwrap().id;
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'M', 'member', 'member', 'active', ?1, ?1, 1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_defaults', 'Defaults', 'active', ?1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_memberships (company_id, user_id, created_at) VALUES ('company_defaults', 'member', ?1)", [now.to_rfc3339()]).unwrap();
            let member = crate::http::routes::auth::tests::verified_session(database, "member", now).unwrap();
            (member, worker)
        });
        crate::http::routes::auth::tests::require_remote_login(&state);
        let app = crate::http::router(state.clone());
        let call = crate::http::routes::avatars::tests::call;
        let admin = format!("sid_v1={admin}");
        let member = format!("sid_v1={member}");
        let set_path = format!("/api/admin/profiles/{worker}/default");

        let (status, _, body) = call(&app, "GET", "/api/profiles/defaults", Some(&member), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"root":"profile_native_root","alt":"profile_native_independent","worker":"profile_native_worker"})
        );
        let (status, _, _) = call(&app, "POST", &set_path, Some(&member), Some(json!({"slot":"worker"}))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = call(&app, "POST", &set_path, Some(&admin), Some(json!({"slot":"lead"}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, body) = call(&app, "POST", &set_path, Some(&admin), Some(json!({"slot":"root"}))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["error"],
            "Select a Coordinator agent for the default Coordinator"
        );
        let (status, _, _) = call(&app, "POST", "/api/admin/profiles/profile_missing/default", Some(&admin), Some(json!({"slot":"worker"}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, body) = call(&app, "POST", &set_path, Some(&admin), Some(json!({"slot":"worker"}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["worker"], worker.as_str());
        let (_, _, body) = call(&app, "GET", "/api/profiles/defaults", Some(&member), None).await;
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"root":"profile_native_root","alt":"profile_native_independent","worker":worker})
        );
        let (status, _, body) = call(&app, "DELETE", &format!("/api/admin/profiles/{worker}"), Some(&admin), None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["error"],
            "Select another default Worker before you delete this agent"
        );
        drop(app);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
