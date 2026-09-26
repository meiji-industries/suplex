//! Task reads and local backlog creation. Native wake is connected separately.

use crate::http::access::authorize;
use crate::http::access::with_cookies;
use crate::http::error::ApiError;
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
    tasks::{
        archive::operations::{self as archive, ArchiveOutcome},
        commands, images, response as task_response,
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        return crate::shared::public_failure(error);
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
                Err(error) => with_cookies(ApiError::response(error), cookies),
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
    let result = crate::tasks::creation::create_browser(state, company_id, user_id, request).await;
    let response = match result {
        Ok((created, snapshot)) => (
            if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(snapshot),
        )
            .into_response(),
        Err(error) => error.into_response(),
    };
    with_cookies(response, cookies)
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
    let result = state.with_database(|database| {
        crate::tasks::repository::list_visible(database, &user_id, company_id.as_deref(), archived)
    });
    match result {
        Ok(tasks) => with_cookies(Json(json!({"tasks": tasks})).into_response(), cookies),
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => ApiError::response(error),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        return with_cookies(ApiError::response(error), cookies);
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
            Err(error) => {
                return with_cookies(ApiError::response(error), cookies);
            }
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
                    ApiError::response(Box::new(commands::pull_request_rejection(rejection))),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
                Err(error) => {
                    return with_cookies(ApiError::response(error), cookies);
                }
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
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
        Err(error) => with_cookies(ApiError::response(error), cookies),
    }
}

#[cfg(test)]
include!("../../../tests/routes/tasks.rs");
