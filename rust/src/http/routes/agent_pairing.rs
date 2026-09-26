//! Pairing-code exchange: a one-time code becomes a scoped agent credential.

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use chrono::Utc;

use crate::{
    http::{
        AppState, agent_api_runtime,
        contracts::typed::{self, Contract, agent_api::PairingExchangeBody},
        session,
    },
    identity::external_agents,
};

use super::auth;

pub fn router() -> Router<AppState> {
    [
        "/api/agent/pairing/exchange",
        "/api/agent/pair",
        "/api/hermes/pairing/exchange",
        "/api/hermes/pair",
    ]
    .into_iter()
    .fold(Router::new(), |router, path| {
        router.route(path, post(exchange))
    })
}

async fn exchange(State(state): State<AppState>, headers: HeaderMap, bytes: Bytes) -> Response {
    let request = match auth::parsed_body(&headers, &bytes)
        .map(|value| PairingExchangeBody::parse(value.as_ref()))
    {
        Ok(Ok(request)) => request,
        Ok(Err(typed::ContractFailure::Issues(findings))) => {
            return agent_api_runtime::validation(findings, false);
        }
        Ok(Err(_)) => {
            return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
        }
        Err(response) => return *response,
    };
    // The exchange carries no session authority; a board cookie still needs a valid origin.
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    match state.with_database(|database| {
        external_agents::exchange(
            database,
            &request.pairing_code,
            request.profile_id.as_deref(),
            Utc::now(),
        )
    }) {
        Ok(exchanged) => (
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(exchanged),
        )
            .into_response(),
        Err(error) => agent_api_runtime::failure(error, false),
    }
}
