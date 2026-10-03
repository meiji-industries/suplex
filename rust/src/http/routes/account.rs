//! The Suplex account linked to this installation: read, log in, log out.

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;

use crate::{
    accounts::{self, AccountLoginState, LoginPoll},
    http::{
        AppState,
        access::{SessionUser, with_cookies},
        contracts::typed::account::{
            AccountLoginBody, AccountLoginResponse, AccountLoginStatusResponse, AccountResponse,
            AccountSummary, AttemptIdParams,
        },
        error::ApiError,
        validation::{Valid, ValidPath},
    },
    shared::PublicFailure,
};

use super::admin_platform::{administrator, record_audit};

const ADMIN_REQUIRED: &str = "Administrator access required";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/account", get(read))
        .route("/api/account/login", post(login))
        .route("/api/account/login/{attempt_id}", get(login_status))
        .route("/api/account/logout", post(logout))
}

fn private(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn failure(failure: PublicFailure) -> Response {
    private(ApiError(failure).into_response())
}

async fn read(State(state): State<AppState>, SessionUser(user): SessionUser) -> Response {
    let account = match state.with_database(|database| accounts::linked(database)) {
        Ok(account) => account,
        Err(error) => return ApiError::response(error),
    };
    private(
        Json(AccountResponse {
            configured: state.accounts.is_some(),
            can_manage: user.role == "admin",
            account: account.map(|account| AccountSummary {
                email: account.email,
                display_name: account.display_name,
            }),
        })
        .into_response(),
    )
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<AccountLoginBody>,
) -> Response {
    let (_, cookies) = match administrator(&state, &headers, &Method::POST, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(client) = state.accounts.clone() else {
        return with_cookies(failure(accounts::not_configured()), cookies);
    };
    let response = match client
        .start_login(body.provider, body.email.as_deref())
        .await
    {
        Ok((attempt_id, url)) => {
            private(Json(AccountLoginResponse { attempt_id, url }).into_response())
        }
        Err(error) => failure(error),
    };
    with_cookies(response, cookies)
}

async fn login_status(
    State(state): State<AppState>,
    SessionUser(user): SessionUser,
    ValidPath(AttemptIdParams { attempt_id }): ValidPath<AttemptIdParams>,
) -> Response {
    let Some(client) = state.accounts.clone() else {
        return failure(accounts::not_configured());
    };
    let status = match client.poll_login(&attempt_id).await {
        Ok(LoginPoll::Pending) => AccountLoginState::Pending,
        Ok(LoginPoll::Expired) => AccountLoginState::Expired,
        Ok(LoginPoll::Complete { token, account }) => {
            let linked = state.with_database(|database| {
                accounts::link(database, &account, &token)?;
                record_audit(database, Some(&user.id), "account_linked", json!({}))
            });
            if let Err(error) = linked {
                return ApiError::response(error);
            }
            AccountLoginState::Complete
        }
        Err(error) => return failure(error),
    };
    private(Json(AccountLoginStatusResponse { status }).into_response())
}

/// Removes the local link first, so a hosted outage never keeps an account
/// linked. The hosted token revocation is best effort.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user, cookies) = match administrator(&state, &headers, &Method::POST, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let token = state.with_database(|database| {
        let token = accounts::unlink(database)?;
        if token.is_some() {
            record_audit(database, Some(&user.id), "account_unlinked", json!({}))?;
        }
        Ok(token)
    });
    let token = match token.map_err(ApiError::response) {
        Ok(token) => token,
        Err(response) => return with_cookies(response, cookies),
    };
    if let (Some(client), Some(token)) = (state.accounts.clone(), token) {
        client.logout(&token).await;
    }
    with_cookies(private(StatusCode::NO_CONTENT.into_response()), cookies)
}

#[cfg(test)]
include!("../../../tests/routes/account.rs");
