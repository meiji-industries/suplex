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
    identity::remote_access_repository as remote_access,
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

fn response(
    state: &AppState,
    _actor: &str,
) -> Result<AccessResponse, Box<dyn std::error::Error + Send + Sync>> {
    state.with_database(|database| {
        let external_https_origin = remote_access::external_https_origin(database)?;
        Ok(AccessResponse {
            https_origin: remote_access::effective_https_origin(
                external_https_origin.as_deref(),
                &state.session_config.reachable_address,
            ),
            settings: AccessSettings {
                external_https_origin,
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
        remote_access::set_external_https_origin(
            database,
            settings.external_https_origin.as_deref(),
        )
    });
    let response = match updated.and_then(|_| response(&state, &actor)) {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}
