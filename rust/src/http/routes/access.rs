use axum::{
    Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};

use crate::{
    http::{
        AppState,
        access::{authorize_profile, with_cookies},
        error::ApiError,
    },
    identity::remote_access_repository::{self as remote_access, RemoteAccessPolicy},
};

crate::shared::wire_enum! {
    pub enum NetworkAccessMode {
        Local = "local",
        Tailscale = "tailscale",
        All = "all",
    }
}

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccessResponse {
    settings: AccessSettings,
    https_origin: Option<String>,
    network_mode: Option<NetworkAccessMode>,
}

#[derive(Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct AccessSettings {
    external_https_origin: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/admin/access", get(read).put(update))
}

fn response(state: &AppState, _actor: &str) -> Result<AccessResponse, Box<dyn std::error::Error>> {
    state.with_database(|database| {
        let policy = remote_access::read(database)?;
        Ok(AccessResponse {
            https_origin: remote_access::effective_https_origin(
                &policy,
                &state.session_config.reachable_address,
            ),
            settings: AccessSettings {
                external_https_origin: policy.external_https_origin().map(str::to_owned),
            },
            network_mode: state
                .installation
                .as_ref()
                .and_then(|installation| NetworkAccessMode::parse(&installation.access_mode)),
        })
    })
}

async fn read(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authorize_profile(&state, &headers, "GET", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = response(&state, &actor)
        .map(Json)
        .map(IntoResponse::into_response)
        .unwrap_or_else(ApiError::response);
    with_cookies(result, cookies)
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(settings): Json<AccessSettings>,
) -> Response {
    let (actor, cookies) = match authorize_profile(&state, &headers, "PUT", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let updated = state.with_database(|database| {
        let policy = remote_access::normalize(
            database,
            RemoteAccessPolicy::Passkeys {
                external_https_origin: settings.external_https_origin,
            },
        )?;
        remote_access::update(database, policy)
    });
    let response = match updated.and_then(|_| response(&state, &actor)) {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}
