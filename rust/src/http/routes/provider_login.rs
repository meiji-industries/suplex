//! Provider instances and interactive provider sign-in panes.

use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use std::collections::HashMap;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery, State, ws::WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use rusqlite::OptionalExtension;
use serde_json::json;

use crate::{
    http::{AppState, contracts::typed::finding, validation},
    integrations::herdr_bridge::{self, Mode},
    profiles::{
        provider_connection::connection_from_health, provider_instances, provider_login,
        provider_readiness,
    },
};

use super::{
    auth,
    profiles::authorize,
    task_pane::{TerminalSession, origin_allowed, run_terminal, terminal_size},
};

const HARNESS_KINDS: [&str; 4] = ["opencode", "claude-code", "devin", "codex"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/provider-instances",
            get(list_instances).post(create_instance),
        )
        .route(
            "/api/admin/provider-instances/{instance_id}",
            delete(delete_instance),
        )
        .route(
            "/api/admin/provider-instances/{instance_id}/login",
            post(instance_login),
        )
        .route(
            "/api/admin/providers/{provider_id}/login",
            post(provider_login),
        )
        .route("/api/admin/provider-login/{pane_id}", delete(close_login))
        .route(
            "/api/admin/provider-login/{pane_id}/terminal",
            get(terminal),
        )
}

async fn list_instances(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let instances = state
        .with_database(|database| provider_instances::list(database, &user_id))
        .map_err(ApiError::response);
    let instances = match instances {
        Ok(instances) => instances,
        Err(response) => return with_cookies(response, cookies),
    };
    let inherited = std::env::vars().collect::<HashMap<_, _>>();
    let mut listed = Vec::new();
    for mut instance in instances {
        let mut environment = inherited.clone();
        environment.insert(
            "CLAUDE_CONFIG_DIR".into(),
            instance["homeDirectory"]
                .as_str()
                .unwrap_or_default()
                .into(),
        );
        let check = provider_readiness::check("claude-code", Some(environment), false).await;
        let readiness = json!({"status": check["status"], "summary": check["summary"]});
        instance["connection"] = connection_from_health(&readiness);
        instance["readiness"] = readiness;
        listed.push(instance);
    }
    with_cookies(Json(json!({"instances": listed})).into_response(), cookies)
}

async fn create_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match auth::validated_body(
        &headers,
        &body,
        "providers.ProviderInstanceCreateBodySchema",
    ) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "POST", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let created = state.with_database(|database| {
        provider_instances::create(
            database,
            &user_id,
            input["provider"].as_str().unwrap_or_default(),
            input["label"].as_str().unwrap_or_default(),
        )
        .map_err(ApiError::response)
    });
    let response = match created {
        Ok(instance) => (StatusCode::CREATED, Json(instance)).into_response(),
        Err(response) => response,
    };
    with_cookies(response, cookies)
}

