//! OAuth 2.1 protocol endpoints and the consent API behind the browser approval page.
//!
//! The `/oauth/*` protocol endpoints carry no board session authority, so they
//! skip the board origin check (TypeScript `oauthProtocol`).

use crate::http::access::with_cookies;
use std::{
    collections::HashMap,
    net::SocketAddr,
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Bytes,
    extract::{ConnectInfo, RawQuery, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{
            self, Contract,
            oauth::{ClientRegistration, ConsentApproval, ConsentParams},
        },
        session,
        validation::{Valid, ValidPath},
    },
    identity::oauth::{self, OAuth, OAuthFailure},
    projects::service as projects,
    shared::js_json,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth/register", post(register))
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/token", post(token))
        .route("/oauth/revoke", post(revoke))
        .route("/api/oauth/consent/{request_id}", get(consent))
        .route("/api/oauth/consent/{request_id}/approve", post(approve))
        .route("/api/oauth/consent/{request_id}/deny", post(deny))
}

/// `WWW-Authenticate` for the MCP resource.
pub(crate) fn challenge(oauth: &OAuth) -> String {
    format!(
        "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\", scope=\"suplex:mcp\"",
        oauth.issuer
    )
}

fn json_body(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js_json::stringify(body),
    )
        .into_response()
}

fn redirect(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}

