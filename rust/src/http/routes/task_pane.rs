//! Live terminal views of task panes. Session panes are read-only observers;
//! the task Shell is interactive. Herdr owns the panes: a missing or recreated
//! pane closes the socket, and the browser reconnects to the current pane.

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
use tokio::sync::mpsc::UnboundedReceiver;

use crate::{
    http::{AppState, contracts::typed::finding, validation},
    integrations::herdr_bridge::{self, Bridge, BridgeEvent, Mode},
};

use super::{auth, profiles::authorize, task_worktree::validated_task_id};

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
    let values = url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let mut findings = Vec::new();
    let mut read = |name: &str, default: f64, minimum: f64, maximum: f64| {
        let Some((_, raw)) = values.iter().find(|(key, _)| key == name) else {
            return default;
        };
        let trimmed = raw.trim();
        let number = if trimmed.is_empty() {
            Some(0.0)
        } else {
            trimmed.parse::<f64>().ok()
        };
        let code = match number {
            None => Some("invalid_type"),
            Some(value) if !value.is_finite() || value.fract() != 0.0 => Some("invalid_type"),
            Some(value) if value < minimum => Some("too_small"),
            Some(value) if value > maximum => Some("too_big"),
            Some(_) => None,
        };
        if let Some(code) = code {
            findings.push(finding(code, &[json!(name)]));
        }
        number.unwrap_or(default)
    };
    let cols = read("cols", 80.0, 20.0, 300.0);
    let rows = read("rows", 24.0, 5.0, 150.0);
    if findings.is_empty() {
        Ok((cols as i64, rows as i64))
    } else {
        Err(Box::new(validation::validation_error_public(findings)))
    }
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
    bridge: Bridge,
    mut events: UnboundedReceiver<BridgeEvent>,
    mut access: impl FnMut() -> Option<(u16, &'static str)>,
) {
    let opened = json!({"type":"open","paneId":session.pane_id,"readOnly":session.read_only,"cols":session.cols,"rows":session.rows});
    if socket
        .send(Message::Text(opened.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.tick().await;
    loop {
        tokio::select! {
            message = socket.recv() => match message {
                Some(Ok(Message::Binary(bytes))) if !session.read_only => bridge.input(bytes.to_vec()),
                Some(Ok(Message::Text(text))) if !session.read_only => {
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
            event = events.recv() => match event {
                Some(BridgeEvent::Frame { width, height, bytes, .. }) => {
                    let size = json!({"type":"size","cols":width,"rows":height}).to_string();
                    if socket.send(Message::Text(size.into())).await.is_err()
                        || socket.send(Message::Binary(bytes.into())).await.is_err()
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
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    if !["root", "worker", "shell"].contains(&role.as_str()) {
        return validation::validation_error_public(vec![finding(
            "invalid_union",
            &[json!("role")],
        )]);
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
        let (bridge, events) = herdr_bridge::open(
            state.herdr.clone(),
            pane_id.clone(),
            shell.then_some(cols as f64),
            shell.then_some(rows as f64),
            if shell { Mode::Control } else { Mode::Observe },
        );
        let session = TerminalSession {
            pane_id: pane_id.clone(),
            read_only: !shell,
            cols,
            rows,
            ended_code: if shell { 1000 } else { 1012 },
        };
        run_terminal(socket, session, bridge, events, || {
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

#[cfg(test)]
include!("../../../tests/routes/task_pane.rs");
