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
        contracts::typed::{self, ContractResult, agent_api as contracts},
    },
    identity::external_agents::{self, Principal},
    shared::js_json,
    tasks::{agent_api, images::MAX_TASK_REQUEST_BYTES},
};

use super::auth;

const TASK_COMMANDS: [&str; 8] = contracts::TASK_COMMANDS;
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

/// Agent delivery runs where the host has an artifact store, as the TypeScript server always does.
pub(crate) fn delivery(state: &AppState) -> Option<AgentDelivery> {
    let root = state.artifact_root.clone()?;
    let path = state.with_database(|database| database.connection().path().map(PathBuf::from))?;
    Some(AgentDelivery::new(&path, &root))
}

/// `agentApiCapabilities`: the reported surface is the registered surface.
pub fn capabilities(agent_delivery: bool) -> Value {
    let mut autonomous = vec!["create_backlog_task", "create_queued_task"];
    autonomous.extend(TASK_COMMANDS);
    if agent_delivery {
        autonomous.extend(DELIVERY_COMMANDS);
    }
    let unavailable: Vec<&str> = if agent_delivery {
        vec!["answer_human_question", "deliver_task"]
    } else {
        vec![
            "answer_human_question",
            "deliver_task",
            "merge_pull_request",
        ]
    };
    json!({
        "apiVersion": "v1",
        "capabilities": {
            "read": {"task": true, "workflows": true, "templates": true},
            "create": {"backlogTask": true, "queuedTask": true, "deliveryTargets": ["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"]},
            "taskControl": true, "delivery": agent_delivery, "merge": agent_delivery, "humanDecisions": false,
        },
        "autonomousCommands": autonomous,
        "humanOnlyRecords": ["task_human_answer"],
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
            .route(&format!("{prefix}/tasks/{{task_id}}"), get(read))
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
        contracts::parse_task_id_params(Some(&json!({"taskId": id}))),
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
    attempt!(bearer(&state, &headers, true));
    no_store(StatusCode::OK, &capabilities(delivery(&state).is_some()))
}

async fn workflows(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let principal = attempt!(bearer(&state, &headers, true));
    let query = attempt!(validated(
        contracts::parse_project_discovery(Some(&contracts::query_object(query.as_deref()))),
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
        contracts::parse_project_discovery(Some(&contracts::query_object(query.as_deref()))),
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
    let request = attempt!(validated(contracts::parse_task_create(body.as_ref()), true));
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
        contracts::parse_task_command(body.as_ref()),
        true
    ));
    let result = agent_api::command(&state, &principal, &id, &request).await;
    if result.is_ok() && agent_api::wakes_host(&request.command) {
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
        contracts::parse_task_list(Some(&contracts::query_object(query.as_deref()))),
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
        contracts::parse_task_dependencies(body.as_ref()),
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
        contracts::parse_merge_train(Some(&contracts::query_object(query.as_deref()))),
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
async fn detached<F>(operation: F) -> Response
where
    F: FnOnce() -> Response + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .unwrap_or_else(|_| agent_api_runtime::failure("delivery failed".into(), false))
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
        .map(|runtime| runtime.block_on(future))
}

async fn delivery_refresh(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    detached(move || {
        block_on(async {
            respond(
                delivery.refresh(&principal, &id).await,
                StatusCode::OK,
                false,
            )
        })
        .unwrap_or_else(|| agent_api_runtime::failure("delivery failed".into(), false))
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
        contracts::parse_delivery_decision(body.as_ref()),
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
        contracts::parse_merge_approval(body.as_ref()),
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
                &request.base_sha,
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
    let request = attempt!(validated(contracts::parse_merge(body.as_ref()), false));
    let (delivery, principal, id) = attempt!(delivery_task(&state, &headers, &id));
    detached(move || {
        block_on(async {
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
        .unwrap_or_else(|| agent_api_runtime::failure("delivery failed".into(), false))
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
pub(crate) mod tests {
    use std::process::Command;

    use chrono::Utc;
    use rusqlite::params;
    use serde_json::{Value, json};

    use crate::{
        http::routes::{
            auth as route_auth,
            external_agent_administration::tests::{Server, server},
        },
        identity::external_agents,
    };

    fn git(args: &[&str], cwd: &std::path::Path) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A local repository whose `origin` fetch resolves to a bare repository.
    pub(crate) fn repository(root: &std::path::Path) -> std::path::PathBuf {
        let bare = root.join("origin.git");
        let local = root.join("repository");
        std::fs::create_dir_all(root).unwrap();
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            root,
        );
        git(&["remote", "add", "origin", bare.to_str().unwrap()], &local);
        git(
            &[
                "-c",
                "user.name=Probe",
                "-c",
                "user.email=probe@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "base",
            ],
            &local,
        );
        git(&["push", "--quiet", "origin", "main"], &local);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/demo.git",
            ],
            &local,
        );
        git(
            &[
                "config",
                "--local",
                &format!("url.file://{}.insteadOf", bare.display()),
                "https://github.com/acme/demo.git",
            ],
            &local,
        );
        local
    }

    pub(crate) struct Agent {
        pub server: Server,
        pub credential: String,
        pub agent_id: String,
        pub root: std::path::PathBuf,
    }

    impl Drop for Agent {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    pub(crate) fn pair(server: &Server, name: &str, projects: &[&str]) -> (String, String) {
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
        let projects = projects
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<Vec<_>>();
        server.state.with_database(|database| {
            let issued = external_agents::create(
                database,
                &admin,
                external_agents::CreateInput {
                    name,
                    company_id: "company_api",
                    project_ids: &projects,
                    avatar_seed: None,
                },
                Utc::now(),
            )
            .unwrap();
            let paired = external_agents::exchange(
                database,
                &issued.pairing_code,
                Some("profile-bot"),
                Utc::now(),
            )
            .unwrap();
            (paired.credential, issued.agent.id)
        })
    }

    /// The agent API fixture: a project on a real repository with a local-worktree agent policy.
    pub(crate) async fn agent() -> Agent {
        let root = std::env::temp_dir().join(format!("suplex-agent-api-{}", uuid::Uuid::new_v4()));
        let local = repository(&root);
        let (state, path) = route_auth::tests::state();
        let state = state.with_artifact_root(root.join("artifacts"));
        let server = server(Some((state, path))).await;
        let policy = json!({"workflowIds": ["workflow_native_standard"], "defaultWorkflowId": "workflow_native_standard", "rootProfileIds": ["profile_native_root"], "workerProfileIds": ["profile_native_worker"], "deliveryTarget": "local_worktree"});
        server.state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_projects SET root_profile_id = 'profile_native_root', worker_profile_id = 'profile_native_worker', agent_task_policy_json = ?1 WHERE id IN ('project_api', 'project_api_2')",
                params![policy.to_string()],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_projects SET repository_path = ?1, worktree_root = ?2, repository_identity = 'acme/demo' WHERE id = 'project_api'",
                params![local.to_str().unwrap(), root.join("worktrees").to_str().unwrap()],
            ).unwrap();
        });
        let (credential, agent_id) = pair(&server, "AgentApi Bot", &["project_api"]);
        Agent {
            server,
            credential,
            agent_id,
            root,
        }
    }

    impl Agent {
        pub(crate) async fn call(
            &self,
            method: reqwest::Method,
            path: &str,
            body: Option<Value>,
        ) -> (u16, Value) {
            self.call_as(&self.credential, method, path, body).await
        }

        pub(crate) async fn call_as(
            &self,
            credential: &str,
            method: reqwest::Method,
            path: &str,
            body: Option<Value>,
        ) -> (u16, Value) {
            let bearer = format!("Bearer {credential}");
            let response = self
                .server
                .request(method, path, &[("authorization", bearer.as_str())], body)
                .await;
            let status = response.status().as_u16();
            let text = response.text().await.unwrap();
            (status, serde_json::from_str(&text).unwrap_or(Value::Null))
        }

        pub(crate) async fn create(&self, title: &str, key: &str) -> Value {
            let (status, task) = self
                .call(
                    reqwest::Method::POST,
                    "/api/agent/tasks",
                    Some(
                        json!({"projectId": "project_api", "title": title, "idempotencyKey": key}),
                    ),
                )
                .await;
            assert_eq!(status, 201, "{task}");
            task
        }
    }

    /// Ports `tests/agent-machine-discovery.integration.test.ts`: the public map, pairing, and the contract agree.
    #[tokio::test]
    async fn a_paired_agent_follows_the_public_map_without_the_web_application() {
        let agent = agent().await;
        let (_, catalog) = agent
            .server
            .send(
                reqwest::Method::GET,
                "/.well-known/suplex/api-catalog.json",
                None,
                None,
            )
            .await;
        let admin = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        });
        let projects = vec!["project_api".to_owned()];
        let issued = agent
            .server
            .state
            .with_database(|database| {
                external_agents::create(
                    database,
                    &admin,
                    external_agents::CreateInput {
                        name: "Journey agent",
                        company_id: "company_api",
                        project_ids: &projects,
                        avatar_seed: None,
                    },
                    Utc::now(),
                )
            })
            .unwrap();
        let (status, paired) = agent
            .server
            .send(
                reqwest::Method::POST,
                catalog["pairing"][0]["path"].as_str().unwrap(),
                None,
                Some(json!({"pairingCode": issued.pairing_code, "profileId": "journey"})),
            )
            .await;
        assert_eq!(status, 200);
        let credential = paired["credential"].as_str().unwrap();
        let (status, document) = agent
            .call_as(
                credential,
                reqwest::Method::GET,
                "/api/agent/openapi.json",
                None,
            )
            .await;
        assert_eq!(status, 200);
        for entry in catalog["runtime"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["path"].as_str().unwrap().contains('{'))
        {
            assert!(
                document["paths"][entry["path"].as_str().unwrap()].is_object(),
                "{entry}"
            );
        }
        assert!(document["paths"]["/api/agent/tasks"].is_object());
        let body = json!({"projectId": "project_api", "title": "Acknowledge the pairing", "idempotencyKey": "journey-ack-001"});
        let (first, created) = agent
            .call_as(
                credential,
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body.clone()),
            )
            .await;
        let (second, replay) = agent
            .call_as(
                credential,
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body),
            )
            .await;
        assert_eq!(
            (
                first,
                second,
                replay["id"].clone(),
                replay["status"].as_str()
            ),
            (201, 200, created["id"].clone(), Some("backlog"))
        );
        assert_eq!(
            agent
                .server
                .request(reqwest::Method::GET, "/api/agent/me", &[], None)
                .await
                .status(),
            401
        );
    }

    #[tokio::test]
    async fn rejected_credentials_and_board_sessions_cannot_reach_runtime_routes() {
        let agent = agent().await;
        let anonymous = agent
            .server
            .request(reqwest::Method::GET, "/api/agent/me", &[], None)
            .await;
        assert_eq!(anonymous.status(), 401);
        assert_eq!(
            anonymous.json::<Value>().await.unwrap(),
            json!({"error": "Authentication failed", "code": "credential_invalid"})
        );
        let board = agent
            .server
            .send(
                reqwest::Method::GET,
                "/api/agent/capabilities",
                Some(&agent.server.admin_cookie.clone()),
                None,
            )
            .await;
        assert_eq!(
            board,
            (
                401,
                json!({"error": "Authentication failed", "code": "credential_invalid"})
            )
        );
        for credential in ["wrong", "fha_invalid0000000000000000000000000000000000", ""] {
            assert_eq!(
                agent
                    .call_as(
                        credential,
                        reqwest::Method::GET,
                        "/api/hermes/openapi.json",
                        None
                    )
                    .await
                    .0,
                401
            );
            assert_eq!(
                agent
                    .call_as(
                        credential,
                        reqwest::Method::POST,
                        "/api/agent/tasks",
                        Some(json!({}))
                    )
                    .await
                    .0,
                401
            );
        }
        let admin = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        });
        agent
            .server
            .state
            .with_database(|database| {
                external_agents::revoke(database, &admin, &agent.agent_id, Utc::now())
            })
            .unwrap();
        assert_eq!(
            agent
                .call(reqwest::Method::GET, "/api/agent/me", None)
                .await
                .0,
            401
        );
    }

    #[tokio::test]
    async fn identity_capabilities_contract_and_discovery_follow_live_grants() {
        let agent = agent().await;
        let (status, identity) = agent
            .call(reqwest::Method::GET, "/api/agent/me", None)
            .await;
        assert_eq!(status, 200);
        assert_eq!(
            identity["agent"],
            json!({"id": agent.agent_id, "name": "AgentApi Bot", "profileId": "profile-bot"})
        );
        assert_eq!(
            identity["projects"],
            json!([{"id": "project_api", "name": "API Project", "agentTaskPolicy": {"deliveryTargets": ["local_worktree"], "runProjectTests": true, "visualEvidence": "off"}}])
        );
        assert_eq!(
            identity["capabilities"]["taskCommands"]
                .as_array()
                .unwrap()
                .len(),
            8
        );
        let (_, capabilities) = agent
            .call(reqwest::Method::GET, "/api/agent/capabilities", None)
            .await;
        assert_eq!(capabilities, super::capabilities(true));
        assert_eq!(
            super::capabilities(false)["unavailableCommands"],
            json!([
                "answer_human_question",
                "deliver_task",
                "merge_pull_request"
            ])
        );
        let response = agent
            .server
            .request(
                reqwest::Method::GET,
                "/api/agent/openapi.json",
                &[("authorization", &format!("Bearer {}", agent.credential))],
                None,
            )
            .await;
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let document = response.json::<Value>().await.unwrap();
        assert_eq!(document["openapi"], "3.0.3");
        assert!(document["paths"]["/api/agent/tasks/{taskId}/commands"]["post"].is_object());
        let (status, workflows) = agent
            .call(
                reqwest::Method::GET,
                "/api/agent/workflows?projectId=project_api",
                None,
            )
            .await;
        assert_eq!(status, 200);
        let standard = workflows["workflows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|workflow| workflow["id"] == "workflow_native_standard")
            .unwrap();
        assert_eq!(standard["permittedForAgentTaskCreation"], true);
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    "/api/agent/templates?projectId=project_api",
                    None
                )
                .await,
            (200, json!({"templates": []}))
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    "/api/agent/workflows?projectId=project_api_2",
                    None
                )
                .await,
            (404, json!({"error": "Not found", "code": "not_found"}))
        );
        let (status, invalid) = agent
            .call(
                reqwest::Method::GET,
                "/api/agent/workflows?projectId=project_api&extra=1",
                None,
            )
            .await;
        assert_eq!(
            (status, invalid["code"].as_str()),
            (400, Some("request_invalid"))
        );
    }

    #[tokio::test]
    async fn creation_is_idempotent_scoped_and_validated_and_dry_runs_write_nothing() {
        let agent = agent().await;
        let (status, preview) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Dry", "idempotencyKey": "dry-run-0001", "dryRun": true}))).await;
        assert_eq!(status, 200, "{preview}");
        assert_eq!(
            (
                preview["dryRun"].as_bool(),
                preview["wouldStart"].as_str(),
                preview["workflow"]["id"].as_str()
            ),
            (
                Some(true),
                Some("backlog"),
                Some("workflow_native_standard")
            )
        );
        let count = || {
            agent.server.state.with_database(|database| {
                database
                    .connection()
                    .query_row("SELECT COUNT(*) FROM suplex_tasks", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap()
            })
        };
        assert_eq!(count(), 0);
        let task = agent.create("Build the thing", "create-001").await;
        assert_eq!(
            (
                task["status"].as_str(),
                task["permittedCommands"][0].as_str(),
                task["workflowStage"].as_str()
            ),
            (Some("backlog"), Some("start_task"), Some("backlog"))
        );
        assert_eq!(task["integration"]["observation"], "observed");
        assert!(task["actionRequired"].is_null());
        let creator: Option<String> = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT creator_agent_id FROM suplex_tasks WHERE id = ?1",
                    [task["id"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!(creator.as_deref(), Some(agent.agent_id.as_str()));
        let (status, replay) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Build the thing", "idempotencyKey": "create-001"}))).await;
        assert_eq!((status, replay["id"].clone()), (200, task["id"].clone()));
        let (status, dry_replay) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Build the thing", "idempotencyKey": "create-001", "dryRun": true}))).await;
        assert_eq!(
            (status, dry_replay),
            (
                200,
                json!({"dryRun": true, "status": 200, "existingTaskId": task["id"]})
            )
        );
        let (status, conflict) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Different", "idempotencyKey": "create-001"}))).await;
        assert_eq!(
            (status, conflict["code"].as_str()),
            (409, Some("idempotency_conflict"))
        );
        let (status, unknown) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00002", "surprise": true}))).await;
        assert_eq!(
            (status, unknown),
            (
                400,
                json!({"error": "Invalid request", "code": "request_invalid"})
            )
        );
        let (status, ignored) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Authority", "idempotencyKey": "key-00003", "companyId": "company_other", "agentId": "agent_other"}))).await;
        assert_eq!(status, 201, "{ignored}");
        let (status, missing) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api_2", "title": "T", "idempotencyKey": "key-00004"}))).await;
        assert_eq!(
            (status, missing),
            (
                422,
                json!({"error": "The project is not available.", "code": "project_not_found", "field": "projectId", "value": "project_api_2", "reason": "The project is not available."})
            )
        );
        let (status, policy) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00005", "deliveryTarget": "merged"}))).await;
        assert_eq!(
            (status, policy["code"].as_str()),
            (422, Some("delivery_policy_rejected"))
        );
        let (status, workflow) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00006", "workflowId": "missing"}))).await;
        assert_eq!(
            (
                status,
                workflow["code"].as_str(),
                workflow["permittedWorkflowIds"].clone()
            ),
            (
                422,
                Some("workflow_not_found"),
                json!(["workflow_native_standard"])
            )
        );
        let (status, profile) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00007", "rootProfileId": "profile_missing"}))).await;
        assert_eq!(
            (status, profile["code"].as_str(), profile["field"].as_str()),
            (422, Some("root_profile_not_found"), Some("rootProfileId"))
        );
        let (status, invalid) = agent
            .call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(json!({"projectId": "", "title": "T", "idempotencyKey": "k"})),
            )
            .await;
        assert_eq!(
            (
                status,
                invalid["code"].as_str(),
                invalid["findings"][0]["field"].as_str()
            ),
            (400, Some("request_invalid"), Some(".projectId"))
        );
    }

    #[tokio::test]
    async fn reads_poll_conditionally_page_by_cursor_and_keep_commands_creator_only() {
        let agent = agent().await;
        let first = agent.create("First", "read-001").await;
        agent.create("Second", "read-002").await;
        agent.create("Third", "read-003").await;
        let (other_credential, _) = pair(&agent.server, "Other agent", &["project_api"]);
        let (status, _) = agent
            .call_as(
                &other_credential,
                reqwest::Method::GET,
                &format!("/api/agent/tasks/{}", first["id"].as_str().unwrap()),
                None,
            )
            .await;
        assert_eq!(status, 200);
        let (_, foreign) = agent
            .call_as(
                &other_credential,
                reqwest::Method::GET,
                &format!("/api/agent/tasks/{}", first["id"].as_str().unwrap()),
                None,
            )
            .await;
        assert_eq!(foreign["permittedCommands"], json!([]));
        let (outside, _) = pair(&agent.server, "Outside agent", &["project_api_2"]);
        assert_eq!(
            agent
                .call_as(
                    &outside,
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks/{}", first["id"].as_str().unwrap()),
                    None
                )
                .await,
            (
                404,
                json!({"error": "Not found", "code": "resource_not_found"})
            )
        );
        assert_eq!(
            agent
                .call(reqwest::Method::GET, "/api/agent/tasks/task_missing", None)
                .await,
            (
                404,
                json!({"error": "Not found", "code": "resource_not_found"})
            )
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks/{}", "x".repeat(101)),
                    None
                )
                .await,
            (404, json!({"error": "Not found"}))
        );

        let path = format!("/api/agent/tasks/{}", first["id"].as_str().unwrap());
        let bearer = format!("Bearer {}", agent.credential);
        let etag = format!("\"{}\"", first["revision"].as_str().unwrap());
        let unchanged = agent
            .server
            .request(
                reqwest::Method::GET,
                &path,
                &[
                    ("authorization", bearer.as_str()),
                    ("if-none-match", etag.as_str()),
                ],
                None,
            )
            .await;
        assert_eq!(unchanged.status(), 304);
        assert_eq!(unchanged.headers()["etag"], etag.as_str());
        let stale = agent
            .server
            .request(
                reqwest::Method::GET,
                &path,
                &[("authorization", bearer.as_str()), ("if-match", "\"old\"")],
                None,
            )
            .await;
        assert_eq!(stale.status(), 412);

        let (status, page) = agent
            .call(reqwest::Method::GET, "/api/agent/tasks?limit=2", None)
            .await;
        assert_eq!(status, 200);
        assert_eq!(page["tasks"].as_array().unwrap().len(), 2);
        assert!(page["tasks"][0]["integration"].is_object());
        let cursor = page["nextCursor"].as_str().unwrap().to_owned();
        let encoded = url::form_urlencoded::byte_serialize(cursor.as_bytes()).collect::<String>();
        let (_, next) = agent
            .call(
                reqwest::Method::GET,
                &format!("/api/agent/tasks?limit=2&cursor={encoded}"),
                None,
            )
            .await;
        assert_eq!(
            (
                next["tasks"].as_array().unwrap().len(),
                next["nextCursor"].clone()
            ),
            (1, Value::Null)
        );
        assert_eq!(
            agent
                .call_as(
                    &other_credential,
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks?limit=2&cursor={encoded}"),
                    None
                )
                .await
                .1["code"],
            "cursor_invalid"
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks?limit=2&status=active&cursor={encoded}"),
                    None
                )
                .await
                .0,
            400
        );
        let (_, summary) = agent
            .call(
                reqwest::Method::GET,
                "/api/agent/tasks?view=summary&titleContains=secon",
                None,
            )
            .await;
        assert_eq!(summary["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(
            summary["tasks"][0]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            [
                "id",
                "title",
                "status",
                "archived",
                "workflow",
                "dependsOn",
                "updatedAt"
            ]
        );
        let (status, invalid) = agent
            .call(reqwest::Method::GET, "/api/agent/tasks?limit=0", None)
            .await;
        assert_eq!((status, invalid.get("code").is_none()), (400, true));
    }

    #[tokio::test]
    async fn lifecycle_commands_use_revisions_receipts_note_attribution_and_duplicate_provenance() {
        let agent = agent().await;
        let task = agent.create("Command target", "command-001").await;
        let id = task["id"].as_str().unwrap().to_owned();
        let path = format!("/api/agent/tasks/{id}/commands");
        let command = |body: Value| agent.call(reqwest::Method::POST, &path, Some(body));
        let (status, started) = command(json!({"command": "start_task", "revision": task["revision"], "idempotencyKey": "start-001"})).await;
        assert_eq!(
            (status, started["status"].as_str()),
            (200, Some("active")),
            "{started}"
        );
        assert_eq!(command(json!({"command": "start_task", "revision": task["revision"], "idempotencyKey": "start-001"})).await, (200, started.clone()));
        let (status, stale) = command(json!({"command": "cancel_task", "revision": task["revision"], "idempotencyKey": "stale-001"})).await;
        assert_eq!(
            (status, stale["code"].as_str()),
            (412, Some("revision_stale"))
        );
        let (status, illegal) = command(json!({"command": "start_task", "revision": started["revision"], "idempotencyKey": "illegal-001"})).await;
        assert_eq!(
            (status, illegal["code"].as_str()),
            (409, Some("illegal_command"))
        );
        let (status, noted) = command(json!({"command": "send_task_note", "revision": started["revision"], "idempotencyKey": "note-001", "note": "Machine progress note"})).await;
        assert_eq!(status, 200, "{noted}");
        let prompt: String = agent.server.state.with_database(|database| database.connection().query_row("SELECT prompt_text FROM suplex_task_turns WHERE task_id = ?1 AND prompt_text LIKE '%Machine progress%'", [&id], |row| row.get(0)).unwrap());
        assert_eq!(
            prompt,
            format!("Agent note ({}):\nMachine progress note", agent.agent_id)
        );
        let (status, duplicate) = command(json!({"command": "duplicate_task", "revision": noted["revision"], "idempotencyKey": "duplicate-001"})).await;
        assert_eq!(
            (
                status,
                duplicate["status"].as_str(),
                duplicate["title"].as_str()
            ),
            (200, Some("backlog"), Some("Command target (2)")),
            "{duplicate}"
        );
        let copied: Option<String> = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT copied_from_task_id FROM suplex_tasks WHERE id = ?1",
                    [duplicate["id"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!(copied.as_deref(), Some(id.as_str()));
        let (_, current) = agent
            .call(
                reqwest::Method::GET,
                &format!("/api/agent/tasks/{id}"),
                None,
            )
            .await;
        let (status, cancelled) = command(json!({"command": "cancel_task", "revision": current["revision"], "idempotencyKey": "cancel-001"})).await;
        assert_eq!(
            (status, cancelled["status"].as_str()),
            (200, Some("cancelled")),
            "{cancelled}"
        );
        let (status, archived) = command(json!({"command": "archive_task", "revision": cancelled["revision"], "idempotencyKey": "archive-001"})).await;
        assert_eq!(
            (status, archived["archived"].as_bool()),
            (200, Some(true)),
            "{archived}"
        );
        let (status, reopened) = command(json!({"command": "unarchive_task", "revision": archived["revision"], "idempotencyKey": "unarchive-001"})).await;
        assert_eq!(
            (status, reopened["archived"].as_bool()),
            (200, Some(false)),
            "{reopened}"
        );
        let audits: i64 = agent.server.state.with_database(|database| database.connection().query_row("SELECT COUNT(*) FROM suplex_audit_events WHERE actor_agent_id = ?1 AND action IN ('task_started', 'task_note_added', 'task_duplicated', 'task_cancelled', 'task_archived', 'task_unarchived')", [&agent.agent_id], |row| row.get(0)).unwrap());
        assert_eq!(audits, 6);
        let (other, _) = pair(&agent.server, "Other commander", &["project_api"]);
        let (status, denied) = agent.call_as(&other, reqwest::Method::POST, &format!("/api/agent/tasks/{id}/commands"), Some(json!({"command": "archive_task", "revision": reopened["revision"], "idempotencyKey": "other-001"}))).await;
        assert_eq!((status, denied["code"].as_str()), (404, Some("not_found")));
    }

    #[tokio::test]
    async fn dependencies_are_replaced_previewed_and_reject_cycles_and_foreign_tasks() {
        let agent = agent().await;
        let upstream = agent.create("Upstream", "dependency-001").await;
        let downstream = agent.create("Downstream", "dependency-002").await;
        let (up, down) = (
            upstream["id"].as_str().unwrap(),
            downstream["id"].as_str().unwrap(),
        );
        let (status, preview) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": [up], "dryRun": true})),
            )
            .await;
        assert_eq!(
            (status, preview),
            (
                200,
                json!({"dryRun": true, "dependsOn": [up], "wouldStart": "backlog", "blockingPrerequisiteIds": []})
            )
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks/{down}"),
                    None
                )
                .await
                .1["dependsOn"],
            json!([])
        );
        let (status, set) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": [up]})),
            )
            .await;
        assert_eq!(
            (
                status,
                set["dependsOn"].clone(),
                set["blockedBy"][0]["id"].as_str()
            ),
            (200, json!([up]), Some(up)),
            "{set}"
        );
        let (status, cycle) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{up}/dependencies"),
                Some(json!({"dependsOn": [down]})),
            )
            .await;
        assert_eq!(
            (status, cycle["error"].as_str()),
            (422, Some("The dependency creates a cycle"))
        );
        let (status, missing) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": ["task_missing"]})),
            )
            .await;
        assert_eq!(
            (status, missing["code"].as_str(), missing["value"].as_str()),
            (422, Some("dependency_not_found"), Some("task_missing"))
        );
        let (status, strict) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": [], "extra": 1})),
            )
            .await;
        assert_eq!(
            (status, strict["code"].as_str()),
            (400, Some("request_invalid"))
        );
    }
}
