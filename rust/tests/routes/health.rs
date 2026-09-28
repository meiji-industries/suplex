#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::health::{check, tailscale_hostname};
    use crate::{
        http::session::SessionConfig,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::body::to_bytes;
    use serde_json::json;

    #[tokio::test]
    async fn health_query_keeps_public_field_order_for_empty_duplicate_and_unknown_keys() {
        let Err(invalid) = query(Some("projectId=&other=x")) else {
            panic!("invalid health query was accepted");
        };
        let body: Value =
            serde_json::from_slice(&to_bytes((*invalid).into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(
            body["findings"],
            json!([
                {"code":"invalid-too_small","field":".projectId","message":"Request value is invalid"},
                {"code":"invalid-unrecognized_keys","field":".","message":"Request value is invalid"},
            ])
        );
        let Err(duplicate) = query(Some("projectId=x&projectId=y&profileIds=")) else {
            panic!("duplicate health query was accepted");
        };
        let body: Value =
            serde_json::from_slice(&to_bytes((*duplicate).into_body(), 4096).await.unwrap())
                .unwrap();
        assert_eq!(
            body["findings"],
            json!([
                {"code":"invalid-invalid_type","field":".projectId","message":"Request value is invalid"},
                {"code":"invalid-too_small","field":".profileIds","message":"Request value is invalid"},
            ])
        );
    }

    #[tokio::test]
    async fn health_uses_live_owned_checks_and_authorizes_requested_context() {
        let root = std::env::temp_dir().join(format!("suplex-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = SuplexDatabase::open(&root.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".into(),
                tailscale_exposure: "off".into(),
            },
        )
        .with_artifact_root(root.join("artifacts"))
        .with_project_roots(root.join("repositories"), root.join("worktrees"));
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_environment_settings SET min_free_disk_gb = 0 WHERE id = 'host'",
                    [],
                )
                .unwrap();
        });
        std::fs::create_dir_all(root.join("worktrees")).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:4113".parse().unwrap());
        headers.insert(
            crate::http::session::REQUEST_CLASS_HEADER,
            "local".parse().unwrap(),
        );
        let fake_github = check(
            "gh-auth",
            "GitHub",
            "warning",
            "Sign in to GitHub",
            json!({"method":"device","source":"none","status":"sign_in_required"}),
        );
        let response = health_with_github(
            state.clone(),
            None,
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 128 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["reachableAddress"], "http://127.0.0.1:4113");
        assert_eq!(body["ready"], true);
        assert_eq!(body["checks"][0]["id"], "database");
        assert_eq!(body["checks"][0]["status"], "healthy");
        assert_eq!(body["checks"][1]["id"], "artifact-root");
        assert_eq!(body["checks"][1]["status"], "healthy");
        assert_eq!(body["checks"][2]["status"], "healthy");
        assert_eq!(body["checks"][3]["id"], "git");
        assert!(
            body["checks"][3]["details"]["version"]
                .as_str()
                .unwrap()
                .starts_with("libgit2 ")
        );
        // Unit tests use a Herdr binary that is never installed.
        assert_eq!(body["checks"][4]["summary"], "Herdr is not installed");
        assert_eq!(body["checks"][5]["details"]["method"], "device");
        state.with_database(|database| {
            database.connection().execute("UPDATE suplex_environment_settings SET min_free_disk_gb = 1024 WHERE id = 'host'", []).unwrap();
        });
        let low = health_with_github(
            state.clone(),
            None,
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        let low: Value =
            serde_json::from_slice(&to_bytes(low.into_body(), 128 * 1024).await.unwrap()).unwrap();
        assert_eq!(low["checks"][2]["status"], "warning");
        assert!(
            regex::Regex::new(r"^Worktree root: \d+\.\d\d GB free; Artifact root: \d+\.\d\d GB free; minimum is 1024\.00 GB$")
                .unwrap()
                .is_match(low["checks"][2]["summary"].as_str().unwrap())
        );
        assert_eq!(
            low["checks"][2]["details"]["minFreeBytes"],
            1_099_511_627_776_u64
        );
        assert_eq!(low["checks"][6]["id"], "backup");
        assert_eq!(low["checks"][6]["summary"], "No backup has been made yet");
        assert_eq!(
            tailscale_hostname(br#"{"Self":{"DNSName":"host.tailnet.ts.net."}}"#).as_deref(),
            Some("host.tailnet.ts.net")
        );
        assert_eq!(
            tailscale_hostname(br#"{"Self":{"DNSName":"host.local."}}"#),
            None
        );
        let unknown = health_with_github(
            state.clone(),
            Some("profileIds=missing".into()),
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        let unknown_project = health_with_github(
            state.clone(),
            Some("projectId=missing".into()),
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(unknown_project.status(), StatusCode::NOT_FOUND);
        let conflict = health_with_github(
            state.clone(),
            Some("projectId=x&profileIds=y".into()),
            headers.clone(),
            Some(fake_github),
        )
        .await;
        assert_eq!(conflict.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            health_with_github(
                state.clone(),
                Some("other=x".into()),
                HeaderMap::new(),
                None
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
