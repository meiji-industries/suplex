use axum::{
    Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;

use crate::{
    http::{
        AppState,
        access::{authorize_profile, with_cookies},
        error::ApiError,
    },
    identity::{
        admin::CredentialSummary,
        auth::AuthUser,
        remote_access_repository::{self as remote_access, RemoteAccessPolicy},
    },
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
    policy: RemoteAccessPolicy,
    users: Vec<AuthUser>,
    credentials: Vec<CredentialSummary>,
    https_origin: Option<String>,
    network_mode: Option<NetworkAccessMode>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/admin/access", get(read).put(update))
}

fn response(state: &AppState, actor: &str) -> Result<AccessResponse, Box<dyn std::error::Error>> {
    state.with_database(|database| {
        let policy = remote_access::read(database)?;
        Ok(AccessResponse {
            https_origin: remote_access::effective_https_origin(
                &policy,
                &state.session_config.reachable_address,
            ),
            policy,
            users: crate::identity::admin::list_users(database, actor)?,
            credentials: crate::identity::admin::list_credentials(database, actor)?,
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
    Json(policy): Json<RemoteAccessPolicy>,
) -> Response {
    let (actor, cookies) = match authorize_profile(&state, &headers, "PUT", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let updated = state.with_database(|database| {
        let policy = remote_access::normalize(database, policy)?;
        if policy.requires_https()
            && remote_access::effective_https_origin(
                &policy,
                &state.session_config.reachable_address,
            )
            .is_none()
        {
            return Err(crate::identity::IdentityError::auth(
                "Configure an external HTTPS origin before HTTPS is necessary",
                400,
                "remote_access_invalid",
            )
            .into());
        }
        remote_access::update(database, policy)
    });
    let response = match updated.and_then(|_| response(&state, &actor)) {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}
