//! Read-only task details backed by saved intent and native observations.

use crate::http::error::ApiError;

use crate::http::access::authorize;
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use serde_json::{Value, json};
use tower_http::compression::CompressionLayer;

use crate::{
    coordination::{
        advisor_bridge::AdvisorRole,
        root_session_store::{self, RootObservationRows},
        workflows,
    },
    http::{
        AppState,
        contracts::{
            task_reads::{
                TaskActivityResponse, TaskActivitySession, TaskActivityTurn, TaskDiffResponse,
                TaskDiffSummaryResponse, TaskExecutionReasoning, TaskExecutionResponse,
                TaskExecutionSession, TaskExecutionTool, TaskToolStatus, TaskWorkerAssignment,
                WorkerAssignmentMode, WorkerAssignmentPurpose,
            },
            typed::tasks::TaskIdParams,
        },
        validation::ValidPath,
    },
    integrations::github::Access,
    platform::database::SuplexDatabase,
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::control::SessionRow,
    tasks::worktree,
    terminals::{self, host::HostTerminals},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tasks/{task_id}/activity",
            get(activity).layer(CompressionLayer::new()),
        )
        .route("/api/tasks/{task_id}/execution", get(execution))
        .route("/api/tasks/{task_id}/diff", get(diff))
        .route("/api/tasks/{task_id}/diff/summary", get(diff_summary))
        .route("/api/tasks/{task_id}/checks", get(checks))
}

/// Live check runs of the task's pull request.
async fn checks(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let intent = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        let (rows, _) = read_task(database, &user_id, &task_id)?;
        let configuration = &rows.context["configuration"];
        Ok(rows
            .control
            .pull_request
            .as_ref()
            .map(|pull| pull.number)
            .map(|number| {
                (
                    number,
                    configuration["repository"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                    configuration["branch"].as_str().unwrap_or("").to_owned(),
                )
            }))
    });
    let intent = intent.map_err(|error| error.to_string());
    let (number, repository, branch) = match intent {
        Ok(Some(intent)) => intent,
        Ok(None) => return respond(Ok(json!({"available":false,"runs":[]})), cookies),
        Err(error) => return respond::<Value>(Err(error.into()), cookies),
    };
    // Check observations use GitHub for every repository connection.
    let observed = async {
        let github = crate::integrations::github_delivery::Github::load().await?;
        github
            .observe_pull_request(&repository, &branch, Some(number))
            .await
    };
    let observation = match observed.await {
        Ok(observation) => observation,
        Err(error) => return respond::<Value>(Err(Box::new(error)), cookies),
    };
    let pull_request_state = match observation.state.as_deref() {
        Some("open") if observation.is_draft == Some(false) => json!("ready"),
        Some("open") => json!("draft"),
        other => json!(other),
    };
    let value = json!({"available": observation.exists, "runs": observation.checks.runs, "pullRequestState": pull_request_state});
    let scope = state.with_database(|database| read_task(database, &user_id, &task_id));
    respond(scope.map(|_| value), cookies)
}

fn read_task(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<(RootObservationRows, PathBuf), Box<dyn Error>> {
    crate::tasks::authorize_task(database, user_id, task_id)?;
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let database_path = PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Task database has no file path")?,
    );
    Ok((rows, database_path))
}

fn respond<T: Serialize>(result: Result<T, Box<dyn Error>>, cookies: Vec<String>) -> Response {
    let mut response = match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn role_label(session: &SessionRow) -> &'static str {
    workflows::role_label(
        session.kind.as_str(),
        session.advisor_role.map(AdvisorRole::as_str),
    )
}

/// Only the delegating turn stores its own input; continuation turns carry none.
fn worker_assignment(input: Option<&Value>) -> Option<TaskWorkerAssignment> {
    let input = input.filter(|input| input["kind"] == "worker")?;
    serde_json::from_value(input.clone()).ok()
}

