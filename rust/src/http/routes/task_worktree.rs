//! Opens a task worktree in a desktop application on the Suplex host. A remote
//! browser can copy the path but can never cause a local desktop launch.

use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use crate::shared::time::now_millis_rfc3339;
use std::net::SocketAddr;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::{Extensions, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;

use crate::{
    http::{
        AppState,
        contracts::typed::tasks::{TaskIdParams, WorktreeOpenBody},
        session,
        validation::{ValidPath, body_contract, valid},
    },
    tasks::worktree_open::{self, Launcher},
};

use super::{auth, profiles::authorize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/worktree/apps", get(apps))
        .route("/api/tasks/{task_id}/worktree/open", post(open))
}

pub(crate) use crate::tasks::repository::task_worktree;

fn loopback_peer(extensions: &Extensions) -> bool {
    extensions
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(address)| match address.ip() {
            std::net::IpAddr::V4(ip) => ip == std::net::Ipv4Addr::LOCALHOST,
            std::net::IpAddr::V6(ip) => {
                ip == std::net::Ipv6Addr::LOCALHOST
                    || ip.to_ipv4_mapped() == Some(std::net::Ipv4Addr::LOCALHOST)
            }
        })
}

fn direct_loopback_request(state: &AppState, headers: &HeaderMap, extensions: &Extensions) -> bool {
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    session::is_loopback_host(&state.session_config, host)
        && [
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-real-ip",
        ]
        .iter()
        .all(|name| !headers.contains_key(*name))
        && loopback_peer(extensions)
}

async fn apps(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
    extensions: Extensions,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let worktree = state
        .with_database(|database| task_worktree(database, &user_id, &task_id))
        .map_err(ApiError::response);
    let response = match worktree {
        Err(response) => response,
        Ok((_, None)) => auth::error(StatusCode::NOT_FOUND, "Worktree not found"),
        Ok(_) if !direct_loopback_request(&state, &headers, &extensions) => {
            Json(json!({"apps": []})).into_response()
        }
        Ok(_) => {
            let apps = tokio::task::spawn_blocking(worktree_open::worktree_launchers)
                .await
                .unwrap_or_default();
            Json(json!({"apps": apps.iter().map(|app| json!({"id": app.id, "label": app.label})).collect::<Vec<_>>()}))
                .into_response()
        }
    };
    with_cookies(response, cookies)
}

async fn open(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    extensions: Extensions,
    body: Bytes,
) -> Response {
    open_with(state, task_id, headers, extensions, body, || {
        (
            worktree_open::worktree_launchers(),
            worktree_open::configured_editor_launcher(None),
        )
    })
    .await
}

pub(crate) async fn open_with(
    state: AppState,
    task_id: String,
    headers: HeaderMap,
    extensions: Extensions,
    body: Bytes,
    discover: fn() -> (Vec<Launcher>, Option<Launcher>),
) -> Response {
    let app = match valid::<TaskIdParams>(json!({"taskId": task_id}))
        .and_then(|_| body_contract::<WorktreeOpenBody>(&headers, &body))
    {
        Ok(body) => body.app,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "POST", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (company_id, path) =
        match state.with_database(|database| task_worktree(database, &user_id, &task_id)) {
            Ok((company_id, Some(path))) => (company_id, path),
            Ok((_, None)) => {
                return with_cookies(
                    auth::error(StatusCode::NOT_FOUND, "Worktree not found"),
                    cookies,
                );
            }
            Err(error) => {
                return with_cookies(ApiError::response(error), cookies);
            }
        };
    if !direct_loopback_request(&state, &headers, &extensions) {
        return with_cookies(
            (
                StatusCode::FORBIDDEN,
                Json(json!({"ok": false, "error": "Opening a worktree is available only from the Suplex host"})),
            )
                .into_response(),
            cookies,
        );
    }
    let (launchers, editor) = tokio::task::spawn_blocking(discover)
        .await
        .unwrap_or_default();
    let Some(launcher) = worktree_open::worktree_launcher(&app, launchers, editor) else {
        return with_cookies(
            (
                StatusCode::NOT_IMPLEMENTED,
                Json(json!({"ok": false, "error": "This application is not available on this Suplex host"})),
            )
                .into_response(),
            cookies,
        );
    };
    let mut command = tokio::process::Command::new(&launcher.command);
    command
        .args((launcher.args)(&path))
        .stdin(std::process::Stdio::null());
    if launcher.cwd_is_path {
        command.current_dir(&path);
    }
    let response = match command.output().await {
        Err(error) => Json(json!({"ok": false, "error": error.to_string()})).into_response(),
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let error = [stderr, stdout]
                .into_iter()
                .find(|text| !text.is_empty())
                .unwrap_or_else(|| "Could not open the worktree".into());
            Json(json!({"ok": false, "error": error})).into_response()
        }
        Ok(_) => {
            let recorded = state.with_database(|database| {
                crate::identity::audit::record(
                    database,
                    &crate::identity::audit::AuditEvent {
                        id: &uuid::Uuid::new_v4().to_string(),
                        actor_user_id: Some(&user_id),
                        actor_agent_id: None,
                        action: "worktree_opened",
                        target_user_id: None,
                        company_id: Some(&company_id),
                        metadata_json: &json!({"taskId": task_id, "app": launcher.id}).to_string(),
                        created_at: &now_millis_rfc3339(),
                    },
                )
            });
            match recorded {
                Ok(_) => Json(json!({"ok": true})).into_response(),
                Err(_) => auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            }
        }
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/task_worktree.rs");
