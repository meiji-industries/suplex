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
use serde_json::json;

use crate::{
    http::{
        AppState,
        contracts::typed::{agent_api::query_object, projects::IncludeArchivedQuery},
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

/// `AgentProfileSchema` output: the Zod shape's key order.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileView<'a> {
    provider: &'a str,
    model: &'a str,
    reasoning_level: &'a str,
    service_tier: &'a str,
    provider_instance_id: &'a Option<String>,
    name: &'a str,
    role: &'a str,
    avatar_seed: &'a str,
    id: &'a str,
    archived_at: &'a Option<String>,
    created_at: &'a str,
    updated_at: &'a str,
}

fn view(profile: &AgentProfile) -> ProfileView<'_> {
    ProfileView {
        provider: &profile.provider,
        model: &profile.model,
        reasoning_level: &profile.reasoning_level,
        service_tier: &profile.service_tier,
        provider_instance_id: &profile.provider_instance_id,
        name: &profile.name,
        role: &profile.role,
        avatar_seed: &profile.avatar_seed,
        id: &profile.id,
        archived_at: &profile.archived_at,
        created_at: &profile.created_at,
        updated_at: &profile.updated_at,
    }
}

/// A profile response with the given status.
fn profile_response(
    result: Result<AgentProfile, Box<dyn std::error::Error>>,
    status: StatusCode,
) -> Response {
    match result {
        Ok(profile) => (status, Json(view(&profile))).into_response(),
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
        Ok(profiles) => Json(json!({ "profiles": profiles.iter().map(view).collect::<Vec<_>>() }))
            .into_response(),
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
    let response = profile_response(
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
    let response = profile_response(
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
    let response = profile_response(
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
    let response = match state.with_database(|database| {
        agent_profiles::choose_defaults(
            database,
            &user_id,
            agent_profiles::provider_installed,
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
