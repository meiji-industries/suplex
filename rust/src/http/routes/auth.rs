use crate::http::error::ApiError;
use std::error::Error;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::json;

use crate::{
    http::{
        access::with_cookies,
        contracts::typed::auth::{
            AuthenticationVerificationBody, CredentialIdParams, CredentialLabelBody, ProfileBody,
            RegistrationVerificationBody, SelfRegistrationVerificationBody, TokenBody,
        },
        validation::{Valid, ValidPath},
    },
    identity::{
        auth::{self, AuthUser, ProfileUpdate},
        ceremony::{self, PreparedCredential, WebAuthnSite},
    },
};

use super::super::{AppState, session};

#[derive(Serialize)]
struct AuthEnvelope {
    user: AuthUser,
}

#[derive(Serialize)]
struct AuthStatus {
    required: bool,
    authenticated: bool,
}

pub fn router(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/bootstrap/options", post(bootstrap_options))
        .route("/api/auth/invitation/options", post(invitation_options))
        .route("/api/auth/recovery/options", post(recovery_options))
        .route("/api/auth/bootstrap/verify", post(bootstrap_verify))
        .route("/api/auth/invitation/verify", post(invitation_verify))
        .route("/api/auth/recovery/verify", post(recovery_verify))
        .route(
            "/api/auth/options",
            post(authentication_options).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::http::access::csrf_layer,
            )),
        )
        .route("/api/auth/verify", post(authentication_verify))
        .route("/api/auth/me", get(me).patch(update_me))
        .route("/api/auth/sign-out", post(sign_out))
        .route(
            "/api/auth/passkeys/options",
            post(self_registration_options),
        )
        .route("/api/auth/passkeys/verify", post(self_registration_verify))
        .route(
            "/api/auth/passkeys/{credential_id}",
            axum::routing::patch(rename_passkey).delete(remove_passkey),
        )
}

fn site(config: &session::SessionConfig) -> Result<url::Url, Box<Response>> {
    url::Url::parse(&config.reachable_address).map_err(|_| {
        Box::new(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))
    })
}

fn ceremony_site(state: &AppState, headers: &HeaderMap) -> Result<url::Url, Box<Response>> {
    let origin = state
        .with_database(|database| {
            let policy = crate::identity::remote_access_repository::read(database)?;
            crate::identity::remote_access_repository::effective_https_origin(
                &policy,
                &state.session_config.reachable_address,
            )
            .or_else(|| {
                site(&state.session_config)
                    .ok()
                    .map(|url| url.origin().ascii_serialization())
            })
            .ok_or_else(|| -> Box<dyn Error> { "WebAuthn origin is not configured".into() })
        })
        .map_err(|error| Box::new(ApiError::response(error)))?;
    let supplied = headers.get("origin").and_then(|value| value.to_str().ok());
    let parsed = url::Url::parse(&origin).map_err(|_| {
        Box::new(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))
    })?;
    let trusted_transport = if parsed.scheme() == "https" {
        session::is_verified_https(headers)
    } else {
        session::is_local_recovery(headers)
    };
    if !trusted_transport || supplied != Some(parsed.origin().ascii_serialization().as_str()) {
        return Err(Box::new(error(
            StatusCode::FORBIDDEN,
            "Open the configured HTTPS address to manage passkeys",
        )));
    }
    Ok(parsed)
}

async fn registration_options(
    state: AppState,
    headers: HeaderMap,
    parsed: TokenBody,
    kind: &'static str,
) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let reachable = match ceremony_site(&state, &headers) {
        Ok(reachable) => reachable,
        Err(response) => return *response,
    };
    let token = parsed.token;
    let origin = reachable.origin().ascii_serialization();
    let result = state.with_database(|database| {
        ceremony::begin_registration(
            database,
            kind,
            &token,
            WebAuthnSite {
                origin: &origin,
                rp_id: reachable.host_str().unwrap_or_default(),
            },
            Utc::now(),
        )
    });
    match result {
        Ok(options) => Json(options).into_response(),
        Err(error) => ApiError::response(error),
    }
}

