//! Paired-agent runtime routes under `/api/agent` and the legacy `/api/hermes` prefix.
//!
//! Runtime routes authenticate before validating the request, as the TypeScript
//! `preValidation` hook does; the read routes validate first. Delivery and merge
//! routes exist only where agent delivery is configured, and capabilities say so.

use std::{error::Error, path::PathBuf, sync::LazyLock};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, RawQuery, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    delivery::agent_delivery::{AgentDelivery, AgentPrincipal},
    http::{
        AppState, agent_api_runtime,
        contracts::typed::{self, Contract, ContractResult, agent_api as contracts},
    },
    identity::external_agents::{self, Principal},
    shared::js_json,
    tasks::{agent_api, images::MAX_TASK_REQUEST_BYTES},
};

use super::auth;

const DELIVERY_COMMANDS: [&str; 6] = [
    "observe_delivery",
    "request_delivery_repair",
    "decide_delivery_wait",
    "read_merge_train",
    "request_merge_approval",
    "merge_pull_request",
];

static OPENAPI: LazyLock<String> = LazyLock::new(|| {
    js_json::stringify(
        &serde_json::from_str::<Value>(include_str!("agent_api_openapi.json"))
            .expect("generated OpenAPI is JSON"),
    )
});

/// Agent delivery uses the host artifact store.
pub(crate) fn delivery(state: &AppState) -> Option<AgentDelivery> {
    let root = state.artifact_root.clone()?;
    let path = state.with_database(|database| database.connection().path().map(PathBuf::from))?;
    Some(AgentDelivery::new(&path, &root))
}

/// `agentApiCapabilities`: the reported surface is the registered surface.
/// Answers appear only for an agent that holds the answer grant.
pub fn capabilities(agent_delivery: bool, answers: bool) -> Value {
    let mut autonomous = vec!["create_backlog_task", "create_queued_task", "update_task"];
    autonomous.extend(agent_api::task_commands(answers));
    if agent_delivery {
        autonomous.extend(DELIVERY_COMMANDS);
    }
    let mut unavailable = Vec::new();
    if !answers {
        unavailable.push(contracts::ANSWER_HUMAN_QUESTION);
    }
    unavailable.push("deliver_task");
    if !agent_delivery {
        unavailable.push("merge_pull_request");
    }
    let human_only = if answers {
        vec!["task_limit_decision", "command_cleanup_confirmation"]
    } else {
        vec!["task_human_answer"]
    };
    json!({
        "apiVersion": "v1",
        "capabilities": {
            "read": {"task": true, "workflows": true, "templates": true},
            "create": {"backlogTask": true, "queuedTask": true, "deliveryTargets": ["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"]},
            "taskControl": true, "delivery": agent_delivery, "merge": agent_delivery, "humanDecisions": answers,
        },
        "autonomousCommands": autonomous,
        "humanOnlyRecords": human_only,
        "unavailableCommands": unavailable,
        "pagination": {"supported": true, "cursor": true},
    })
}

pub fn router() -> Router<AppState> {
    let mut router = Router::new();
    for prefix in ["/api/agent", "/api/hermes"] {
        router = router
            .route(&format!("{prefix}/me"), get(me))
            .route(&format!("{prefix}/openapi.json"), get(openapi))
            .route(&format!("{prefix}/capabilities"), get(capabilities_route))
            .route(&format!("{prefix}/workflows"), get(workflows))
            .route(&format!("{prefix}/templates"), get(templates))
            .route(
                &format!("{prefix}/tasks"),
                get(list)
                    .post(create)
                    .layer(DefaultBodyLimit::max(MAX_TASK_REQUEST_BYTES)),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}"),
                get(read).patch(update),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}/commands"),
                post(command),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}/dependencies"),
                put(dependencies),
            )
            .route(&format!("{prefix}/merge-train"), get(merge_train))
            .route(
                &format!("{prefix}/tasks/{{task_id}}/delivery/refresh"),
                post(delivery_refresh),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}/delivery/repair"),
                post(delivery_repair),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}/delivery/decision"),
                post(delivery_decision),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}/delivery/approvals"),
                post(delivery_approval),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}/delivery/merge"),
                post(delivery_merge),
            )
            .route(
                &format!("{prefix}/tasks/{{task_id}}/delivery/provenance"),
                get(delivery_provenance),
            );
    }
    router
}

