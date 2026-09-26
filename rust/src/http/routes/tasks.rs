//! Task reads and local backlog creation. Native wake is connected separately.

use crate::identity::IdentityError;
use crate::shared::PublicFailure;
use crate::tasks::TaskError;
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, OriginalUri, Path, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::Serialize;
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
        service::{self as projects},
    },
    tasks::{
        archive::operations::{self as archive, ArchiveOutcome},
        commands,
        images::{self, DecodedTaskImage},
        response as task_response,
    },
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks", get(list_all))
        .route(
            "/api/companies/{company_id}/tasks",
            get(list_company)
                .post(create)
                .layer(DefaultBodyLimit::max(images::MAX_TASK_REQUEST_BYTES)),
        )
        .route("/api/tasks/{task_id}", get(get_one).patch(update_details))
        .route("/api/tasks/{task_id}/rename", axum::routing::post(rename))
        .route(
            "/api/tasks/{task_id}/issue",
            axum::routing::patch(set_issue),
        )
        .route(
            "/api/tasks/{task_id}/dependencies",
            axum::routing::put(set_dependencies),
        )
        .route(
            "/api/tasks/{task_id}/start",
            axum::routing::post(start_pending),
        )
        .route(
            "/api/tasks/{task_id}/cancel",
            axum::routing::post(cancel_pending),
        )
        .route(
            "/api/tasks/{task_id}/disarm",
            axum::routing::post(disarm_pending),
        )
        .route(
            "/api/tasks/{task_id}/continue-delivery",
            axum::routing::post(continue_delivery),
        )
        .route(
            "/api/tasks/{task_id}/select-agent",
            axum::routing::post(select_agent),
        )
        .route("/api/tasks/{task_id}/note", axum::routing::post(send_note))
        .route(
            "/api/tasks/{task_id}/replace-worker",
            axum::routing::post(replace_worker),
        )
        .route(
            "/api/tasks/{task_id}/replace-coordinator",
            axum::routing::post(replace_coordinator),
        )
        .route(
            "/api/tasks/{task_id}/answer",
            axum::routing::post(answer_pending),
        )
        .route(
            "/api/tasks/{task_id}/archive",
            axum::routing::post(archive_pending),
        )
        .route(
            "/api/tasks/{task_id}/unarchive",
            axum::routing::post(unarchive_pending),
        )
        .route("/api/tasks/{task_id}/refresh", axum::routing::post(refresh))
}

/// TypeScript refresh: read the task, then wake the host to observe it again.
async fn refresh(
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
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        commands::user_task_configuration(database, &user_id, &id)?;
        task_response::get(database, &id)?.ok_or_else(|| "refreshed task disappeared".into())
    });
    match result {
        Ok(task) => {
            if let Some(host) = &state.task_host {
                host.wake(id);
            }
            with_cookies(Json(task).into_response(), cookies)
        }
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn unarchive_pending(
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
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        archive::unarchive_local_task(database, &user_id, &id)?;
        task_response::get(database, &id)?.ok_or_else(|| "unarchived task disappeared".into())
    });
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveConfirmation {
    status: &'static str,
    dirty_file_count: usize,
    dirty_file_paths: Vec<String>,
}

/// Archive keeps the envelope of task and access failures; any other failure is a 409.
fn archive_error(error: Box<dyn Error>) -> PublicFailure {
    if matches!(error.downcast_ref(), Some(TaskError::Failure { .. }))
        || matches!(error.downcast_ref(), Some(IdentityError::Auth { .. }))
    {
        return auth::public_failure(error);
    }
    PublicFailure::new(409, error.to_string())
}

