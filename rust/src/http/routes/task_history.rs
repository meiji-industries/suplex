//! Native Codex session history with live, read-only observation.

use crate::http::error::ApiError;

use crate::http::access::authorize;
use crate::tasks::TaskError;
use std::{error::Error, io, path::PathBuf};

use axum::{
    Json, Router,
    extract::{
        Path, RawQuery, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};

use crate::{
    coordination::root_session_store,
    http::{
        AppState,
        contracts::typed::{
            agent_api::query_object,
            tasks::{TaskHistoryQuery, TaskSessionParams},
        },
        validation::{ValidPath, valid},
    },
    platform::database::SuplexDatabase,
    runtimes::{task_harness::ReaderSession, task_harness_registry},
};

use super::auth;

const PAGE_SIZE: usize = 40;
const MAX_BUFFERED_BYTES: usize = 4 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tasks/{task_id}/sessions/{session_id}/history",
            get(history),
        )
        .route(
            "/api/tasks/{task_id}/sessions/{session_id}/history/live",
            get(live),
        )
}

#[derive(Clone)]
struct ScopedSession {
    database_path: PathBuf,
    session_id: String,
    current: bool,
    native_session_id: Option<String>,
    instance_home_directory: Option<String>,
}

fn scoped_session(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
    session_id: &str,
) -> Result<ScopedSession, Box<dyn Error>> {
    crate::tasks::authorize_task(database, user_id, task_id)?;
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let session = rows.session(session_id).ok_or_else(TaskError::not_found)?;
    let instance_home_directory = rows
        .profile_of(session)
        .instance_home_directory()
        .map(str::to_owned);
    Ok(ScopedSession {
        database_path: PathBuf::from(
            database
                .connection()
                .path()
                .ok_or("Task database has no path")?,
        ),
        session_id: session_id.to_owned(),
        current: session.current,
        native_session_id: session.native_session_id.clone(),
        instance_home_directory,
    })
}

fn native_history(scoped: &ScopedSession) -> io::Result<Vec<Value>> {
    let Some(native_session_id) = scoped.native_session_id.as_deref() else {
        return Ok(Vec::new());
    };
    task_harness_registry::native_session_reader(native_session_id)
        .ok_or_else(|| io::Error::other("Native session history is not available"))?
        .history(&ReaderSession {
            database_path: &scoped.database_path,
            session_id: &scoped.session_id,
            native_session_id,
            instance_home_directory: scoped
                .instance_home_directory
                .as_deref()
                .map(std::path::Path::new),
        })
}

fn page(messages: &[Value], before: Option<&str>) -> Result<Value, TaskError> {
    let end = match before {
        None => messages.len(),
        Some(before) => messages
            .iter()
            .position(|message| message["id"] == before)
            .ok_or_else(|| TaskError::Failure {
                message: "The session history cursor is not available".into(),
                status: 400,
                code: "cursor_invalid",
            })?,
    };
    let start = end.saturating_sub(PAGE_SIZE);
    Ok(json!({
        "messages": &messages[start..end],
        "olderCursor": (start > 0).then(|| messages[start]["id"].clone()),
    }))
}

