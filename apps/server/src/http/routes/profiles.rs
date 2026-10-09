pub(crate) use crate::http::access::authorize_profile as authorize;
use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use axum::{
    Json, Router,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{
            agent_api::query_object,
            projects::{IncludeArchivedQuery, profile_response},
        },
        validation::{Valid, valid},
    },
    profiles::agent_profiles::{self, AgentProfile, ProfileInput, ProfilePatch},
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/profiles", get(list))
        .route("/api/admin/profiles", post(create))
        .route("/api/admin/profiles/defaults", post(choose_defaults))
        .route(
            "/api/admin/profiles/{agent_id}",
            axum::routing::patch(update).delete(delete),
        )
        .route("/api/admin/profiles/{agent_id}/duplicate", post(duplicate))
}

/// `AgentProfileSchema` output in its key order; a profile that fails it is a 500.
fn view(profile: &AgentProfile) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    profile_response(&serde_json::to_value(profile)?)
        .map_err(|failure| format!("profile response is invalid: {failure:?}").into())
}

/// A profile response with the given status.
fn respond_profile(
    result: Result<AgentProfile, Box<dyn std::error::Error + Send + Sync>>,
    status: StatusCode,
) -> Response {
    match result.and_then(|profile| view(&profile)) {
        Ok(profile) => (status, Json(profile)).into_response(),
        Err(error) => ApiError::response(error),
    }
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = match valid::<IncludeArchivedQuery>(query_object(query.as_deref())) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let include_archived = query.include_archived.is_some();
    let response = match state
        .with_database(|database| agent_profiles::list(database, &user_id, include_archived))
    {
        Ok(profiles) => match profiles.iter().map(view).collect::<Result<Vec<_>, _>>() {
            Ok(profiles) => Json(json!({ "profiles": profiles })).into_response(),
            Err(error) => ApiError::response(error),
        },
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(input): Valid<ProfileInput>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = respond_profile(
        state.with_database(|database| {
            agent_profiles::create(database, &user_id, &input, Utc::now())
        }),
        StatusCode::CREATED,
    );
    with_cookies(response, cookies)
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Valid(patch): Valid<ProfilePatch>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "PATCH", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = respond_profile(
        state.with_database(|database| {
            agent_profiles::update(database, &user_id, &agent_id, patch, Utc::now())
        }),
        StatusCode::OK,
    );
    with_cookies(response, cookies)
}

async fn duplicate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = respond_profile(
        state.with_database(|database| {
            agent_profiles::duplicate(database, &user_id, &agent_id, Utc::now())
        }),
        StatusCode::CREATED,
    );
    with_cookies(response, cookies)
}

async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "DELETE", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| agent_profiles::delete(database, &user_id, &agent_id, Utc::now()))
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn choose_defaults(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    // Signed-in providers win; before any sign-in, installed ones do.
    use crate::profiles::provider_connection::provider_connection;
    let providers = ["claude-code", "codex", "devin"];
    let (claude, codex, devin) = tokio::join!(
        provider_connection("claude-code"),
        provider_connection("codex"),
        provider_connection("devin"),
    );
    let connected: Vec<&str> = providers
        .into_iter()
        .zip([claude, codex, devin])
        .filter(|(_, connection)| connection["status"] == "connected")
        .map(|(provider, _)| provider)
        .collect();
    let response = match state.with_database(|database| {
        agent_profiles::choose_defaults(
            database,
            &user_id,
            |provider| {
                if connected.is_empty() {
                    agent_profiles::provider_installed(provider)
                } else {
                    connected.contains(&provider)
                }
            },
            Utc::now(),
        )
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/profiles.rs");