async fn archive_pending(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request =
        match auth::validated_typed_body(&headers, &body, task_contracts::parse_task_archive) {
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
    let Some(database_path) =
        state.with_database(|database| database.connection().path().map(PathBuf::from))
    else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    let response_user_id = user_id.clone();
    // Admission owns the blocking operation, including its in-process archive
    // guard, even if the HTTP waiter disconnects before Git cleanup finishes.
    let operation = tokio::task::spawn_blocking(move || {
        archive::archive_local_task(&database_path, &user_id, &id, request.confirm_discard_dirty)
            .map_err(archive_error)
    });
    let result = match operation.await {
        Ok(result) => result,
        Err(_) => {
            return with_cookies(
                auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
                cookies,
            );
        }
    };
    match result {
        Ok(ArchiveOutcome::ConfirmationRequired(paths)) => with_cookies(
            Json(ArchiveConfirmation {
                status: "confirmation_required",
                dirty_file_count: paths.len(),
                dirty_file_paths: paths,
            })
            .into_response(),
            cookies,
        ),
        Ok(ArchiveOutcome::Archived(task)) => {
            let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
                companies::require_company_access(database, &response_user_id, &task.company_id)?;
                task_response::get(database, &task.id)?
                    .ok_or_else(|| "archived task disappeared".into())
            });
            match result {
                Ok(task) => with_cookies(Json(task).into_response(), cookies),
                Err(error) => with_cookies(auth::service_error(error), cookies),
            }
        }
        Err(failure) => with_cookies(failure.into_response(), cookies),
    }
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
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if let Err(response) = validated_company_id(&company_id) {
        return *response;
    }
    let body = match body {
        Ok(body) => body,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error":"Request is too large","findings":[{"code":"request-too-large","field":"images","message":"Attach fewer or smaller images and submit again"}]}))).into_response();
        }
        Err(_) => return auth::error(StatusCode::BAD_REQUEST, "Invalid request"),
    };
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
                return Err(TaskError::new("The company is not active", 409).into());
            }
            let project = projects::get(database, &user_id, &request.project_id)?;
            if project.company_id != company_id {
                return Err(TaskError::not_found().into());
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
            Err(error) => return with_cookies(auth::service_error(error), cookies),
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
    let Some(repository) = project.repository.clone() else {
        return with_cookies(
            auth::error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Configure the project repository before creating a task",
            ),
            cookies,
        );
    };
    let numbers = request
        .blocked_by_pull_requests
        .iter()
        .map(|dependency| dependency.number)
        .collect::<Vec<_>>();
    let pull_requests =
        match crate::tasks::pull_request_dependencies::observe(&repository, &numbers).await {
            Ok(pull_requests) => pull_requests,
            Err(rejection) => {
                return with_cookies(
                    auth::service_error(Box::new(commands::pull_request_rejection(rejection))),
                    cookies,
                );
            }
        };
    let profiles = {
        let selected = state.with_database(|database| {
            commands::select_local_profiles(database, &project, &request)
        });
        match selected {
            Ok(profiles) => profiles,
            Err(error) => return with_cookies(auth::service_error(error), cookies),
        }
    };
    let decoded_images = match request
        .images
        .iter()
        .map(images::decode_task_image)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(images) => images,
        Err(failure) => return with_cookies(auth::service_error(Box::new(failure)), cookies),
    };
    let operation = tokio::spawn(finish_admitted_create(
        state,
        AdmittedCreate {
            company_id,
            user_id,
            cookies,
            project,
            request,
            profiles,
            decoded_images,
            pull_requests,
        },
    ));
    match operation.await {
        Ok(response) => response,
        Err(_) => auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

/// Once authorization and policy admit creation, the Git fetch and database
/// transaction keep running even if the HTTP waiter goes away.
struct AdmittedCreate {
    company_id: String,
    user_id: String,
    cookies: Vec<String>,
    project: projects::Project,
    request: task_contracts::TaskCreateBody,
    profiles: commands::LocalProfiles,
    decoded_images: Vec<DecodedTaskImage>,
    pull_requests: Vec<Value>,
}

async fn finish_admitted_create(state: AppState, admitted: AdmittedCreate) -> Response {
    let AdmittedCreate {
        company_id,
        user_id,
        cookies,
        project,
        request,
        profiles,
        decoded_images,
        pull_requests,
    } = admitted;
    let source = request
        .source
        .as_ref()
        .map(serde_json::to_value)
        .transpose();
    let issue = request
        .issue
        .as_ref()
        .map(|issue| issue.as_ref().map(serde_json::to_value).transpose())
        .transpose();
    let (Ok(source), Ok(issue)) = (source, issue) else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    let pinned = match crate::tasks::sources::creation_source(
        &project,
        &request.title,
        &request.description,
        source.as_ref(),
        issue.as_ref().map(Option::as_ref),
    )
    .await
    {
        Ok(pinned) => pinned,
        Err(error) => return with_cookies(auth::service_error(error), cookies),
    };
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
    let captured =
        git::capture_local_task_heads(&state.project_github, &repository_path, &base_branch, &host)
            .await;
    let base_sha = match captured {
        Ok(sha) => sha,
        Err(findings) => return with_cookies((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"Project configuration could not be captured","findings":findings})),
        ).into_response(), cookies),
    };
    let now = Utc::now();
    let host = state.task_host.clone();
    let written = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        let mut prepared = commands::prepare_local_user_task(
            &company_id,
            &user_id,
            &project,
            &request,
            profiles,
            &base_sha,
            now,
        )?;
        crate::tasks::sources::apply(&mut prepared, pinned);
        prepared.pull_request_dependencies = pull_requests;
        let artifact_root = state
            .artifact_root
            .as_deref()
            .ok_or("Artifact root is not configured")?;
        let result = commands::create_user_task_with_images(
            database,
            &user_id,
            &project,
            &prepared,
            commands::ImageFiles {
                root: artifact_root,
                images: &decoded_images,
            },
            &request.workflow,
            now,
            move |id| {
                if let Some(host) = host {
                    host.wake(id);
                }
            },
        )?;
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
        Err(error) => with_cookies(auth::service_error(error), cookies),
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
            return Err(TaskError::not_found().into())
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
        Err(error) => with_cookies(auth::service_error(error), cookies),
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
        let company = company.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, &user_id, &company)?;
        task_response::get(database, &id)?.ok_or_else(|| TaskError::not_found().into())
    });
    let mut response = match result {
        Ok(task) => Json(task).into_response(),
        Err(error) => auth::service_error(error),
    };
    response
        .headers_mut()
        .insert("cache-control", "private, no-store".parse().unwrap());
    with_cookies(response, cookies)
}