type Rejection = Box<Response>;

/// `authenticateAgentApiBearer`: the persisted credential decides on every request.
pub(crate) fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Principal, Box<dyn Error>> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(crate::identity::auth::js_trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(external_agents::authentication_failure)?;
    state.with_database(|database| external_agents::authenticate(database, token, Utc::now()))
}

fn bearer(state: &AppState, headers: &HeaderMap, runtime: bool) -> Result<Principal, Rejection> {
    authenticate(state, headers)
        .map_err(|error| Box::new(agent_api_runtime::failure(error, runtime)))
}

fn validated<T>(result: ContractResult<T>, runtime: bool) -> Result<T, Rejection> {
    match result {
        Ok(value) => Ok(value),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(agent_api_runtime::validation(findings, runtime)))
        }
        Err(_) => Err(Box::new(agent_api_runtime::failure(
            "contract failed".into(),
            runtime,
        ))),
    }
}

/// Fastify's content-type parsers run before authentication.
fn parsed_body(
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
    runtime: bool,
) -> Result<Option<Value>, Rejection> {
    let body =
        body.map_err(|error| Box::new(agent_api_runtime::body_failure(error.status(), runtime)))?;
    auth::parsed_body(headers, &body)
        .map_err(|response| Box::new(agent_api_runtime::body_failure(response.status(), runtime)))
}

/// Fastify's router rejects a parameter longer than 100 characters before matching the route.
fn task_id(id: &str, runtime: bool) -> Result<String, Rejection> {
    if id.chars().count() > 100 {
        return Err(Box::new(
            (StatusCode::NOT_FOUND, Json(json!({"error": "Not found"}))).into_response(),
        ));
    }
    validated(
        contracts::TaskIdParams::parse(Some(&json!({"taskId": id}))),
        runtime,
    )
    .map(|params| params.task_id)
}

fn no_store(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::CONTENT_TYPE, "application/json"),
        ],
        js_json::stringify(body),
    )
        .into_response()
}

fn respond(result: Result<Value, Box<dyn Error>>, status: StatusCode, runtime: bool) -> Response {
    match result {
        Ok(body) => no_store(status, &body),
        Err(error) => agent_api_runtime::failure(error, runtime),
    }
}

fn wake(state: &AppState, task_id: &str) {
    if let Some(host) = &state.task_host {
        host.wake(task_id.to_owned());
    }
}

macro_rules! attempt {
    ($value:expr) => {
        match $value {
            Ok(value) => value,
            Err(response) => return *response,
        }
    };
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let principal = attempt!(bearer(&state, &headers, false));
    respond(
        state.with_database(|database| agent_api::identity(database, &principal)),
        StatusCode::OK,
        false,
    )
}

async fn openapi(State(state): State<AppState>, headers: HeaderMap) -> Response {
    attempt!(bearer(&state, &headers, true));
    (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::CONTENT_TYPE, "application/json"),
        ],
        OPENAPI.as_str(),
    )
        .into_response()
}

async fn capabilities_route(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let principal = attempt!(bearer(&state, &headers, true));
    no_store(
        StatusCode::OK,
        &capabilities(delivery(&state).is_some(), principal.answer_grant.is_some()),
    )
}

async fn workflows(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let principal = attempt!(bearer(&state, &headers, true));
    let query = attempt!(validated(
        contracts::ProjectDiscoveryQuery::parse(Some(&contracts::query_object(query.as_deref()))),
        true
    ));
    let result = state
        .with_database(|database| agent_api::workflows(database, &principal, &query.project_id));
    respond(
        result.map(|workflows| json!({"workflows": workflows})),
        StatusCode::OK,
        true,
    )
}