async fn registration_verify(
    state: AppState,
    headers: HeaderMap,
    parsed: RegistrationVerificationBody,
    kind: &'static str,
) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let reachable = match ceremony_site(&state, &headers) {
        Ok(reachable) => reachable,
        Err(response) => return *response,
    };
    let token = parsed.token;
    let challenge_id = parsed.challenge_id;
    let response = prepared_response(parsed.response);
    let origin = reachable.origin().ascii_serialization();
    let rp_id = reachable.host_str().unwrap_or_default().to_owned();
    // A blocking task continues the accepted ceremony if the HTTP waiter drops.
    let task = tokio::task::spawn_blocking(move || {
        run_registration_ceremony(RegistrationAttempt {
            state,
            kind,
            token,
            challenge_id,
            response,
            origin,
            rp_id,
            secure_cookie: reachable.scheme() == "https",
        })
    });
    match task.await {
        Ok(response) => response,
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

struct RegistrationAttempt {
    state: AppState,
    kind: &'static str,
    token: String,
    challenge_id: String,
    response: PreparedCredential,
    origin: String,
    rp_id: String,
    secure_cookie: bool,
}

fn run_registration_ceremony(attempt: RegistrationAttempt) -> Response {
    let RegistrationAttempt {
        state,
        kind,
        token,
        challenge_id,
        response,
        origin,
        rp_id,
        secure_cookie,
    } = attempt;
    let challenge = match state.with_database(|database| {
        ceremony::consume_registration_challenge(
            database,
            kind,
            &token,
            &challenge_id,
            &response,
            Utc::now(),
        )
    }) {
        Ok(challenge) => challenge,
        Err(error) => return ApiError::response(error),
    };
    let verified = match ceremony::verify_consumed_registration(
        &response,
        &challenge,
        WebAuthnSite {
            origin: &origin,
            rp_id: &rp_id,
        },
    ) {
        Ok(verified) => verified,
        Err(error) => return ApiError::response(error),
    };
    let result = state.with_database(|database| {
        ceremony::finish_registration(database, kind, &token, verified, Utc::now())
    });
    auth_result(&state, result, secure_cookie)
}

fn auth_result(
    state: &AppState,
    result: Result<auth::AuthResult, Box<dyn Error>>,
    secure_cookie: bool,
) -> Response {
    match result {
        Ok(result) => {
            let cookies = session::set_session_cookies(
                &state.session_config,
                &result.session_token,
                Some(secure_cookie),
            );
            match cookies {
                Ok(cookies) => {
                    let mut response = Json(AuthEnvelope { user: result.user }).into_response();
                    append_cookies(&mut response, cookies);
                    response
                }
                Err(error) => ApiError::response(error),
            }
        }
        Err(error) => ApiError::response(error),
    }
}

async fn bootstrap_options(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<TokenBody>,
) -> Response {
    registration_options(state, headers, body, "bootstrap").await
}

async fn invitation_options(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<TokenBody>,
) -> Response {
    registration_options(state, headers, body, "user").await
}

async fn recovery_options(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<TokenBody>,
) -> Response {
    registration_options(state, headers, body, "recovery").await
}

async fn bootstrap_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<RegistrationVerificationBody>,
) -> Response {
    registration_verify(state, headers, body, "bootstrap").await
}

async fn invitation_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<RegistrationVerificationBody>,
) -> Response {
    registration_verify(state, headers, body, "user").await
}

async fn recovery_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<RegistrationVerificationBody>,
) -> Response {
    registration_verify(state, headers, body, "recovery").await
}

async fn authentication_options(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let reachable = match ceremony_site(&state, &headers) {
        Ok(reachable) => reachable,
        Err(response) => return *response,
    };
    let origin = reachable.origin().ascii_serialization();
    let result = state.with_database(|database| {
        ceremony::begin_authentication(
            database,
            WebAuthnSite {
                origin: &origin,
                rp_id: reachable.host_str().unwrap_or_default(),
            },
            Utc::now(),
        )
    });
    match result {
        Ok(options) => Json(options).into_response(),
        Err(error) => ApiError::response(error),
    }
}

async fn authentication_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(parsed): Valid<AuthenticationVerificationBody>,
) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let reachable = match ceremony_site(&state, &headers) {
        Ok(reachable) => reachable,
        Err(response) => return *response,
    };
    let response = prepared_response(parsed.response);
    let result = state.with_database(|database| {
        ceremony::complete_authentication_prepared(
            database,
            &parsed.challenge_id,
            response,
            WebAuthnSite {
                origin: reachable.origin().ascii_serialization().as_str(),
                rp_id: reachable.host_str().unwrap_or_default(),
            },
            Utc::now(),
        )
    });
    auth_result(&state, result, reachable.scheme() == "https")
}

