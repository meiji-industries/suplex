//! Administrator routes for external agents: create, list, grants, pairing codes, rotation, revocation.

use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::Utc;
use serde_json::json;

use crate::{
    http::{
        AppState, agent_api_runtime,
        contracts::typed::agent_api::{
            AdminCreateBody, AdminListQuery, AdminProjectsBody, AgentIdParams, query_object,
        },
        validation::{Valid, ValidPath, valid},
    },
    identity::external_agents,
    platform::database::SuplexDatabase,
};

use super::auth;

type AgentPath = ValidPath<AgentIdParams>;

pub fn router() -> Router<AppState> {
    let mut router = Router::new();
    for prefix in ["/api/admin/external-agents", "/api/admin/hermes-agents"] {
        router = router
            .route(prefix, get(list).post(create))
            .route(
                &format!("{prefix}/{{agent_id}}/projects"),
                put(replace_projects),
            )
            .route(
                &format!("{prefix}/{{agent_id}}/pairing-code"),
                post(pairing_code),
            )
            .route(&format!("{prefix}/{{agent_id}}/rotate"), post(rotate))
            .route(&format!("{prefix}/{{agent_id}}/revoke"), post(revoke));
    }
    router
}

/// The authenticated plugin after validation: origin, then the live session.
fn respond(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    operation: impl FnOnce(&mut SuplexDatabase, &str) -> Result<Response, Box<dyn std::error::Error>>,
) -> Response {
    let (user, cookies) = match crate::http::access::authorize_method(state, headers, method) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = state
        .with_database(|database| operation(database, &user))
        .unwrap_or_else(|error| agent_api_runtime::failure(error, false));
    auth::append_cookies(&mut response, cookies);
    response
}

fn no_store(status: StatusCode, value: impl serde::Serialize) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(value),
    )
        .into_response()
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = match valid::<AdminListQuery>(query_object(query.as_deref())) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    respond(&state, &headers, "GET", |database, user| {
        let agents = external_agents::list(database, user, query.company_id.as_deref())?;
        Ok(Json(json!({"agents": agents})).into_response())
    })
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(request): Valid<AdminCreateBody>,
) -> Response {
    respond(&state, &headers, "POST", |database, user| {
        let issued = external_agents::create(
            database,
            user,
            external_agents::CreateInput {
                name: &request.name,
                company_id: &request.company_id,
                project_ids: &request.project_ids,
                avatar_seed: request.avatar_seed.as_deref(),
            },
            Utc::now(),
        )?;
        Ok(no_store(StatusCode::CREATED, issued))
    })
}

async fn replace_projects(
    State(state): State<AppState>,
    ValidPath(AgentIdParams { agent_id: id }): AgentPath,
    headers: HeaderMap,
    Valid(request): Valid<AdminProjectsBody>,
) -> Response {
    respond(&state, &headers, "PUT", |database, user| {
        let agent = external_agents::replace_projects(
            database,
            user,
            &id,
            &request.project_ids,
            Utc::now(),
        )?;
        Ok(Json(json!({"agent": agent})).into_response())
    })
}

async fn pairing_code(
    State(state): State<AppState>,
    ValidPath(AgentIdParams { agent_id: id }): AgentPath,
    headers: HeaderMap,
) -> Response {
    respond(&state, &headers, "POST", |database, user| {
        let code = external_agents::issue_initial_pairing(database, user, &id, Utc::now())?;
        Ok(no_store(StatusCode::OK, code))
    })
}

async fn rotate(
    State(state): State<AppState>,
    ValidPath(AgentIdParams { agent_id: id }): AgentPath,
    headers: HeaderMap,
) -> Response {
    respond(&state, &headers, "POST", |database, user| {
        let code = external_agents::rotate(database, user, &id, Utc::now())?;
        Ok(no_store(StatusCode::OK, code))
    })
}

async fn revoke(
    State(state): State<AppState>,
    ValidPath(AgentIdParams { agent_id: id }): AgentPath,
    headers: HeaderMap,
) -> Response {
    respond(&state, &headers, "POST", |database, user| {
        external_agents::revoke(database, user, &id, Utc::now())?;
        Ok(StatusCode::NO_CONTENT.into_response())
    })
}

#[cfg(test)]
include!("../../../tests/routes/external_agent_administration.rs");