async fn history(
    State(state): State<AppState>,
    ValidPath(TaskSessionParams {
        task_id,
        session_id,
    }): ValidPath<TaskSessionParams>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let before = match valid::<TaskHistoryQuery>(query_object(query.as_deref())) {
        Ok(query) => query.before,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let scoped = match state
        .with_database(|database| scoped_session(database, &user_id, &task_id, &session_id))
    {
        Ok(value) => value,
        Err(error) => {
            let mut response = ApiError::response(error);
            auth::append_cookies(&mut response, cookies);
            return response;
        }
    };
    let observed = tokio::task::spawn_blocking(move || native_history(&scoped)).await;
    let result = match observed {
        Ok(Ok(messages)) => page(&messages, before.as_deref())
            .map_err(|failure| Box::new(failure) as Box<dyn Error>),
        Ok(Err(_)) | Err(_) => {
            let mut response = auth::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Session history is not available",
            );
            auth::append_cookies(&mut response, cookies);
            return response;
        }
    };
    let result = match result {
        Ok(result) => state
            .with_database(|database| scoped_session(database, &user_id, &task_id, &session_id))
            .map(|_| result),
        Err(error) => Err(error),
    };
    let mut response = match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn origin_allowed(headers: &HeaderMap, reachable_address: &str) -> bool {
    let Some(origin) = headers.get("origin") else {
        return true;
    };
    let Ok(origin) = origin
        .to_str()
        .ok()
        .and_then(|raw| url::Url::parse(raw).ok())
        .ok_or(())
    else {
        return false;
    };
    let reachable = url::Url::parse(reachable_address).ok();
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    reachable
        .as_ref()
        .is_some_and(|value| value.origin() == origin.origin())
        || host.is_some_and(|host| {
            origin.host_str().is_some_and(|name| {
                origin
                    .port()
                    .map_or(name.to_owned(), |port| format!("{name}:{port}"))
                    == host
            })
        })
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

#[derive(Clone, Copy)]
enum LiveFailure {
    Missing,
    Access,
    Native,
}

fn live_scope_error(error: Box<dyn Error>) -> LiveFailure {
    if matches!(error.downcast_ref(), Some(TaskError::Failure { .. })) {
        LiveFailure::Missing
    } else {
        // The source websocket treats any failed fresh task/session lookup as
        // revoked access. Native read failures are classified separately.
        LiveFailure::Access
    }
}

async fn read_live(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    session_id: &str,
) -> Result<(ScopedSession, Vec<Value>), LiveFailure> {
    let scoped = state
        .with_database(|database| scoped_session(database, user_id, task_id, session_id))
        .map_err(live_scope_error)?;
    let reading = scoped.clone();
    let messages = tokio::task::spawn_blocking(move || native_history(&reading))
        .await
        .map_err(|_| LiveFailure::Native)?
        .map_err(|_| LiveFailure::Native)?;
    state
        .with_database(|database| scoped_session(database, user_id, task_id, session_id))
        .map_err(live_scope_error)?;
    Ok((scoped, messages))
}

fn live_change(previous: &[Value], next: &[Value]) -> Option<Value> {
    let previous_ids = previous
        .iter()
        .map(|message| message["id"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    let order = next
        .iter()
        .map(|message| message["id"].clone())
        .collect::<Vec<_>>();
    let changed = next
        .iter()
        .filter(|message| previous.iter().find(|old| old["id"] == message["id"]) != Some(*message))
        .cloned()
        .collect::<Vec<_>>();
    let removed = previous_ids
        .iter()
        .filter(|id| !next.iter().any(|message| message["id"] == **id))
        .map(|id| json!(id))
        .collect::<Vec<_>>();
    if changed.is_empty()
        && removed.is_empty()
        && previous
            .iter()
            .map(|message| &message["id"])
            .eq(order.iter())
    {
        None
    } else {
        Some(json!({"type":"update","messages":changed,"removedIds":removed,"order":order}))
    }
}

async fn live_socket(
    mut socket: WebSocket,
    state: AppState,
    user_id: String,
    task_id: String,
    session_id: String,
    headers: HeaderMap,
) {
    if !origin_allowed(&headers, &state.session_config.reachable_address) {
        close(&mut socket, 4403, "origin").await;
        return;
    }
    if state
        .with_database(|database| scoped_session(database, &user_id, &task_id, &session_id))
        .is_err()
    {
        close(&mut socket, 4404, "not found").await;
        return;
    }
    let mut previous = Vec::new();
    let mut snapshot = false;
    let mut recovered = false;
    let mut failures = 0u32;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
    loop {
        tokio::select! {
            _ = state.history_shutdown.cancelled() => {
                close(&mut socket, 1012, "server closing").await;
                return;
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(_)) => { close(&mut socket, 1008, "read only").await; return; }
                }
            }
            _ = interval.tick() => {
                let observed = tokio::select! {
                    _ = state.history_shutdown.cancelled() => {
                        close(&mut socket, 1012, "server closing").await;
                        return;
                    }
                    message = socket.recv() => {
                        match message {
                            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                            Some(Ok(_)) => { close(&mut socket, 1008, "read only").await; return; }
                        }
                    }
                    observed = read_live(&state, &user_id, &task_id, &session_id) => observed,
                };
                match observed {
                    Ok((scoped, messages)) => {
                        let value = if !snapshot || recovered {
                            page(&messages, None).ok().map(|page| json!({"type":"snapshot","page":page,"order":messages.iter().map(|message| message["id"].clone()).collect::<Vec<_>>()}))
                        } else { live_change(&previous, &messages) };
                        if let Some(value) = value {
                            let payload = value.to_string();
                            if payload.len() > MAX_BUFFERED_BYTES || !matches!(tokio::time::timeout(std::time::Duration::from_secs(1), socket.send(Message::Text(payload.into()))).await, Ok(Ok(()))) {
                                close(&mut socket, 1013, "client too slow").await;
                                return;
                            }
                        }
                        previous = messages;
                        snapshot = true;
                        recovered = false;
                        failures = 0;
                        interval = tokio::time::interval(std::time::Duration::from_millis(if scoped.current {500} else {2_000}));
                        interval.tick().await;
                    }
                    Err(LiveFailure::Missing) => { close(&mut socket, 4404, if snapshot { "session removed" } else { "not found" }).await; return; }
                    Err(LiveFailure::Access) => { close(&mut socket, 4403, "access revoked").await; return; }
                    Err(LiveFailure::Native) => {
                        match state.with_database(|database| scoped_session(database, &user_id, &task_id, &session_id)).map_err(live_scope_error) {
                            Err(LiveFailure::Missing) => { close(&mut socket, 4404, if snapshot { "session removed" } else { "not found" }).await; return; }
                            Err(LiveFailure::Access) => { close(&mut socket, 4403, "access revoked").await; return; }
                            _ => {}
                        }
                        let payload = json!({"type":"error","message":"Live output is not available. Suplex will retry."}).to_string();
                        if socket.send(Message::Text(payload.into())).await.is_err() { return; }
                        recovered = true;
                        failures = failures.saturating_add(1);
                        let base = 500_u64.saturating_mul(2_u64.saturating_pow(failures.min(8)));
                        interval = tokio::time::interval(std::time::Duration::from_millis(base.min(8_000)));
                        interval.tick().await;
                    }
                }
            }
        }
    }
}

async fn live(
    State(state): State<AppState>,
    Path((task_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // The WebSocket upgrade check runs before the params, as an extractor.
    if let Err(response) =
        valid::<TaskSessionParams>(json!({"taskId": task_id, "sessionId": session_id}))
    {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = upgrade.on_upgrade(move |socket| {
        live_socket(socket, state, user_id, task_id, session_id, headers)
    });
    auth::append_cookies(&mut response, cookies);
    response
}

#[cfg(test)]
include!("../../../tests/routes/task_history.rs");
