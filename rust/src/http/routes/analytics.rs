//! Company analytics, task costs, and timeline.

use crate::http::error::ApiError;
use crate::tasks::TaskError;
use std::{error::Error, path::PathBuf};

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use serde::Serialize;

use crate::{
    http::{AppState, contracts::typed::auth::CompanyIdParams, validation::ValidPath},
    identity::companies,
    platform::database::SuplexDatabase,
    shared::js_json,
    tasks::{analytics, timeline},
};

use super::{auth, profiles::authorize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/companies/{company_id}/analytics",
            get(company_analytics),
        )
        .route("/api/companies/{company_id}/task-costs", get(task_costs))
        .route(
            "/api/companies/{company_id}/timeline",
            get(company_timeline),
        )
}

fn respond<T: Serialize>(result: Result<T, Box<dyn Error>>, cookies: Vec<String>) -> Response {
    let mut response =
        match result.and_then(|value| serde_json::to_value(value).map_err(Into::into)) {
            Ok(value) => (
                [
                    (header::CONTENT_TYPE, "application/json; charset=utf-8"),
                    (header::CACHE_CONTROL, "private, no-store"),
                ],
                js_json::stringify(&value),
            )
                .into_response(),
            Err(error) => ApiError::response(error),
        };
    auth::append_cookies(&mut response, cookies);
    response
}

async fn company_analytics(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        analytics::analytics(database, &user_id, &company_id, Utc::now())
    });
    respond(result, cookies)
}

async fn task_costs(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        let analytics = analytics::analytics(database, &user_id, &company_id, Utc::now())?;
        analytics::task_costs(&analytics)
    });
    respond(result, cookies)
}

fn saved_timelines(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> Result<(Vec<timeline::SavedTimeline>, PathBuf), Box<dyn Error>> {
    let mut ids = analytics::company_task_ids(database, user_id, company_id, false)?;
    ids.extend(analytics::company_task_ids(
        database, user_id, company_id, true,
    )?);
    let mut saved = Vec::new();
    for id in ids {
        companies::require_company_access(database, user_id, company_id)?;
        saved.push(timeline::read_saved(database, &id)?.ok_or_else(TaskError::not_found)?);
    }
    let path = database
        .connection()
        .path()
        .ok_or("Task database has no file path")?;
    Ok((saved, PathBuf::from(path)))
}

async fn company_timeline(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (saved, database_path) =
        match state.with_database(|database| saved_timelines(database, &user_id, &company_id)) {
            Ok(value) => value,
            Err(error) => return respond::<()>(Err(error), cookies),
        };
    let observed =
        tokio::task::spawn_blocking(move || -> Result<timeline::TimelineResponse, String> {
            let mut tasks = Vec::new();
            let mut unavailable = 0;
            for task in saved {
                let value =
                    timeline::observe(&database_path, task).map_err(|error| error.to_string())?;
                tasks.extend(value.tasks);
                unavailable += value.unavailable_sessions;
            }
            Ok(timeline::TimelineResponse {
                tasks,
                unavailable_sessions: unavailable,
            })
        })
        .await;
    let result = match observed {
        Ok(Ok(value)) => state
            .with_database(|database| {
                analytics::company_task_ids(database, &user_id, &company_id, false)
            })
            .map(|_| value),
        Ok(Err(error)) => Err(error.into()),
        Err(error) => Err(Box::new(error) as Box<dyn Error>),
    };
    let mut response = respond(result, cookies);
    if response.status() == StatusCode::OK {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    }
    response
}

#[cfg(test)]
include!("../../../tests/routes/analytics.rs");
