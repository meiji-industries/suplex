//! Read-only task details backed by saved intent and native observations.

use crate::tasks::TaskError;
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::{
    coordination::root_session_store::{self, RootObservationRows},
    http::{
        AppState,
        contracts::typed::{self, tasks as task_contracts},
        session, validation,
    },
    identity::companies,
    integrations::github::Access,
    platform::database::SuplexDatabase,
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::worktree,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/activity", get(activity))
        .route("/api/tasks/{task_id}/execution", get(execution))
        .route("/api/tasks/{task_id}/diff", get(diff))
        .route("/api/tasks/{task_id}/diff/summary", get(diff_summary))
        .route("/api/tasks/{task_id}/checks", get(checks))
}

/// TypeScript `readTaskChecks`: live check runs of the task's pull request.
async fn checks(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let intent = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        let (rows, _) = read_task(database, &user_id, &task_id)?;
        let configuration = &rows.context["configuration"];
        Ok(rows.control["pullRequest"]["number"]
            .as_u64()
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
        Err(error) => return respond(Err(error.into()), cookies),
    };
    // TypeScript `readTaskChecks` reads GitHub for every repository connection.
    let observed = async {
        let github = crate::integrations::github_delivery::Github::load().await?;
        github
            .observe_pull_request(&repository, &branch, Some(number))
            .await
    };
    let observation = match observed.await {
        Ok(observation) => observation,
        Err(error) => return respond(Err(Box::new(error)), cookies),
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

fn validated_task_id(id: &str) -> Result<(), Box<Response>> {
    match task_contracts::parse_task_id_params(Some(&json!({"taskId": id}))) {
        Ok(_) => Ok(()),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(validation::validation_error_public(findings)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, Vec<String>), Box<Response>> {
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(auth::service_error)
        .map_err(Box::new)?;
    match session.user {
        Some(user) => Ok((user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn read_task(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<(RootObservationRows, PathBuf), Box<dyn Error>> {
    let company_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    let company_id = company_id.ok_or_else(TaskError::not_found)?;
    companies::require_company_access(database, user_id, &company_id)?;
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let database_path = PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Task database has no file path")?,
    );
    Ok((rows, database_path))
}

fn respond(result: Result<Value, Box<dyn Error>>, cookies: Vec<String>) -> Response {
    let mut response = match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        Err(error) => auth::service_error(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn role_label(session: &Value) -> &'static str {
    if session["kind"] == "root" {
        "Coordinator"
    } else {
        match session["advisorRole"].as_str() {
            Some("reviewer") => "Reviewer",
            Some("planner_a") => "Plan A",
            Some("planner_b") => "Plan B",
            Some("rater") => "Rater",
            _ => "Worker",
        }
    }
}

fn session_profile<'a>(rows: &'a RootObservationRows, session: &'a Value) -> &'a Value {
    if !session["profile"].is_null() {
        return &session["profile"];
    }
    if session["kind"] == "root" {
        &rows.control["rootProfile"]
    } else if let Some(role) = session["advisorRole"].as_str() {
        rows.control["advisorProfiles"]
            .get(role)
            .unwrap_or(&rows.control["rootProfile"])
    } else {
        &rows.control["workerProfile"]
    }
}

fn activity_document(rows: &RootObservationRows) -> Value {
    let sessions = rows
        .sessions
        .iter()
        .map(|session| {
            let profile = session_profile(rows, session);
            let mut entry = json!({
                "id":session["id"], "kind":session["kind"],
                "advisorRole":session["advisorRole"], "label":role_label(session),
                "profileId":profile["profileId"], "generation":session["generation"],
                "nativeSessionId":session["nativeSessionId"], "paneId":session["paneId"],
                "current":session["current"], "replacement":session["replacement"],
            });
            if let Some(provider) = profile.get("provider") {
                entry["harness"] = provider.clone();
            }
            entry
        })
        .collect::<Vec<_>>();
    let turns = rows
        .turns
        .iter()
        .map(|turn| {
            json!({
                "id":turn["id"], "sessionId":turn["sessionId"],
                "prompt":turn["promptText"], "status":turn["status"],
                "promptedAt":turn["promptedAt"], "completedAt":turn["completedAt"],
                "result":turn["terminalObservation"],
            })
        })
        .collect::<Vec<_>>();
    json!({
        "sessions":sessions, "turns":turns,
        "shellPaneId":rows.control["shellPaneId"],
    })
}

fn execution_document(rows: &RootObservationRows, database_path: &std::path::Path) -> Value {
    let sessions = rows
        .sessions
        .iter()
        .filter(|session| !session["nativeSessionId"].is_null())
        .map(|session| {
            let mut entry = json!({
                "id":session["id"], "role":session["kind"],
                "advisorRole":session["advisorRole"], "label":role_label(session),
                "generation":session["generation"],
            });
            let profile = session_profile(rows, session);
            let observed = session["nativeSessionId"]
                .as_str()
                .and_then(|native_session_id| {
                    let reader = task_harness_registry::native_session_reader(native_session_id)?;
                    let session = ReaderSession {
                        database_path,
                        session_id: session["id"].as_str()?,
                        native_session_id,
                        instance_home_directory: profile["instanceHomeDirectory"]
                            .as_str()
                            .map(std::path::Path::new),
                    };
                    reader.execution(&session).ok()
                });
            match observed {
                Some((tools, plan)) => {
                    entry["available"] = json!(true);
                    entry["limited"] = json!(false);
                    entry["tools"] = json!(tools);
                    entry["plan"] = plan;
                }
                None => {
                    entry["available"] = json!(false);
                    entry["limited"] = json!(false);
                    entry["tools"] = json!([]);
                    entry["plan"] = Value::Null;
                }
            }
            entry
        })
        .collect::<Vec<_>>();
    json!({"sessions":sessions})
}

async fn activity(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<Value, Box<dyn Error>> {
        let (rows, _) = read_task(database, &user_id, &task_id)?;
        Ok(activity_document(&rows))
    });
    respond(result, cookies)
}

async fn execution(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (rows, database_path) =
        match state.with_database(|database| read_task(database, &user_id, &task_id)) {
            Ok(value) => value,
            Err(error) => return respond(Err(error), cookies),
        };
    let observation = match tokio::task::spawn_blocking(move || {
        execution_document(&rows, &database_path)
    })
    .await
    {
        Ok(value) => value,
        Err(error) => return respond(Err(Box::new(error)), cookies),
    };
    // Native files can change during observation; refresh user scope after it.
    let scope = state.with_database(|database| read_task(database, &user_id, &task_id));
    respond(scope.map(|_| observation), cookies)
}

async fn diff_summary(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    diff_summary_with_access(state, task_id, headers, None).await
}

async fn diff(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    read_diff(state, task_id, headers, None, DiffKind::Patch).await
}

#[derive(Clone, Copy)]
enum DiffKind {
    Patch,
    Summary,
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
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
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
        let Some(path) = rows.control["worktree"].get("path").and_then(Value::as_str) else {
            if rows.control["worktree"].is_null() {
                return Ok(DiffIntent::NoWorktree);
            }
            return Err("Task worktree path is invalid".into());
        };
        let configuration = &rows.context["configuration"];
        // TypeScript `resolveTaskDiffBase`: a pull request diff uses its current base branch.
        let pull_request = rows.control["pullRequest"]["number"].as_u64().or_else(|| {
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
        Err(error) => return respond(Err(error), cookies),
    };
    let (path, repository, mut base_branch, pull_request) = match intent {
        DiffIntent::NoWorktree => {
            let value = match kind {
                DiffKind::Patch => json!({"available":false,"patch":"","truncated":false}),
                DiffKind::Summary => json!({"available":false,"files":0}),
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
            Err(error) => return respond(Err(Box::new(error)), cookies),
        }
    }
    let access_result = match access_override {
        Some(access) => Ok(access),
        None => Access::load().await,
    };
    let access = match access_result {
        Ok(access) => access,
        Err(error) => return respond(Err(error), cookies),
    };
    let published_sha = match access.published_branch_sha(&repository, &base_branch).await {
        Ok(sha) => sha,
        Err(error) => return respond(Err(error), cookies),
    };
    let token = access.token().map(str::to_owned);
    let observed = tokio::task::spawn_blocking(move || {
        let result = match kind {
            DiffKind::Patch => worktree::local_diff_patch(&path, published_sha, token.as_deref())
                .map(|patch| json!({"available":true,"patch":patch,"truncated":false})),
            DiffKind::Summary => {
                worktree::local_diff_file_count(&path, published_sha, token.as_deref())
                    .map(|files| json!({"available":true,"files":files}))
            }
        };
        result.map_err(|error| error.to_string())
    })
    .await;
    let value = match observed {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return respond(Err(error.into()), cookies),
        Err(error) => return respond(Err(Box::new(error)), cookies),
    };
    let scope = state.with_database(|database| read_task(database, &user_id, &task_id));
    respond(scope.map(|_| value), cookies)
}

#[cfg(test)]
include!("../../../tests/routes/task_reads.rs");
