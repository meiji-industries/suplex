use std::{future::Future, sync::Arc};

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use uuid::Uuid;

use crate::{
    http::{AppState, contracts::typed::github_auth::parse_device_poll},
    integrations::{
        github,
        github_device::{DeviceAuth, Granted, Poll},
    },
};

use super::{auth, profiles};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/github/auth", get(status))
        .route("/api/github/device/start", post(start))
        .route("/api/github/device/poll", post(poll))
}

fn no_store(mut response: Response, cookies: Vec<String>) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("static cache header"),
    );
    auth::append_cookies(&mut response, cookies);
    response
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match profiles::authorize(&state, &headers, "GET", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let access = github::Access::load().await;
    let response = match access {
        Ok(access) if access.token().is_some() => match access.current_user_login().await {
            Ok(login) => Json(json!({
                "method": "device", "source": access.source().as_str(),
                "status": "connected", "login": login,
            }))
            .into_response(),
            Err(error) if matches!(error.downcast_ref::<octocrab::Error>(), Some(octocrab::Error::GitHub { source, .. }) if source.status_code.as_u16() == 401) => {
                Json(json!({
                    "method": "device", "source": access.source().as_str(),
                    "status": "sign_in_required",
                }))
                .into_response()
            }
            Err(_) => Json(json!({
                "method": "device", "source": access.source().as_str(),
                "status": "unavailable",
            }))
            .into_response(),
        },
        Ok(_) => Json(json!({
            "method": "device", "source": "none", "status": "sign_in_required",
        }))
        .into_response(),
        _ => Json(json!({
            "method": "device", "source": "none", "status": "unavailable",
        }))
        .into_response(),
    };
    no_store(response, cookies)
}

async fn start(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match profiles::authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let device = state.github_device.clone();
    let result = tokio::spawn(async move { device.start().await.map_err(|_| ()) }).await;
    let response = match result {
        Ok(Ok(started)) => Json(started).into_response(),
        _ => auth::error(StatusCode::BAD_GATEWAY, "GitHub sign-in is unavailable"),
    };
    no_store(response, cookies)
}

async fn poll(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let request = match auth::validated_typed_body(&headers, &body, parse_device_poll) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let (_, cookies) = match profiles::authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let device = state.github_device.clone();
    let Ok(flow_id) = Uuid::parse_str(&request.flow_id) else {
        return no_store(Json(Poll::Expired).into_response(), cookies);
    };
    // The owned operation keeps polling and storing a granted token even if
    // the HTTP waiter disconnects after admission.
    let result = tokio::spawn(poll_and_store(device, flow_id, |grant| async move {
        github::save_device_grant(&grant).await.map_err(|_| ())
    }))
    .await;
    let response = match result {
        Ok(Ok(result)) => Json(result).into_response(),
        _ => auth::error(StatusCode::BAD_GATEWAY, "GitHub sign-in is unavailable"),
    };
    no_store(response, cookies)
}

async fn poll_and_store<F, Fut>(device: Arc<DeviceAuth>, flow_id: Uuid, save: F) -> Result<Poll, ()>
where
    F: FnOnce(Granted) -> Fut,
    Fut: Future<Output = Result<(), ()>>,
{
    device.poll(flow_id, save).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        http::session,
        identity::auth::development_sign_in,
        integrations::github_device::DeviceAuth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use chrono::Utc;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn accepted_device_grant_is_saved_after_waiter_disconnects() {
        let app = Router::new()
            .route(
                "/login/device/code",
                post(|| async {
                    Json(json!({
                        "device_code":"private-device-code", "user_code":"ABCD-EFGH",
                        "verification_uri":"https://github.com/login/device",
                        "expires_in":900, "interval":1,
                    }))
                }),
            )
            .route(
                "/login/oauth/access_token",
                post(|| async {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    Json(json!({
                        "access_token":"fixture-access", "refresh_token":"fixture-refresh",
                        "expires_in":28800, "refresh_token_expires_in":15897600,
                    }))
                }),
            )
            .route("/user", get(|| async { Json(json!({"login":"fixture"})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let device = Arc::new(DeviceAuth::for_endpoints(&endpoint, &endpoint).unwrap());
        let flow = device.start().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let saved = Arc::new(Mutex::new(None::<String>));
        let notify = Arc::new(tokio::sync::Notify::new());
        let waiter = tokio::spawn(poll_and_store(device, flow.flow_id, {
            let saved = saved.clone();
            let notify = notify.clone();
            move |grant| async move {
                *saved.lock().unwrap() = Some(grant.refresh_token.unwrap());
                notify.notify_one();
                Ok(())
            }
        }));
        drop(waiter);
        tokio::time::timeout(std::time::Duration::from_secs(2), notify.notified())
            .await
            .unwrap();
        assert_eq!(saved.lock().unwrap().as_deref(), Some("fixture-refresh"));
        server.abort();
    }

    #[tokio::test]
    async fn admin_device_start_and_poll_keep_validation_and_secret_boundary() {
        let app = Router::new().route(
            "/login/device/code",
            post(|| async {
                Json(json!({
                    "device_code":"private-device-code", "user_code":"ABCD-EFGH",
                    "verification_uri":"https://github.com/login/device",
                    "expires_in":900, "interval":5,
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let path =
            std::env::temp_dir().join(format!("suplex-device-route-{}.sqlite", Uuid::new_v4()));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let admin = development_sign_in(&mut database, Utc::now()).unwrap();
        let mut state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "http://127.0.0.1:4111".into(),
                tailscale_exposure: "none".into(),
            },
        );
        state.github_device = Arc::new(DeviceAuth::for_endpoints(&endpoint, &endpoint).unwrap());
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4111"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:4111"),
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let invalid = poll(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let invalid: Value =
            serde_json::from_slice(&to_bytes(invalid.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(invalid["error"], "Invalid request");
        assert_eq!(invalid["findings"][0]["field"], ".flowId");
        let started = start(State(state.clone()), headers.clone()).await;
        assert_eq!(started.status(), StatusCode::OK);
        assert_eq!(started.headers()[header::CACHE_CONTROL], "no-store");
        let started: Value =
            serde_json::from_slice(&to_bytes(started.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(started["userCode"], "ABCD-EFGH");
        assert!(started["expiresAt"].as_str().unwrap().ends_with('Z'));
        assert!(!started.to_string().contains("private-device-code"));
        let pending = poll(
            State(state),
            headers,
            Bytes::from(json!({"flowId":started["flowId"]}).to_string()),
        )
        .await;
        assert_eq!(pending.status(), StatusCode::OK);
        let pending: Value =
            serde_json::from_slice(&to_bytes(pending.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(pending["status"], "pending");
        assert!(!pending.to_string().contains("private-device-code"));
        server.abort();
        let _ = std::fs::remove_file(path);
    }
}