/// `oauthError`: a redirectable failure returns to the client; others answer JSON.
fn oauth_error(error: &(dyn std::error::Error + 'static), oauth: &OAuth) -> Response {
    let failure = OAuthFailure::from_error(error);
    if let Some(target) = &failure.redirect_uri {
        let mut values = vec![
            ("error", failure.error),
            ("error_description", failure.public_message.as_str()),
            ("iss", oauth.issuer.as_str()),
        ];
        if let Some(state) = &failure.state {
            values.push(("state", state));
        }
        return redirect(&oauth::with_params(target, &values));
    }
    let mut response = json_body(
        StatusCode::from_u16(failure.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &json!({"error": failure.error, "error_description": failure.public_message}),
    );
    let headers = response.headers_mut();
    if failure.status_code == 401
        && let Ok(value) = HeaderValue::from_str(&challenge(oauth))
    {
        headers.insert(header::WWW_AUTHENTICATE, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn failure(
    error: &'static str,
    message: &str,
    status: u16,
) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(OAuthFailure::new(error, message, status))
}

fn content_type(headers: &HeaderMap) -> String {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// `parseForm`: an urlencoded body with every field exactly once.
fn form(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<HashMap<String, String>, Box<dyn std::error::Error + Send + Sync>> {
    if content_type(headers) != "application/x-www-form-urlencoded" || body.len() > 16 * 1024 {
        return Err(failure("invalid_request", "Form body is invalid", 400));
    }
    let mut values = HashMap::new();
    for (name, value) in url::form_urlencoded::parse(body) {
        if values
            .insert(name.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(failure(
                "invalid_request",
                "Form body contains duplicate fields",
                400,
            ));
        }
    }
    Ok(values)
}

fn source_address(request: &Request) -> String {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or_else(|| "unknown".to_owned(), |info| info.0.ip().to_string())
}

/// Twenty registrations per source address per hour, across at most a thousand sources.
fn throttle(
    state: &AppState,
    source: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let limited = || {
        failure(
            "temporarily_unavailable",
            "Client registration limit reached",
            429,
        )
    };
    let mut registrations = state.oauth_registrations.lock().map_err(|_| limited())?;
    let now = Instant::now();
    let cutoff = now.checked_sub(Duration::from_secs(60 * 60));
    let recent = |times: &Vec<Instant>| {
        times
            .iter()
            .copied()
            .filter(|time| cutoff.is_none_or(|cutoff| *time >= cutoff))
            .collect::<Vec<_>>()
    };
    registrations.retain(|_, times| {
        *times = recent(times);
        !times.is_empty()
    });
    let current = registrations.get(source).cloned().unwrap_or_default();
    if current.len() >= 20 || (!registrations.contains_key(source) && registrations.len() >= 1_000)
    {
        return Err(limited());
    }
    registrations
        .entry(source.to_owned())
        .or_default()
        .push(now);
    Ok(())
}

async fn register(State(state): State<AppState>, request: Request) -> Response {
    let oauth = state.oauth();
    let source = source_address(&request);
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .unwrap_or_default();
    let result = (|| {
        throttle(&state, &source)?;
        let value = if content_type(&parts.headers) == "application/json" {
            serde_json::from_slice::<Value>(&body).ok()
        } else {
            None
        };
        let metadata = ClientRegistration::parse(value.as_ref())
            .map_err(|_| failure("invalid_client_metadata", "Client metadata is invalid", 400))?;
        let registered = state.with_database(|database| {
            oauth.register_client(
                database,
                oauth::ClientMetadata {
                    client_name: metadata.client_name,
                    redirect_uris: metadata.redirect_uris,
                    grant_types: metadata.grant_types,
                    response_types: metadata.response_types,
                    token_endpoint_auth_method: metadata.token_endpoint_auth_method,
                },
                Utc::now(),
            )
        })?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(serde_json::to_value(registered)?)
    })();
    match result {
        Ok(client) => {
            let mut response = json_body(StatusCode::CREATED, &client);
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => oauth_error(error.as_ref(), &oauth),
    }
}

fn session_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Option<String>, Vec<String>), Box<dyn std::error::Error + Send + Sync>> {
    let session = state.with_database(|database| {
        session::session_user(database, headers, Some(&state.session_config), Utc::now())
    })?;
    Ok((session.user.map(|user| user.id), session.set_cookies))
}

async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let oauth = state.oauth();
    let query = typed::agent_api::query_object(query.as_deref());
    let text = |name: &str| query.get(name).and_then(Value::as_str);
    let required = [
        "client_id",
        "redirect_uri",
        "response_type",
        "resource",
        "code_challenge",
        "code_challenge_method",
    ];
    let valid = required.iter().all(|name| text(name).is_some())
        && ["state", "scope"]
            .iter()
            .all(|name| query.get(*name).is_none_or(Value::is_string));
    if !valid {
        return oauth_error(
            failure("invalid_request", "Authorization request is invalid", 400).as_ref(),
            &oauth,
        );
    }
    let started = state.with_database(|database| {
        oauth.begin_authorization(
            database,
            oauth::AuthorizationRequest {
                client_id: text("client_id").unwrap_or_default(),
                redirect_uri: text("redirect_uri").unwrap_or_default(),
                response_type: text("response_type").unwrap_or_default(),
                state: text("state"),
                scope: text("scope"),
                resource: text("resource").unwrap_or_default(),
                code_challenge: text("code_challenge").unwrap_or_default(),
                code_challenge_method: text("code_challenge_method").unwrap_or_default(),
            },
            Utc::now(),
        )
    });
    let request_id = match started {
        Ok(request_id) => request_id,
        Err(error) => return oauth_error(error.as_ref(), &oauth),
    };
    let consent = format!(
        "/oauth/consent?request={}",
        url::form_urlencoded::byte_serialize(request_id.as_bytes()).collect::<String>()
    );
    match session_user(&state, &headers) {
        Ok((Some(_), cookies)) => with_cookies(redirect(&consent), cookies),
        Ok((None, cookies)) => {
            let encoded = js_encode_uri_component(&consent);
            with_cookies(redirect(&format!("/auth?returnTo={encoded}")), cookies)
        }
        Err(error) => oauth_error(error.as_ref(), &oauth),
    }
}

/// `encodeURIComponent`.
fn js_encode_uri_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

async fn consent(
    State(state): State<AppState>,
    ValidPath(ConsentParams { request_id: id }): ValidPath<ConsentParams>,
    headers: HeaderMap,
) -> Response {
    let oauth = state.oauth();
    let (user, cookies) = match session_user(&state, &headers) {
        Ok(value) => value,
        Err(error) => return oauth_error(error.as_ref(), &oauth),
    };
    let Some(user) = user else {
        return with_cookies(
            json_body(
                StatusCode::UNAUTHORIZED,
                &json!({"error": "Authentication is necessary"}),
            ),
            cookies,
        );
    };
    let result = state.with_database(|database| {
        let consent = oauth.read_consent(database, &user, &id, Utc::now())?;
        let visible = projects::list(database, &user, None)?
            .into_iter()
            .map(|project| json!({"id": project.id, "name": project.name, "companyId": project.company_id}))
            .collect::<Vec<_>>();
        let mut body = serde_json::to_value(consent)?.as_object().cloned().unwrap_or_else(Map::new);
        body.insert("projects".into(), json!(visible));
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Value::Object(body))
    });
    let response = match result {
        Ok(body) => {
            let mut response = json_body(StatusCode::OK, &body);
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response.headers_mut().insert(
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            );
            response
        }
        Err(error) => oauth_error(error.as_ref(), &oauth),
    };
    with_cookies(response, cookies)
}

/// `requireCsrf`: the double-submit token, independent of the request origin.
fn require_csrf(headers: &HeaderMap) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut values = headers.get_all(session::CSRF_HEADER_NAME).iter();
    let header = values.next().and_then(|value| value.to_str().ok());
    let cookie = session::cookie(headers, session::CSRF_COOKIE_NAME);
    match header {
        Some(header) if header.len() >= 32 && Some(header) == cookie.as_deref() => Ok(()),
        _ => Err(failure("access_denied", "Request origin is invalid", 403)),
    }
}

enum Decision {
    Approve(ConsentApproval),
    Deny,
}

async fn decide(state: AppState, id: String, headers: HeaderMap, decision: Decision) -> Response {
    let oauth = state.oauth();
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let mut cookies = Vec::new();
    let result = (|| {
        require_csrf(&headers)?;
        let (user, set_cookies) = session_user(&state, &headers)?;
        cookies = set_cookies;
        let user =
            user.ok_or_else(|| failure("access_denied", "Authentication is necessary", 401))?;
        state.with_database(|database| match &decision {
            Decision::Approve(approval) => oauth.approve(
                database,
                &user,
                &id,
                &approval.company_id,
                &approval.project_ids,
                Utc::now(),
            ),
            Decision::Deny => oauth.deny(database, &user, &id, Utc::now()),
        })
    })();
    let response = match result {
        Ok(target) => {
            let mut response = json_body(StatusCode::OK, &json!({"redirectTo": target}));
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => oauth_error(error.as_ref(), &oauth),
    };
    with_cookies(response, cookies)
}

async fn approve(
    State(state): State<AppState>,
    ValidPath(ConsentParams { request_id: id }): ValidPath<ConsentParams>,
    headers: HeaderMap,
    Valid(approval): Valid<ConsentApproval>,
) -> Response {
    decide(state, id, headers, Decision::Approve(approval)).await
}

async fn deny(
    State(state): State<AppState>,
    ValidPath(ConsentParams { request_id: id }): ValidPath<ConsentParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = auth::parsed_body(&headers, &body) {
        return *response;
    }
    decide(state, id, headers, Decision::Deny).await
}

async fn token(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let oauth = state.oauth();
    let result = (|| {
        let fields = form(&headers, &body)?;
        let get = |name: &str| fields.get(name).map(String::as_str);
        let invalid = || failure("invalid_request", "Form body is invalid", 400);
        let tokens = match get("grant_type") {
            Some("authorization_code") => {
                let [
                    Some(code),
                    Some(client_id),
                    Some(redirect_uri),
                    Some(resource),
                    Some(verifier),
                ] = [
                    "code",
                    "client_id",
                    "redirect_uri",
                    "resource",
                    "code_verifier",
                ]
                .map(get)
                else {
                    return Err(invalid());
                };
                state.with_database(|database| {
                    oauth.exchange_code(
                        database,
                        oauth::CodeExchange {
                            code,
                            client_id,
                            redirect_uri,
                            resource,
                            verifier,
                        },
                        Utc::now(),
                    )
                })?
            }
            Some("refresh_token") => {
                let [Some(refresh_token), Some(client_id), Some(resource)] =
                    ["refresh_token", "client_id", "resource"].map(get)
                else {
                    return Err(invalid());
                };
                state.with_database(|database| {
                    oauth.refresh(
                        database,
                        oauth::Refresh {
                            refresh_token,
                            client_id,
                            resource,
                            scope: get("scope"),
                        },
                        Utc::now(),
                    )
                })?
            }
            _ => return Err(invalid()),
        };
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(serde_json::to_value(tokens)?)
    })();
    match result {
        Ok(tokens) => {
            let mut response = json_body(StatusCode::OK, &tokens);
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
                .headers_mut()
                .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
            response
        }
        Err(error) => oauth_error(error.as_ref(), &oauth),
    }
}

async fn revoke(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let oauth = state.oauth();
    let result = form(&headers, &body).and_then(|fields| {
        let token = fields
            .get("token")
            .ok_or_else(|| failure("invalid_request", "Form body is invalid", 400))?;
        state.with_database(|database| {
            oauth.revoke(
                database,
                token,
                fields.get("client_id").map(String::as_str),
                Utc::now(),
            )
        })
    });
    match result {
        Ok(()) => (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")]).into_response(),
        Err(error) => oauth_error(error.as_ref(), &oauth),
    }
}

#[cfg(test)]
include!("../../../tests/routes/oauth.rs");
