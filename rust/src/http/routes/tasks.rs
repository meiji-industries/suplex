//! Task reads and local backlog creation. Native wake is connected separately.

use crate::http::access::authorize;
use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use crate::identity::IdentityError;
use crate::platform::database::SuplexDatabase;
use crate::shared::PublicFailure;
use crate::tasks::TaskError;
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, OriginalUri, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    coordination::workflow_records::normalize_workflow_input,
    http::{
        AppState,
        contracts::typed::{
            Contract,
            agent_api::query_object,
            auth::CompanyIdParams,
            task_answers::TaskAnswerBody,
            tasks::{
                ArchivedQuery, TaskAgentSelectionBody, TaskArchiveBody, TaskContinueDeliveryBody,
                TaskCoordinatorReplacementBody, TaskCreateBody, TaskDependenciesBody,
                TaskDetailsBody, TaskIdParams, TaskIssueBody, TaskNoteBody, TaskRenameBody,
                TaskWorkerReplacementBody,
            },
        },
        session,
        validation::{Valid, ValidPath, checked, parsed_body, valid},
    },
    identity::companies,
    tasks::{
        archive::operations::{self as archive, ArchiveOutcome},
        commands, images, response as task_response,
    },
};

use super::auth;

type TaskPath = ValidPath<TaskIdParams>;

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
            "/api/tasks/{task_id}/force-start",
            axum::routing::post(force_start_pending),
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

/// Validate first, then check the request origin and session.
fn admit(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
) -> Result<(String, Vec<String>), Box<Response>> {
    if !session::csrf_allowed(&state.session_config, headers, method, false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    authorize(state, headers)
}

/// Run a user command on the task, then return the task it changed.
fn task_command<T>(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    id: &str,
    command: impl FnOnce(&mut SuplexDatabase, &str) -> Result<T, Box<dyn Error>>,
) -> Response {
    let (user_id, cookies) = match admit(state, headers, method) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        command(database, &user_id)?;
        task_response::get(database, id)?.ok_or_else(|| format!("task {id} disappeared").into())
    });
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(ApiError::response(error), cookies),
    }
}

/// Wake the task host for a task a command changed.
fn waker(state: &AppState) -> impl FnOnce(String) + Send + 'static {
    let host = state.task_host.clone();
    move |id| {
        if let Some(host) = host {
            host.wake(id);
        }
    }
}

/// TypeScript refresh: read the task, then wake the host to observe it again.
async fn refresh(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match admit(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        commands::user_task_configuration(database, &user_id, &id)?;
        task_response::get(database, &id)?.ok_or_else(|| "refreshed task disappeared".into())
    });
    match result {
        Ok(task) => {
            waker(&state)(id);
            with_cookies(Json(task).into_response(), cookies)
        }
        Err(error) => with_cookies(ApiError::response(error), cookies),
    }
}

async fn unarchive_pending(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        archive::unarchive_local_task(database, user_id, &id)
    })
}

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
struct ArchiveConfirmation {
    #[ts(type = "\"confirmation_required\"")]
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
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<Option<TaskArchiveBody>>,
) -> Response {
    let (user_id, cookies) = match admit(&state, &headers, "POST") {
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
        archive::archive_local_task(
            &database_path,
            &user_id,
            &id,
            request.unwrap_or_default().confirm_discard_dirty,
        )
        .map_err(archive_error)
    });
    let Ok(result) = operation.await else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
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
            state.host_terminals.close_task(&task.id, false);
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

async fn create(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error":"Request is too large","findings":[{"code":"request-too-large","field":"images","message":"Attach fewer or smaller images and submit again"}]}))).into_response();
        }
        Err(_) => return auth::error(StatusCode::BAD_REQUEST, "Invalid request"),
    };
    let mut parsed = match parsed_body(&headers, &body) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    // Apply workflow defaults before validating the request.
    if let Some(Value::Object(fields)) = parsed.as_mut()
        && let Err(message) = normalize_workflow_input(fields, true)
    {
        return auth::error(StatusCode::UNPROCESSABLE_ENTITY, &message);
    }
    let request = match checked(TaskCreateBody::parse(parsed.as_ref())) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match admit(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    crate::billing::observe(&state, crate::billing::Limit::MonthlyTasks).await;
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
    uri: &axum::http::Uri,
    company_id: Option<String>,
) -> Response {
    let archived = match valid::<ArchivedQuery>(query_object(uri.query())) {
        Ok(query) => query.archived.as_deref() == Some("true"),
        Err(response) => return *response,
    };
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
    list_for(state, headers, &uri, None)
}

async fn list_company(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    list_for(state, headers, &uri, Some(company_id))
}

