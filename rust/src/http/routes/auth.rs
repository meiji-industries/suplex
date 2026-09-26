use crate::http::error::ApiError;
use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::json;

use crate::{
    http::contracts::{self, typed},
    identity::{
        auth::{self, AuthUser, ProfileUpdate},
        ceremony::{self, PreparedCredential, WebAuthnSite},
    },
};

use super::super::{AppState, session, validation};

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
}

fn site(config: &session::SessionConfig) -> Result<url::Url, Box<Response>> {
    url::Url::parse(&config.reachable_address).map_err(|_| {
        Box::new(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))
    })
}

async fn registration_options(
    state: AppState,
    headers: HeaderMap,
    body: Bytes,
    kind: &'static str,
) -> Response {
    let parsed = match validated_typed_body(&headers, &body, typed::auth::parse_token) {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let reachable = match site(&state.session_config) {
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
    body: Bytes,
    kind: &'static str,
) -> Response {
    let parsed = match validated_typed_body(
        &headers,
        &body,
        typed::auth::parse_registration_verification,
    ) {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let reachable = match site(&state.session_config) {
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
    auth_result(&state, result)
}

fn auth_result(state: &AppState, result: Result<auth::AuthResult, Box<dyn Error>>) -> Response {
    match result {
        Ok(result) => {
            let cookies =
                session::set_session_cookies(&state.session_config, &result.session_token, None);
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
    body: Bytes,
) -> Response {
    registration_options(state, headers, body, "bootstrap").await
}

async fn invitation_options(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    registration_options(state, headers, body, "user").await
}

async fn recovery_options(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    registration_options(state, headers, body, "recovery").await
}

async fn bootstrap_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    registration_verify(state, headers, body, "bootstrap").await
}

async fn invitation_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    registration_verify(state, headers, body, "user").await
}

async fn recovery_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    registration_verify(state, headers, body, "recovery").await
}

async fn authentication_options(State(state): State<AppState>) -> Response {
    let reachable = match site(&state.session_config) {
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
    body: Bytes,
) -> Response {
    let parsed = match validated_typed_body(
        &headers,
        &body,
        typed::auth::parse_authentication_verification,
    ) {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let reachable = match site(&state.session_config) {
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
    auth_result(&state, result)
}

pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub(crate) fn not_ported() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "Experimental Rust backend has not ported this route",
            "code": "experimental_not_ported",
        })),
    )
        .into_response()
}

pub(crate) use crate::http::access::append_cookies;

pub(crate) fn validation_error(issues: Vec<serde_json::Value>) -> Response {
    validation::validation_error(issues)
}

pub(crate) fn parsed_body(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Option<serde_json::Value>, Box<Response>> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default();
    let parsed = if body.is_empty() {
        None
    } else if content_type == "text/plain" {
        Some(serde_json::Value::String(
            String::from_utf8_lossy(body).into_owned(),
        ))
    } else if content_type == "application/json" {
        match serde_json::from_slice::<serde_json::Value>(body) {
            Ok(value) => Some(value),
            Err(_) => return Err(Box::new(error(StatusCode::BAD_REQUEST, "Invalid request"))),
        }
    } else {
        return Err(Box::new(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported media type",
        )));
    };
    Ok(parsed)
}

pub(crate) fn validated_typed_body<T>(
    headers: &HeaderMap,
    body: &Bytes,
    parse: fn(Option<&serde_json::Value>) -> contracts::typed::ContractResult<T>,
) -> Result<T, Box<Response>> {
    let parsed = parsed_body(headers, body)?;
    match parse(parsed.as_ref()) {
        Ok(value) => Ok(value),
        Err(contracts::typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(validation::validation_error_public(findings)))
        }
        Err(
            contracts::typed::ContractFailure::Unhandled
            | contracts::typed::ContractFailure::Internal(_),
        ) => Err(Box::new(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

pub(crate) fn validated_body(
    headers: &HeaderMap,
    body: &Bytes,
    contract: &str,
) -> Result<serde_json::Value, Box<Response>> {
    let parsed = parsed_body(headers, body)?;
    match contracts::validate(contract, parsed.as_ref()) {
        Some(Ok(value)) => Ok(value),
        Some(Err(issues)) => Err(Box::new(validation_error(issues))),
        None => Err(Box::new(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

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

async fn update_me(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let parsed = match validated_typed_body(&headers, &body, typed::auth::parse_profile) {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };
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
