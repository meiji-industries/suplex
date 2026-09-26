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
        .route("/api/github/disconnect", post(disconnect))
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

async fn disconnect(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match profiles::authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    state.github_device.cancel_all().await;
    let response = match github::disconnect().await {
        Ok(()) => Json(json!({"status": "sign_in_required"})).into_response(),
        Err(_) => auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Suplex could not disconnect GitHub.",
        ),
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
        github::save_device_grant(&grant).await.map_err(|error| {
            eprintln!(
                "{}",
                json!({"event": "github.credential.save_failed", "error": error.to_string()})
            );
        })
    }))
    .await;
    let response = match result {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err(error)) if error == "GitHub credential store failed" => auth::error(
            StatusCode::BAD_GATEWAY,
            "GitHub authorized sign-in, but Suplex could not save the credential. Allow Suplex access in the macOS Keychain prompt, then try again.",
        ),
        _ => auth::error(StatusCode::BAD_GATEWAY, "GitHub sign-in is unavailable"),
    };
    no_store(response, cookies)
}

async fn poll_and_store<F, Fut>(
    device: Arc<DeviceAuth>,
    flow_id: Uuid,
    save: F,
) -> Result<Poll, String>
where
    F: FnOnce(Granted) -> Fut,
    Fut: Future<Output = Result<(), ()>>,
{
    let result = device.poll(flow_id, save).await;
    // A restart or lost response must not hide an already stored, valid grant.
    if matches!(&result, Ok(Poll::Expired))
        && let Ok(access) = github::Access::load().await
        && access.token().is_some()
        && let Ok(login) = access.current_user_login().await
    {
        return Ok(Poll::Connected { login });
    }
    result.map_err(|error| {
        eprintln!("{}", json!({ "event": "github.device.poll_failed", "flowId": flow_id, "error": error.to_string() }));
        error.to_string()
    })
}

#[cfg(test)]
include!("../../../tests/routes/github_auth.rs");
