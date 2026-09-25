use axum::{
    Json, Router,
    body::Bytes,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    coordination::workflow_records::{self, WorkflowRecord},
    http::{
        AppState, contracts,
        contracts::typed::{ContractResult, workflows as workflow_contracts},
        session,
    },
    platform::database::{DatabaseResult, SuplexDatabase},
    tasks::commands::TaskFailure,
};

use super::auth;

#[derive(Serialize)]
struct WorkflowList {
    workflows: Vec<WorkflowRecord>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workflows", get(list))
        .route("/api/admin/workflows", post(create))
        .route("/api/admin/workflows/{workflow_id}", patch(update))
        .route(
            "/api/admin/workflows/{workflow_id}/duplicate",
            post(duplicate),
        )
}

type Parser = fn(Option<&Value>) -> ContractResult<Map<String, Value>>;

/// Validate the body, then check the request origin and the session, and run
/// the service operation, in the TypeScript hook order.
fn mutate(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    status: StatusCode,
    body: Option<(&Bytes, Parser)>,
    operation: impl FnOnce(
        &mut SuplexDatabase,
        &str,
        Map<String, Value>,
    ) -> DatabaseResult<WorkflowRecord>,
) -> Response {
    let values = match body {
        Some((body, parse)) => match auth::validated_typed_body(headers, body, parse) {
            Ok(value) => value,
            Err(response) => return *response,
        },
        None => Map::new(),
    };
    if !session::csrf_allowed(&state.session_config, headers, method, false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let session = match state.with_database(|database| {
        session::session_user(database, headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(value) => value,
        Err(error) => return auth::service_error(error),
    };
    let mut response = match session.user {
        None => auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
        Some(user) => match state.with_database(|database| operation(database, &user.id, values)) {
            Ok(record) => (status, Json(record)).into_response(),
            Err(error) => match error.downcast::<TaskFailure>() {
                Ok(failure) => auth::error(
                    StatusCode::from_u16(failure.status_code)
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    &failure.public_message,
                ),
                Err(error) => auth::service_error(error),
            },
        },
    };
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

async fn create(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    mutate(
        &state,
        &headers,
        "POST",
        StatusCode::CREATED,
        Some((&body, workflow_contracts::parse_input)),
        workflow_records::create,
    )
}

async fn update(
    State(state): State<AppState>,
    Path(workflow_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    mutate(
        &state,
        &headers,
        "PATCH",
        StatusCode::OK,
        Some((&body, workflow_contracts::parse_patch)),
        |database, user_id, changes| {
            workflow_records::update(database, user_id, &workflow_id, changes)
        },
    )
}

async fn duplicate(
    State(state): State<AppState>,
    Path(workflow_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    mutate(
        &state,
        &headers,
        "POST",
        StatusCode::CREATED,
        None,
        |database, user_id, _| workflow_records::duplicate(database, user_id, &workflow_id),
    )
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
    async fn workflow_api_edits_default_agents_validates_them_and_archives() {
        let (state, filename) = super::super::auth::tests::state();
        let admin = state
            .with_database(|database| identity_auth::development_sign_in(database, Utc::now()))
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, crate::http::router(state.clone())).into_future());
        let client = reqwest::Client::new();
        let cookie = format!("sid_v1={}", admin.session_token);
        let send = |method: reqwest::Method, path: &str, body: Option<Value>| {
            let request = client
                .request(method, format!("http://{address}{path}"))
                .header("origin", "https://suplex.example.test:4111")
                .header("cookie", &cookie);
            match body {
                Some(body) => request.json(&body),
                None => request,
            }
            .send()
        };
        let url = "/api/admin/workflows/workflow_native_refine_pull_request";
        let saved = send(
            reqwest::Method::PATCH,
            url,
            Some(json!({"rootProfileId":"profile_native_root","advisorProfileIds":{"rater":"profile_native_root"},"description":"Fable rates and plans."})),
        )
        .await
        .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        let saved: Value = saved.json().await.unwrap();
        assert_eq!(saved["engine"], "refine_pull_request");
        assert_eq!(saved["rootProfileId"], "profile_native_root");
        assert_eq!(
            saved["advisorProfileIds"],
            json!({"rater":"profile_native_root"})
        );
        assert_eq!(saved["description"], "Fable rates and plans.");
        for payload in [
            json!({"advisorProfileIds":{"reviewer":"profile_native_root"}}),
            json!({"rootProfileId":"profile_native_worker"}),
            json!({"workerProfileId":"profile_missing"}),
            json!({"deliveryTarget":"pull_request_draft"}),
        ] {
            let response = send(reqwest::Method::PATCH, url, Some(payload.clone()))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "{payload}"
            );
        }
        let taken = send(
            reqwest::Method::PATCH,
            url,
            Some(json!({"name":"Standard"})),
        )
        .await
        .unwrap();
        assert_eq!(taken.status(), StatusCode::CONFLICT);
        assert_eq!(
            taken.json::<Value>().await.unwrap(),
            json!({"error":"This workflow name is already in use"})
        );
        // A new engine drops Advisor choices it does not admit and clears a null setting.
        let switched: Value = send(
            reqwest::Method::PATCH,
            url,
            Some(json!({"engine":"independent_review","rootProfileId":null})),
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(switched["engine"], "independent_review");
        assert_eq!(switched["advisorProfileIds"], json!({}));
        assert!(switched.get("rootProfileId").is_none());
        let created = send(
            reqwest::Method::POST,
            "/api/admin/workflows",
            Some(json!({"name":"Fable repair","engine":"refine_pull_request","advisorProfileIds":{"rater":"profile_native_root"},"visualEvidence":"capture"})),
        )
        .await
        .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created: Value = created.json().await.unwrap();
        let id = created["id"].as_str().unwrap();
        assert!(id.starts_with("workflow_"));
        let duplicated = send(
            reqwest::Method::POST,
            &format!("/api/admin/workflows/{id}/duplicate"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(duplicated.status(), StatusCode::CREATED);
        let duplicated: Value = duplicated.json().await.unwrap();
        assert_eq!(duplicated["name"], "Fable repair (copy)");
        assert_eq!(duplicated["engine"], "refine_pull_request");
        assert_eq!(
            duplicated["advisorProfileIds"],
            json!({"rater":"profile_native_root"})
        );
        let archived: Value = send(
            reqwest::Method::PATCH,
            &format!("/api/admin/workflows/{id}"),
            Some(json!({"archived":true})),
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert!(archived["archivedAt"].is_string());
        let active: Value = send(reqwest::Method::GET, "/api/workflows", None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            active["workflows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|workflow| workflow["name"] != "Fable repair")
        );
        let all: Value = send(
            reqwest::Method::GET,
            "/api/workflows?includeArchived=true",
            None,
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(all["workflows"].as_array().unwrap().len(), 7);
        let audits: i64 = state.with_database(|database| {
            database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action IN ('workflow_created', 'workflow_updated')",
                [],
                |row| row.get(0),
            )
        }).unwrap();
        assert_eq!(audits, 5);
        let anonymous = client
            .post(format!("http://{address}/api/admin/workflows"))
            .json(&json!({"name":"x","engine":"standard"}))
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

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
