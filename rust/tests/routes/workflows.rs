#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{
        body::to_bytes,
        http::{HeaderValue, StatusCode},
    };
    use serde_json::json;

    #[tokio::test]
    async fn workflow_api_edits_default_agents_validates_them_and_archives() {
        let (state, filename) = super::super::auth::tests::state();
        let admin = super::super::auth::tests::operator_passkey(&state, Utc::now());
        super::super::auth::tests::require_passkeys(&state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, crate::http::router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future());
        let client = reqwest::Client::new();
        let cookie = format!("sid_v1={admin}");
        let send = |method: reqwest::Method, path: &str, body: Option<Value>| {
            let request = client
                .request(method, format!("http://{address}{path}"))
                .header("host", "suplex.example.test:4111")
                .header("x-forwarded-host", "suplex.example.test:4111")
                .header("x-forwarded-proto", "https")
                .header("origin", "https://suplex.example.test:4111")
                .header("cookie", &cookie);
            match body {
                Some(body) => request.json(&body),
                None => request,
            }
            .send()
        };
        let url = "/api/admin/workflows/workflow_native_refine_pull_request";
        let saved = send(
            reqwest::Method::PATCH,
            url,
            Some(json!({"rootProfileId":"profile_native_root","advisorProfileIds":{"rater":"profile_native_root"},"description":"Fable rates and plans."})),
        )
        .await
        .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let saved: Value = saved.json().await.unwrap();
        assert_eq!(saved["engine"], "refine_pull_request");
        assert_eq!(saved["rootProfileId"], "profile_native_root");
        assert_eq!(
            saved["advisorProfileIds"],
            json!({"rater":"profile_native_root"})
        );
        assert_eq!(saved["description"], "Fable rates and plans.");
        for payload in [
            json!({"advisorProfileIds":{"reviewer":"profile_native_root"}}),
            json!({"rootProfileId":"profile_native_worker"}),
            json!({"workerProfileId":"profile_missing"}),
            json!({"deliveryTarget":"pull_request_draft"}),
        ] {
            let response = send(reqwest::Method::PATCH, url, Some(payload.clone()))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "{payload}"
            );
        }
        let taken = send(
            reqwest::Method::PATCH,
            url,
            Some(json!({"name":"Plan and build"})),
        )
        .await
        .unwrap();
        assert_eq!(taken.status(), StatusCode::CONFLICT);
        assert_eq!(
            taken.json::<Value>().await.unwrap(),
            json!({"error":"This workflow name is already in use"})
        );
        // A new engine drops Advisor choices it does not admit and clears a null setting.
        let switched: Value = send(
            reqwest::Method::PATCH,
            url,
            Some(json!({"engine":"independent_review","rootProfileId":null})),
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(switched["engine"], "independent_review");
        assert_eq!(switched["advisorProfileIds"], json!({}));
        assert!(switched.get("rootProfileId").is_none());
        let created = send(
            reqwest::Method::POST,
            "/api/admin/workflows",
            Some(json!({"name":"Fable repair","engine":"refine_pull_request","advisorProfileIds":{"rater":"profile_native_root"},"visualEvidence":"capture"})),
        )
        .await
        .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created: Value = created.json().await.unwrap();
        let id = created["id"].as_str().unwrap();
        assert!(id.starts_with("workflow_"));
        let duplicated = send(
            reqwest::Method::POST,
            &format!("/api/admin/workflows/{id}/duplicate"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(duplicated.status(), StatusCode::CREATED);
        let duplicated: Value = duplicated.json().await.unwrap();
        assert_eq!(duplicated["name"], "Fable repair (copy)");
        assert_eq!(duplicated["engine"], "refine_pull_request");
        assert_eq!(
            duplicated["advisorProfileIds"],
            json!({"rater":"profile_native_root"})
        );
        let archived: Value = send(
            reqwest::Method::PATCH,
            &format!("/api/admin/workflows/{id}"),
            Some(json!({"archived":true})),
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert!(archived["archivedAt"].is_string());
        let active: Value = send(reqwest::Method::GET, "/api/workflows", None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            active["workflows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|workflow| workflow["name"] != "Fable repair")
        );
        let all: Value = send(
            reqwest::Method::GET,
            "/api/workflows?includeArchived=true",
            None,
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(all["workflows"].as_array().unwrap().len(), 7);
        let audits: i64 = state.with_database(|database| {
            database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action IN ('workflow_created', 'workflow_updated')",
                [],
                |row| row.get(0),
            )
        }).unwrap();
        assert_eq!(audits, 5);
        let anonymous = client
            .post(format!("http://{address}/api/admin/workflows"))
            .header("host", "suplex.example.test:4111")
            .header("x-forwarded-host", "suplex.example.test:4111")
            .header("x-forwarded-proto", "https")
            .json(&json!({"name":"x","engine":"standard"}))
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn seeded_list_applies_archive_filter_after_query_validation_and_session() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            crate::shared::ids::random_hex_id("suplex_workflow_list").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let signed_in = identity_auth::development_sign_in(&mut database, Utc::now()).unwrap();
        database.connection().execute(
            "UPDATE suplex_workflows SET archived_at = '2026-09-24T12:00:00.000Z' WHERE id = 'workflow_native_standard'",
            [],
        ).unwrap();
        database.connection().execute(
            "UPDATE suplex_workflows SET configuration_json = '{\"advisorProfileIds\":{\"rater\":\"r\",\"planner_b\":\"b\",\"reviewer\":\"x\",\"planner_a\":\"a\"}}' WHERE id = 'workflow_native_standard'",
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
        let invalid = list(
            State(state.clone()),
            OriginalUri("/api/workflows?includeArchived=false".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let invalid: serde_json::Value =
            serde_json::from_slice(&to_bytes(invalid.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(invalid["findings"][0]["code"], "invalid-invalid_value");
        assert_eq!(invalid["findings"][0]["field"], ".includeArchived");
        let unknown = list(
            State(state.clone()),
            OriginalUri("/api/workflows?other=true".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        let unknown: serde_json::Value =
            serde_json::from_slice(&to_bytes(unknown.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(unknown["findings"][0]["code"], "invalid-unrecognized_keys");
        assert_eq!(unknown["findings"][0]["field"], ".");
        let active = list(
            State(state.clone()),
            OriginalUri("/api/workflows".parse().unwrap()),
            headers.clone(),
        )
        .await;
        assert_eq!(active.status(), StatusCode::OK);
        let active: serde_json::Value =
            serde_json::from_slice(&to_bytes(active.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(active["workflows"].as_array().unwrap().len(), 4);
        let all = list(
            State(state.clone()),
            OriginalUri("/api/workflows?includeArchived=true".parse().unwrap()),
            headers,
        )
        .await;
        assert_eq!(all.status(), StatusCode::OK);
        let all = to_bytes(all.into_body(), 8192).await.unwrap();
        let raw = String::from_utf8(all.to_vec()).unwrap();
        assert!(raw.contains(
            r#""advisorProfileIds":{"reviewer":"x","planner_a":"a","planner_b":"b","rater":"r"}"#
        ));
        let all: serde_json::Value = serde_json::from_slice(&all).unwrap();
        assert_eq!(all["workflows"].as_array().unwrap().len(), 5);
        assert_eq!(all["workflows"][2]["id"], "workflow_native_standard");
        drop(state);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