async fn templates(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let principal = attempt!(bearer(&state, &headers, true));
    let query = attempt!(validated(
        contracts::ProjectDiscoveryQuery::parse(Some(&contracts::query_object(query.as_deref()))),
        true
    ));
    let result = state
        .with_database(|database| agent_api::templates(database, &principal, &query.project_id));
    respond(
        result.map(|templates| json!({"templates": templates})),
        StatusCode::OK,
        true,
    )
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = attempt!(parsed_body(&headers, body, true));
    let principal = attempt!(bearer(&state, &headers, true));
    let request = attempt!(validated(
        contracts::TaskCreateBody::parse(body.as_ref()),
        true
    ));
    // Admission keeps running when the HTTP waiter disconnects, as board creation does.
    let task = tokio::spawn(async move {
        let creation = match agent_api::create(&state, &principal, &request, None).await {
            Ok(creation) => creation,
            Err(error) => return agent_api_runtime::failure(error, true),
        };
        let (id, created, active) = match creation {
            agent_api::Creation::DryRun(preview) => return no_store(StatusCode::OK, &preview),
            agent_api::Creation::Task {
                id,
                created,
                active,
            } => (id, created, active),
        };
        if active {
            wake(&state, &id);
        }
        let status = if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        };
        let task = agent_api::read(&state, &principal, &id).await;
        respond(task, status, true)
    });
    task.await
        .unwrap_or_else(|_| agent_api_runtime::failure("create failed".into(), true))
}

async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let id = attempt!(task_id(&id, false));
    let principal = attempt!(bearer(&state, &headers, false));
    let task = match agent_api::read(&state, &principal, &id).await {
        Ok(task) => task,
        Err(error) => return agent_api_runtime::failure(error, false),
    };
    let etag = format!("\"{}\"", task["revision"].as_str().unwrap_or_default());
    let header_value = |name: header::HeaderName| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let mut response = if header_value(header::IF_MATCH).is_some_and(|value| value != etag) {
        (
            StatusCode::PRECONDITION_FAILED,
            Json(json!({"error": "Task revision is stale", "code": "revision_stale"})),
        )
            .into_response()
    } else if header_value(header::IF_NONE_MATCH).as_deref() == Some(etag.as_str()) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        no_store(StatusCode::OK, &task)
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    if let Ok(value) = header::HeaderValue::from_str(&etag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

async fn command(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = attempt!(parsed_body(&headers, body, true));
    let principal = attempt!(bearer(&state, &headers, true));
    let id = attempt!(task_id(&id, true));
    let request = attempt!(validated(
        contracts::TaskCommandBody::parse(body.as_ref()),
        true
    ));
    let result = agent_api::command(&state, &principal, &id, &request).await;
    if result.is_ok() && agent_api::wakes_host(&request.command) {
        wake(&state, &id);
    }
    respond(result, StatusCode::OK, true)
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = attempt!(parsed_body(&headers, body, true));
    let principal = attempt!(bearer(&state, &headers, true));
    let id = attempt!(task_id(&id, true));
    let request = attempt!(validated(
        contracts::TaskUpdateBody::parse(body.as_ref()),
        true
    ));
    let result =
        state.with_database(|database| agent_api::update(database, &principal, &id, &request));
    if result.as_ref().is_ok_and(|task| task["status"] == "active") {
        wake(&state, &id);
    }
    respond(result, StatusCode::OK, true)
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = attempt!(validated(
        contracts::TaskListQuery::parse(Some(&contracts::query_object(query.as_deref()))),
        false
    ));
    let principal = attempt!(bearer(&state, &headers, false));
    let view = query.view.clone().unwrap_or_else(|| "full".into());
    respond(
        agent_api::read_list(&state, &principal, &query, &view).await,
        StatusCode::OK,
        false,
    )
}

async fn dependencies(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = attempt!(parsed_body(&headers, body, true));
    let principal = attempt!(bearer(&state, &headers, true));
    let id = attempt!(task_id(&id, true));
    let request = attempt!(validated(
        contracts::TaskDependenciesBody::parse(body.as_ref()),
        true
    ));
    if request.dry_run == Some(true) {
        let result = state.with_database(|database| {
            agent_api::preview_dependencies(database, &principal, &id, &request.depends_on)
        });
        return respond(result, StatusCode::OK, true);
    }
    // GitHub observes each pull request prerequisite between the checks and the write.
    let repository = match state.with_database(|database| {
        agent_api::dependency_repository(database, &principal, &id, &request)
    }) {
        Ok(repository) => repository,
        Err(error) => return respond(Err(error), StatusCode::OK, true),
    };
    let numbers = request
        .blocked_by_pull_requests
        .iter()
        .map(|dependency| dependency.number)
        .collect::<Vec<_>>();
    let observed = crate::tasks::pull_request_dependencies::observe(&repository, &numbers).await;
    let result = match observed {
        Err(rejection) => Err(agent_api::pull_request_unavailable(rejection)),
        Ok(pull_requests) => state.with_database(|database| {
            agent_api::set_dependencies(database, &principal, &id, &request, &pull_requests)
        }),
    };
    respond(result, StatusCode::OK, true)
}

// Delivery routes validate before authenticating and use the board envelope.

fn delivery_principal(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(AgentDelivery, AgentPrincipal), Rejection> {
    let Some(delivery) = delivery(state) else {
        return Err(Box::new(
            (StatusCode::NOT_FOUND, Json(json!({"error": "Not found"}))).into_response(),
        ));
    };
    let principal = bearer(state, headers, false)?;
    Ok((
        delivery,
        AgentPrincipal {
            agent_id: principal.agent_id,
            company_id: principal.company_id,
        },
    ))
}

async fn merge_train(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if delivery(&state).is_none() {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "Not found"}))).into_response();
    }
    let query = attempt!(validated(
        contracts::MergeTrainQuery::parse(Some(&contracts::query_object(query.as_deref()))),
        false
    ));
    let (delivery, principal) = attempt!(delivery_principal(&state, &headers));
    respond(
        delivery
            .merge_train(&principal, query.project_id.as_deref())
            .await,
        StatusCode::OK,
        false,
    )
}

