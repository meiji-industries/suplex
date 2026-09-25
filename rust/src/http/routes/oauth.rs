//! OAuth 2.1 protocol endpoints and the consent API behind the browser approval page.
//!
//! The `/oauth/*` protocol endpoints carry no board session authority, so they
//! skip the board origin check (TypeScript `oauthProtocol`).

use std::{
    collections::HashMap,
    net::SocketAddr,
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Bytes,
    extract::{ConnectInfo, Path, RawQuery, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    http::{
        AppState, agent_api_runtime,
        contracts::typed::{self, ContractResult, oauth as contracts},
        session,
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

fn failure(error: &'static str, message: &str, status: u16) -> Box<dyn std::error::Error> {
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
) -> Result<HashMap<String, String>, Box<dyn std::error::Error>> {
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
fn throttle(state: &AppState, source: &str) -> Result<(), Box<dyn std::error::Error>> {
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
    let oauth = OAuth::new(&state.session_config.reachable_address);
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
        let metadata = contracts::parse_client_registration(value.as_ref())
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
        Ok::<_, Box<dyn std::error::Error>>(serde_json::to_value(registered)?)
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
) -> Result<(Option<String>, Vec<String>), Box<dyn std::error::Error>> {
    let session = state.with_database(|database| {
        session::session_user(database, headers, Some(&state.session_config), Utc::now())
    })?;
    Ok((session.user.map(|user| user.id), session.set_cookies))
}

fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let oauth = OAuth::new(&state.session_config.reachable_address);
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

fn request_id(id: &str) -> Result<String, Box<Response>> {
    validated(contracts::parse_consent_params(Some(
        &json!({"requestId": id}),
    )))
    .map(|params| params.request_id)
}

fn validated<T>(result: ContractResult<T>) -> Result<T, Box<Response>> {
    match result {
        Ok(value) => Ok(value),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(agent_api_runtime::validation(findings, false)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

async fn consent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let oauth = OAuth::new(&state.session_config.reachable_address);
    let id = match request_id(&id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
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
        Ok::<_, Box<dyn std::error::Error>>(Value::Object(body))
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
fn require_csrf(headers: &HeaderMap) -> Result<(), Box<dyn std::error::Error>> {
    let mut values = headers.get_all(session::CSRF_HEADER_NAME).iter();
    let header = values.next().and_then(|value| value.to_str().ok());
    let cookie = session::cookie(headers, session::CSRF_COOKIE_NAME);
    match header {
        Some(header) if header.len() >= 32 && Some(header) == cookie.as_deref() => Ok(()),
        _ => Err(failure("access_denied", "Request origin is invalid", 403)),
    }
}

enum Decision {
    Approve(contracts::ConsentApproval),
    Deny,
}

async fn decide(state: AppState, id: String, headers: HeaderMap, decision: Decision) -> Response {
    let oauth = OAuth::new(&state.session_config.reachable_address);
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
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let id = match request_id(&id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    let approval = match auth::parsed_body(&headers, &body)
        .and_then(|value| validated(contracts::parse_consent_approval(value.as_ref())))
    {
        Ok(approval) => approval,
        Err(response) => return *response,
    };
    decide(state, id, headers, Decision::Approve(approval)).await
}

async fn deny(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let id = match request_id(&id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    if let Err(response) = auth::parsed_body(&headers, &body) {
        return *response;
    }
    decide(state, id, headers, Decision::Deny).await
}

async fn token(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let oauth = OAuth::new(&state.session_config.reachable_address);
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
        Ok::<_, Box<dyn std::error::Error>>(serde_json::to_value(tokens)?)
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
    let oauth = OAuth::new(&state.session_config.reachable_address);
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
pub(crate) mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    use crate::http::routes::external_agent_administration::tests::{HOST, ORIGIN, Server, server};

    pub(crate) const REDIRECT: &str = "http://127.0.0.1:9317/callback";
    pub(crate) const RESOURCE: &str = "https://suplex.example.test:4111/mcp";
    const CSRF: &str = "csrf-token-0123456789abcdefghijklmnopqrstuvwxyz";

    fn challenge(verifier: &str) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    }

    fn query_value(url: &str, name: &str) -> Option<String> {
        let parsed = url::Url::parse(url)
            .or_else(|_| url::Url::parse(&format!("https://base{url}")))
            .unwrap();
        parsed
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }

    pub(crate) async fn register(server: &Server, name: &str) -> String {
        let (status, client) = server
            .send(reqwest::Method::POST, "/oauth/register", None, Some(json!({"client_name": name, "redirect_uris": [REDIRECT], "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": "none", "client_uri": "https://claude.ai", "scope": "suplex:mcp"})))
            .await;
        assert_eq!(status, 201, "{client}");
        client["client_id"].as_str().unwrap().to_owned()
    }

    fn authorize_path(client_id: &str, verifier: &str, state: &str) -> String {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in [
            ("client_id", client_id),
            ("redirect_uri", REDIRECT),
            ("response_type", "code"),
            ("state", state),
            ("scope", "suplex:mcp"),
            ("resource", RESOURCE),
            ("code_challenge", &challenge(verifier)),
            ("code_challenge_method", "S256"),
        ] {
            serializer.append_pair(name, value);
        }
        format!("/oauth/authorize?{}", serializer.finish())
    }

    pub(crate) fn session(server: &Server) -> String {
        format!("{}; csrf_v1={CSRF}", server.admin_cookie)
    }

    async fn start(server: &Server, client_id: &str, verifier: &str, state: &str) -> String {
        let cookie = session(server);
        let started = server
            .request(
                reqwest::Method::GET,
                &authorize_path(client_id, verifier, state),
                &[("cookie", &cookie)],
                None,
            )
            .await;
        assert_eq!(started.status(), 302);
        query_value(started.headers()["location"].to_str().unwrap(), "request").unwrap()
    }

    pub(crate) async fn authorize(
        server: &Server,
        client_id: &str,
        verifier: &str,
        state: &str,
    ) -> String {
        let request = start(server, client_id, verifier, state).await;
        let cookie = session(server);
        let consent = server
            .request(
                reqwest::Method::GET,
                &format!("/api/oauth/consent/{request}"),
                &[("cookie", &cookie)],
                None,
            )
            .await;
        assert_eq!(consent.status(), 200);
        assert_eq!(consent.headers()["referrer-policy"], "no-referrer");
        let consent = consent.json::<Value>().await.unwrap();
        assert_eq!(
            (
                consent["redirectOrigin"].as_str(),
                consent["scope"].as_str()
            ),
            (Some("http://127.0.0.1:9317"), Some("suplex:mcp"))
        );
        let approval = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/approve"),
                &[("cookie", &cookie), ("origin", ORIGIN), ("x-csrf-v1", CSRF)],
                Some(json!({"companyId": "company_api", "projectIds": ["project_api"]})),
            )
            .await;
        assert_eq!(approval.status(), 200);
        let target = approval.json::<Value>().await.unwrap()["redirectTo"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(query_value(&target, "state").as_deref(), Some(state));
        assert_eq!(
            query_value(&target, "iss").as_deref(),
            Some("https://suplex.example.test:4111")
        );
        query_value(&target, "code").unwrap()
    }

    pub(crate) async fn form(server: &Server, path: &str, fields: &[(&str, &str)]) -> (u16, Value) {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields)
            .finish();
        let response = server
            .client
            .post(format!("{}{path}", server.base))
            .header("host", HOST)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (
            status,
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    }

    pub(crate) async fn exchange(
        server: &Server,
        client_id: &str,
        code: &str,
        verifier: &str,
    ) -> (u16, Value) {
        form(
            server,
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("client_id", client_id),
                ("redirect_uri", REDIRECT),
                ("resource", RESOURCE),
                ("code_verifier", verifier),
            ],
        )
        .await
    }

    async fn mcp_status(server: &Server, token: &str) -> u16 {
        let bearer = format!("Bearer {token}");
        let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}});
        server
            .request(
                reqwest::Method::POST,
                "/mcp",
                &[
                    ("authorization", bearer.as_str()),
                    ("accept", "application/json, text/event-stream"),
                ],
                Some(initialize),
            )
            .await
            .status()
            .as_u16()
    }

    fn agent_of(server: &Server, client_id: &str) -> String {
        server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT agent_id FROM suplex_oauth_grants WHERE client_id = ?1",
                    [client_id],
                    |row| row.get(0),
                )
                .unwrap()
        })
    }

    fn revoke_agent(server: &Server, agent_id: &str) {
        let admin = server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        });
        server
            .state
            .with_database(|database| {
                crate::identity::external_agents::revoke(
                    database,
                    &admin,
                    agent_id,
                    chrono::Utc::now(),
                )
            })
            .unwrap();
    }

    #[tokio::test]
    async fn discovery_registration_consent_pkce_rotation_replay_revocation_and_reapproval() {
        let server = server(None).await;
        let (status, metadata) = server
            .send(
                reqwest::Method::GET,
                "/.well-known/oauth-protected-resource/mcp",
                None,
                None,
            )
            .await;
        assert_eq!(
            (status, metadata["resource"].as_str()),
            (200, Some(RESOURCE))
        );
        let anonymous = server
            .request(reqwest::Method::POST, "/mcp", &[], Some(json!({})))
            .await;
        assert_eq!(anonymous.status(), 401);
        assert!(
            anonymous.headers()["www-authenticate"]
                .to_str()
                .unwrap()
                .contains("oauth-protected-resource/mcp")
        );

        let client = register(&server, "Claude").await;
        let verifier = "v".repeat(43);
        let code = authorize(&server, &client, &verifier, "opaque-state").await;
        let (status, wrong) = exchange(&server, &client, &code, &"w".repeat(43)).await;
        assert_eq!(
            (status, wrong["error"].as_str()),
            (400, Some("invalid_grant"))
        );
        assert_eq!(
            exchange(&server, "oauth_client_wrong", &code, &verifier)
                .await
                .0,
            400
        );
        let (status, tokens) = exchange(&server, &client, &code, &verifier).await;
        assert_eq!(
            (
                status,
                tokens["token_type"].as_str(),
                tokens["expires_in"].as_i64()
            ),
            (200, Some("Bearer"), Some(3600)),
            "{tokens}"
        );
        assert_eq!(exchange(&server, &client, &code, &verifier).await.0, 400);
        let first_refresh = tokens["refresh_token"].as_str().unwrap().to_owned();

        let (status, expanded) = form(
            &server,
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &first_refresh),
                ("client_id", &client),
                ("resource", RESOURCE),
                ("scope", "suplex:mcp suplex:admin"),
            ],
        )
        .await;
        assert_eq!(
            (status, expanded["error"].as_str()),
            (400, Some("invalid_scope"))
        );
        let (status, rotated) = form(
            &server,
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &first_refresh),
                ("client_id", &client),
                ("resource", RESOURCE),
                ("scope", "suplex:mcp"),
                ("extension", "ignored"),
            ],
        )
        .await;
        assert_eq!(status, 200, "{rotated}");
        assert_eq!(
            form(
                &server,
                "/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &first_refresh),
                    ("client_id", &client),
                    ("resource", RESOURCE)
                ]
            )
            .await
            .0,
            400
        );
        assert_eq!(
            mcp_status(&server, rotated["access_token"].as_str().unwrap()).await,
            401
        );

        let agent = agent_of(&server, &client);
        let active = authorize(&server, &client, &verifier, "active-before-revoke").await;
        let (_, active_tokens) = exchange(&server, &client, &active, &verifier).await;
        revoke_agent(&server, &agent);
        assert_eq!(
            form(
                &server,
                "/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    (
                        "refresh_token",
                        active_tokens["refresh_token"].as_str().unwrap()
                    ),
                    ("client_id", &client),
                    ("resource", RESOURCE)
                ]
            )
            .await
            .0,
            400
        );
        let again = authorize(&server, &client, &verifier, "reapprove").await;
        assert_eq!(exchange(&server, &client, &again, &verifier).await.0, 200);
        assert_eq!(agent_of(&server, &client), agent);
        let outstanding = authorize(&server, &client, &verifier, "outstanding").await;
        revoke_agent(&server, &agent);
        let fresh = authorize(&server, &client, &verifier, "fresh").await;
        assert_eq!(
            exchange(&server, &client, &outstanding, &verifier).await.0,
            400
        );
        assert_eq!(exchange(&server, &client, &fresh, &verifier).await.0, 200);
    }

    #[tokio::test]
    async fn denial_keeps_state_and_consent_needs_csrf_admin_and_session() {
        let server = server(None).await;
        let client = register(&server, "Claude").await;
        let verifier = "v".repeat(43);
        let request = start(&server, &client, &verifier, "deny-state").await;
        let page = server
            .request(
                reqwest::Method::GET,
                &format!("/oauth/consent?request={request}"),
                &[],
                None,
            )
            .await;
        assert_eq!(page.status(), 302);
        assert_eq!(
            page.headers()["location"],
            format!("/auth?returnTo=%2Foauth%2Fconsent%3Frequest%3D{request}").as_str()
        );
        let cookie = session(&server);
        let no_csrf = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/approve"),
                &[("cookie", &cookie), ("origin", ORIGIN)],
                Some(json!({"companyId": "company_api", "projectIds": ["project_api"]})),
            )
            .await;
        assert_eq!(no_csrf.status(), 403);
        let member = format!("{}; csrf_v1={CSRF}", server.member_cookie);
        let non_admin = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/approve"),
                &[("cookie", &member), ("origin", ORIGIN), ("x-csrf-v1", CSRF)],
                Some(json!({"companyId": "company_api", "projectIds": ["project_api"]})),
            )
            .await;
        assert_eq!(non_admin.status(), 403);
        let grants: i64 = server.state.with_database(|database| {
            database
                .connection()
                .query_row("SELECT COUNT(*) FROM suplex_oauth_grants", [], |row| {
                    row.get(0)
                })
                .unwrap()
        });
        assert_eq!(grants, 0);
        let denied = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/deny"),
                &[("cookie", &cookie), ("origin", ORIGIN), ("x-csrf-v1", CSRF)],
                Some(json!({})),
            )
            .await;
        let target = denied.json::<Value>().await.unwrap()["redirectTo"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            (
                query_value(&target, "error").as_deref(),
                query_value(&target, "state").as_deref()
            ),
            (Some("access_denied"), Some("deny-state"))
        );
        let invalid = server.request(reqwest::Method::GET, "/oauth/authorize?client_id=missing&redirect_uri=x&response_type=code&resource=r&code_challenge=c&code_challenge_method=S256", &[], None).await;
        assert_eq!(invalid.status(), 400);
        assert_eq!(
            invalid.json::<Value>().await.unwrap(),
            json!({"error": "invalid_request", "error_description": "Client or redirect URI is invalid"})
        );
    }

    #[tokio::test]
    async fn bearer_checks_follow_live_host_authority_grants_and_token_state() {
        let server = server(None).await;
        let client = register(&server, "Claude").await;
        let verifier = "p".repeat(43);
        let code = authorize(&server, &client, &verifier, "state").await;
        let token = exchange(&server, &client, &code, &verifier).await.1["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let bearer = format!("Bearer {token}");
        let wrong_host = server
            .client
            .post(format!("{}/mcp", server.base))
            .header("host", "attacker.test")
            .header("authorization", &bearer)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_host.status(), 403);
        let wrong_origin = server
            .request(
                reqwest::Method::POST,
                "/mcp",
                &[
                    ("origin", "https://attacker.test"),
                    ("authorization", &bearer),
                ],
                Some(json!({})),
            )
            .await;
        assert_eq!(wrong_origin.status(), 403);
        let malformed = server
            .request(
                reqwest::Method::POST,
                "/mcp",
                &[("authorization", "Bearer wrong")],
                Some(json!({})),
            )
            .await;
        assert_eq!(malformed.status(), 401);
        assert!(
            malformed.headers()["www-authenticate"]
                .to_str()
                .unwrap()
                .contains("resource_metadata")
        );
        assert_eq!(mcp_status(&server, &token).await, 200);
        let oauth =
            crate::identity::oauth::OAuth::new(&server.state.session_config.reachable_address);
        let agent = agent_of(&server, &client);
        server.state.with_database(|database| database.connection().execute("UPDATE suplex_external_agents SET client_profile_id = 'missing-profile' WHERE id = ?1", [&agent]).unwrap());
        let principal = server
            .state
            .with_database(|database| {
                oauth.authenticate_access_token(database, &token, chrono::Utc::now())
            })
            .unwrap();
        assert_eq!(
            (
                principal.agent_id.as_str(),
                principal.profile_id.as_deref(),
                principal.project_ids.as_slice()
            ),
            (
                agent.as_str(),
                Some("missing-profile"),
                ["project_api".to_owned()].as_slice()
            )
        );
        server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_users SET role = 'member' WHERE role = 'admin'",
                    [],
                )
                .unwrap()
        });
        assert!(
            server
                .state
                .with_database(|database| oauth.authenticate_access_token(
                    database,
                    &token,
                    chrono::Utc::now()
                ))
                .is_err()
        );
        server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_users SET role = 'admin' WHERE id <> 'member_user'",
                    [],
                )
                .unwrap()
        });
        assert_eq!(mcp_status(&server, &token).await, 200);
        server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_oauth_access_tokens SET expires_at = '1970-01-01T00:00:00.000Z'",
                    [],
                )
                .unwrap()
        });
        assert_eq!(mcp_status(&server, &token).await, 401);
        let fresh = authorize(&server, &client, &verifier, "revoke-endpoint").await;
        let fresh_token = exchange(&server, &client, &fresh, &verifier).await.1["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            form(
                &server,
                "/oauth/revoke",
                &[("token", &fresh_token), ("client_id", &client)]
            )
            .await
            .0,
            200
        );
        assert_eq!(mcp_status(&server, &fresh_token).await, 401);
        assert_eq!(
            server
                .request(reqwest::Method::GET, "/mcp", &[], None)
                .await
                .status(),
            405
        );
    }

    #[tokio::test]
    async fn same_named_clients_stay_isolated_and_registration_throttles_per_source() {
        let server = server(None).await;
        let verifier = "n".repeat(43);
        let first = register(&server, "Claude").await;
        let second = register(&server, "Claude").await;
        for (client, state) in [(&first, "first"), (&second, "second")] {
            let code = authorize(&server, client, &verifier, state).await;
            assert_eq!(exchange(&server, client, &code, &verifier).await.0, 200);
        }
        let names: Vec<String> = server.state.with_database(|database| {
            let mut statement = database.connection().prepare("SELECT a.name FROM suplex_oauth_grants g JOIN suplex_agents a ON a.id = g.agent_id").unwrap();
            statement.query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        });
        assert_eq!(names.len(), 2);
        assert_ne!(names[0], names[1]);
        for _ in 2..20 {
            register(&server, "Rate test").await;
        }
        let (status, limited) = server
            .send(
                reqwest::Method::POST,
                "/oauth/register",
                None,
                Some(json!({"client_name": "Rate test", "redirect_uris": [REDIRECT]})),
            )
            .await;
        assert_eq!(
            (status, limited["error"].as_str()),
            (429, Some("temporarily_unavailable"))
        );
        server
            .state
            .oauth_registrations
            .lock()
            .unwrap()
            .insert("192.0.2.2".into(), Vec::new());
        assert!(super::throttle(&server.state, "192.0.2.2").is_ok());
    }
}
