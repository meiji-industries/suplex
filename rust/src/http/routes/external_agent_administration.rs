//! Administrator routes for external agents: create, list, grants, pairing codes, rotation, revocation.

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    http::{
        AppState, agent_api_runtime,
        contracts::typed::{self, ContractResult, agent_api},
        session,
    },
    identity::external_agents,
};

use super::auth;

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

fn parsed<T>(result: ContractResult<T>) -> Result<T, Box<Response>> {
    match result {
        Ok(value) => Ok(value),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(agent_api_runtime::validation(findings, false)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn body<T>(
    headers: &HeaderMap,
    bytes: &Bytes,
    parse: fn(Option<&Value>) -> ContractResult<T>,
) -> Result<T, Box<Response>> {
    let value = auth::parsed_body(headers, bytes)?;
    parsed(parse(value.as_ref()))
}

/// The authenticated plugin: validation first, then origin, then the live session.
fn session_user(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
) -> Result<(String, Vec<String>), Box<Response>> {
    if !session::csrf_allowed(&state.session_config, headers, method, false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(|error| Box::new(auth::service_error(error)))?;
    match session.user {
        Some(user) => Ok((user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn respond(result: Result<Response, Box<dyn std::error::Error>>, cookies: Vec<String>) -> Response {
    let mut response = result.unwrap_or_else(|error| agent_api_runtime::failure(error, false));
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

fn agent_id(id: String) -> Result<String, Box<Response>> {
    parsed(agent_api::parse_agent_id_params(Some(
        &json!({"agentId": id}),
    )))
    .map(|params| params.agent_id)
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = match parsed(agent_api::parse_admin_list(Some(&agent_api::query_object(
        query.as_deref(),
    )))) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "GET") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::list(database, &user, query.company_id.as_deref())
    });
    respond(
        result.map(|agents| Json(json!({"agents": agents})).into_response()),
        cookies,
    )
}

async fn create(State(state): State<AppState>, headers: HeaderMap, bytes: Bytes) -> Response {
    let request = match body(&headers, &bytes, agent_api::parse_admin_create) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::create(
            database,
            &user,
            external_agents::CreateInput {
                name: &request.name,
                company_id: &request.company_id,
                project_ids: &request.project_ids,
                avatar_seed: request.avatar_seed.as_deref(),
            },
            Utc::now(),
        )
    });
    respond(
        result.map(|issued| no_store(StatusCode::CREATED, issued)),
        cookies,
    )
}

async fn replace_projects(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let (id, request) = match agent_id(id)
        .and_then(|id| Ok((id, body(&headers, &bytes, agent_api::parse_admin_projects)?)))
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "PUT") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::replace_projects(database, &user, &id, &request.project_ids, Utc::now())
    });
    respond(
        result.map(|agent| Json(json!({"agent": agent})).into_response()),
        cookies,
    )
}

async fn pairing_code(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let id = match agent_id(id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::issue_initial_pairing(database, &user, &id, Utc::now())
    });
    respond(result.map(|code| no_store(StatusCode::OK, code)), cookies)
}

async fn rotate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let id = match agent_id(id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result =
        state.with_database(|database| external_agents::rotate(database, &user, &id, Utc::now()));
    respond(result.map(|code| no_store(StatusCode::OK, code)), cookies)
}

async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let id = match agent_id(id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result =
        state.with_database(|database| external_agents::revoke(database, &user, &id, Utc::now()));
    respond(
        result.map(|()| StatusCode::NO_CONTENT.into_response()),
        cookies,
    )
}

#[cfg(test)]
include!("../../../tests/routes/external_agent_administration.rs");
