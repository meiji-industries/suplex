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
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::http::routes::task_pane::tests::fixture;

    fn fake_launchers() -> (Vec<Launcher>, Option<Launcher>) {
        let launcher = |id, command: &str, cwd_is_path| Launcher {
            id,
            label: "Fake",
            command: command.into(),
            args: Arc::new(|path: &str| {
                vec![
                    "-c".into(),
                    "test \"$0\" = /tmp || { echo failed >&2; exit 3; }".into(),
                    path.into(),
                ]
            }),
            cwd_is_path,
        };
        (
            vec![
                launcher("finder", "/bin/sh", false),
                launcher("terminal", "/nonexistent/suplex-terminal", true),
            ],
            Some(launcher("editor", "/bin/sh", false)),
        )
    }

    fn loopback() -> Extensions {
        let mut extensions = Extensions::new();
        extensions.insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50_000))));
        extensions
    }

    #[tokio::test]
    async fn worktree_routes_require_a_direct_loopback_peer_and_the_configured_host() {
        let fixture = fixture();
        let address = fixture.serve().await;
        let client = reqwest::Client::new();
        let apps = format!(
            "http://{address}/api/tasks/{}/worktree/apps",
            fixture.task_id
        );
        let open = format!(
            "http://{address}/api/tasks/{}/worktree/open",
            fixture.task_id
        );
        let get = |host: &'static str| {
            client
                .get(&apps)
                .header("host", host)
                .header("cookie", &fixture.cookie)
        };
        let missing = get("127.0.0.1:4113").send().await.unwrap();
        assert_eq!(missing.status(), 404);
        assert_eq!(
            missing.json::<Value>().await.unwrap(),
            json!({"error":"Worktree not found"})
        );
        let worktree = json!({"path":"/tmp","branch":"task"}).to_string();
        fixture.execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
            &[&worktree, &fixture.task_id],
        );
        let local: Value = get("127.0.0.1:4113")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(local["apps"].is_array());
        let remote: Value = get("suplex.tailnet.ts.net:4113")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(remote, json!({"apps":[]}));
        let forwarded: Value = get("127.0.0.1:4113")
            .header("x-forwarded-for", "127.0.0.1")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(forwarded, json!({"apps":[]}));
        let post = |host: &'static str, body: Value| {
            client
                .post(&open)
                .header("host", host)
                .header("origin", "http://127.0.0.1:4113")
                .header("cookie", &fixture.cookie)
                .json(&body)
                .send()
        };
        let remote = post("suplex.tailnet.ts.net:4113", json!({"app":"finder"}))
            .await
            .unwrap();
        assert_eq!(remote.status(), 403);
        assert_eq!(
            remote.json::<Value>().await.unwrap(),
            json!({"ok":false,"error":"Opening a worktree is available only from the Suplex host"})
        );
        let invalid = post("127.0.0.1:4113", json!({"app":"not-an-app"}))
            .await
            .unwrap();
        assert_eq!(invalid.status(), 400);
        assert_eq!(
            invalid.json::<Value>().await.unwrap()["findings"][0]["field"],
            ".app"
        );
        let anonymous = client
            .get(&apps)
            .header("host", "suplex.tailnet.ts.net:4113")
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), 401);
        let _ = std::fs::remove_dir_all(&fixture.root);
    }

    #[tokio::test]
    async fn opening_runs_the_resolved_launcher_and_audits_only_successful_launches() {
        let fixture = fixture();
        let worktree = json!({"path":"/tmp","branch":"task"}).to_string();
        fixture.execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
            &[&worktree, &fixture.task_id],
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:4113".parse().unwrap());
        headers.insert("origin", "http://127.0.0.1:4113".parse().unwrap());
        headers.insert("cookie", fixture.cookie.parse().unwrap());
        headers.insert("content-type", "application/json".parse().unwrap());
        let open = |app: &str, extensions: Extensions| {
            open_with(
                fixture.state.clone(),
                fixture.task_id.clone(),
                headers.clone(),
                extensions,
                Bytes::from(json!({"app": app}).to_string()),
                fake_launchers,
            )
        };
        async fn body(response: Response) -> Value {
            serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 4096)
                    .await
                    .unwrap(),
            )
            .unwrap()
        }
        let audits = || {
            fixture.state.with_database(|database| {
                database
                    .connection()
                    .query_row(
                        "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'worktree_opened'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
            })
        };
        assert_eq!(open("ghostty", loopback()).await.status(), 501);
        assert_eq!(body(open("terminal", loopback()).await).await["ok"], false);
        assert_eq!(audits(), 0);
        assert_eq!(open("editor", Extensions::new()).await.status(), 403);
        assert_eq!(
            body(open("editor", loopback()).await).await,
            json!({"ok": true})
        );
        assert_eq!(audits(), 1);
        let _ = std::fs::remove_dir_all(&fixture.root);
    }
}