/// Older Standard implementations stored no input, so their saved Worker
/// prompt is the only record. Those are always planned implementations with
/// this fixed section order; split from the end because a plan can hold any text.
fn legacy_worker_assignment(prompt: &str) -> Option<TaskWorkerAssignment> {
    let (_, rest) = prompt.split_once("\n\nAssignment:\nCoordinator plan:\n")?;
    let (rest, _) = rest.rsplit_once("\n\nScreenshots:\n")?;
    let (rest, instruction) = rest.rsplit_once("\n\nWorker instructions:\n")?;
    let (plan, criteria) = rest.rsplit_once("\n\nAcceptance criteria:\n")?;
    let mut acceptance_criteria = Vec::new();
    let mut remaining = criteria;
    for number in 1.. {
        let Some(item) = remaining.strip_prefix(&format!("{number}. ")) else {
            break;
        };
        let next = format!("\n{}. ", number + 1);
        // Keep the newline so the next item starts with its number.
        let (criterion, tail) = match item.split_once(&next) {
            Some((head, _)) => (head, &item[head.len() + 1..]),
            None => (item, ""),
        };
        acceptance_criteria.push(criterion.to_owned());
        remaining = tail;
    }
    Some(TaskWorkerAssignment {
        mode: WorkerAssignmentMode::Planned,
        purpose: WorkerAssignmentPurpose::Implementation,
        plan: Some(plan.to_owned()),
        acceptance_criteria,
        instruction: instruction.to_owned(),
    })
}

/// A paired agent's note starts with `Agent note (<agentId>):`. A deleted
/// agent has no name.
fn note_agent_name(database: &SuplexDatabase, prompt: &str) -> Option<String> {
    let (agent_id, _) = prompt.strip_prefix("Agent note (")?.split_once("):\n")?;
    database
        .connection()
        .query_row(
            "SELECT name FROM suplex_agents WHERE id = ?1",
            [agent_id],
            |row| row.get(0),
        )
        .ok()
}

/// `host` derives terminal ids for host terminals instead of stored Herdr panes.
pub(crate) fn activity_document(
    database: &SuplexDatabase,
    rows: &RootObservationRows,
    task_id: &str,
    host: Option<&HostTerminals>,
) -> TaskActivityResponse {
    let sessions = rows
        .sessions
        .iter()
        .map(|session| {
            let profile = rows.profile_of(session);
            TaskActivitySession {
                id: session.id.clone(),
                kind: session.kind,
                advisor_role: session.advisor_role,
                label: role_label(session).into(),
                profile_id: profile.profile_id.clone(),
                generation: session.generation,
                native_session_id: session.native_session_id.clone(),
                pane_id: terminals::session_pane(host.is_some(), session, profile.provider),
                current: session.current,
                replacement: session.replacement.clone(),
                harness: profile.provider,
            }
        })
        .collect::<Vec<_>>();
    let turns = rows
        .turns
        .iter()
        .map(|turn| TaskActivityTurn {
            id: turn.id.clone(),
            session_id: turn.session_id.clone(),
            prompt: turn.prompt_text.clone(),
            status: turn.status,
            prompted_at: turn.prompted_at.clone(),
            completed_at: turn.completed_at.clone(),
            result: turn.terminal_observation.clone(),
            assignment: match &turn.workflow_input {
                None if rows
                    .session(&turn.session_id)
                    .is_some_and(SessionRow::is_plain_worker) =>
                {
                    legacy_worker_assignment(&turn.prompt_text)
                }
                input => worker_assignment(input.as_ref()),
            },
            note_agent_name: note_agent_name(database, &turn.prompt_text),
        })
        .collect::<Vec<_>>();
    TaskActivityResponse {
        sessions,
        turns,
        shell_pane_id: terminals::shell_pane(
            host,
            task_id,
            rows.control.worktree_path(),
            rows.control.shell_pane_id.as_ref(),
        ),
    }
}

