use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::json;

use crate::{
    http::contracts::{self, typed},
    identity::{
        auth::{self, AuthFailure, AuthUser, ProfileUpdate},
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/bootstrap/options", post(bootstrap_options))
        .route("/api/auth/invitation/options", post(invitation_options))
        .route("/api/auth/recovery/options", post(recovery_options))
        .route("/api/auth/bootstrap/verify", post(bootstrap_verify))
        .route("/api/auth/invitation/verify", post(invitation_verify))
        .route("/api/auth/recovery/verify", post(recovery_verify))
        .route("/api/auth/options", post(authentication_options))
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
        Err(error) => service_error(error),
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
        Err(error) => return service_error(error),
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
        Err(error) => return service_error(error),
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
                Err(error) => service_error(error),
            }
        }
        Err(error) => service_error(error),
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

async fn authentication_options(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
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
        Err(error) => service_error(error),
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

pub(crate) fn service_error(source: Box<dyn Error>) -> Response {
    match source.downcast::<AuthFailure>() {
        Ok(failure) => {
            let status = StatusCode::from_u16(failure.status_code)
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            if failure.code == "auth_failure" {
                error(status, failure.message)
            } else {
                (
                    status,
                    Json(json!({ "error": failure.message, "code": failure.code })),
                )
                    .into_response()
            }
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

pub(crate) fn append_cookies(response: &mut Response, cookies: Vec<String>) {
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
}

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
        Err(error) => service_error(error),
    }
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let result = state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    });
    match result {
        Ok(session) => {
            let Some(user) = session.user else {
                return error(StatusCode::UNAUTHORIZED, "Authentication required");
            };
            let mut response = Json(AuthEnvelope { user }).into_response();
            append_cookies(&mut response, session.set_cookies);
            response
        }
        Err(error) => service_error(error),
    }
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
                    let mut response = service_error(failure);
                    append_cookies(&mut response, cookies);
                    return response;
                }
            };
            let mut response = Json(AuthEnvelope { user }).into_response();
            append_cookies(&mut response, cookies);
            response
        }
        Err(error) => service_error(error),
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
        Err(error) => service_error(error),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::body::to_bytes;

    pub(crate) fn state() -> (AppState, std::path::PathBuf) {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let filename = std::env::temp_dir().join(format!(
            "suplex_auth_route_{}_{}_{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let config = session::SessionConfig {
            port: 4111,
            reachable_address: "https://suplex.example.test:4111".to_owned(),
            tailscale_exposure: "serve".to_owned(),
        };
        (AppState::new(database, config), filename)
    }

    #[tokio::test]
    async fn status_cookie_and_sign_out_follow_existing_order() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        let response = status(State(state.clone()), headers.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookies = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(cookies.len(), 2);
        assert!(cookies[0].starts_with("sid_v1=session_v1_"));
        assert!(cookies[1].starts_with("csrf_v1="));
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({ "required": true, "authenticated": true })
        );

        let without_cookie = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(without_cookie.status(), StatusCode::UNAUTHORIZED);
        let session_cookie = cookies[0].split(';').next().unwrap();
        headers.insert("cookie", HeaderValue::from_str(session_cookie).unwrap());
        let current = me(State(state.clone()), headers.clone()).await;
        let current_body = to_bytes(current.into_body(), 4096).await.unwrap();
        assert_eq!(
            current_body,
            r#"{"user":{"id":"user_development","displayName":"Operator","username":"operator@suplex.local","avatarSeed":"operator@suplex.local","role":"admin","status":"active","companyIds":[]}}"#
        );
        let wrong_origin = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        let signed_out = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(signed_out.status(), StatusCode::OK);
        assert_eq!(
            signed_out
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            3
        );
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        let after = me(State(state.clone()), headers).await;
        assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn ceremony_body_validation_precedes_csrf_and_consumes_no_challenge() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("sid_v1=session_v1_fake"),
        );
        let malformed = invitation_options(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"token":42}"#),
        )
        .await;
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
        let malformed_body = to_bytes(malformed.into_body(), 4096).await.unwrap();
        assert_eq!(
            malformed_body,
            r#"{"error":"Invalid request","findings":[{"code":"invalid-invalid_type","field":".token","message":"Request value is invalid"}]}"#
        );
        let csrf = invitation_options(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"token":"invalid"}"#),
        )
        .await;
        assert_eq!(csrf.status(), StatusCode::FORBIDDEN);
        let no_credentials = authentication_options(State(state.clone()), HeaderMap::new()).await;
        assert_eq!(no_credentials.status(), StatusCode::BAD_REQUEST);
        let no_credentials_body = to_bytes(no_credentials.into_body(), 1024).await.unwrap();
        assert_eq!(no_credentials_body, r#"{"error":"No passkey is enrolled"}"#);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn signed_fresh_passkey_over_isolated_tcp_listener() {
        use chrono::Duration;
        use rusqlite::params;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        use crate::identity::webauthn::test_support::synthetic;

        async fn post(address: std::net::SocketAddr, path: &str, body: String) -> String {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            let request = format!(
                "POST {path} HTTP/1.1\r\nHost: suplex.example.test:4111\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            String::from_utf8(response).unwrap()
        }
        fn body(response: &str) -> serde_json::Value {
            serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
        }

        let (state, filename) = state();
        let token = format!("invite_v1_user_{}", "A".repeat(43));
        let now = Utc::now();
        state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_existing', 'Fixture member', 'user_v1_user_existing', 'user_v1_user_existing', 'member', 'pending', ?1, ?1, 1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at, metadata_json) VALUES ('invitation_tcp', ?1, 'user', 'Fixture member', 'user_existing', ?2, ?3, '{}')", params![auth::hash_secret(&token), (now + Duration::days(1)).to_rfc3339(), now.to_rfc3339()]).unwrap();
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, crate::http::router(server_state))
                .await
                .unwrap();
        });
        let offered = post(
            address,
            "/api/auth/invitation/options",
            json!({"token":token}).to_string(),
        )
        .await;
        assert!(offered.starts_with("HTTP/1.1 200 OK\r\n"), "{offered}");
        let offered = body(&offered);
        let signed = synthetic(&json!({
            "mode":"register", "options":offered["options"],
            "origin":"https://suplex.example.test:4111"
        }));
        let enrolled = post(
            address,
            "/api/auth/invitation/verify",
            json!({
                "token":token, "challengeId":offered["challengeId"], "response":signed["response"]
            })
            .to_string(),
        )
        .await;
        assert!(enrolled.starts_with("HTTP/1.1 200 OK\r\n"), "{enrolled}");
        assert!(
            enrolled.contains("set-cookie: sid_v1=session_v1_"),
            "{enrolled}"
        );
        assert!(enrolled.contains("set-cookie: csrf_v1="), "{enrolled}");
        assert!(enrolled.ends_with(r#"{"user":{"id":"user_existing","displayName":"Fixture member","username":"user_v1_user_existing","avatarSeed":"user_v1_user_existing","role":"member","status":"active","companyIds":[]}}"#), "{enrolled}");
        let authentication = post(address, "/api/auth/options", "{}".into()).await;
        assert!(
            authentication.starts_with("HTTP/1.1 200 OK\r\n"),
            "{authentication}"
        );
        let authentication = body(&authentication);
        let assertion = synthetic(&json!({
            "mode":"authenticate", "options":authentication["options"],
            "origin":"https://suplex.example.test:4111",
            "credentialId":signed["credentialId"],
            "token":signed["token"]
        }));
        let signed_in = post(
            address,
            "/api/auth/verify",
            json!({
                "challengeId":authentication["challengeId"], "response":assertion["response"]
            })
            .to_string(),
        )
        .await;
        assert!(signed_in.starts_with("HTTP/1.1 200 OK\r\n"), "{signed_in}");
        assert!(signed_in.ends_with(r#"{"user":{"id":"user_existing","displayName":"Fixture member","username":"user_v1_user_existing","avatarSeed":"user_v1_user_existing","role":"member","status":"active","companyIds":[]}}"#), "{signed_in}");
        let counter: u32 = state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT counter FROM suplex_credentials WHERE credential_id = ?1",
                    [signed["credentialId"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!(counter, 1);
        let detached_token = format!("invite_v1_user_{}", "B".repeat(43));
        state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_detached', 'Detached member', 'user_v1_user_detached', 'user_v1_user_detached', 'member', 'pending', ?1, ?1, 1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at, metadata_json) VALUES ('invitation_detached', ?1, 'user', 'Detached member', 'user_detached', ?2, ?3, '{}')", params![auth::hash_secret(&detached_token), (now + Duration::days(1)).to_rfc3339(), now.to_rfc3339()]).unwrap();
        });
        let detached_options = state.with_database(|database| {
            ceremony::begin_registration(
                database,
                "user",
                &detached_token,
                WebAuthnSite {
                    origin: "https://suplex.example.test:4111",
                    rp_id: "suplex.example.test",
                },
                now,
            )
            .unwrap()
        });
        let detached_signed = synthetic(&json!({
            "mode":"register", "options":detached_options.options,
            "origin":"https://suplex.example.test:4111"
        }));
        let detached_state = state.clone();
        let detached = tokio::task::spawn_blocking(move || {
            run_registration_ceremony(RegistrationAttempt {
                state: detached_state,
                kind: "user",
                token: detached_token,
                challenge_id: detached_options.challenge_id,
                response: PreparedCredential {
                    shape_valid: true,
                    payload: Some(detached_signed["response"].clone()),
                },
                origin: "https://suplex.example.test:4111".into(),
                rp_id: "suplex.example.test".into(),
            })
        });
        drop(detached);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let active: bool = state.with_database(|database| {
                    database
                        .connection()
                        .query_row(
                            "SELECT status = 'active' FROM suplex_users WHERE id = 'user_detached'",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap()
                });
                if active {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn profile_body_validation_precedes_csrf_and_session() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        let signin = status(State(state.clone()), headers.clone()).await;
        let cookie = signin
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        headers.insert("cookie", HeaderValue::from_str(&cookie).unwrap());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let invalid = update_me(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let invalid_body = to_bytes(invalid.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&invalid_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-custom", "field": ".", "message": "Request value is invalid" }] })
        );
        let wrong_type = update_me(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"username":42}"#),
        )
        .await;
        assert_eq!(wrong_type.status(), StatusCode::BAD_REQUEST);
        let wrong_type_body = to_bytes(wrong_type.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&wrong_type_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".username", "message": "Request value is invalid" }] })
        );
        let missing = update_me(State(state.clone()), headers.clone(), Bytes::new()).await;
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        let missing_body = to_bytes(missing.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&missing_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".", "message": "Request value is invalid" }] })
        );
        let mut text_headers = headers.clone();
        text_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        let text = update_me(
            State(state.clone()),
            text_headers,
            Bytes::from_static(b"hello"),
        )
        .await;
        assert_eq!(text.status(), StatusCode::BAD_REQUEST);
        let text_body = to_bytes(text.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&text_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".", "message": "Request value is invalid" }] })
        );
        let valid = Bytes::from_static(
            br#"{"displayName":"\uFEFFUpdated Operator\uFEFF","username":"\uFEFFupdated-operator\uFEFF","avatarSeed":"\uFEFFupdated-avatar\uFEFF"}"#,
        );
        let wrong_origin = update_me(State(state.clone()), headers.clone(), valid.clone()).await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        headers.insert("origin", HeaderValue::from_static("http://localhost:4111"));
        let updated = update_me(State(state.clone()), headers.clone(), valid).await;
        assert_eq!(updated.status(), StatusCode::OK);
        let body = to_bytes(updated.into_body(), 4096).await.unwrap();
        assert_eq!(
            body,
            r#"{"user":{"id":"user_development","displayName":"Updated Operator","username":"updated-operator","avatarSeed":"updated-avatar","role":"admin","status":"active","companyIds":[]}}"#
        );
        headers.remove("cookie");
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        let anonymous = update_me(
            State(state.clone()),
            headers,
            Bytes::from_static(br#"{"displayName":"Other"}"#),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
