//! Task reads and local backlog creation. Native wake is connected separately.

use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::{
    http::{
        AppState,
        contracts::{
            self,
            typed::{self, task_answers, tasks as task_contracts},
        },
        session, validation,
    },
    identity::companies,
    projects::{
        repository as git,
        service::{self as projects, ProjectFailure},
    },
    tasks::{
        commands::{self, TaskFailure},
        repository::TaskConflict,
        response as task_response,
    },
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks", get(list_all))
        .route(
            "/api/companies/{company_id}/tasks",
            get(list_company).post(create),
        )
        .route("/api/tasks/{task_id}", get(get_one))
        .route(
            "/api/tasks/{task_id}/start",
            axum::routing::post(start_pending),
        )
        .route(
            "/api/tasks/{task_id}/cancel",
            axum::routing::post(cancel_pending),
        )
        .route(
            "/api/tasks/{task_id}/answer",
            axum::routing::post(answer_pending),
        )
}

fn validated_company_id(id: &str) -> Result<(), Box<Response>> {
    match contracts::validate(
        "common.CompanyIdParamsSchema",
        Some(&json!({"companyId": id})),
    ) {
        Some(Ok(_)) => Ok(()),
        Some(Err(issues)) => Err(Box::new(auth::validation_error(issues))),
        None => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
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

fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

fn service_error(source: Box<dyn Error>) -> Response {
    let source = match source.downcast::<TaskFailure>() {
        Ok(failure) => {
            return auth::error(
                StatusCode::from_u16(failure.status_code)
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                &failure.public_message,
            );
        }
        Err(source) => source,
    };
    let source = match source.downcast::<TaskConflict>() {
        Ok(failure) => return auth::error(StatusCode::CONFLICT, &failure.to_string()),
        Err(source) => source,
    };
    match source.downcast::<ProjectFailure>() {
        Ok(failure) => (
            StatusCode::from_u16(failure.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({"error":failure.message,"findings":failure.findings})),
        )
            .into_response(),
        Err(source) => auth::service_error(source),
    }
}

fn normalize_workflow(value: &mut Value) -> Result<(), Box<Response>> {
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    let selected = object.get("workflow").filter(|value| !value.is_null());
    let workflow = selected
        .and_then(Value::as_str)
        .unwrap_or("standard")
        .to_owned();
    if selected.is_some_and(|value| !value.is_string())
        || ![
            "standard",
            "direct_build",
            "independent_review",
            "competing_plans",
            "refine_pull_request",
        ]
        .contains(&workflow.as_str())
    {
        return Err(Box::new(auth::error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The selected workflow does not exist",
        )));
    }
    let advisors = object
        .get("advisorProfileIds")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let Some(ids) = advisors.as_object() else {
        return Err(Box::new(auth::error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The Advisor profile selection is not valid",
        )));
    };
    if ids.iter().any(|(name, id)| {
        !["reviewer", "planner_a", "planner_b", "rater"].contains(&name.as_str())
            || !id
                .as_str()
                .is_some_and(|value| (1..=256).contains(&value.encode_utf16().count()))
    }) {
        return Err(Box::new(auth::error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The Advisor profile selection is not valid",
        )));
    }
    let allowed: &[&str] = match workflow.as_str() {
        "independent_review" => &["reviewer"],
        "competing_plans" => &["planner_a", "planner_b"],
        "refine_pull_request" => &["rater"],
        _ => &[],
    };
    let extra = ["reviewer", "planner_a", "planner_b", "rater"]
        .into_iter()
        .filter(|role| ids.contains_key(*role) && !allowed.contains(role))
        .collect::<Vec<_>>();
    if !extra.is_empty() {
        let name = match workflow.as_str() {
            "standard" => "Standard",
            "direct_build" => "Direct build",
            "independent_review" => "Second opinion",
            "competing_plans" => "Combined planning",
            _ => "Pull request repair",
        };
        let labels = extra
            .iter()
            .map(|role| match *role {
                "reviewer" => "Reviewer",
                "planner_a" => "Plan A",
                "planner_b" => "Plan B",
                _ => "Rater",
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(Box::new(auth::error(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("The {name} workflow has no {labels} Advisor"),
        )));
    }
    object.insert("workflow".into(), json!(workflow));
    object.insert("advisorProfileIds".into(), advisors);
    if workflow == "refine_pull_request" {
        if object
            .get("deliveryTarget")
            .is_some_and(|value| value != "merged")
        {
            return Err(Box::new(auth::error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Pull request repair always delivers a merged pull request",
            )));
        }
        if object
            .get("runProjectTests")
            .is_some_and(|value| value != true)
        {
            return Err(Box::new(auth::error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Pull request repair always runs the project tests",
            )));
        }
        if object
            .get("source")
            .and_then(|value| value.get("kind"))
            .and_then(Value::as_str)
            != Some("pull_request")
        {
            return Err(Box::new(auth::error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Select a pull request source for Pull request repair",
            )));
        }
        object.insert("deliveryTarget".into(), json!("merged"));
        object.insert("runProjectTests".into(), json!(true));
    }
    Ok(())
}