pub(crate) fn execution_document(
    rows: &RootObservationRows,
    database_path: &std::path::Path,
) -> Result<TaskExecutionResponse, Box<dyn Error>> {
    let sessions = rows
        .sessions
        .iter()
        .filter(|session| session.native_session_id.is_some())
        .map(|session| -> Result<TaskExecutionSession, Box<dyn Error>> {
            let profile = rows.profile_of(session);
            let observed = session
                .native_session_id
                .as_deref()
                .and_then(|native_session_id| {
                    let reader = task_harness_registry::native_session_reader(native_session_id)?;
                    let session = ReaderSession {
                        database_path,
                        session_id: &session.id,
                        native_session_id,
                        instance_home_directory: profile
                            .instance_home_directory()
                            .map(std::path::Path::new),
                    };
                    // ponytail: read native logs twice; combine observations if Activity polling becomes costly.
                    reader.execution(&session).ok().map(|execution| {
                        (execution, reader.reasoning(&session).unwrap_or_default())
                    })
                });
            let available = observed.is_some();
            let (tools, plan, reasoning) = match observed {
                Some(((tools, plan), reasoning)) => {
                    let tools = tools
                        .into_iter()
                        .map(|tool| {
                            Ok(TaskExecutionTool {
                                id: tool.id,
                                name: tool.name,
                                status: TaskToolStatus::parse(tool.status)
                                    .ok_or("Native tool status is invalid")?,
                                input: Value::Object(tool.input),
                                output: tool.output,
                                error: tool.error,
                            })
                        })
                        .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
                    (
                        tools,
                        serde_json::from_value(plan)?,
                        reasoning
                            .into_iter()
                            .map(|part| TaskExecutionReasoning {
                                id: part.id,
                                text: part.text,
                            })
                            .collect(),
                    )
                }
                None => (Vec::new(), None, Vec::new()),
            };
            Ok(TaskExecutionSession {
                id: session.id.clone(),
                role: session.kind,
                advisor_role: session.advisor_role,
                label: role_label(session).into(),
                generation: session.generation,
                available,
                limited: false,
                tools,
                reasoning,
                plan,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TaskExecutionResponse { sessions })
}

async fn activity(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<TaskActivityResponse, Box<dyn Error>> {
        let (rows, _) = read_task(database, &user_id, &task_id)?;
        Ok(activity_document(
            database,
            &rows,
            &task_id,
            terminals::host_enabled(database).then_some(&*state.host_terminals),
        ))
    });
    respond(result, cookies)
}

async fn execution(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (rows, database_path) =
        match state.with_database(|database| read_task(database, &user_id, &task_id)) {
            Ok(value) => value,
            Err(error) => return respond::<Value>(Err(error), cookies),
        };
    let observation = match tokio::task::spawn_blocking(move || {
        execution_document(&rows, &database_path).map_err(|error| error.to_string())
    })
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return respond::<Value>(Err(error.into()), cookies),
        Err(error) => return respond::<Value>(Err(Box::new(error)), cookies),
    };
    // Native files can change during observation; refresh user scope after it.
    let scope = state.with_database(|database| read_task(database, &user_id, &task_id));
    respond(scope.map(|_| observation), cookies)
}

async fn diff_summary(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
) -> Response {
    diff_summary_with_access(state, task_id, headers, None).await
}

async fn diff(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
) -> Response {
    read_diff(state, task_id, headers, None, DiffKind::Patch).await
}

#[derive(Clone, Copy)]
enum DiffKind {
    Patch,
    Summary,
}

#[derive(Serialize)]
#[serde(untagged)]
enum DiffResponse {
    Patch(TaskDiffResponse),
    Summary(TaskDiffSummaryResponse),
}

async fn diff_summary_with_access(
    state: AppState,
    task_id: String,
    headers: HeaderMap,
    access_override: Option<Access>,
) -> Response {
    read_diff(state, task_id, headers, access_override, DiffKind::Summary).await
}

async fn read_diff(
    state: AppState,
    task_id: String,
    headers: HeaderMap,
    access_override: Option<Access>,
    kind: DiffKind,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    enum DiffIntent {
        NoWorktree,
        Local {
            path: PathBuf,
            repository: String,
            base_branch: String,
            pull_request: Option<u64>,
        },
    }
    let intent = match state.with_database(|database| -> Result<DiffIntent, Box<dyn Error>> {
        let (rows, _) = read_task(database, &user_id, &task_id)?;
        let Some(path) = rows.control.worktree_path() else {
            return Ok(DiffIntent::NoWorktree);
        };
        let configuration = &rows.context["configuration"];
        // A pull request diff uses its current base branch.
        let pull_request = rows
            .control
            .pull_request
            .as_ref()
            .map(|pull| pull.number)
            .or_else(|| {
                (configuration["source"]["kind"] == "pull_request")
                    .then(|| configuration["source"]["number"].as_u64())
                    .flatten()
            });
        let repository = configuration["repository"]
            .as_str()
            .ok_or("Task repository is missing")?;
        let base_branch = configuration["baseBranch"]
            .as_str()
            .ok_or("Task base branch is missing")?;
        Ok(DiffIntent::Local {
            path: PathBuf::from(path),
            repository: repository.to_owned(),
            base_branch: base_branch.to_owned(),
            pull_request,
        })
    }) {
        Ok(intent) => intent,
        Err(error) => return respond::<Value>(Err(error), cookies),
    };
    let (path, repository, mut base_branch, pull_request) = match intent {
        DiffIntent::NoWorktree => {
            let value = match kind {
                DiffKind::Patch => DiffResponse::Patch(TaskDiffResponse {
                    available: false,
                    patch: String::new(),
                    truncated: false,
                }),
                DiffKind::Summary => DiffResponse::Summary(TaskDiffSummaryResponse {
                    available: false,
                    files: 0,
                }),
            };
            return respond(Ok(value), cookies);
        }
        DiffIntent::Local {
            path,
            repository,
            base_branch,
            pull_request,
        } => (path, repository, base_branch, pull_request),
    };
    if let Some(number) = pull_request {
        let pull = async {
            let github = crate::integrations::github_delivery::Github::load().await?;
            github.get_pull_request(&repository, number).await
        };
        match pull.await {
            Ok(pull) => base_branch = pull.base_branch,
            Err(error) => return respond::<Value>(Err(Box::new(error)), cookies),
        }
    }
    let access_result = match access_override {
        Some(access) => Ok(access),
        None => Access::load().await,
    };
    let access = match access_result {
        Ok(access) => access,
        Err(error) => return respond::<Value>(Err(error), cookies),
    };
    let published_sha = match access.published_branch_sha(&repository, &base_branch).await {
        Ok(sha) => sha,
        Err(error) => return respond::<Value>(Err(error), cookies),
    };
    let token = access.token().map(str::to_owned);
    let observed = tokio::task::spawn_blocking(move || {
        let result = match kind {
            DiffKind::Patch => worktree::local_diff_patch(&path, published_sha, token.as_deref())
                .map(|patch| {
                    DiffResponse::Patch(TaskDiffResponse {
                        available: true,
                        patch,
                        truncated: false,
                    })
                }),
            DiffKind::Summary => {
                worktree::local_diff_file_count(&path, published_sha, token.as_deref()).map(
                    |files| {
                        DiffResponse::Summary(TaskDiffSummaryResponse {
                            available: true,
                            files,
                        })
                    },
                )
            }
        };
        result.map_err(|error| error.to_string())
    })
    .await;
    let value = match observed {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return respond::<Value>(Err(error.into()), cookies),
        Err(error) => return respond::<Value>(Err(Box::new(error)), cookies),
    };
    let scope = state.with_database(|database| read_task(database, &user_id, &task_id));
    respond(scope.map(|_| value), cookies)
}

#[cfg(test)]
include!("../../../tests/routes/task_reads.rs");
