//! `http/routes/update.ts` and the client lifecycle report from
//! `http/routes/authenticated.ts`. The Rust binary runs without the Node
//! supervisor, so it reports its own build as current and cannot restart.

use crate::http::error::ApiError;
use std::sync::LazyLock;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{RawQuery, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{ContractFailure, system},
        session, validation,
    },
    identity::auth::AuthUser,
    platform::system_events,
};

use super::auth;

/// One identity per server process, as `server.ts` creates it.
static INSTANCE_ID: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/update", get(read_update))
        .route("/api/update/restart", post(restart))
        .route("/api/system/client-lifecycle", post(client_lifecycle))
}

fn user(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> Result<(AuthUser, Vec<String>), Box<Response>> {
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(|error| Box::new(ApiError::response(error)))?;
    match session.user {
        Some(user) => Ok((user, session.set_cookies)),
        None => Err(Box::new(auth::error(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        ))),
    }
}

fn finish(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

fn issues(failure: ContractFailure) -> Response {
    match failure {
        ContractFailure::Issues(findings) => validation::validation_error_public(findings),
        _ => auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

pub fn current_revision() -> Option<&'static str> {
    let revision = env!("SUPLEX_RUST_REVISION");
    (revision.len() == 40
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(revision)
}

async fn read_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let mut input = Map::new();
    for (name, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        let value = json!(value.into_owned());
        match input.get_mut(name.as_ref()) {
            Some(Value::Array(values)) => values.push(value),
            Some(previous) => *previous = Value::Array(vec![previous.clone(), value]),
            None => {
                input.insert(name.into_owned(), value);
            }
        }
    }
    if let Err(failure) = system::parse_update_query(Some(&Value::Object(input))) {
        return issues(failure);
    }
    let (_, cookies) = match user(&state, &headers, &Method::GET) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut body = json!({ "status": { "kind": "current" } });
    if let Some(revision) = current_revision() {
        body["currentRevision"] = json!(revision);
    }
    body["canRestart"] = json!(false);
    body["instanceId"] = json!(*INSTANCE_ID);
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    finish(response, cookies)
}

async fn restart(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user, cookies) = match user(&state, &headers, &Method::POST) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = if user.role != "admin" {
        auth::error(StatusCode::FORBIDDEN, "Administrator access necessary")
    } else {
        auth::error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Suplex update control is not available.",
        )
    };
    finish(response, cookies)
}

async fn client_lifecycle(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > 1024 {
        return auth::error(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large");
    }
    let parsed = match auth::parsed_body(&headers, &body)
        .map(|value| system::parse_client_lifecycle(value.as_ref()))
    {
        Ok(Ok(parsed)) => parsed,
        Ok(Err(failure)) => return issues(failure),
        Err(response) => return *response,
    };
    let (_, cookies) = match user(&state, &headers, &Method::POST) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut context = Map::new();
    context.insert("source".into(), json!("http"));
    if let Some(client) = headers
        .get("x-suplex-tab-id")
        .and_then(|value| value.to_str().ok())
    {
        context.insert("clientId".into(), json!(client));
    }
    let mut event = json!({ "type": "client_lifecycle" });
    if let (Some(event), Ok(Value::Object(fields))) =
        (event.as_object_mut(), serde_json::to_value(parsed))
    {
        event.extend(fields);
    }
    system_events::emit_with_context(event, context);
    finish(StatusCode::NO_CONTENT.into_response(), cookies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::routes::auth::tests::state;

    async fn serve(state: AppState) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = crate::http::router(state);
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (address, server)
    }

    #[tokio::test]
    async fn update_reports_the_current_build_and_restart_needs_an_administrator() {
        let (state, filename) = state();
        let (address, server) = serve(state.clone()).await;
        let client = reqwest::Client::new();
        let get = |path: &str, host: Option<&str>| {
            let request = client.get(format!("http://{address}{path}"));
            match host {
                Some(host) => request.header("host", host),
                None => request,
            }
        };
        assert_eq!(get("/api/update", None).send().await.unwrap().status(), 401);
        let response = get("/api/update?check=1", Some("127.0.0.1:4111"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["status"], json!({"kind":"current"}));
        assert_eq!(body["canRestart"], false);
        assert_eq!(body["instanceId"], INSTANCE_ID.as_str());
        assert_eq!(
            get("/api/update?check=2", Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        assert_eq!(
            get("/api/update?other=1", Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        let restart = |cookie: &str| {
            client
                .post(format!("http://{address}/api/update/restart"))
                .header("host", "127.0.0.1:4111")
                .header("origin", "http://127.0.0.1:4111")
                .header("cookie", cookie.to_owned())
        };
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_users SET role = 'member'", [])
                .unwrap()
        });
        let member = restart(&cookie).send().await.unwrap();
        assert_eq!(member.status(), 403);
        assert_eq!(
            member.json::<Value>().await.unwrap(),
            json!({"error":"Administrator access necessary"})
        );
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_users SET role = 'admin'", [])
                .unwrap()
        });
        let admin = restart(&cookie).send().await.unwrap();
        assert_eq!(admin.status(), 503);
        assert_eq!(
            admin.json::<Value>().await.unwrap(),
            json!({"error":"Suplex update control is not available."})
        );
        server.abort();
        let _ = std::fs::remove_file(filename);
    }

    #[tokio::test]
    async fn client_lifecycle_reports_are_bounded_and_authenticated() {
        let logs = system_events::install_for_test();
        let (state, filename) = state();
        let (address, server) = serve(state).await;
        let client = reqwest::Client::new();
        let tab = uuid::Uuid::new_v4().to_string();
        let body = json!({"state":"startup","tabId":tab,"documentId":"22222222-2222-4222-8222-222222222222","clientTime":"2026-09-22T12:00:00.000Z","visible":true,"online":true});
        let post = |body: &Value, host: Option<&str>| {
            let request = client
                .post(format!("http://{address}/api/system/client-lifecycle"))
                .header("x-suplex-tab-id", tab.clone())
                .json(body);
            match host {
                Some(host) => request.header("host", host),
                None => request,
            }
        };
        assert_eq!(post(&body, None).send().await.unwrap().status(), 401);
        let mut extra = body.clone();
        extra["url"] = json!("https://private.example/secret");
        assert_eq!(
            post(&extra, Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        assert_eq!(
            post(&body, Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            204
        );
        let log = std::fs::read_to_string(logs.join("system.log")).unwrap();
        let record: Value = log
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|record| record["tabId"] == tab.as_str())
            .unwrap();
        assert_eq!(record["type"], "client_lifecycle");
        assert_eq!(record["source"], "http");
        assert_eq!(record["clientId"], tab.as_str());
        server.abort();
        let _ = std::fs::remove_file(filename);
    }
}
