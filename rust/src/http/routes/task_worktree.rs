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
use rusqlite::params;
use serde_json::{Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{self, finding, tasks as task_contracts},
        session, validation,
    },
    tasks::worktree_open::{self, Launcher, WORKTREE_APP_IDS},
};

use super::{auth, profiles::authorize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/worktree/apps", get(apps))
        .route("/api/tasks/{task_id}/worktree/open", post(open))
}

pub(crate) fn validated_task_id(id: &str) -> Result<(), Box<Response>> {
    match task_contracts::parse_task_id_params(Some(&json!({"taskId": id}))) {
        Ok(_) => Ok(()),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(validation::validation_error_public(findings)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
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
    Path(task_id): Path<String>,
    headers: HeaderMap,
    extensions: Extensions,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
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

fn parse_open_body(headers: &HeaderMap, body: &Bytes) -> Result<String, Box<Response>> {
    let body = auth::parsed_body(headers, body)?;
    let Some(Value::Object(fields)) = body else {
        return Err(Box::new(validation::validation_error_public(vec![
            finding("invalid_type", &[]),
        ])));
    };
    match fields.get("app").and_then(Value::as_str) {
        Some(app) if app == "editor" || WORKTREE_APP_IDS.contains(&app) => Ok(app.to_owned()),
        _ => Err(Box::new(validation::validation_error_public(vec![
            finding("invalid_union", &[json!("app")]),
        ]))),
    }
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
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    let app = match parse_open_body(&headers, &body) {
        Ok(app) => app,
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
                database.connection().execute(
                    "INSERT INTO suplex_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?1, ?2, 'worktree_opened', ?3, ?4, ?5)",
                    params![
                        uuid::Uuid::new_v4().to_string(),
                        user_id,
                        company_id,
                        json!({"taskId": task_id, "app": launcher.id}).to_string(),
                        now_millis_rfc3339(),
                    ],
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
