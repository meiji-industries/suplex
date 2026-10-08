mod tests {
    use super::*;
    use crate::{
        http::session::SessionConfig,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::body::to_bytes;
    use uuid::Uuid;

    #[tokio::test]
    async fn stored_video_supports_ranges_and_unsatisfiable_ranges() {
        let directory = std::env::temp_dir().join(format!("suplex-range-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("video.bin");
        std::fs::write(&path, b"0123456789").unwrap();

        let request = Request::builder()
            .header(header::RANGE, "bytes=2-5")
            .body(Body::empty())
            .unwrap();
        let response = serve_path(path.clone(), "video/mp4".parse().unwrap(), request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(
            to_bytes(response.into_body(), 10).await.unwrap(),
            &b"2345"[..]
        );

        let request = Request::builder()
            .header(header::RANGE, "bytes=20-30")
            .body(Body::empty())
            .unwrap();
        let response = serve_path(path, "video/mp4".parse().unwrap(), request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn artifact_route_rejects_an_unauthenticated_request() {
        let directory = std::env::temp_dir().join(format!("suplex-route-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database =
            SuplexDatabase::open(&directory.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        )
        .with_artifact_root(directory.join("artifacts"));
        let response = read(
            State(state),
            ValidPath(TaskArtifactParams {
                task_id: "task_missing".to_owned(),
                artifact_id: "artifact_missing".to_owned(),
            }),
            Request::new(Body::empty()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn scoped_artifact_denies_a_user_from_another_company() {
        let (directory, _, database, task_id) = crate::tasks::artifacts::tests::fixture();
        let now = Utc::now().to_rfc3339();
        database.connection().execute(
            "INSERT INTO suplex_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('artifact_real', 'company_media', ?1, 'delivery-image', 'proof.png', 'image/png', 8, 'digest', 'company_media/objects/aa/artifact_real.bin', ?2)",
            [&task_id, &now],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_foreign', 'Foreign', 'foreign@example.invalid', 'foreign', 'member', 'active', ?1, ?1, 1)",
            [&now],
        ).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        );
        assert!(scoped_artifact(&state, "user_development", &task_id, "artifact_real").is_ok());
        assert!(scoped_artifact(&state, "user_foreign", &task_id, "artifact_real").is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