async fn self_registration_options(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match crate::http::access::authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let reachable = match ceremony_site(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let origin = reachable.origin().ascii_serialization();
    let result = state.with_database(|database| {
        ceremony::begin_self_registration(
            database,
            &user_id,
            WebAuthnSite {
                origin: &origin,
                rp_id: reachable.host_str().unwrap_or_default(),
            },
            Utc::now(),
        )
    });
    with_cookies(
        result
            .map(Json)
            .map(IntoResponse::into_response)
            .unwrap_or_else(ApiError::response),
        cookies,
    )
}

async fn self_registration_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<SelfRegistrationVerificationBody>,
) -> Response {
    let (user_id, cookies) = match crate::http::access::authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let reachable = match ceremony_site(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let origin = reachable.origin().ascii_serialization();
    let result = state.with_database(|database| {
        ceremony::complete_self_registration(
            database,
            &user_id,
            &body.challenge_id,
            prepared_response(body.response),
            &body.label,
            WebAuthnSite {
                origin: &origin,
                rp_id: reachable.host_str().unwrap_or_default(),
            },
            Utc::now(),
        )
    });
    let response = result
        .map(|_| StatusCode::NO_CONTENT.into_response())
        .unwrap_or_else(ApiError::response);
    with_cookies(response, cookies)
}

async fn rename_passkey(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CredentialIdParams { credential_id }): ValidPath<CredentialIdParams>,
    Valid(body): Valid<CredentialLabelBody>,
) -> Response {
    let (user_id, cookies) = match crate::http::access::authorize_method(&state, &headers, "PATCH")
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = state
        .with_database(|database| {
            crate::identity::admin::rename_own_credential(
                database,
                &user_id,
                &credential_id,
                &body.label,
            )
        })
        .map(|_| StatusCode::NO_CONTENT.into_response())
        .unwrap_or_else(ApiError::response);
    with_cookies(response, cookies)
}

async fn remove_passkey(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CredentialIdParams { credential_id }): ValidPath<CredentialIdParams>,
) -> Response {
    let (user_id, cookies) = match crate::http::access::authorize_method(&state, &headers, "DELETE")
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = state
        .with_database(|database| {
            crate::identity::admin::revoke_own_credential(
                database,
                &user_id,
                &credential_id,
                Utc::now(),
            )
        })
        .map(|_| StatusCode::NO_CONTENT.into_response())
        .unwrap_or_else(ApiError::response);
    with_cookies(response, cookies)
}

pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub(crate) use crate::http::access::append_cookies;

pub(crate) use crate::http::validation::parsed_body;

fn prepared_response(response: serde_json::Value) -> PreparedCredential {
    let shape_valid = response
        .get("id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| !id.is_empty() && id.encode_utf16().count() <= 512)
        && response.get("type").and_then(serde_json::Value::as_str) == Some("public-key");
    PreparedCredential {
        shape_valid,
        payload: Some(response),
    }
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let result = state.with_database(|database| {
        let required = auth::bootstrap_required(database)?;
        let session =
            session::session_user(database, &headers, Some(&state.session_config), Utc::now())?;
        Ok::<_, Box<dyn Error>>((required, session))
    });
    match result {
        Ok((required, session)) => {
            let mut response = Json(AuthStatus {
                required,
                authenticated: session.user.is_some(),
            })
            .into_response();
            append_cookies(&mut response, session.set_cookies);
            response
        }
        Err(error) => ApiError::response(error),
    }
}

async fn me(crate::http::access::SessionUser(user): crate::http::access::SessionUser) -> Response {
    Json(AuthEnvelope { user }).into_response()
}

async fn update_me(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(parsed): Valid<ProfileBody>,
) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "PATCH", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let result = state.with_database(|database| {
        let session =
            session::session_user(database, &headers, Some(&state.session_config), Utc::now())?;
        let Some(user) = session.user else {
            return Ok::<_, Box<dyn Error>>((None, session.set_cookies));
        };
        let update = ProfileUpdate {
            display_name: parsed.display_name,
            username: parsed.username,
            avatar_seed: parsed.avatar_seed,
        };
        let updated = auth::update_profile(database, &user.id, update, Utc::now());
        Ok((Some(updated), session.set_cookies))
    });
    match result {
        Ok((user, cookies)) => {
            let Some(user) = user else {
                return error(StatusCode::UNAUTHORIZED, "Authentication required");
            };
            let user = match user {
                Ok(user) => user,
                Err(failure) => {
                    let mut response = ApiError::response(failure);
                    append_cookies(&mut response, cookies);
                    return response;
                }
            };
            let mut response = Json(AuthEnvelope { user }).into_response();
            append_cookies(&mut response, cookies);
            response
        }
        Err(error) => ApiError::response(error),
    }
}

async fn sign_out(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let result = state.with_database(|database| {
        let session = session::session_user(database, &headers, None, Utc::now())?;
        if session.user.is_none() {
            return Ok::<_, Box<dyn Error>>(false);
        }
        let token = session::cookie(&headers, session::SESSION_COOKIE_NAME)
            .or_else(|| session::cookie(&headers, session::LEGACY_SESSION_COOKIE_NAME))
            .unwrap_or_default();
        auth::sign_out(database, &token, Utc::now())?;
        Ok(true)
    });
    match result {
        Ok(false) => error(StatusCode::UNAUTHORIZED, "Authentication required"),
        Ok(true) => {
            let mut response = Json(json!({ "signedOut": true })).into_response();
            append_cookies(&mut response, session::clear_session_cookies());
            response
        }
        Err(error) => ApiError::response(error),
    }
}

#[cfg(test)]
include!("../../../tests/routes/auth.rs");