fn archived_query(uri: &axum::http::Uri) -> Result<bool, Box<Response>> {
    let values = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .filter(|(name, _)| name == "archived")
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    match values.as_slice() {
        [] => Ok(false),
        [value] if value == "false" => Ok(false),
        [value] if value == "true" => Ok(true),
        _ => Err(Box::new(validation::validation_error_public(vec![
            json!({"code":"invalid-invalid_value","field":".archived","message":"Request value is invalid"}),
        ]))),
    }
}

async fn create(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_company_id(&company_id) {
        return *response;
    }
    let mut parsed = match auth::parsed_body(&headers, &body) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Some(value) = parsed.as_mut()
        && let Err(response) = normalize_workflow(value)
    {
        return *response;
    }
    let request = match task_contracts::parse_task_create(parsed.as_ref()) {
        Ok(value) => value,
        Err(typed::ContractFailure::Issues(findings)) => {
            return validation::validation_error_public(findings);
        }
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (project, existing) = {
        let admission = state.with_database(|database| -> Result<_, Box<dyn Error>> {
            let company = companies::require_company_access(database, &user_id, &company_id)?;
            if company.status != "active" {
                return Err(Box::new(TaskFailure {
                    public_message: "The company is not active".into(),
                    status_code: 409,
                    code: "task_failure",
                }));
            }
            let project = projects::get(database, &user_id, &request.project_id)?;
            if project.company_id != company_id {
                return Err(Box::new(TaskFailure {
                    public_message: "Not found".into(),
                    status_code: 404,
                    code: "task_failure",
                }));
            }
            let hash = commands::task_request_hash(&request, &user_id)?;
            if let Some(existing) = commands::existing_user_task(
                database,
                &company_id,
                &request.idempotency_key,
                &hash,
                &user_id,
            )? {
                return Ok((
                    None,
                    Some((
                        existing.status,
                        existing.id.clone(),
                        task_response::get(database, &existing.id)?
                            .ok_or("existing task disappeared")?,
                    )),
                ));
            }
            Ok((Some(project), None))
        });
        match admission {
            Ok(value) => value,
            Err(error) => return with_cookies(service_error(error), cookies),
        }
    };
    if let Some((status, id, snapshot)) = existing {
        if status == "active"
            && let Some(host) = &state.task_host
        {
            host.wake(id);
        }
        return with_cookies(Json(snapshot).into_response(), cookies);
    }
    let Some(project) = project else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    if request.workflow != "standard"
        || request.source.is_some()
        || request.issue.as_ref().is_some_and(|issue| issue.is_some())
        || !request.images.is_empty()
        || !request.blocked_by_pull_requests.is_empty()
        || request.delivery_target != "local_worktree"
    {
        return with_cookies(auth::not_ported(), cookies);
    }
    if project.repository.is_none() {
        return with_cookies(
            auth::error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Configure the project repository before creating a task",
            ),
            cookies,
        );
    }
    let profiles = {
        let selected = state.with_database(|database| {
            commands::select_local_profiles(database, &project, &request)
        });
        match selected {
            Ok(profiles) => profiles,
            Err(error) => return with_cookies(service_error(error), cookies),
        }
    };
    let operation = tokio::spawn(finish_admitted_create(
        state, company_id, user_id, cookies, project, request, profiles,
    ));
    match operation.await {
        Ok(response) => response,
        Err(_) => auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

/// Once authorization and policy admit creation, the Git fetch and database
/// transaction keep running even if the HTTP waiter goes away.
async fn finish_admitted_create(
    state: AppState,
    company_id: String,
    user_id: String,
    cookies: Vec<String>,
    project: projects::Project,
    request: task_contracts::TaskCreateBody,
    profiles: commands::LocalProfiles,
) -> Response {
    let repository_path = PathBuf::from(&project.repository_path);
    let base_branch = project.base_branch.clone();
    let host = match project
        .integration
        .as_ref()
        .map(|integration| &integration.repository)
    {
        Some(crate::http::contracts::typed::projects::RepositoryConnection::Bitbucket {
            ..
        }) => "bitbucket",
        _ => "github",
    }
    .to_owned();
    let captured = tokio::task::spawn_blocking(move || {
        git::capture_local_task_heads(&repository_path, &base_branch, &host)
    })
    .await;
    let base_sha = match captured {
        Ok(Ok(sha)) => sha,
        Ok(Err(findings)) => return with_cookies((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"Project configuration could not be captured","findings":findings})),
        ).into_response(), cookies),
        Err(_) => return with_cookies(auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"), cookies),
    };
    let now = Utc::now();
    let host = state.task_host.clone();
    let written = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        let prepared = commands::prepare_local_user_task(
            &company_id,
            &user_id,
            &project,
            &request,
            profiles,
            &base_sha,
            now,
        )?;
        let result =
            commands::create_user_task(database, &user_id, &project, &prepared, now, move |id| {
                if let Some(host) = host {
                    host.wake(id);
                }
            })?;
        let snapshot =
            task_response::get(database, &result.task.id)?.ok_or("created task disappeared")?;
        Ok((result.created, snapshot))
    });
    match written {
        Ok((created, snapshot)) => with_cookies(
            (
                if created {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                Json(snapshot),
            )
                .into_response(),
            cookies,
        ),
        Err(error) => with_cookies(service_error(error), cookies),
    }
}

