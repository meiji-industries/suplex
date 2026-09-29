//! Live terminal views of task panes. Session panes are read-only observers;
//! the task Shell is interactive. Herdr owns the panes by default: a missing
//! or recreated pane closes the socket, and the browser reconnects to the
//! current pane. With the host terminal experiment on, the host owns them and
//! starts a missing terminal on open.

use std::time::Duration;

use axum::{
    Router,
    extract::{
        Path, RawQuery, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::Response,
    routing::get,
};
use serde_json::{Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{
            agent_api::query_object,
            tasks::{TaskPaneParams, TerminalSize},
        },
        validation::valid,
    },
    integrations::herdr_bridge,
    terminals::{self, Bridge, BridgeEvent, Mode, ReplayState},
};

use super::{auth, profiles::authorize};

/// Close code for a terminal control bridge displaced by a newer controller.
pub const TERMINAL_TAKEOVER_CLOSE_CODE: u16 = 4498;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/tasks/{task_id}/pane/{role}/terminal", get(terminal))
}

pub(crate) fn origin_allowed(headers: &HeaderMap, reachable_address: &str) -> bool {
    let Some(origin) = headers.get("origin") else {
        return true;
    };
    let Some(origin) = origin
        .to_str()
        .ok()
        .and_then(|raw| url::Url::parse(raw).ok())
    else {
        return false;
    };
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    let authority = origin.host_str().map(|name| match origin.port() {
        Some(port) => format!("{name}:{port}"),
        None => name.to_owned(),
    });
    url::Url::parse(reachable_address).is_ok_and(|reachable| reachable.origin() == origin.origin())
        || (host.is_some() && authority.as_deref() == host)
}

/// `cols` and `rows` coerced like `z.coerce.number().int().min().max().default()`.
pub(crate) fn terminal_size(query: Option<&str>) -> Result<(i64, i64), Box<Response>> {
    valid::<TerminalSize>(query_object(query)).map(|size| (size.cols, size.rows))
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.chars().take(100).collect::<String>().into(),
        })))
        .await;
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text
            .trim()
            .parse()
            .ok()
            .or(text.trim().is_empty().then_some(0.0)),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        Value::Null => Some(0.0),
        _ => None,
    }
    .filter(|number| number.is_finite())
}

pub(crate) struct TerminalSession {
    pub pane_id: String,
    pub read_only: bool,
    pub cols: i64,
    pub rows: i64,
    /// Close code after the controller or observer ends normally.
    pub ended_code: u16,
}

