#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::{
        body::to_bytes,
        http::{HeaderValue, header},
    };

    #[tokio::test]
    async fn profile_response_keeps_zod_field_order() {
        let response = validated_response(
            "projects.ProfileResponseSchema",
            json!({
                "id": "profile_fixed", "name": "Fixed", "role": "worker",
                "avatarSeed": "0123456789abcdef0123456789abcdef", "provider": "codex",
                "model": "gpt-6-sol", "reasoningLevel": "medium", "serviceTier": "priority",
                "providerInstanceId": null, "archivedAt": null,
                "createdAt": "2026-09-24T00:00:00.000Z", "updatedAt": "2026-09-24T00:00:00.000Z"
            }),
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
}