async fn update_details(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request =
        match auth::validated_typed_body(&headers, &body, task_contracts::parse_task_details) {
            Ok(value) => value,
            Err(response) => return *response,
        };
    if !session::csrf_allowed(&state.session_config, &headers, "PATCH", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::update_user_task_details(database, &user_id, &id, &request, Utc::now())?;
            task_response::get(database, &id)?.ok_or_else(|| "edited task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn rename(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request =
        match auth::validated_typed_body(&headers, &body, task_contracts::parse_task_rename) {
            Ok(value) => value,
            Err(response) => return *response,
        };
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::rename_user_task(database, &user_id, &id, &request, Utc::now())?;
            task_response::get(database, &id)?.ok_or_else(|| "renamed task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
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
        let company = company.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, &user_id, &company)?;
        Ok(())
    });
    if let Err(error) = access {
        return with_cookies(auth::service_error(error), cookies);
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
        Err(error) => with_cookies(auth::service_error(error), cookies),
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
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn disarm_pending(
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
    let disarmed = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::disarm_user_task(database, &user_id, &id, Utc::now())?;
            task_response::get(database, &id)?.ok_or_else(|| "disarmed task disappeared".into())
        },
    );
    match disarmed {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn set_dependencies(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request = match auth::validated_typed_body(
        &headers,
        &body,
        task_contracts::parse_task_dependencies,
    ) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !session::csrf_allowed(&state.session_config, &headers, "PUT", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    // TypeScript `applyDependencies`: GitHub observes each pull request prerequisite before any write.
    let repository = {
        let repository = state.with_database(|database| -> Result<String, Box<dyn Error>> {
            for dependency in &request.depends_on {
                commands::user_task_configuration(database, &user_id, dependency)?;
            }
            let configuration = commands::user_task_configuration(database, &user_id, &id)?;
            Ok(configuration["repository"]
                .as_str()
                .unwrap_or("")
                .to_owned())
        });
        match repository {
            Ok(repository) => repository,
            Err(error) => return with_cookies(auth::service_error(error), cookies),
        }
    };
    let numbers = request
        .blocked_by_pull_requests
        .iter()
        .map(|dependency| dependency.number)
        .collect::<Vec<_>>();
    let pull_requests =
        match crate::tasks::pull_request_dependencies::observe(&repository, &numbers).await {
            Ok(pull_requests) => pull_requests,
            Err(rejection) => {
                return with_cookies(
                    auth::service_error(Box::new(commands::pull_request_rejection(rejection))),
                    cookies,
                );
            }
        };
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::set_user_task_dependencies(
                database,
                &user_id,
                &id,
                &request,
                &pull_requests,
                Utc::now(),
            )?;
            task_response::get(database, &id)?.ok_or_else(|| "blocked task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn set_issue(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request =
        match auth::validated_typed_body(&headers, &body, task_contracts::parse_task_issue) {
            Ok(value) => value,
            Err(response) => return *response,
        };
    if !session::csrf_allowed(&state.session_config, &headers, "PATCH", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let resolved = match &request.issue {
        None => None,
        Some(issue) => {
            let read = async {
                let configuration = state.with_database(|database| {
                    commands::user_task_configuration(database, &user_id, &id)
                })?;
                let tracker = crate::tasks::issue_context::task_tracker(&configuration)?;
                let tracker = crate::integrations::issue_tracker::IssueTracker::new(&tracker)
                    .await
                    .map_err(|error| error.to_string())?;
                let context = tracker
                    .read(&serde_json::to_value(issue)?)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok::<_, Box<dyn Error>>(context["issue"].clone())
            };
            match read.await {
                Ok(issue) => Some(issue),
                Err(error) => return with_cookies(auth::service_error(error), cookies),
            }
        }
    };
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::set_user_task_issue(database, &user_id, &id, resolved.as_ref(), Utc::now())?;
            task_response::get(database, &id)?.ok_or_else(|| "linked task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn select_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request = match auth::validated_typed_body(
        &headers,
        &body,
        task_contracts::parse_task_agent_selection,
    ) {
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
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::select_user_task_agent(
                database,
                &user_id,
                &id,
                &request,
                Utc::now(),
                move |id| {
                    if let Some(host) = host {
                        host.wake(id);
                    }
                },
            )?;
            task_response::get(database, &id)?.ok_or_else(|| "selected task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn continue_delivery(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request = match auth::validated_typed_body(
        &headers,
        &body,
        task_contracts::parse_task_continue_delivery,
    ) {
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
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::continue_user_delivery(database, &user_id, &id, &request, move |id| {
                if let Some(host) = host {
                    host.wake(id);
                }
            })?;
            task_response::get(database, &id)?.ok_or_else(|| "continued task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn send_note(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request = match auth::validated_typed_body(&headers, &body, task_contracts::parse_task_note)
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
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::send_user_note(database, &user_id, &id, &request, Utc::now(), move |id| {
                if let Some(host) = host {
                    host.wake(id);
                }
            })?;
            task_response::get(database, &id)?.ok_or_else(|| "noted task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
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
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn replace_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request = match auth::validated_typed_body(
        &headers,
        &body,
        task_contracts::parse_task_worker_replacement,
    ) {
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
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::replace_user_worker(
                database,
                &user_id,
                &id,
                &request,
                Utc::now(),
                move |id| {
                    if let Some(host) = host {
                        host.wake(id);
                    }
                },
            )?;
            task_response::get(database, &id)?.ok_or_else(|| "replacement task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

async fn replace_coordinator(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_task_id(&id) {
        return *response;
    }
    let request = match auth::validated_typed_body(
        &headers,
        &body,
        task_contracts::parse_task_coordinator_replacement,
    ) {
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
    let result = state.with_database(
        |database| -> Result<task_response::TaskResponse, Box<dyn Error>> {
            commands::replace_user_coordinator(
                database,
                &user_id,
                &id,
                &request,
                Utc::now(),
                move |id| {
                    if let Some(host) = host {
                        host.wake(id);
                    }
                },
            )?;
            task_response::get(database, &id)?.ok_or_else(|| "replacement task disappeared".into())
        },
    );
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(auth::service_error(error), cookies),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create(
        state: State<AppState>,
        company_id: Path<String>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        super::create(state, company_id, headers, Ok(body)).await
    }
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
                "git@github.com:acme/demo.git",
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
        let github = git::Github {
            api: Some(("https://api.github.com".into(), "fixture-token".into())),
            git: None,
        };
        assert_eq!(
            git::capture_local_task_heads(&github, &local, "main", "github")
                .await
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
        )
        .with_artifact_root(root.join("artifacts"))
        .with_project_github(github);
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
                "images":[{"filename":"design.png","mimeType":"image/png","base64":"iVBORw0KGgo="}],
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
        let oversized = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/api/companies/task_http_company/tasks",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .header("origin", format!("http://127.0.0.1:{}", address.port()))
            .header("content-type", "application/json")
            .body(vec![b' '; images::MAX_TASK_REQUEST_BYTES + 1])
            .send()
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            oversized.text().await.unwrap(),
            "{\"error\":\"Request is too large\",\"findings\":[{\"code\":\"request-too-large\",\"field\":\"images\",\"message\":\"Attach fewer or smaller images and submit again\"}]}"
        );
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
        let artifact_id = value["images"][0]["artifactId"].as_str().unwrap();
        let client = reqwest::Client::new();
        for alias in ["images", "artifacts"] {
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/api/tasks/{}/{}/{}",
                    address.port(),
                    value["id"].as_str().unwrap(),
                    alias,
                    artifact_id
                ))
                .header("cookie", format!("sid_v1={}", admin.session_token))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["cache-control"], "private, no-store");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(response.headers()["content-type"], "image/png");
            assert_eq!(
                response.bytes().await.unwrap().as_ref(),
                &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
            );
        }
        for (task_id, id) in [
            (value["id"].as_str().unwrap(), "missing-artifact"),
            ("missing-task", artifact_id),
        ] {
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/api/tasks/{}/images/{}",
                    address.port(),
                    task_id,
                    id
                ))
                .header("cookie", format!("sid_v1={}", admin.session_token))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(response.text().await.unwrap(), "{\"error\":\"Not found\"}");
        }
        let storage_path: String = state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT storage_path FROM suplex_artifacts WHERE id = ?1",
                    [artifact_id],
                    |row| row.get(0),
                )
                .unwrap()
        });
        let file_path = root.join("artifacts").join(&storage_path);
        fs::write(&file_path, b"changed").unwrap();
        let corrupt = client
            .get(format!(
                "http://127.0.0.1:{}/api/tasks/{}/images/{}",
                address.port(),
                value["id"].as_str().unwrap(),
                artifact_id
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .send()
            .await
            .unwrap();
        assert_eq!(corrupt.status(), StatusCode::CONFLICT);
        assert_eq!(
            corrupt.text().await.unwrap(),
            "{\"error\":\"The stored artifact failed its integrity check\"}"
        );
        fs::write(&file_path, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
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
        let refreshed = client
            .post(format!(
                "http://127.0.0.1:{}/api/tasks/{task_id}/refresh",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .header("origin", format!("http://127.0.0.1:{}", address.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(refreshed.status(), StatusCode::OK);
        assert_eq!(refreshed.bytes().await.unwrap(), raw);
        let refused = client
            .post(format!(
                "http://127.0.0.1:{}/api/tasks/{task_id}/refresh",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .header("origin", "https://wrong.example.test")
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let checks = client
            .get(format!(
                "http://127.0.0.1:{}/api/tasks/{task_id}/checks",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .send()
            .await
            .unwrap();
        assert_eq!(checks.status(), StatusCode::OK);
        assert_eq!(
            checks.text().await.unwrap(),
            r#"{"available":false,"runs":[]}"#
        );
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
        let reviewed = create(
            State(state.clone()), Path("task_http_company".into()), headers.clone(),
            Bytes::from(json!({"projectId":"task_http_project","title":"Reviewed","idempotencyKey":"review-1","deliveryTarget":"local_worktree","workflow":"independent_review"}).to_string()),
        ).await;
        assert_eq!(reviewed.status(), StatusCode::CREATED);
        let reviewed: Value =
            serde_json::from_slice(&to_bytes(reviewed.into_body(), 128 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(reviewed["workflow"], "independent_review");
        assert_eq!(
            reviewed["advisorProfiles"]["reviewer"]["profileId"],
            "profile_native_root"
        );
        let wrong_role = create(
            State(state.clone()), Path("task_http_company".into()), headers.clone(),
            Bytes::from(json!({"projectId":"task_http_project","title":"Wrong role","idempotencyKey":"review-2","deliveryTarget":"local_worktree","workflow":"independent_review","advisorProfileIds":{"reviewer":"profile_native_worker"}}).to_string()),
        ).await;
        assert_eq!(wrong_role.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let empty_edit = update_details(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(empty_edit.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            to_bytes(empty_edit.into_body(), 1024)
                .await
                .unwrap()
                .as_ref(),
            br#"{"error":"Internal server error"}"#
        );
        state.with_database(|database| database.connection().execute(
            "UPDATE suplex_profiles SET archived_at = ?1 WHERE id IN ('profile_native_root','profile_native_worker')",
            [Utc::now().to_rfc3339()],
        )).unwrap();
        let edited = update_details(
            State(state.clone()), Path(task_id.clone()), headers.clone(),
            Bytes::from(json!({"title":"  Edited objective  ","description":"  Check the edit  ","runProjectTests":false,"visualEvidence":"capture"}).to_string()),
        ).await;
        assert_eq!(edited.status(), StatusCode::OK);
        let edited_raw = to_bytes(edited.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &edited_raw);
        let edited_value: Value = serde_json::from_slice(&edited_raw).unwrap();
        assert_eq!(edited_value["title"], "Edited objective");
        assert_eq!(
            edited_value["rootProfile"]["profileId"],
            "profile_native_root"
        );
        assert_eq!(edited_value["configuration"]["runProjectTests"], false);
        let backlog_renamed = rename(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Backlog name"}"#),
        )
        .await;
        assert_eq!(backlog_renamed.status(), StatusCode::OK);
        let backlog_raw = to_bytes(backlog_renamed.into_body(), 128 * 1024)
            .await
            .unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &backlog_raw);
        let objective: String = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT objective FROM suplex_task_controls WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(objective, "Backlog name\n\nCheck the edit");
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                    [&task_id],
                )
            })
            .unwrap();
        let active_renamed = rename(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Active name"}"#),
        )
        .await;
        assert_eq!(active_renamed.status(), StatusCode::OK);
        let active_raw = to_bytes(active_renamed.into_body(), 128 * 1024)
            .await
            .unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &active_raw);
        assert_eq!(
            serde_json::from_slice::<Value>(&active_raw).unwrap()["title"],
            "Active name"
        );
        let objective_after: String = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT objective FROM suplex_task_controls WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(objective_after, objective);
        let active_edit = update_details(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Too late"}"#),
        )
        .await;
        assert_eq!(active_edit.status(), StatusCode::CONFLICT);
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_tasks SET archived_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), task_id],
                )
            })
            .unwrap();
        let archived_rename = rename(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Archived name"}"#),
        )
        .await;
        assert_eq!(archived_rename.status(), StatusCode::CONFLICT);
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_tasks SET archived_at = NULL WHERE id = ?1",
                [&task_id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'backlog', objective = (SELECT CASE WHEN description = '' THEN title ELSE title || char(10) || char(10) || description END FROM suplex_tasks WHERE id = ?1) WHERE task_id = ?1",
                [&task_id],
            )
        }).unwrap();
        state.with_database(|database| database.connection().execute(
            "UPDATE suplex_profiles SET archived_at = NULL WHERE id IN ('profile_native_root','profile_native_worker')", [],
        )).unwrap();
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
        let invalid_note = send_note(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"note":"   ","extra":true}"#),
        )
        .await;
        assert_eq!(invalid_note.status(), StatusCode::BAD_REQUEST);
        let noted = send_note(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"note":"  Check the current result.  "}"#),
        )
        .await;
        assert_eq!(noted.status(), StatusCode::OK);
        let noted_raw = to_bytes(noted.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &noted_raw);
        let (noted_root, noted_hash): (String, String) = state.with_database(|database| {
            database.connection().query_row(
                "SELECT session_id,prompt_hash FROM suplex_task_turns WHERE task_id = ?1 AND prompt_text = 'Human note:' || char(10) || 'Check the current result.'",
                [&immediate_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        }).unwrap();
        assert_eq!(noted_root, root_session);
        assert_eq!(
            noted_hash,
            "d41fa338e9f66d1b305d9678a1d2556a9c7559c0ec366d11abf1088a500507eb"
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'delivered',workflow = 'independent_review',workflow_state_json = json_set(workflow_state_json,'$.completion',json(?1)) WHERE task_id = ?2",
                rusqlite::params![r#"{"kind":"workflow","reviewedHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pullRequestNumber":1597,"observedAt":"2026-09-25T12:00:00.000Z"}"#, immediate_id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'stopped',native_session_id = 'codex-retained',stopped_at = ?1 WHERE id = ?2",
                rusqlite::params![Utc::now().to_rfc3339(), root_session],
            ).unwrap();
        });
        let follow_up = send_note(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"note":"Fix the checks."}"#),
        )
        .await;
        assert_eq!(follow_up.status(), StatusCode::OK);
        let follow_up_raw = to_bytes(follow_up.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &follow_up_raw);
        assert_eq!(
            serde_json::from_slice::<Value>(&follow_up_raw).unwrap()["status"],
            "active"
        );
        state.with_database(|database| {
            let (id, native): (String, String) = database.connection().query_row(
                "SELECT id,native_session_id FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
                [&immediate_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(id, root_session);
            assert_eq!(native, "codex-retained");
        });
        let stale_answer = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            answer_body,
        )
        .await;
        assert_eq!(stale_answer.status(), StatusCode::CONFLICT);
        let old_worker_id = state.with_database(|database| {
            let root =
                crate::coordination::root_session_store::current_root(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            crate::coordination::root_session_store::launch_standard_worker(
                database,
                &root,
                "Finish the behavior",
                "Worker assignment: Finish the behavior",
                None,
                Utc::now(),
            )
            .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        });
        let invalid_replacement = replace_worker(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"sessionId":"","reason":"  "}"#),
        )
        .await;
        assert_eq!(invalid_replacement.status(), StatusCode::BAD_REQUEST);
        let replacement_body = Bytes::from(json!({"sessionId":old_worker_id,"reason":"  Change strategy  ","handoff":"  Finish the checks  "}).to_string());
        let replaced = replace_worker(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            replacement_body.clone(),
        )
        .await;
        assert_eq!(replaced.status(), StatusCode::OK);
        let replaced_raw = to_bytes(replaced.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &replaced_raw);
        let replacement_id = state.with_database(|database| {
            let worker =
                crate::coordination::root_session_store::current_worker(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            assert_ne!(worker.id, old_worker_id);
            assert!(
                !crate::coordination::root_session_store::worker_replacement_ready(
                    database, &worker.id
                )
                .unwrap()
            );
            worker.id
        });
        let replayed = replace_worker(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            replacement_body,
        )
        .await;
        assert_eq!(replayed.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(replayed.into_body(), 128 * 1024).await.unwrap(),
            replaced_raw
        );
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), old_worker_id],
                )
            })
            .unwrap();
        assert!(
            state
                .with_database(|database| {
                    crate::coordination::root_session_store::worker_replacement_ready(
                        database,
                        &replacement_id,
                    )
                })
                .unwrap()
        );
        state.with_database(|database| {
            database.connection().execute(
                "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('replacement-root','Replacement Root','root','replacement-root','codex','gpt-6-sol','medium','default',?1,?1)",
                [Utc::now().to_rfc3339()],
            )
        }).unwrap();
        let invalid_coordinator = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"sessionId":"","rootProfileId":"","resume":true}"#),
        )
        .await;
        assert_eq!(invalid_coordinator.status(), StatusCode::BAD_REQUEST);
        let coordinator_body = Bytes::from(json!({"sessionId":root_session,"rootProfileId":"replacement-root","resume":false,"handoff":"  Continue the task  "}).to_string());
        let coordinator = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            coordinator_body.clone(),
        )
        .await;
        assert_eq!(coordinator.status(), StatusCode::OK);
        let coordinator_raw = to_bytes(coordinator.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &coordinator_raw);
        let new_root_id = state.with_database(|database| {
            let root =
                crate::coordination::root_session_store::current_root(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            assert_ne!(root.id, root_session);
            assert!(
                !crate::coordination::root_session_store::worker_replacement_ready(
                    database, &root.id
                )
                .unwrap()
            );
            assert_eq!(
                crate::coordination::root_session_store::current_worker(database, &immediate_id)
                    .unwrap()
                    .unwrap()
                    .id,
                replacement_id
            );
            root.id
        });
        let coordinator_replay = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            coordinator_body,
        )
        .await;
        assert_eq!(coordinator_replay.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(coordinator_replay.into_body(), 128 * 1024)
                .await
                .unwrap(),
            coordinator_raw
        );
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), root_session],
                )
            })
            .unwrap();
        assert!(
            state
                .with_database(|database| {
                    crate::coordination::root_session_store::worker_replacement_ready(
                        database,
                        &new_root_id,
                    )
                })
                .unwrap()
        );
        state.with_database(|database| database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human',human_question = 'Resolve provider failure?',human_question_id = 'coordinator-question',human_question_options_json = '[]' WHERE task_id = ?1",
            [&immediate_id],
        )).unwrap();
        let resumed = replace_coordinator(
            State(state.clone()),Path(immediate_id.clone()),headers.clone(),
            Bytes::from(json!({"sessionId":new_root_id,"rootProfileId":"replacement-root","resume":true,"questionId":"coordinator-question"}).to_string()),
        ).await;
        assert_eq!(resumed.status(), StatusCode::OK);
        let resumed_raw = to_bytes(resumed.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &resumed_raw);
        assert_eq!(
            serde_json::from_slice::<Value>(&resumed_raw).unwrap()["status"],
            "active"
        );
        state.with_database(|database| {
            let next =
                crate::coordination::root_session_store::current_root(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            let prompt = crate::coordination::root_session_store::pending_turns(database, &next.id)
                .unwrap()
                .remove(0)
                .prompt_text;
            assert!(prompt.contains("Question coordinator-question:\nResolve provider failure?"));
        });
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
        let cancelled_without_host = cancel_pending(
            State(state.clone()),
            Path(disconnected_id.clone()),
            headers.clone(),
        )
        .await;
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
        let intent = crate::tasks::worktree::TaskWorktreeIntent {
            task_id: task_id.clone(),
            repository_path: PathBuf::from(
                value["configuration"]["repositoryPath"].as_str().unwrap(),
            ),
            worktree_root: PathBuf::from(value["configuration"]["worktreeRoot"].as_str().unwrap()),
            branch: value["configuration"]["branch"]
                .as_str()
                .unwrap()
                .to_owned(),
            starting_sha: value["configuration"]["startingSha"]
                .as_str()
                .unwrap()
                .to_owned(),
        };
        let worktree = crate::tasks::worktree::prepare_local_task_worktree(&intent, None).unwrap();
        fs::write(
            worktree.path.join("archive-dirty.txt"),
            "keep until confirmed\n",
        )
        .unwrap();
        let invalid_archive = archive_pending(
            State(state.clone()),
            Path(task_id.clone()),
            content_headers,
            Bytes::from(r#"{"confirmDiscardDirty":"yes"}"#),
        )
        .await;
        assert_eq!(invalid_archive.status(), StatusCode::BAD_REQUEST);
        let confirmation = archive_pending(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::new(),
        )
        .await;
        assert_eq!(confirmation.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(confirmation.into_body(), 128 * 1024).await.unwrap().as_ref(),
            br#"{"status":"confirmation_required","dirtyFileCount":1,"dirtyFilePaths":["archive-dirty.txt"]}"#,
        );
        assert!(worktree.path.exists());
        let archived = archive_pending(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from(r#"{"confirmDiscardDirty":true}"#),
        )
        .await;
        assert_eq!(archived.status(), StatusCode::OK);
        let archived_raw = to_bytes(archived.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &archived_raw);
        assert!(serde_json::from_slice::<Value>(&archived_raw).unwrap()["archivedAt"].is_string());
        assert!(!worktree.path.exists());
        let unarchived =
            unarchive_pending(State(state.clone()), Path(task_id.clone()), headers.clone()).await;
        assert_eq!(unarchived.status(), StatusCode::OK);
        let unarchived_raw = to_bytes(unarchived.into_body(), 128 * 1024).await.unwrap();
        assert_typescript_task_body(&db_path, &root.join("artifacts"), &unarchived_raw);
        assert!(serde_json::from_slice::<Value>(&unarchived_raw).unwrap()["archivedAt"].is_null());
        let disconnected_configuration: Value = state.with_database(|database| {
            let configuration: String = database
                .connection()
                .query_row(
                    "SELECT configuration_json FROM suplex_tasks WHERE id = ?1",
                    [&disconnected_id],
                    |row| row.get(0),
                )
                .unwrap();
            serde_json::from_str(&configuration).unwrap()
        });
        let disconnected_intent = crate::tasks::worktree::TaskWorktreeIntent {
            task_id: disconnected_id.clone(),
            repository_path: PathBuf::from(
                disconnected_configuration["repositoryPath"]
                    .as_str()
                    .unwrap(),
            ),
            worktree_root: PathBuf::from(
                disconnected_configuration["worktreeRoot"].as_str().unwrap(),
            ),
            branch: disconnected_configuration["branch"]
                .as_str()
                .unwrap()
                .to_owned(),
            starting_sha: disconnected_configuration["startingSha"]
                .as_str()
                .unwrap()
                .to_owned(),
        };
        let disconnected_worktree =
            crate::tasks::worktree::prepare_local_task_worktree(&disconnected_intent, None)
                .unwrap();
        let mut dropped_archive = Box::pin(archive_pending(
            State(state.clone()),
            Path(disconnected_id.clone()),
            headers.clone(),
            Bytes::new(),
        ));
        assert!(matches!(
            std::future::Future::poll(
                dropped_archive.as_mut(),
                &mut Context::from_waker(Waker::noop())
            ),
            Poll::Pending
        ));
        drop(dropped_archive);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let archived: bool = state
                    .with_database(|database| {
                        database.connection().query_row(
                            "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
                            [&disconnected_id],
                            |row| row.get(0),
                        )
                    })
                    .unwrap();
                if archived {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(!disconnected_worktree.path.exists());
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
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_tasks SET company_id = 'task_other_company' WHERE id = ?1",
                    [&task_id],
                )
                .unwrap()
        });
        let revoked = client
            .get(format!(
                "http://127.0.0.1:{}/api/tasks/{}/artifacts/{}",
                address.port(),
                task_id,
                artifact_id
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::NOT_FOUND);
        server.abort();
        let _ = server.await;
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