fn list_for(
    state: AppState,
    headers: HeaderMap,
    company_id: Option<String>,
    archived: bool,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        let visible = companies::list_visible_companies(database, &user_id)?;
        if company_id.as_deref().is_some_and(|id| !visible.iter().any(|company| company.id == id)) {
            return Err(Box::new(TaskFailure { public_message: "Not found".into(), status_code: 404, code: "task_failure" }))
        }
        let mut statement = database.connection().prepare(
            "SELECT t.id, t.company_id FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE (t.archived_at IS NOT NULL) = ?1 ORDER BY julianday(CASE WHEN julianday(t.updated_at) >= julianday(c.updated_at) THEN t.updated_at ELSE c.updated_at END) DESC, t.id"
        )?;
        let rows = statement.query_map([archived], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut tasks = Vec::new();
        for (id, company) in rows {
            if visible.iter().any(|item| item.id == company)
                && company_id.as_deref().is_none_or(|wanted| wanted == company)
                && let Some(snapshot) = task_response::get(database, &id)?
            { tasks.push(snapshot) }
        }
        Ok(tasks)
    });
    match result {
        Ok(tasks) => with_cookies(Json(json!({"tasks": tasks})).into_response(), cookies),
        Err(error) => with_cookies(service_error(error), cookies),
    }
}