async fn get_one(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        crate::tasks::authorize_task(database, &user_id, &id)?;
        task_response::get(database, &id)?.ok_or_else(|| TaskError::not_found().into())
    });
    let mut response = match result {
        Ok(task) => Json(task).into_response(),
        Err(error) => ApiError::response(error),
    };
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    with_cookies(response, cookies)
}

async fn update_details(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskDetailsBody>,
) -> Response {
    task_command(&state, &headers, "PATCH", &id, |database, user_id| {
        commands::update_user_task_details(database, user_id, &id, &request, Utc::now())
    })
}

async fn rename(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskRenameBody>,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::rename_user_task(database, user_id, &id, &request, Utc::now())
    })
}

async fn start_pending(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
) -> Response {
    crate::billing::observe(&state, crate::billing::Limit::RunningTasks).await;
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        crate::tasks::authorize_task(database, user_id, &id)?;
        commands::start_user_task(database, user_id, &id, Utc::now(), waker(&state))
    })
}

async fn force_start_pending(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
) -> Response {
    crate::billing::observe(&state, crate::billing::Limit::RunningTasks).await;
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        crate::tasks::authorize_task(database, user_id, &id)?;
        commands::force_start_user_task(database, user_id, &id, Utc::now(), waker(&state))
    })
}

async fn cancel_pending(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::cancel_user_task(database, user_id, &id, Utc::now(), waker(&state))
    })
}

async fn disarm_pending(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::disarm_user_task(database, user_id, &id, Utc::now())
    })
}

async fn set_dependencies(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskDependenciesBody>,
) -> Response {
    let (user_id, cookies) = match admit(&state, &headers, "PUT") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    // GitHub observes each pull request prerequisite before any write.
    let repository = match state.with_database(|database| -> Result<String, Box<dyn Error>> {
        for dependency in &request.depends_on {
            commands::user_task_configuration(database, &user_id, dependency)?;
        }
        let configuration = commands::user_task_configuration(database, &user_id, &id)?;
        Ok(configuration["repository"]
            .as_str()
            .unwrap_or("")
            .to_owned())
    }) {
        Ok(repository) => repository,
        Err(error) => return with_cookies(ApiError::response(error), cookies),
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
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        commands::set_user_task_dependencies(
            database,
            &user_id,
            &id,
            &request,
            &pull_requests,
            Utc::now(),
        )?;
        task_response::get(database, &id)?.ok_or_else(|| "blocked task disappeared".into())
    });
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(ApiError::response(error), cookies),
    }
}

async fn set_issue(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskIssueBody>,
) -> Response {
    let (user_id, cookies) = match admit(&state, &headers, "PATCH") {
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
                Err(error) => return with_cookies(ApiError::response(error), cookies),
            }
        }
    };
    let result = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        commands::set_user_task_issue(database, &user_id, &id, resolved.as_ref(), Utc::now())?;
        task_response::get(database, &id)?.ok_or_else(|| "linked task disappeared".into())
    });
    match result {
        Ok(task) => with_cookies(Json(task).into_response(), cookies),
        Err(error) => with_cookies(ApiError::response(error), cookies),
    }
}

async fn select_agent(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskAgentSelectionBody>,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::select_user_task_agent(
            database,
            user_id,
            &id,
            &request,
            Utc::now(),
            waker(&state),
        )
    })
}

async fn continue_delivery(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskContinueDeliveryBody>,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::continue_user_delivery(database, user_id, &id, &request, waker(&state))
    })
}

async fn send_note(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskNoteBody>,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::send_user_note(database, user_id, &id, &request, Utc::now(), waker(&state))
    })
}

async fn answer_pending(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskAnswerBody>,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        let wake = waker(&state);
        match request {
            TaskAnswerBody::Answer(answer) => {
                commands::answer_user_task(database, user_id, &id, &answer, Utc::now(), wake)
            }
            TaskAnswerBody::LimitDecision(decision) => commands::answer_user_task_limit(
                database,
                user_id,
                &id,
                &decision,
                Utc::now(),
                wake,
            ),
        }
    })
}

async fn replace_worker(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskWorkerReplacementBody>,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::replace_user_worker(database, user_id, &id, &request, Utc::now(), waker(&state))
    })
}

async fn replace_coordinator(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id: id }): TaskPath,
    headers: HeaderMap,
    Valid(request): Valid<TaskCoordinatorReplacementBody>,
) -> Response {
    task_command(&state, &headers, "POST", &id, |database, user_id| {
        commands::replace_user_coordinator(
            database,
            user_id,
            &id,
            &request,
            Utc::now(),
            waker(&state),
        )
    })
}

#[cfg(test)]
include!("../../../tests/routes/tasks.rs");
