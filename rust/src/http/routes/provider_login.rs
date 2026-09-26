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
include!("../../../tests/routes/provider_login.rs");
