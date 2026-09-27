//! Authenticated bytes for task-owned artifacts, including image previews.

use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use crate::tasks::TaskError;
use std::error::Error;

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use tower_http::services::ServeFile;

use crate::{
    coordination::root_session_store::{self, TaskArtifact},
    http::{AppState, contracts::typed::tasks::TaskArtifactParams, session, validation::ValidPath},
    platform::artifacts,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/artifacts/{artifact_id}", get(read))
        .route("/api/tasks/{task_id}/images/{artifact_id}", get(read))
}

fn scoped_artifact(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    artifact_id: &str,
) -> Result<TaskArtifact, Box<dyn Error>> {
    state.with_database(|database| {
        crate::tasks::authorize_task(database, user_id, task_id)?;
        root_session_store::task_artifact(database, task_id, artifact_id)?
            .ok_or_else(|| TaskError::not_found().into())
    })
}

fn reauthorize(state: &AppState, user_id: &str, task_id: &str) -> Result<(), Box<dyn Error>> {
    state.with_database(|database| {
        crate::tasks::authorize_task(database, user_id, task_id)?;
        Ok(())
    })
}

async fn serve_path(
    path: std::path::PathBuf,
    mime_type: mime::Mime,
    request: Request,
) -> Option<Response> {
    let response = ServeFile::new_with_mime(path, &mime_type)
        .try_call(request)
        .await
        .ok()?;
    let (parts, body) = response.into_parts();
    Some(Response::from_parts(parts, Body::new(body)))
}

async fn read(
    State(state): State<AppState>,
    ValidPath(TaskArtifactParams {
        task_id,
        artifact_id,
    }): ValidPath<TaskArtifactParams>,
    request: Request,
) -> Response {
    let session = match state.with_database(|database| {
        session::session_user(
            database,
            request.headers(),
            Some(&state.session_config),
            Utc::now(),
        )
    }) {
        Ok(session) => session,
        Err(error) => return ApiError::response(error),
    };
    let Some(user) = session.user else {
        return with_cookies(
            auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
            session.set_cookies,
        );
    };
    let cookies = session.set_cookies;
    let artifact = match scoped_artifact(&state, &user.id, &task_id, &artifact_id) {
        Ok(artifact) => artifact,
        Err(error) => {
            return with_cookies(ApiError::response(error), cookies);
        }
    };
    let Some(root) = state.artifact_root.clone() else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    let company_id = artifact.company_id.clone();
    let storage_path = artifact.storage_path.clone();
    let path = tokio::task::spawn_blocking(move || {
        artifacts::verified_path(&root, &company_id, &storage_path, &artifact.sha256)
            .map_err(crate::http::error::public_failure)
    })
    .await;
    let path = match path {
        Ok(Ok(Some(path))) => path,
        Ok(Ok(None)) => {
            return with_cookies(
                auth::error(
                    StatusCode::CONFLICT,
                    "The stored artifact failed its integrity check",
                ),
                cookies,
            );
        }
        Ok(Err(failure)) => {
            return with_cookies(failure.into_response(), cookies);
        }
        Err(_) => {
            return with_cookies(
                auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
                cookies,
            );
        }
    };
    if let Err(error) = reauthorize(&state, &user.id, &task_id) {
        return with_cookies(ApiError::response(error), cookies);
    }
    let Ok(content_type) = artifact.mime_type.parse::<mime::Mime>() else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    let mut response = match serve_path(path, content_type, request).await {
        Some(response) => response,
        None => {
            return with_cookies(
                auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
                cookies,
            );
        }
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        axum::http::HeaderValue::from_static("nosniff"),
    );
    with_cookies(response, cookies)
}

#[cfg(test)]
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
