//! The quick shell: one host login shell for each admin, in the home
//! directory. It stays open between views until its person exits it or
//! Suplex stops, so closing the console never ends the shell.

#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use axum::{
    Router,
    extract::{RawQuery, State, ws::WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::get,
};

use super::{
    auth,
    task_pane::{TerminalSession, origin_allowed, run_terminal, terminal_size},
};
use crate::{
    http::AppState,
    identity::companies,
    terminals::{Bridge, host::Spec},
};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/quick-shell/terminal", get(terminal))
}

fn terminal_id(user_id: &str) -> String {
    format!("quick-shell:{user_id}")
}

/// Starts the person's quick shell when it is not running, then shows it.
async fn terminal(
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (cols, rows) = match terminal_size(query.as_deref()) {
        Ok(size) => size,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match super::moves::admitted(&state, &headers, &Method::GET) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    // A host shell runs as the Suplex process, so only an admin gets one.
    if state
        .with_database(|database| companies::require_admin(database, &user_id))
        .is_err()
    {
        let mut response = auth::error(
            StatusCode::FORBIDDEN,
            "Only an admin can open the quick shell",
        );
        auth::append_cookies(&mut response, cookies);
        return response;
    }
    let mut response = upgrade.on_upgrade(move |mut socket| async move {
        let id = terminal_id(&user_id);
        let viewer = origin_allowed(&headers, &state.session_config.reachable_address)
            .then(|| {
                state
                    .host_terminals
                    .open(&id, Spec::quick_shell(), cols, rows)
                    .ok()
            })
            .flatten();
        let Some(viewer) = viewer else {
            let frame = axum::extract::ws::CloseFrame {
                code: 4404,
                reason: "terminal closed".into(),
            };
            let _ = socket
                .send(axum::extract::ws::Message::Close(Some(frame)))
                .await;
            return;
        };
        viewer.resize(cols as f64, rows as f64);
        let session = TerminalSession {
            pane_id: id.clone(),
            read_only: false,
            cols,
            rows,
            ended_code: 1000,
        };
        run_terminal(socket, session, Bridge::Host(viewer), || {
            (!state.host_terminals.contains(&id)).then_some((4404, "terminal closed"))
        })
        .await;
    });
    auth::append_cookies(&mut response, cookies);
    response
}

#[cfg(test)]
include!("../../../tests/routes/quick_shell.rs");