async fn delete_instance(
    State(state): State<AppState>,
    Path(instance_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "DELETE", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| {
        provider_instances::delete(database, &user_id, &instance_id).map_err(ApiError::response)
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    };
    with_cookies(response, cookies)
}

/// Opens the sign-in pane; a Herdr failure is a 503 the admin can act on.
async fn start(
    state: AppState,
    target: String,
    label: String,
    provider: String,
    home: Option<String>,
) -> Response {
    let opened = tokio::task::spawn_blocking(move || {
        let command = provider_login::login_command(&provider, home.as_deref());
        let cwd = std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        state
            .provider_logins
            .start(&state.herdr, &target, &label, &command, &cwd)
    })
    .await;
    match opened {
        Ok(Ok(session)) => {
            let mut response = Json(json!({"paneId": session.pane_id})).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        _ => auth::error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Suplex could not open a sign-in pane. Check Herdr on the Suplex host.",
        ),
    }
}

async fn provider_login(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !HARNESS_KINDS.contains(&provider_id.as_str()) {
        return validation::validation_error_public(vec![finding(
            "invalid_value",
            &[json!("providerId")],
        )]);
    }
    let (_, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = start(
        state,
        format!("provider:{provider_id}"),
        provider_id.clone(),
        provider_id,
        None,
    )
    .await;
    with_cookies(response, cookies)
}

async fn instance_login(
    State(state): State<AppState>,
    Path(instance_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let instance = state
        .with_database(|database| provider_instances::list(database, &user_id))
        .map_err(ApiError::response)
        .map(|instances| {
            instances
                .into_iter()
                .find(|instance| instance["id"] == instance_id)
        });
    let response = match instance {
        Err(response) => response,
        Ok(None) => auth::error(StatusCode::NOT_FOUND, "Not found"),
        Ok(Some(instance)) => {
            let text = |key: &str| instance[key].as_str().unwrap_or_default().to_owned();
            start(
                state,
                format!("instance:{instance_id}"),
                text("label"),
                text("provider"),
                Some(text("homeDirectory")),
            )
            .await
        }
    };
    with_cookies(response, cookies)
}

async fn close_login(
    State(state): State<AppState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (_, cookies) = match authorize(&state, &headers, "DELETE", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let logins = state.clone();
    let closed =
        tokio::task::spawn_blocking(move || logins.provider_logins.close(&logins.herdr, &pane_id))
            .await
            .unwrap_or(false);
    let response = if closed {
        StatusCode::NO_CONTENT.into_response()
    } else {
        auth::error(StatusCode::NOT_FOUND, "Not found")
    };
    with_cookies(response, cookies)
}

fn admin(state: &AppState, user_id: &str) -> bool {
    state.with_database(|database| {
        database
            .connection()
            .query_row(
                "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
                [user_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .is_some_and(|role| role == "admin")
    })
}

async fn terminal(
    State(state): State<AppState>,
    Path(pane_id): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (cols, rows) = match terminal_size(query.as_deref()) {
        Ok(size) => size,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = upgrade.on_upgrade(move |mut socket| async move {
        let refusal = if !origin_allowed(&headers, &state.session_config.reachable_address) {
            Some((4403, "origin"))
        } else if !admin(&state, &user_id) {
            Some((4403, "access"))
        } else if state.provider_logins.get(&pane_id).is_none() {
            Some((4404, "not found"))
        } else {
            None
        };
        if let Some((code, reason)) = refusal {
            let frame = axum::extract::ws::CloseFrame {
                code,
                reason: reason.into(),
            };
            let _ = socket
                .send(axum::extract::ws::Message::Close(Some(frame)))
                .await;
            return;
        }
        let (bridge, events) = herdr_bridge::open(
            state.herdr.clone(),
            pane_id.clone(),
            Some(cols as f64),
            Some(rows as f64),
            Mode::Control,
        );
        let session = TerminalSession {
            pane_id: pane_id.clone(),
            read_only: false,
            cols,
            rows,
            ended_code: 1000,
        };
        run_terminal(socket, session, bridge, events, || {
            if !admin(&state, &user_id) {
                Some((4403, "access revoked"))
            } else if state.provider_logins.get(&pane_id).is_none() {
                Some((4404, "pane closed"))
            } else {
                None
            }
        })
        .await;
    });
    auth::append_cookies(&mut response, cookies);
    response
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use reqwest::Method;
    use serde_json::Value;

    use super::*;
    use crate::{
        http::routes::task_pane::tests::{
            client::{Frame, connect},
            fixture,
        },
        integrations::herdr_bridge::tests::fake_terminal,
        profiles::provider_login::tests::login_herdr,
    };

    #[tokio::test]
    async fn provider_login_and_instance_routes_create_reuse_and_close_sign_in_panes() {
        let mut fixture = fixture();
        fixture.state.herdr = login_herdr().0;
        let address = fixture.serve().await;
        let client = reqwest::Client::new();
        let request = |method: Method, path: &str| {
            client
                .request(method, format!("http://{address}{path}"))
                .header("host", "127.0.0.1:4113")
                .header("origin", "http://127.0.0.1:4113")
                .header("cookie", &fixture.cookie)
        };
        let status = |response: reqwest::Response| response.status().as_u16();
        let started = request(Method::POST, "/api/admin/providers/devin/login")
            .send()
            .await
            .unwrap();
        assert_eq!(started.status(), 200);
        assert_eq!(started.headers()["cache-control"], "private, no-store");
        assert_eq!(
            started.json::<Value>().await.unwrap(),
            json!({"paneId":"pane-login-1"})
        );
        let reused: Value = request(Method::POST, "/api/admin/providers/devin/login")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reused["paneId"], "pane-login-1");
        assert_eq!(
            status(
                request(Method::POST, "/api/admin/providers/openai/login")
                    .send()
                    .await
                    .unwrap()
            ),
            400
        );
        let refused = request(Method::POST, "/api/admin/provider-instances")
            .json(&json!({"provider":"opencode","label":"No"}))
            .send()
            .await
            .unwrap();
        assert_eq!(status(refused), 422);
        let created = request(Method::POST, "/api/admin/provider-instances")
            .json(&json!({"provider":"claude-code","label":" Work "}))
            .send()
            .await
            .unwrap();
        assert_eq!(created.status(), 201);
        let instance: Value = created.json().await.unwrap();
        assert_eq!(instance["label"], "Work");
        assert!(std::path::Path::new(instance["homeDirectory"].as_str().unwrap()).is_dir());
        let id = instance["id"].as_str().unwrap();
        let login: Value = request(
            Method::POST,
            &format!("/api/admin/provider-instances/{id}/login"),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(login["paneId"], "pane-login-2");
        assert_eq!(
            status(
                request(
                    Method::POST,
                    "/api/admin/provider-instances/instance_missing/login"
                )
                .send()
                .await
                .unwrap()
            ),
            404
        );
        let listed: Value = request(Method::GET, "/api/admin/provider-instances")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed["instances"][0]["id"], id);
        assert!(listed["instances"][0]["readiness"]["status"].is_string());
        assert!(listed["instances"][0]["connection"]["status"].is_string());
        assert_eq!(
            status(
                request(Method::DELETE, "/api/admin/provider-login/pane-login-1")
                    .send()
                    .await
                    .unwrap()
            ),
            404
        );
        assert_eq!(
            status(
                request(Method::DELETE, "/api/admin/provider-login/pane-login-2")
                    .send()
                    .await
                    .unwrap()
            ),
            204
        );
        assert_eq!(
            status(
                request(
                    Method::DELETE,
                    &format!("/api/admin/provider-instances/{id}")
                )
                .send()
                .await
                .unwrap()
            ),
            204
        );
        assert_eq!(
            status(
                request(
                    Method::DELETE,
                    &format!("/api/admin/provider-instances/{id}")
                )
                .send()
                .await
                .unwrap()
            ),
            404
        );
        fixture.execute("UPDATE suplex_users SET role = 'member'", &[]);
        assert_eq!(
            status(
                request(Method::POST, "/api/admin/providers/devin/login")
                    .send()
                    .await
                    .unwrap()
            ),
            403
        );
        assert_eq!(
            status(
                request(Method::GET, "/api/admin/provider-instances")
                    .send()
                    .await
                    .unwrap()
            ),
            403
        );
        let _ = std::fs::remove_dir_all(&fixture.root);
    }

    #[tokio::test]
    async fn the_sign_in_terminal_is_admin_only_and_bridges_control_input() {
        let mut fixture = fixture();
        let frame = r#"{"type":"terminal.frame","seq":1,"full":true,"width":80,"height":24,"bytes":"aGk="}"#;
        let script = fake_terminal(&fixture.root.join("herdr"), &[frame]);
        let (mut herdr, _) = login_herdr();
        herdr.binary = script.to_string_lossy().into_owned();
        fixture.state.herdr = herdr;
        let session = fixture
            .state
            .provider_logins
            .start(
                &fixture.state.herdr,
                "provider:codex",
                "codex",
                "codex login",
                "/",
            )
            .unwrap();
        let address = fixture.serve().await;
        let path = format!(
            "/api/admin/provider-login/{}/terminal?cols=100&rows=30",
            session.pane_id
        );
        let cookie = ("cookie", fixture.cookie.as_str());
        let (_, mut unknown) = connect(
            address,
            "/api/admin/provider-login/pane-unknown/terminal",
            &[cookie],
        )
        .await;
        assert_eq!(unknown.next().await, Frame::Close(4404, "not found".into()));
        let (_, mut foreign) = connect(
            address,
            &path,
            &[cookie, ("origin", "https://evil.example")],
        )
        .await;
        assert_eq!(foreign.next().await, Frame::Close(4403, "origin".into()));
        let (_, mut terminal) = connect(address, &path, &[cookie]).await;
        let Frame::Text(opened) = terminal.next().await else {
            panic!("open message")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&opened).unwrap(),
            json!({"type":"open","paneId":"pane-login-1","readOnly":false,"cols":100,"rows":30})
        );
        assert_eq!(
            terminal.next().await,
            Frame::Text(r#"{"type":"size","cols":80,"rows":24}"#.into())
        );
        assert_eq!(terminal.next().await, Frame::Binary(b"hi".to_vec()));
        terminal.send(2, b"yes\n").await;
        let stdin = fixture.root.join("herdr/stdin");
        for _ in 0..100 {
            if std::fs::read_to_string(&stdin).is_ok_and(|text| !text.is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            std::fs::read_to_string(&stdin).unwrap(),
            "{\"type\":\"terminal.input\",\"bytes\":\"eWVzCg==\"}\n"
        );
        assert!(
            fixture
                .state
                .provider_logins
                .close(&fixture.state.herdr, &session.pane_id)
        );
        assert_eq!(
            terminal.next().await,
            Frame::Close(4404, "pane closed".into())
        );
        fixture.execute("UPDATE suplex_users SET role = 'member'", &[]);
        let (_, mut member) = connect(address, &path, &[cookie]).await;
        assert_eq!(member.next().await, Frame::Close(4403, "access".into()));
        let _ = std::fs::remove_dir_all(&fixture.root);
    }
}