/// Streams bridge events to the browser and forwards control input. Runs
/// until either side closes or `access` returns a close code and reason.
pub(crate) async fn run_terminal(
    mut socket: WebSocket,
    session: TerminalSession,
    mut bridge: Bridge,
    mut access: impl FnMut() -> Option<(u16, &'static str)>,
) {
    let opened = json!({"type":"open","paneId":session.pane_id,"readOnly":session.read_only,"cols":session.cols,"rows":session.rows,"scroll":bridge.scroll_mode()});
    if socket
        .send(Message::Text(opened.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    // A host Mirror is read only, but it takes the size of its viewer.
    let sizable = !session.read_only || matches!(bridge, Bridge::Host(_));
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.tick().await;
    loop {
        tokio::select! {
            message = socket.recv() => match message {
                Some(Ok(Message::Binary(bytes))) if !session.read_only => bridge.input(bytes.to_vec()),
                Some(Ok(Message::Text(text))) if sizable => {
                    let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
                    match (message["type"].as_str(), message["direction"].as_str()) {
                        (Some("resize"), _) => if let (Some(cols), Some(rows)) = (number(&message["cols"]), number(&message["rows"])) {
                            bridge.resize(cols, rows);
                        },
                        (Some("scroll"), Some(direction @ ("up" | "down"))) => if let Some(lines) = number(&message["lines"]) {
                            bridge.scroll(if direction == "up" { "up" } else { "down" }, lines);
                        },
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            event = bridge.next() => match event {
                Some(BridgeEvent::Frame { width, height, bytes, .. }) => {
                    let size = json!({"type":"size","cols":width,"rows":height}).to_string();
                    if socket.send(Message::Text(size.into())).await.is_err()
                        || (!bytes.is_empty() && socket.send(Message::Binary(bytes.into())).await.is_err())
                    {
                        break;
                    }
                }
                Some(BridgeEvent::Snapshot { width, height, bytes }) => {
                    let replay = |state: ReplayState| Message::Text(json!({"type":"replay","state":state}).to_string().into());
                    let size = json!({"type":"size","cols":width,"rows":height}).to_string();
                    if socket.send(replay(ReplayState::Start)).await.is_err()
                        || socket.send(Message::Text(size.into())).await.is_err()
                        || socket.send(Message::Binary(bytes.into())).await.is_err()
                        || socket.send(replay(ReplayState::End)).await.is_err()
                    {
                        break;
                    }
                }
                Some(BridgeEvent::Closed(reason)) => {
                    let code = if reason.contains("taken over") { TERMINAL_TAKEOVER_CLOSE_CODE } else { session.ended_code };
                    close(&mut socket, code, &reason).await;
                    break;
                }
                Some(BridgeEvent::Error(message)) => {
                    let payload = json!({"type":"error","message":message}).to_string();
                    if socket.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            _ = interval.tick() => {
                if let Some((code, reason)) = access() {
                    close(&mut socket, code, reason).await;
                    break;
                }
            }
        }
    }
    bridge.release();
}

use crate::tasks::worktree::{bound_pane, task_shell_pane};

async fn terminal(
    State(state): State<AppState>,
    Path((task_id, role)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // The WebSocket upgrade check runs before the params, as an extractor.
    if let Err(response) = valid::<TaskPaneParams>(json!({"taskId": task_id, "role": role})) {
        return *response;
    }
    let (cols, rows) = match terminal_size(query.as_deref()) {
        Ok(size) => size,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = upgrade.on_upgrade(move |mut socket| async move {
        if !origin_allowed(&headers, &state.session_config.reachable_address) {
            return close(&mut socket, 4403, "origin").await;
        }
        let shell = role == "shell";
        if state.with_database(|database| terminals::host_enabled(database)) {
            return host_terminal(socket, state, user_id, task_id, role, (cols, rows)).await;
        }
        let pane_id = if shell {
            let resolver = state.clone();
            let (user, task) = (user_id.clone(), task_id.clone());
            match tokio::task::spawn_blocking(move || {
                task_shell_pane(&resolver, &user, &task).map_err(|error| error.to_string())
            })
            .await
            {
                Ok(Ok(Some(pane_id))) => pane_id,
                Ok(Ok(None)) => return close(&mut socket, 4404, "no shell pane").await,
                _ => return close(&mut socket, 4404, "not found").await,
            }
        } else {
            let bound = bound_pane(&state, &user_id, &task_id, &role).map_err(|_| ());
            match bound {
                Ok(Some(pane_id)) => pane_id,
                Ok(None) => return close(&mut socket, 4404, "no attachment").await,
                Err(_) => return close(&mut socket, 4404, "not found").await,
            }
        };
        let (connection, events) = herdr_bridge::open(
            state.herdr.clone(),
            pane_id.clone(),
            shell.then_some(cols as f64),
            shell.then_some(rows as f64),
            if shell { Mode::Control } else { Mode::Observe },
        );
        let bridge = Bridge::Herdr(connection, events);
        let session = TerminalSession {
            pane_id: pane_id.clone(),
            read_only: !shell,
            cols,
            rows,
            ended_code: if shell { 1000 } else { 1012 },
        };
        run_terminal(socket, session, bridge, || {
            match bound_pane(&state, &user_id, &task_id, &role) {
                Ok(current) if current.as_deref() == Some(pane_id.as_str()) => None,
                Ok(_) => Some((4404, "attachment changed")),
                Err(_) => Some((4403, "access revoked")),
            }
        })
        .await;
    });
    auth::append_cookies(&mut response, cookies);
    response
}

/// A host terminal view. The route starts a missing terminal, so a restart or
/// a stale stored pane id leads to a new terminal, never to an error.
async fn host_terminal(
    mut socket: WebSocket,
    state: AppState,
    user_id: String,
    task_id: String,
    role: String,
    (cols, rows): (i64, i64),
) {
    let shell = role == "shell";
    let binding = state.with_database(|database| {
        terminals::task_terminal(database, &user_id, &task_id, &role)
            .map_err(|error| error.to_string())
    });
    let (id, spec) = match binding {
        Ok(Some(binding)) => binding,
        Ok(None) => return close(&mut socket, 4404, "no attachment").await,
        Err(_) => return close(&mut socket, 4404, "not found").await,
    };
    let Ok(viewer) = state.host_terminals.open(&id, spec, cols, rows) else {
        return close(&mut socket, 4404, "terminal could not start").await;
    };
    if shell {
        viewer.resize(cols as f64, rows as f64);
    }
    let session = TerminalSession {
        pane_id: id.clone(),
        read_only: !shell,
        cols,
        rows,
        ended_code: if shell { 1000 } else { 1012 },
    };
    run_terminal(socket, session, Bridge::Host(viewer), || {
        match state.with_database(|database| {
            terminals::task_terminal_id(database, &user_id, &task_id, &role)
        }) {
            Ok(current) if current.as_deref() == Some(id.as_str()) => None,
            Ok(_) => Some((4404, "attachment changed")),
            Err(_) => Some((4403, "access revoked")),
        }
    })
    .await;
}

#[cfg(test)]
include!("../../../tests/routes/task_pane.rs");
