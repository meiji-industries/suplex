//! Task timeline reads saved usage and current native execution evidence.

#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use crate::http::error::ApiError;

use crate::http::access::authorize;
use crate::tasks::TaskError;
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::compression::CompressionLayer;

use crate::{
    http::{AppState, contracts::typed::tasks::TaskIdParams, validation::ValidPath},
    platform::database::SuplexDatabase,
    tasks::timeline::{self, SavedTimeline, TimelineResponse},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/tasks/{task_id}/timeline",
        get(task_timeline).layer(CompressionLayer::new()),
    )
}

fn scoped(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<(SavedTimeline, PathBuf), Box<dyn Error + Send + Sync>> {
    crate::tasks::authorize_task(database, user_id, task_id)?;
    let saved = timeline::read_saved(database, task_id)?.ok_or_else(TaskError::not_found)?;
    let database_path = PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Task database has no file path")?,
    );
    Ok((saved, database_path))
}

fn recheck(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    crate::tasks::authorize_task(database, user_id, task_id)?;
    Ok(())
}

fn respond(
    result: Result<TimelineResponse, Box<dyn Error + Send + Sync>>,
    cookies: Vec<String>,
) -> Response {
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

async fn task_timeline(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (saved, database_path) =
        match state.with_database(|database| scoped(database, &user_id, &task_id)) {
            Ok(value) => value,
            Err(error) => return respond(Err(error), cookies),
        };
    let observation = match timeline::observe(&database_path, saved).await {
        Ok(value) => value,
        Err(error) => return respond(Err(error.to_string().into()), cookies),
    };
    let scope = state.with_database(|database| recheck(database, &user_id, &task_id));
    respond(scope.map(|_| observation), cookies)
}

#[cfg(test)]
include!("../../../tests/routes/task_timeline.rs");