async fn list_all(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let archived = match archived_query(&uri) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    list_for(state, headers, None, archived)
}

async fn list_company(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_company_id(&company_id) {
        return *response;
    }
    let archived = match archived_query(&uri) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    list_for(state, headers, Some(company_id), archived)
}

async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        let company: Option<String> = database
            .connection()
            .query_row(
                "SELECT company_id FROM suplex_tasks WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        let company = company.ok_or_else(|| {
            Box::new(TaskFailure {
                public_message: "Not found".into(),
                status_code: 404,
                code: "task_failure",
            }) as Box<dyn Error>
        })?;
        companies::require_company_access(database, &user_id, &company)?;
        task_response::get(database, &id)?.ok_or_else(|| {
            Box::new(TaskFailure {
                public_message: "Not found".into(),
                status_code: 404,
                code: "task_failure",
            }) as Box<dyn Error>
        })
    });
    let mut response = match result {
        Ok(task) => Json(task).into_response(),
        Err(error) => service_error(error),
    };
    response
        .headers_mut()
        .insert("cache-control", "private, no-store".parse().unwrap());
    with_cookies(response, cookies)
}

async fn start_pending(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let access = state.with_database(|database| -> Result<(), Box<dyn Error>> {
        let company: Option<String> = database
            .connection()
            .query_row(
                "SELECT company_id FROM suplex_tasks WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        let company = company.ok_or_else(|| {
            Box::new(TaskFailure {
                public_message: "Not found".into(),
                status_code: 404,
                code: "task_failure",
            }) as Box<dyn Error>
        })?;
        companies::require_company_access(database, &user_id, &company)?;
        Ok(())
    });
    if let Err(error) = access {
        return with_cookies(service_error(error), cookies);
    }
    let host = state.task_host.clone();
    let started = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::start_user_task(database, &user_id, &id, Utc::now(), move |id| {
                if let Some(host) = host {
                    host.wake(id);
                }
            })?;
            task_response::get(database, &id)?.ok_or_else(|| "started task disappeared".into())
        },
    );
    match started {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(service_error(error), cookies),
    }
}

async fn cancel_pending(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let host = state.task_host.clone();
    let cancelled = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::cancel_user_task(database, &user_id, &id, Utc::now(), move |id| {
                if let Some(host) = host {
                    host.wake(id);
                }
            })?;
            task_response::get(database, &id)?.ok_or_else(|| "cancelled task disappeared".into())
        },
    );
    match cancelled {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(service_error(error), cookies),
    }
}