fn delivery_task(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
) -> Result<(AgentDelivery, AgentPrincipal, String), Rejection> {
    if delivery(state).is_none() {
        return Err(Box::new(
            (StatusCode::NOT_FOUND, Json(json!({"error": "Not found"}))).into_response(),
        ));
    }
    let id = task_id(id, false)?;
    let (delivery, principal) = delivery_principal(state, headers)?;
    Ok((delivery, principal, id))
}

/// Some delivery operations hold non-`Send` errors across awaits; run them on their own thread.
async fn detached<F, Fut>(operation: F) -> Response
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Response>,
{
    tokio::task::spawn_blocking(move || crate::shared::blocking::block_on(operation))
        .await
        .unwrap_or_else(|_| agent_api_runtime::failure("delivery failed".into(), false))
}

async fn delivery_refresh(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    detached(move || async move {
        respond(
            delivery.refresh(&principal, &id).await,
            StatusCode::OK,
            false,
        )
    })
    .await
}

async fn delivery_repair(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    respond(
        delivery.request_reconciliation(&principal, &id).await,
        StatusCode::ACCEPTED,
        false,
    )
}

async fn delivery_decision(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = attempt!(parsed_body(&headers, body, false));
    let request = attempt!(validated(
        contracts::DeliveryDecisionBody::parse(body.as_ref()),
        false
    ));
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    respond(
        delivery.decide(&principal, &id, &request.decision),
        StatusCode::OK,
        false,
    )
}

async fn delivery_approval(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = attempt!(parsed_body(&headers, body, false));
    let request = attempt!(validated(
        contracts::MergeApprovalBody::parse(body.as_ref()),
        false
    ));
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    respond(
        delivery
            .issue_approval(
                &principal,
                &id,
                request.pull_request_number,
                &request.head_sha,
            )
            .await,
        StatusCode::CREATED,
        false,
    )
}

async fn delivery_merge(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = attempt!(parsed_body(&headers, body, false));
    let request = attempt!(validated(contracts::MergeBody::parse(body.as_ref()), false));
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    detached(move || async move {
        let result = delivery
            .merge(
                &principal,
                &id,
                request.pull_request_number,
                &request.expected_head_sha,
                &request.expected_base_sha,
                &request.approval_receipt,
            )
            .await;
        respond(result, StatusCode::OK, false)
    })
    .await
}

async fn delivery_provenance(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    let result = delivery.provenance(&principal, &id).map(|records| {
        let parse = |value: &Value| value.as_str().and_then(|raw| serde_json::from_str::<Value>(raw).ok()).unwrap_or(Value::Null);
        json!({"records": records.iter().map(|record| json!({
            "id": record["id"], "attemptId": record["attempt_id"], "kind": record["kind"], "pullRequestNumber": record["pull_request_number"],
            "originalHeadSha": record["original_head_sha"], "headSha": record["head_sha"], "baseSha": record["base_sha"],
            "checks": parse(&record["checks_json"]), "merge": parse(&record["merge_json"]), "recordedAt": record["recorded_at"],
        })).collect::<Vec<_>>()})
    });
    respond(result, StatusCode::OK, false)
}

#[cfg(test)]
include!("../../../tests/routes/agent_api.rs");
