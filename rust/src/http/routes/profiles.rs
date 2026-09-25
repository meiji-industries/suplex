use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    http::{AppState, contracts, session},
    profiles::agent_profiles::{self, ProfileInput, ProfilePatch},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/profiles", get(list))
        .route("/api/admin/profiles", post(create))
        .route("/api/admin/profiles/defaults", post(choose_defaults))
        .route(
            "/api/admin/profiles/{agent_id}",
            axum::routing::patch(update).delete(delete),
        )
        .route("/api/admin/profiles/{agent_id}/duplicate", post(duplicate))
}

fn response_with_cookies(response: Response, cookies: Vec<String>) -> Response {
    let mut response = response;
    auth::append_cookies(&mut response, cookies);
    response
}

pub(crate) fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    admin: bool,
) -> Result<(String, Vec<String>), Box<Response>> {
    if !session::csrf_allowed(&state.session_config, headers, method, false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(auth::service_error)
        .map_err(Box::new)?;
    let Some(user) = session.user else {
        return Err(Box::new(auth::error(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        )));
    };
    if admin && user.role != "admin" {
        return Err(Box::new(response_with_cookies(
            auth::error(StatusCode::FORBIDDEN, "Administrator access required"),
            session.set_cookies,
        )));
    }
    Ok((user.id, session.set_cookies))
}

fn validated_response(contract: &str, value: Value, status: StatusCode) -> Response {
    match contracts::validate(contract, Some(&value)) {
        Some(Ok(value)) => (status, Json(value)).into_response(),
        _ => auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let mut input = Map::new();
    if let Some(query) = query {
        for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
            let value = json!(value.into_owned());
            if let Some(previous) = input.get_mut(name.as_ref()) {
                if let Value::Array(values) = previous {
                    values.push(value);
                } else {
                    *previous = Value::Array(vec![previous.clone(), value]);
                }
            } else {
                input.insert(name.into_owned(), value);
            }
        }
    }
    let Some(validation) = contracts::validate(
        "projects.ProfileListQuerySchema",
        Some(&Value::Object(input)),
    ) else {
        return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
    };
    let query = match validation {
        Ok(value) => value,
        Err(issues) => return auth::validation_error(issues),
    };
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let include_archived = query.get("includeArchived").and_then(Value::as_str) == Some("true");
    let response = match state
        .with_database(|database| agent_profiles::list(database, &user_id, include_archived))
    {
        Ok(profiles) => validated_response(
            "projects.ProfileListResponseSchema",
            json!({ "profiles": profiles }),
            StatusCode::OK,
        ),
        Err(error) => auth::service_error(error),
    };
    response_with_cookies(response, cookies)
}

async fn create(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match auth::validated_body(&headers, &body, "projects.ProfileBodySchema") {
        Ok(input) => input,
        Err(error) => return *error,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let input: ProfileInput = match serde_json::from_value(input) {
        Ok(input) => input,
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let response = match state
        .with_database(|database| agent_profiles::create(database, &user_id, &input, Utc::now()))
    {
        Ok(profile) => validated_response(
            "projects.ProfileResponseSchema",
            json!(profile),
            StatusCode::CREATED,
        ),
        Err(error) => auth::service_error(error),
    };
    response_with_cookies(response, cookies)
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    body: Bytes,
) -> Response {
    let input = match auth::validated_body(&headers, &body, "projects.ProfilePatchBodySchema") {
        Ok(input) => input,
        Err(error) => return *error,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "PATCH", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let patch: ProfilePatch = match serde_json::from_value(input) {
        Ok(patch) => patch,
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let response = match state.with_database(|database| {
        agent_profiles::update(database, &user_id, &agent_id, patch, Utc::now())
    }) {
        Ok(profile) => validated_response(
            "projects.ProfileResponseSchema",
            json!(profile),
            StatusCode::OK,
        ),
        Err(error) => auth::service_error(error),
    };
    response_with_cookies(response, cookies)
}

async fn duplicate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        agent_profiles::duplicate(database, &user_id, &agent_id, Utc::now())
    }) {
        Ok(profile) => validated_response(
            "projects.ProfileResponseSchema",
            json!(profile),
            StatusCode::CREATED,
        ),
        Err(error) => auth::service_error(error),
    };
    response_with_cookies(response, cookies)
}

async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "DELETE", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| agent_profiles::delete(database, &user_id, &agent_id, Utc::now()))
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth::service_error(error),
    };
    response_with_cookies(response, cookies)
}

async fn choose_defaults(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        agent_profiles::choose_defaults(
            database,
            &user_id,
            agent_profiles::provider_installed,
            Utc::now(),
        )
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth::service_error(error),
    };
    response_with_cookies(response, cookies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::{
        body::to_bytes,
        http::{HeaderValue, header},
    };

    #[tokio::test]
    async fn profile_response_keeps_zod_field_order() {
        let response = validated_response(
            "projects.ProfileResponseSchema",
            json!({
                "id": "profile_fixed", "name": "Fixed", "role": "worker",
                "avatarSeed": "0123456789abcdef0123456789abcdef", "provider": "codex",
                "model": "gpt-6-sol", "reasoningLevel": "medium", "serviceTier": "priority",
                "providerInstanceId": null, "archivedAt": null,
                "createdAt": "2026-09-24T00:00:00.000Z", "updatedAt": "2026-09-24T00:00:00.000Z"
            }),
            StatusCode::OK,
        );
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            body,
            r#"{"provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"priority","providerInstanceId":null,"name":"Fixed","role":"worker","avatarSeed":"0123456789abcdef0123456789abcdef","id":"profile_fixed","archivedAt":null,"createdAt":"2026-09-24T00:00:00.000Z","updatedAt":"2026-09-24T00:00:00.000Z"}"#
        );
    }

    #[tokio::test]
    async fn profile_validation_precedes_origin_and_session_checks() {
        let filename = std::env::temp_dir().join(format!(
            "suplex_profile_route_{}_{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "https://suplex.example.test:4111".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            "origin",
            HeaderValue::from_static("https://wrong.example.test"),
        );
        let invalid = create(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(invalid.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "Invalid request");
        assert!(
            body["findings"]
                .as_array()
                .is_some_and(|findings| !findings.is_empty())
        );
        let query = list(
            State(state.clone()),
            headers.clone(),
            RawQuery(Some("includeArchived=true&includeArchived=true".to_owned())),
        )
        .await;
        assert_eq!(query.status(), StatusCode::BAD_REQUEST);
        headers.insert("cookie", HeaderValue::from_static("sid_v1=invalid"));
        let valid = create(
            State(state.clone()),
            headers,
            Bytes::from_static(br#"{"provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"priority","name":"Profile","role":"worker","avatarSeed":"0123456789abcdef0123456789abcdef"}"#),
        ).await;
        assert_eq!(valid.status(), StatusCode::FORBIDDEN);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