async fn answer_pending(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request = match auth::validated_typed_body(&headers, &body, task_answers::parse_task_answer)
    {
        Ok(request) => request,
        Err(response) => return *response,
    };
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let host = state.task_host.clone();
    let answered = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            let wake = move |id| {
                if let Some(host) = host {
                    host.wake(id);
                }
            };
            match request {
                task_answers::TaskAnswerBody::Answer(answer) => {
                    commands::answer_user_task(database, &user_id, &id, &answer, Utc::now(), wake)?;
                }
                task_answers::TaskAnswerBody::LimitDecision(decision) => {
                    commands::answer_user_task_limit(
                        database,
                        &user_id,
                        &id,
                        &decision,
                        Utc::now(),
                        wake,
                    )?;
                }
            }
            task_response::get(database, &id)?.ok_or_else(|| "answered task disappeared".into())
        },
    );
    match answered {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(service_error(error), cookies),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use std::{
        fs,
        process::{Command, Stdio},
        task::{Context, Poll, Waker},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use uuid::Uuid;

    fn git(args: &[&str], cwd: &std::path::Path) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn assert_typescript_task_body(
        database: &std::path::Path,
        artifacts: &std::path::Path,
        raw: &[u8],
    ) {
        if std::env::var_os("SUPLEX_TASK_RESPONSE_TS_ORACLE").is_none() {
            return;
        }
        let script = r#"import {SuplexDatabase} from "./src/platform/database.ts"; import {ArtifactStore} from "./src/platform/artifacts.ts"; import {TaskRepository} from "./src/tasks/repository.ts"; const db = new SuplexDatabase(process.env.SUPLEX_ORACLE_DB!, {readOnly:true,migrate:false}); const repository = new TaskRepository(db, new ArtifactStore(process.env.SUPLEX_ORACLE_ARTIFACTS!)); const row = repository.row(process.env.SUPLEX_ORACLE_TASK!); if (!row) throw new Error("task missing"); process.stdout.write(JSON.stringify(repository.task(row))); db.close();"#;
        let output = Command::new("node")
            .args(["node_modules/tsx/dist/cli.mjs", "-e", script])
            .current_dir(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap(),
            )
            .env("SUPLEX_ORACLE_DB", database)
            .env("SUPLEX_ORACLE_ARTIFACTS", artifacts)
            .env(
                "SUPLEX_ORACLE_TASK",
                serde_json::from_slice::<Value>(raw).unwrap()["id"]
                    .as_str()
                    .unwrap(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let rust = std::str::from_utf8(raw).unwrap();
        let typescript = std::str::from_utf8(&output.stdout).unwrap();
        if rust != typescript {
            let offset = rust
                .bytes()
                .zip(typescript.bytes())
                .position(|(left, right)| left != right)
                .unwrap_or(rust.len().min(typescript.len()));
            panic!(
                "full raw TaskResponse differs from TypeScript at byte {offset}\nRust: {}\nTS: {}",
                &rust[offset.saturating_sub(80)..rust.len().min(offset + 240)],
                &typescript[offset.saturating_sub(80)..typescript.len().min(offset + 240)],
            );
        }
    }

    #[tokio::test]
    async fn local_backlog_create_fetches_git_and_returns_full_task_shape() {
        let root = std::env::temp_dir().join(format!("suplex-task-http-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bare = root.join("origin.git");
        let local = root.join("repository");
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            &root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            &root,
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
        let rewrite = format!("url.file://{}.insteadOf", bare.display());
        git(
            &[
                "config",
                "--local",
                &rewrite,
                "https://github.com/acme/demo.git",
            ],
            &local,
        );
        assert_eq!(
            git::capture_local_task_heads(&local, "main", "github")
                .unwrap()
                .len(),
            40
        );

        let db_path = root.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&db_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('task_http_company', 'Task company', 'active', ?1)",
            [now.to_rfc3339()],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('task_http_project', 'task_http_company', 'Task project', ?1, ?2, 'acme/demo', 'main', '', '', 'profile_native_root', 'profile_native_worker', ?3, ?4, ?4)",
            rusqlite::params![local.to_str().unwrap(), root.join("worktrees").to_str().unwrap(), json!({"workflowIds":["standard"],"defaultWorkflowId":"standard","rootProfileIds":["profile_native_root"],"workerProfileIds":["profile_native_worker"]}).to_string(), now.to_rfc3339()],
        ).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: address.port(),
                reachable_address: format!("http://127.0.0.1:{}", address.port()),
                tailscale_exposure: "none".into(),
            },
        );
        let app = crate::http::router(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let mut headers = HeaderMap::new();
        headers.insert(
            "host",
            HeaderValue::from_str(&format!("127.0.0.1:{}", address.port())).unwrap(),
        );
        headers.insert(
            "origin",
            HeaderValue::from_str(&format!("http://127.0.0.1:{}", address.port())).unwrap(),
        );
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let body = Bytes::from(
            json!({
                "projectId":"task_http_project", "title":"Build the task route",
                "idempotencyKey":"task-http-key", "deliveryTarget":"local_worktree",
            })
            .to_string(),
        );
        let mut content_headers = HeaderMap::new();
        content_headers.insert("content-type", HeaderValue::from_static("application/json"));
        let invalid_workflow = create(
            State(state.clone()), Path("task_http_company".into()), content_headers.clone(),
            Bytes::from(json!({"projectId":"task_http_project","title":"Build","idempotencyKey":"abcdefgh","workflow":"wrong"}).to_string()),
        ).await;
        assert_eq!(invalid_workflow.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            to_bytes(invalid_workflow.into_body(), 1024)
                .await
                .unwrap()
                .as_ref(),
            br#"{"error":"The selected workflow does not exist"}"#
        );
        let invalid_body = create(
            State(state.clone()),
            Path("task_http_company".into()),
            content_headers.clone(),
            Bytes::from(
                json!({"projectId":"task_http_project","title":"","idempotencyKey":"abcdefgh"})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(invalid_body.status(), StatusCode::BAD_REQUEST);
        let mut wrong_origin_headers = headers.clone();
        wrong_origin_headers.insert(
            "origin",
            HeaderValue::from_static("https://wrong.example.test"),
        );
        let wrong_origin = create(
            State(state.clone()),
            Path("task_http_company".into()),
            wrong_origin_headers,
            body.clone(),
        )
        .await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        let mut connection = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!(
            "POST /api/companies/task_http_company/tasks HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://127.0.0.1:{}\r\nCookie: sid_v1={}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            address.port(),
            address.port(),
            admin.session_token,
            body.len(),
            std::str::from_utf8(&body).unwrap(),
        );
        connection.write_all(request.as_bytes()).await.unwrap();
        let mut wire = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            connection.read_to_end(&mut wire),
        )
        .await
        .unwrap()
        .unwrap();
        let wire = std::str::from_utf8(&wire).unwrap();
        let (head, wire_body) = wire.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 201"), "{head}\n{wire_body}");
        let raw = Bytes::copy_from_slice(wire_body.as_bytes());
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &raw);
        let value: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(value["status"], "backlog");
        assert_eq!(value["workflow"], "standard");
        assert_eq!(value["configuration"]["repository"], "acme/demo");
        assert_eq!(
            value["configuration"]["baselineSha"]
                .as_str()
                .unwrap()
                .len(),
            40
        );
        assert!(
            value["configuration"]["branch"]
                .as_str()
                .unwrap()
                .ends_with(
                    &value["id"].as_str().unwrap()[value["id"].as_str().unwrap().len() - 6..]
                )
        );
        assert_eq!(value["limits"]["admittedTurns"], 0);
        let repeated = create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            body,
        )
        .await;
        assert_eq!(repeated.status(), StatusCode::OK);
        let repeated_raw = to_bytes(repeated.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(raw, repeated_raw);
        let task_id = value["id"].as_str().unwrap().to_owned();
        let detail = get_one(State(state.clone()), Path(task_id.clone()), headers.clone()).await;
        assert_eq!(detail.status(), StatusCode::OK);
        assert_eq!(to_bytes(detail.into_body(), 128 * 1024).await.unwrap(), raw);
        let listed = list_company(
            State(state.clone()),
            Path("task_http_company".into()),
            OriginalUri("/api/companies/task_http_company/tasks".parse().unwrap()),
            {
                let mut value = HeaderMap::new();
                value.insert(
                    "host",
                    HeaderValue::from_str(&format!("127.0.0.1:{}", address.port())).unwrap(),
                );
                value.insert(
                    "cookie",
                    HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
                );
                value
            },
        )
        .await;
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = to_bytes(listed.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            listed.as_ref(),
            format!("{{\"tasks\":[{}]}}", std::str::from_utf8(&raw).unwrap()).as_bytes()
        );
        let immediate_body = Bytes::from(
            json!({
                "projectId":"task_http_project", "title":"Start on creation",
                "idempotencyKey":"task-immediate-key", "deliveryTarget":"local_worktree",
                "startImmediately":true
            })
            .to_string(),
        );
        let immediate = create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            immediate_body.clone(),
        )
        .await;
        assert_eq!(immediate.status(), StatusCode::CREATED);
        let immediate_raw = to_bytes(immediate.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &immediate_raw);
        assert_eq!(
            serde_json::from_slice::<Value>(&immediate_raw).unwrap()["status"],
            "active"
        );
        let immediate_replay = create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            immediate_body,
        )
        .await;
        assert_eq!(immediate_replay.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(immediate_replay.into_body(), 128 * 1024)
                .await
                .unwrap(),
            immediate_raw
        );
        let immediate_id = serde_json::from_slice::<Value>(&immediate_raw).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (root_session, question_id) = state.with_database(|database| {
            let root = crate::coordination::root_session_store::reserve_root(
                database,
                &immediate_id,
                Utc::now(),
            )
            .unwrap();
            assert!(
                crate::coordination::root_session_store::ask_human_for_root(
                    database,
                    &immediate_id,
                    &root.id,
                    root.generation,
                    "Use main?",
                    &json!([]),
                    Utc::now(),
                )
                .unwrap()
            );
            let question_id: String = database
                .connection()
                .query_row(
                    "SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?1",
                    [&immediate_id],
                    |row| row.get(0),
                )
                .unwrap();
            (root.id, question_id)
        });
        assert!(!root_session.is_empty());
        let bad_answer = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            content_headers.clone(),
            Bytes::from_static(br#"{"questionId":"","answer":""}"#),
        )
        .await;
        assert_eq!(bad_answer.status(), StatusCode::BAD_REQUEST);
        let limit_answer = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":question_id,"limitDecision":{"kind":"cancel_task"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(limit_answer.status(), StatusCode::CONFLICT);
        let missing_limit_answer = answer_pending(
            State(state.clone()),
            Path("task_missing".into()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":question_id,"limitDecision":{"kind":"cancel_task"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(missing_limit_answer.status(), StatusCode::NOT_FOUND);
        let answer_body =
            Bytes::from(json!({"questionId":question_id,"answer":"  Proceed  "}).to_string());
        let answered = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            answer_body.clone(),
        )
        .await;
        assert_eq!(answered.status(), StatusCode::OK);
        let answered_raw = to_bytes(answered.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &answered_raw);
        let answered_value: Value = serde_json::from_slice(&answered_raw).unwrap();
        assert_eq!(answered_value["status"], "active");
        assert!(answered_value["humanQuestion"].is_null());
        let stale_answer = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            answer_body,
        )
        .await;
        assert_eq!(stale_answer.status(), StatusCode::CONFLICT);
        let pause = json!({
            "kind":"task_limit", "reason":"budget",
            "limits":{"budgetUsd":15,"maxTurns":40},
            "usage":{"estimatedCostUsd":15,"admittedTurns":3},
            "proposedLimits":{"budgetUsd":25,"maxTurns":40}
        });
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Raise limit?', human_question_id = 'limit-http', limit_pause_json = ?1 WHERE task_id = ?2",
                rusqlite::params![pause.to_string(), immediate_id],
            )
        }).unwrap();
        let raised = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":"limit-http","limitDecision":{"kind":"add_allowance"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(raised.status(), StatusCode::OK);
        let raised_raw = to_bytes(raised.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &raised_raw);
        assert_eq!(
            serde_json::from_slice::<Value>(&raised_raw).unwrap()["limits"]["budgetUsd"],
            25
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Stop for limit?', human_question_id = 'limit-cancel-http', limit_pause_json = ?1 WHERE task_id = ?2",
                rusqlite::params![pause.to_string(), immediate_id],
            )
        }).unwrap();
        let stopped = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":"limit-cancel-http","limitDecision":{"kind":"cancel_task"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(stopped.status(), StatusCode::OK);
        let stopped_raw = to_bytes(stopped.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &stopped_raw);
        assert_eq!(
            serde_json::from_slice::<Value>(&stopped_raw).unwrap()["status"],
            "cancelled"
        );
        let disconnected_body = json!({
            "projectId":"task_http_project",
            "title":"Continue after disconnect",
            "idempotencyKey":"task-disconnected-key",
            "deliveryTarget":"local_worktree",
        })
        .to_string();
        let mut dropped_waiter = Box::pin(create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            Bytes::from(disconnected_body),
        ));
        assert!(matches!(
            std::future::Future::poll(
                dropped_waiter.as_mut(),
                &mut Context::from_waker(Waker::noop()),
            ),
            Poll::Pending
        ));
        drop(dropped_waiter);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let persisted: bool = state.with_database(|database| -> Result<bool, rusqlite::Error> {
                    database.connection().query_row(
                        "SELECT EXISTS(SELECT 1 FROM suplex_tasks WHERE idempotency_key = 'task-disconnected-key')",
                        [],
                        |row| row.get(0),
                    )
                }).unwrap();
                if persisted {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        let host = crate::tasks::host::spawn_task_host(db_path.clone(), root.clone());
        let host_state = state.clone().with_task_host(host.clone());
        let cancelled = cancel_pending(
            State(host_state.clone()),
            Path(task_id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(cancelled.status(), StatusCode::OK);
        let cancelled_body = to_bytes(cancelled.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&cancelled_body).unwrap()["status"],
            "cancelled"
        );
        let cancelled_again =
            cancel_pending(State(host_state), Path(task_id.clone()), headers.clone()).await;
        assert_eq!(cancelled_again.status(), StatusCode::OK);
        host.stop().await;
        let disconnected_id: String = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT id FROM suplex_tasks WHERE idempotency_key = 'task-disconnected-key'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        let started = start_pending(
            State(state.clone()),
            Path(disconnected_id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(started.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(started.into_body(), 128 * 1024).await.unwrap()
            )
            .unwrap()["status"],
            "active"
        );
        let cancelled_without_host =
            cancel_pending(State(state.clone()), Path(disconnected_id), headers.clone()).await;
        assert_eq!(cancelled_without_host.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(cancelled_without_host.into_body(), 128 * 1024)
                    .await
                    .unwrap()
            )
            .unwrap()["status"],
            "cancelled"
        );
        state.with_database(|database| -> Result<(), rusqlite::Error> {
            database.connection().execute(
                "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('task_other_company', 'Other', 'active', ?1)",
                [now.to_rfc3339()],
            )?;
            database.connection().execute(
                "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, 'task_http_company', ?2)",
                rusqlite::params![admin.user.id, now.to_rfc3339()],
            )?;
            database.connection().execute(
                "UPDATE suplex_users SET role = 'member' WHERE id = ?1",
                [&admin.user.id],
            )?;
            database.connection().execute(
                "UPDATE suplex_projects SET company_id = 'task_other_company' WHERE id = 'task_http_project'",
                [],
            )?;
            Ok(())
        }).unwrap();
        let replay_without_project_scope = create(
            State(state.clone()),
            Path("task_http_company".into()),
            {
                let mut replay_headers = HeaderMap::new();
                replay_headers.insert(
                    "host",
                    HeaderValue::from_str(&format!("127.0.0.1:{}", address.port())).unwrap(),
                );
                replay_headers.insert(
                    "origin",
                    HeaderValue::from_str(&format!("http://127.0.0.1:{}", address.port())).unwrap(),
                );
                replay_headers.insert("content-type", HeaderValue::from_static("application/json"));
                replay_headers.insert(
                    "cookie",
                    HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
                );
                replay_headers
            },
            Bytes::from(
                json!({
                    "projectId":"task_http_project", "title":"Build the task route",
                    "idempotencyKey":"task-http-key", "deliveryTarget":"local_worktree",
                })
                .to_string(),
            ),
        )
        .await;
        assert_eq!(replay_without_project_scope.status(), StatusCode::NOT_FOUND);
        server.abort();
        let _ = server.await;
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
