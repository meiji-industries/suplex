//! Moves: list, create, edit, delete, start, and read run history.

#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use crate::http::error::ApiError;
use std::error::Error;

use axum::{
    Json, Router,
    extract::{Path, RawQuery, State, ws::WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::Utc;

use crate::{
    http::{
        AppState,
        contracts::typed::moves::{CompanyMovesParams, MoveBody, MoveRunBody},
        session,
        validation::{Valid, ValidPath},
    },
    moves,
    platform::database::SuplexDatabase,
};

use super::{
    auth,
    task_pane::{TerminalSession, origin_allowed, run_terminal, terminal_size},
};
use crate::terminals::Bridge;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/companies/{company_id}/moves", get(list).post(create))
        .route("/api/moves/{move_id}", patch(update).delete(delete))
        .route("/api/moves/{move_id}/runs", get(runs).post(start))
        .route(
            "/api/projects/{project_id}/move-recommendations",
            post(recommend),
        )
        .route("/api/move-runs/{run_id}", get(run))
        .route("/api/move-runs/{run_id}/archive", post(archive))
        .route("/api/move-runs/{run_id}/transcript", get(transcript))
        .route(
            "/api/move-runs/{run_id}/terminal",
            get(terminal).delete(end),
        )
}

fn observed(state: &AppState, run: moves::MoveRunResponse) -> moves::MoveRunResponse {
    moves::observed(&state.host_terminals, run)
}

pub(super) fn admitted(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> Result<(String, Vec<String>), Box<Response>> {
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(|error| Box::new(ApiError::response(error)))?;
    match session.user {
        Some(user) => Ok((user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn respond<T: serde::Serialize>(
    state: &AppState,
    headers: &HeaderMap,
    method: Method,
    status: StatusCode,
    operation: impl FnOnce(&mut SuplexDatabase, &str) -> Result<T, Box<dyn Error + Send + Sync>>,
) -> Response {
    let (user_id, cookies) = match admitted(state, headers, &method) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = match state.with_database(|database| operation(database, &user_id)) {
        Ok(_) if status == StatusCode::NO_CONTENT => status.into_response(),
        Ok(value) => (status, Json(value)).into_response(),
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

async fn list(
    State(state): State<AppState>,
    ValidPath(CompanyMovesParams { company_id }): ValidPath<CompanyMovesParams>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::GET,
        StatusCode::OK,
        |database, user_id| {
            let mut list = moves::list(database, user_id, &company_id)?;
            for item in &mut list.moves {
                item.last_run = item.last_run.take().map(|run| observed(&state, run));
            }
            Ok(list)
        },
    )
}

async fn create(
    State(state): State<AppState>,
    ValidPath(CompanyMovesParams { company_id }): ValidPath<CompanyMovesParams>,
    headers: HeaderMap,
    Valid(body): Valid<MoveBody>,
) -> Response {
    respond(
        &state,
        &headers,
        Method::POST,
        StatusCode::CREATED,
        |database, user_id| moves::create(database, user_id, &company_id, body),
    )
}

async fn update(
    State(state): State<AppState>,
    Path(move_id): Path<String>,
    headers: HeaderMap,
    Valid(body): Valid<MoveBody>,
) -> Response {
    respond(
        &state,
        &headers,
        Method::PATCH,
        StatusCode::OK,
        |database, user_id| moves::update(database, user_id, &move_id, body),
    )
}

async fn delete(
    State(state): State<AppState>,
    Path(move_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::DELETE,
        StatusCode::NO_CONTENT,
        |database, user_id| moves::delete(database, user_id, &move_id),
    )
}

async fn runs(
    State(state): State<AppState>,
    Path(move_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::GET,
        StatusCode::OK,
        |database, user_id| {
            let mut runs = moves::runs(database, user_id, &move_id)?;
            runs.runs = runs
                .runs
                .into_iter()
                .map(|run| observed(&state, run))
                .collect();
            Ok(runs)
        },
    )
}

async fn start(
    State(state): State<AppState>,
    Path(move_id): Path<String>,
    headers: HeaderMap,
    Valid(body): Valid<MoveRunBody>,
) -> Response {
    let (user_id, cookies) = match admitted(&state, &headers, &Method::POST) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response =
        match moves::start(&state, moves::RunActor::User(&user_id), &move_id, body).await {
            Ok((true, run)) => (StatusCode::CREATED, Json(observed(&state, run))).into_response(),
            Ok((false, run)) => Json(observed(&state, run)).into_response(),
            Err(error) => ApiError::response(error),
        };
    auth::append_cookies(&mut response, cookies);
    response
}

async fn run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::GET,
        StatusCode::OK,
        |database, user_id| {
            Ok(observed(
                &state,
                moves::get_run(database, user_id, &run_id)?,
            ))
        },
    )
}

async fn end(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::DELETE,
        StatusCode::NO_CONTENT,
        |database, user_id| {
            moves::get_run(database, user_id, &run_id)?;
            state
                .host_terminals
                .close(&moves::shell::terminal_id(&run_id));
            Ok(())
        },
    )
}

/// Proposed moves for a project, read by its default Worker. Nothing is saved.
async fn recommend(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match admitted(&state, &headers, &Method::POST) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = match moves::recommend::recommend(&state, &user_id, &project_id).await {
        Ok(recommendations) => Json(recommendations).into_response(),
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

async fn transcript(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::GET,
        StatusCode::OK,
        |database, user_id| moves::transcript(database, user_id, &run_id),
    )
}

/// Archiving also closes the terminal, so no hidden run stays live.
async fn archive(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::POST,
        StatusCode::NO_CONTENT,
        |database, user_id| {
            moves::archive_run(database, user_id, &run_id)?;
            state
                .host_terminals
                .close(&moves::shell::terminal_id(&run_id));
            Ok(())
        },
    )
}

async fn terminal(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (cols, rows) = match terminal_size(query.as_deref()) {
        Ok(size) => size,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match admitted(&state, &headers, &Method::GET) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let id = moves::shell::terminal_id(&run_id);
    let allowed = state
        .with_database(|database| moves::get_run(database, &user_id, &run_id))
        .is_ok();
    let mut response = upgrade.on_upgrade(move |mut socket| async move {
        let viewer =
            if !origin_allowed(&headers, &state.session_config.reachable_address) || !allowed {
                None
            } else {
                state.host_terminals.attach(&id)
            };
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
include!("../../../tests/routes/moves.rs");
