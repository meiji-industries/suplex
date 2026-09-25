use axum::{
    Json, Router,
    extract::{OriginalUri, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    coordination::workflow_records::{self, WorkflowRecord},
    http::{AppState, contracts, session},
};

use super::auth;

#[derive(Serialize)]
struct WorkflowList {
    workflows: Vec<WorkflowRecord>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/workflows", get(list))
}

fn include_archived(uri: &axum::http::Uri) -> Result<bool, Box<Response>> {
    let mut input = Map::new();
    for (name, selected) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
    {
        let value = json!(selected.into_owned());
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
    match contracts::validate(
        "workflows.WorkflowListQuerySchema",
        Some(&Value::Object(input)),
    ) {
        Some(Ok(query)) => Ok(query.get("includeArchived").and_then(Value::as_str) == Some("true")),
        Some(Err(issues)) => Err(Box::new(auth::validation_error(issues))),
        None => Err(Box::new(auth::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

async fn list(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let include_archived = match include_archived(&uri) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(value) => value,
        Err(error) => return auth::service_error(error),
    };
    let Some(user) = session.user else {
        let mut response = auth::error(
            axum::http::StatusCode::UNAUTHORIZED,
            "Authentication required",
        );
        auth::append_cookies(&mut response, session.set_cookies);
        return response;
    };
    let mut response = match state
        .with_database(|database| workflow_records::list(database, &user.id, include_archived))
    {
        Ok(workflows) => Json(WorkflowList { workflows }).into_response(),
        Err(error) => auth::service_error(error),
    };
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{
        body::to_bytes,
        http::{HeaderValue, StatusCode},
    };

    #[tokio::test]
    async fn seeded_list_applies_archive_filter_after_query_validation_and_session() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            identity_auth::random_hex_id("suplex_workflow_list").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let signed_in = identity_auth::development_sign_in(&mut database, Utc::now()).unwrap();
        database.connection().execute(
            "UPDATE suplex_workflows SET archived_at = '2026-09-24T12:00:00.000Z' WHERE id = 'workflow_native_standard'",
            [],
        ).unwrap();
        database.connection().execute(
            "UPDATE suplex_workflows SET configuration_json = '{\"advisorProfileIds\":{\"rater\":\"r\",\"planner_b\":\"b\",\"reviewer\":\"x\",\"planner_a\":\"a\"}}' WHERE id = 'workflow_native_standard'",
            [],
        ).unwrap();
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
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", signed_in.session_token)).unwrap(),
        );
        let invalid = list(
            State(state.clone()),
            OriginalUri("/api/workflows?includeArchived=false".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let invalid: serde_json::Value =
            serde_json::from_slice(&to_bytes(invalid.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(invalid["findings"][0]["code"], "invalid-invalid_value");
        assert_eq!(invalid["findings"][0]["field"], ".includeArchived");
        let unknown = list(
            State(state.clone()),
            OriginalUri("/api/workflows?other=true".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        let unknown: serde_json::Value =
            serde_json::from_slice(&to_bytes(unknown.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(unknown["findings"][0]["code"], "invalid-unrecognized_keys");
        assert_eq!(unknown["findings"][0]["field"], ".");
        let active = list(
            State(state.clone()),
            OriginalUri("/api/workflows".parse().unwrap()),
            headers.clone(),
        )
        .await;
        assert_eq!(active.status(), StatusCode::OK);
        let active: serde_json::Value =
            serde_json::from_slice(&to_bytes(active.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(active["workflows"].as_array().unwrap().len(), 4);
        let all = list(
            State(state.clone()),
            OriginalUri("/api/workflows?includeArchived=true".parse().unwrap()),
            headers,
        )
        .await;
        assert_eq!(all.status(), StatusCode::OK);
        let all = to_bytes(all.into_body(), 8192).await.unwrap();
        let raw = String::from_utf8(all.to_vec()).unwrap();
        assert!(raw.contains(
            r#""advisorProfileIds":{"reviewer":"x","planner_a":"a","planner_b":"b","rater":"r"}"#
        ));
        let all: serde_json::Value = serde_json::from_slice(&all).unwrap();
        assert_eq!(all["workflows"].as_array().unwrap().len(), 5);
        assert_eq!(all["workflows"][4]["id"], "workflow_native_standard");
        drop(state);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
