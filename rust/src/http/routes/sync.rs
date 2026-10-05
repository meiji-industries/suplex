//! The company sync socket: the company's lists, then their changes.

use std::{sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::Response,
    routing::get,
};
use chrono::Utc;

use crate::{
    http::{
        AppState,
        access::{authorize, with_cookies},
        contracts::{task_reads::SyncMessage, typed::auth::CompanyIdParams},
        error::ApiError,
        session,
        validation::ValidPath,
    },
    identity::companies,
    sync::{Published, diff},
};

use super::{
    auth,
    task_history::{close, origin_allowed},
};

/// The client connects again when it hears nothing for three heartbeats.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// A snapshot of a large board on a slow link needs more than the history socket's second.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

pub fn router() -> Router<AppState> {
    Router::new().route("/api/companies/{company_id}/sync", get(sync))
}

async fn sync(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(error) = state.with_database(|database| {
        companies::require_company_access(database, &user_id, &company_id)
    }) {
        return with_cookies(ApiError::response(error), cookies);
    }
    let mut response =
        upgrade.on_upgrade(move |socket| sync_socket(socket, state, user_id, company_id, headers));
    auth::append_cookies(&mut response, cookies);
    response
}

/// The session and the company access that opened the socket still hold.
/// Without a session config, `session_user` reads the session and never signs in.
fn still_allowed(state: &AppState, headers: &HeaderMap, user_id: &str, company_id: &str) -> bool {
    state.with_database(|database| {
        session::session_user(database, headers, None, Utc::now())
            .is_ok_and(|session| session.user.is_some_and(|user| user.id == user_id))
            && companies::require_company_access(database, user_id, company_id).is_ok()
    })
}

async fn send(socket: &mut WebSocket, message: &SyncMessage) -> bool {
    let Ok(payload) = serde_json::to_string(message) else {
        return false;
    };
    matches!(
        tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Text(payload.into()))).await,
        Ok(Ok(()))
    )
}

async fn sync_socket(
    mut socket: WebSocket,
    state: AppState,
    user_id: String,
    company_id: String,
    headers: HeaderMap,
) {
    if !origin_allowed(&headers, &state.session_config.reachable_address) {
        close(&mut socket, 4403, "origin").await;
        return;
    }
    let mut feed = state.company_feed.subscribe(&company_id);
    let mut sent: Option<Published> = None;
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    loop {
        // The channel holds only the newest lists, so a slow client skips
        // intermediate states.
        let latest = feed.borrow_and_update().clone();
        let message = match (&sent, latest) {
            (_, None) => None,
            (None, Some(next)) => {
                let message = SyncMessage::Snapshot {
                    tasks: next.tasks.to_vec(),
                    moves: next.moves.to_vec(),
                };
                sent = Some(next);
                Some(message)
            }
            (Some(previous), Some(next)) => {
                let (tasks, removed_task_ids) = if Arc::ptr_eq(&previous.tasks, &next.tasks) {
                    (vec![], vec![])
                } else {
                    diff(&previous.tasks, &next.tasks)
                };
                let moves =
                    (!Arc::ptr_eq(&previous.moves, &next.moves)).then(|| next.moves.to_vec());
                let projects_changed = !Arc::ptr_eq(&previous.projects, &next.projects);
                sent = Some(next);
                (!tasks.is_empty()
                    || !removed_task_ids.is_empty()
                    || moves.is_some()
                    || projects_changed)
                    .then_some(SyncMessage::Changes {
                        tasks,
                        removed_task_ids,
                        moves,
                        projects_changed,
                    })
            }
        };
        if let Some(message) = message
            && !send(&mut socket, &message).await
        {
            close(&mut socket, 1013, "client too slow").await;
            return;
        }
        tokio::select! {
            _ = state.history_shutdown.cancelled() => {
                close(&mut socket, 1012, "server closing").await;
                return;
            }
            received = socket.recv() => match received {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(_)) => {
                    close(&mut socket, 1008, "read only").await;
                    return;
                }
            },
            changed = feed.changed() => if changed.is_err() {
                close(&mut socket, 1013, "feed stopped").await;
                return;
            },
            _ = heartbeat.tick() => {
                if !still_allowed(&state, &headers, &user_id, &company_id) {
                    close(&mut socket, 4403, "access revoked").await;
                    return;
                }
                let idle = SyncMessage::Changes { tasks: vec![], removed_task_ids: vec![], moves: None, projects_changed: false };
                if !send(&mut socket, &idle).await {
                    close(&mut socket, 1013, "client too slow").await;
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
include!("../../../tests/routes/sync.rs");
