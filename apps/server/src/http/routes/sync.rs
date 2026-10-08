//! The company sync socket: the company's lists, then their changes, and the
//! values of the tasks the client watches.

#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

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
use tokio::sync::watch;

use crate::{
    http::{
        AppState,
        access::{authorize, with_cookies},
        contracts::{
            task_reads::{SyncMessage, SyncRequest},
            typed::auth::CompanyIdParams,
        },
        error::ApiError,
        session,
        validation::ValidPath,
    },
    identity::companies,
    platform::database::SuplexDatabase,
    sync::{Published, Watched, diff, same},
};

use super::{
    auth,
    task_history::{close, origin_allowed},
};

/// The client connects again when it hears nothing for three heartbeats.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// A snapshot of a large board on a slow link needs more than the history socket's second.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// The most tasks whose agents one watch reads.
const WATCH_LIMIT: usize = 50;

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

/// The tasks of the socket's company that are not archived. A watch ignores
/// the other agent ids.
fn watchable(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
    mut ids: Vec<String>,
) -> Vec<String> {
    ids.retain(|id| {
        crate::tasks::authorize_task(database, user_id, id)
            .is_ok_and(|company| company == company_id)
            && database
                .connection()
                .query_row(
                    "SELECT archived_at IS NULL FROM suplex_tasks WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap_or(false)
    });
    ids
}

/// One watch of the socket, and what it sent since the `watch` request.
struct Watching {
    agents: bool,
    open_task_id: Option<String>,
    receiver: watch::Receiver<Option<Watched>>,
    shown: Option<Watched>,
}

fn start_watch(
    state: &AppState,
    user_id: &str,
    company_id: &str,
    mut agent_task_ids: Vec<String>,
    open_task_id: Option<String>,
) -> Option<Watching> {
    agent_task_ids.truncate(WATCH_LIMIT);
    agent_task_ids.sort();
    agent_task_ids.dedup();
    let (agent_task_ids, open_task_id) = state.with_database(|database| {
        (
            watchable(database, user_id, company_id, agent_task_ids),
            // An archived task's page is open too.
            open_task_id.filter(|id| {
                crate::tasks::authorize_task(database, user_id, id)
                    .is_ok_and(|company| company == company_id)
            }),
        )
    });
    (!agent_task_ids.is_empty() || open_task_id.is_some()).then(|| Watching {
        agents: !agent_task_ids.is_empty(),
        receiver: state
            .company_feed
            .watch(agent_task_ids, open_task_id.clone()),
        open_task_id,
        shown: None,
    })
}

/// The value when it differs from the one the socket sent.
fn fresh<'a, T>(shown: Option<&Option<Arc<T>>>, next: &'a Option<Arc<T>>) -> Option<&'a T> {
    let sent = shown
        .is_some_and(|shown| shown.as_ref().map(Arc::as_ptr) == next.as_ref().map(Arc::as_ptr));
    next.as_deref().filter(|_| !sent)
}

/// The frames that bring the client from `shown` to `next`. The first frames
/// of a watch carry every value.
fn watch_frames<'a>(watching: &Watching, next: &'a Watched) -> Vec<SyncMessage<'a>> {
    let shown = watching.shown.as_ref();
    let mut frames = Vec::new();
    let tasks = next
        .agents
        .iter()
        .filter(|task| {
            !shown.is_some_and(|shown| shown.agents.iter().any(|sent| Arc::ptr_eq(sent, task)))
        })
        .map(|task| &**task)
        .collect::<Vec<_>>();
    if !tasks.is_empty() || (shown.is_none() && watching.agents) {
        frames.push(SyncMessage::Agents { tasks });
    }
    if let Some(task_id) = &watching.open_task_id {
        let open = shown.map(|shown| &shown.open);
        let task = fresh(open.map(|open| &open.task), &next.open.task);
        let activity = fresh(open.map(|open| &open.activity), &next.open.activity);
        let execution = fresh(open.map(|open| &open.execution), &next.open.execution);
        let timeline = fresh(open.map(|open| &open.timeline), &next.open.timeline);
        if shown.is_none()
            || task.is_some()
            || activity.is_some()
            || execution.is_some()
            || timeline.is_some()
        {
            frames.push(SyncMessage::OpenTask {
                task_id: task_id.clone(),
                task,
                activity,
                execution,
                timeline,
            });
        }
    }
    frames
}

async fn send(socket: &mut WebSocket, message: &SyncMessage<'_>) -> bool {
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
    let mut watching: Option<Watching> = None;
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
                    costs: next.costs.as_deref().cloned(),
                    projects: next.projects.to_vec(),
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
                let costs = next
                    .costs
                    .as_deref()
                    .filter(|_| !same(&previous.costs, &next.costs))
                    .cloned();
                let projects = (!Arc::ptr_eq(&previous.projects, &next.projects))
                    .then(|| next.projects.to_vec());
                sent = Some(next);
                (!tasks.is_empty()
                    || !removed_task_ids.is_empty()
                    || moves.is_some()
                    || costs.is_some()
                    || projects.is_some())
                .then_some(SyncMessage::Changes {
                    tasks,
                    removed_task_ids,
                    moves,
                    costs,
                    projects,
                })
            }
        };
        if let Some(message) = message
            && !send(&mut socket, &message).await
        {
            close(&mut socket, 1013, "client too slow").await;
            return;
        }
        let next = watching
            .as_mut()
            .and_then(|watch| watch.receiver.borrow_and_update().clone());
        if let Some(watch) = &mut watching
            && let Some(next) = next
        {
            for message in watch_frames(watch, &next) {
                if !send(&mut socket, &message).await {
                    close(&mut socket, 1013, "client too slow").await;
                    return;
                }
            }
            watch.shown = Some(next);
        }
        tokio::select! {
            _ = state.history_shutdown.cancelled() => {
                close(&mut socket, 1012, "server closing").await;
                return;
            }
            received = socket.recv() => match received {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
                    // A new watch replaces the previous one; dropping its receiver ends it.
                    Ok(SyncRequest::Watch { agent_task_ids, open_task_id }) => {
                        watching = start_watch(&state, &user_id, &company_id, agent_task_ids, open_task_id);
                    }
                    Err(_) => {
                        close(&mut socket, 1008, "invalid request").await;
                        return;
                    }
                },
                Some(Ok(_)) => {
                    close(&mut socket, 1008, "invalid request").await;
                    return;
                }
            },
            Some(changed) = async {
                match &mut watching {
                    Some(watch) => Some(watch.receiver.changed().await),
                    None => None,
                }
            }, if watching.is_some() => if changed.is_err() {
                close(&mut socket, 1013, "feed stopped").await;
                return;
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
                let idle = SyncMessage::Changes { tasks: vec![], removed_task_ids: vec![], moves: None, costs: None, projects: None };
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
