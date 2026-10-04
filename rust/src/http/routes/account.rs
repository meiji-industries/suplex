//! The Suplex account linked to this installation: read, log in, log out.

use crate::{
    http::session,
    shared::{hash::sha256_hex, time::rfc3339_millis},
};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{Duration, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::json;

use crate::{
    accounts::{self, AccountLoginState, LoginPoll},
    http::{
        AppState,
        access::with_cookies,
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

async fn read(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let local = session::is_local_recovery(&headers);
    let user = crate::http::access::SessionUser::read(&state, &headers)
        .ok()
        .map(|(user, _)| user);
    let account = state.with_database(|database| {
        if local {
            return Ok(accounts::linked(database)?.map(|account| AccountSummary {
                email: account.email,
                display_name: account.display_name,
            }));
        }
        let Some(user) = user.as_ref() else {
            return Ok(None);
        };
        if user.id == "user_development" {
            return Ok(accounts::linked(database)?.map(|account| AccountSummary {
                email: account.email,
                display_name: account.display_name,
            }));
        }
        let email: Option<String> = database
            .connection()
            .query_row(
                "SELECT email FROM suplex_account_users WHERE user_id = ?1",
                [&user.id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(email.map(|email| AccountSummary {
            email,
            display_name: Some(user.display_name.clone()),
        }))
    });
    match account {
        Ok(account) => private(
            Json(AccountResponse {
                configured: state.accounts.is_some(),
                can_manage: if local {
                    user.as_ref().is_some_and(|user| user.role == "admin")
                } else {
                    user.is_none()
                },
                account,
            })
            .into_response(),
        ),
        Err(error) => ApiError::response(error),
    }
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<AccountLoginBody>,
) -> Response {
    let local = session::is_local_recovery(&headers);
    let cookies = if local {
        match administrator(&state, &headers, &Method::POST, ADMIN_REQUIRED) {
            Ok((_, cookies)) => cookies,
            Err(response) => return *response,
        }
    } else {
        let origin = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok());
        let verified = headers
            .get(session::VERIFIED_ORIGIN_HEADER)
            .and_then(|h| h.to_str().ok());
        if !session::is_verified_https(&headers) || origin.is_none() || origin != verified {
            return failure(PublicFailure::new(
                403,
                "Open the HTTPS host address to log in",
            ));
        }
        Vec::new()
    };
    // A loopback login already links the owner; a remote one does when it carries a recovery link.
    let recovery = match body.recovery.as_deref().filter(|_| !local) {
        Some(token) => match state.with_database(|database| {
            accounts::members::recovery_invitation(database, token, Utc::now())
        }) {
            Ok(Some(id)) => Some(id),
            Ok(None) => {
                return failure(PublicFailure::new(
                    403,
                    "This recovery link expired or was used. Run suplex recover again.",
                ));
            }
            Err(error) => return ApiError::response(error),
        },
        None => None,
    };
    let Some(client) = state.accounts.clone() else {
        return with_cookies(failure(accounts::not_configured()), cookies);
    };
    let response = match client
        .start_login(
            body.provider,
            body.email.as_deref(),
            body.client.unwrap_or_default(),
        )
        .await
    {
        Ok((attempt_id, url)) => {
            let Ok(browser) = accounts::wire::random_token() else {
                return failure(PublicFailure::internal());
            };
            if let Err(error) = state.with_database(|database| {
                database.connection().execute("DELETE FROM suplex_account_login_attempts WHERE expires_at <= ?1", [rfc3339_millis(Utc::now())])?;
                database.connection().execute("INSERT INTO suplex_account_login_attempts (id, browser_hash, local_owner, expires_at, recovery_invitation_id) VALUES (?1, ?2, ?3, ?4, ?5)", params![attempt_id, sha256_hex(&browser), local, rfc3339_millis(Utc::now() + Duration::minutes(15)), recovery])?;
                Ok(())
            }) { return ApiError::response(error); }
            let security = if local { "" } else { "; Secure" };
            with_cookies(
                private(Json(AccountLoginResponse { attempt_id, url }).into_response()),
                vec![format!(
                    "suplex_login={browser}; Path=/api/account; HttpOnly; SameSite=Strict; Max-Age=900{security}"
                )],
            )
        }
        Err(error) => failure(error),
    };
    with_cookies(response, cookies)
}

async fn login_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(AttemptIdParams { attempt_id }): ValidPath<AttemptIdParams>,
) -> Response {
    let local = session::is_local_recovery(&headers);
    let browser = session::cookie(&headers, "suplex_login").unwrap_or_default();
    let bound = state.with_database(|database| -> crate::platform::database::DatabaseResult<Option<Option<String>>> {
        Ok(database.connection().query_row("SELECT recovery_invitation_id FROM suplex_account_login_attempts WHERE id = ?1 AND browser_hash = ?2 AND local_owner = ?3 AND expires_at > ?4", params![attempt_id, sha256_hex(&browser), local, rfc3339_millis(Utc::now())], |row| row.get(0)).optional()?)
    }).unwrap_or(None);
    let Some(recovery) = bound else {
        return failure(PublicFailure::new(
            403,
            "This login belongs to another browser or expired",
        ));
    };
    let mut cookies = Vec::new();
    let Some(client) = state.accounts.clone() else {
        return failure(accounts::not_configured());
    };
    let status = match client.poll_login(&attempt_id).await {
        Ok(LoginPoll::Pending) => AccountLoginState::Pending,
        Ok(LoginPoll::Expired) => AccountLoginState::Expired,
        Ok(LoginPoll::Complete { token, account }) => {
            let accepted = state
                .with_database(|database| {
                    if local {
                        accounts::link(database, &account, &token)?;
                        record_audit(
                            database,
                            Some("user_development"),
                            "account_linked",
                            json!({}),
                        )?;
                        Ok(None)
                    } else if let Some(invitation) = recovery.as_deref() {
                        accounts::members::recover(
                            database,
                            invitation,
                            &account,
                            &token,
                            Utc::now(),
                        )
                        .map(Some)
                    } else {
                        accounts::members::accept(database, &account, Utc::now()).map(Some)
                    }
                })
                .map_err(ApiError::response);
            // The owner link keeps its hosted token; a member login does not need one.
            if !local && (recovery.is_none() || accepted.is_err()) {
                client.logout(&token).await;
            }
            let session_token = match accepted {
                Ok(value) => value,
                Err(response) => return response,
            };
            if let Some(token) = session_token {
                cookies =
                    match session::set_session_cookies(&state.session_config, &token, Some(true)) {
                        Ok(value) => value,
                        Err(error) => return ApiError::response(error),
                    };
            }
            if let Err(error) = state.with_database(
                |database| -> crate::platform::database::DatabaseResult<()> {
                    database.connection().execute(
                        "DELETE FROM suplex_account_login_attempts WHERE id = ?1",
                        [&attempt_id],
                    )?;
                    Ok(())
                },
            ) {
                return ApiError::response(error);
            }
            // A newly linked account brings its plan, such as a trial
            // started on suplex.sh.
            let _ = crate::billing::refresh(&state).await;
            AccountLoginState::Complete
        }
        Err(error) => return failure(error),
    };
    with_cookies(
        private(Json(AccountLoginStatusResponse { status }).into_response()),
        cookies,
    )
}

/// Removes the local link first, so a hosted outage never keeps an account
/// linked. The hosted token revocation is best effort.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session::is_local_recovery(&headers) {
        if let Err(error) = crate::http::access::Csrf::check(&state, &headers, "POST") {
            return error.into_response();
        }
        let token = session::cookie(&headers, session::SESSION_COOKIE_NAME).unwrap_or_default();
        if let Err(error) = state
            .with_database(|database| crate::identity::auth::sign_out(database, &token, Utc::now()))
        {
            return ApiError::response(error);
        }
        return with_cookies(
            StatusCode::NO_CONTENT.into_response(),
            session::clear_session_cookies(),
        );
    }
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
