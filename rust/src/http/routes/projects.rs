use crate::http::access::authorize;
use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use std::error::Error;

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{
            Contract,
            auth::CompanyIdParams,
            projects::{
                IssueSearchQuery, LocalProjectCreate, OwnerParams, ProjectCreateBody,
                ProjectIdParams, ProjectPatch, TaskSourceQuery,
            },
        },
        session,
        validation::{Valid, ValidPath, checked, valid},
    },
    projects::{provisioning, service},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects", get(list_all))
        .route(
            "/api/companies/{company_id}/projects",
            get(list_company).post(create),
        )
        .route(
            "/api/companies/{company_id}/repository-owners",
            get(repository_owners),
        )
        .route(
            "/api/companies/{company_id}/repository-owners/{owner}/repositories",
            get(owner_repositories),
        )
        .route("/api/projects/{project_id}", get(get_one).patch(update))
        .route(
            "/api/projects/{project_id}/repository-status",
            get(repository_status),
        )
        .route(
            "/api/projects/{project_id}/repository-defaults",
            get(repository_defaults),
        )
        .route(
            "/api/projects/{project_id}/provider-instances",
            get(provider_instances),
        )
        .route("/api/projects/{project_id}/issues", get(issues))
        .route("/api/projects/{project_id}/task-sources", get(task_sources))
}

async fn repository_status(
    State(state): State<AppState>,
    ValidPath(ProjectIdParams { project_id }): ValidPath<ProjectIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let project =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => project,
            Err(error) => {
                return with_cookies(ApiError::response(error), cookies);
            }
        };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        crate::projects::connection::check(
            &state.project_github,
            &project.repository_path,
            project.repository.as_deref(),
            &project.base_branch,
        ),
    )
    .await;
    if let Err(error) =
        state.with_database(|database| service::get(database, &user_id, &project_id))
    {
        return with_cookies(ApiError::response(error), cookies);
    }
    let response = match result {
        Ok(result) => axum::Json(result).into_response(),
        Err(_) => axum::Json(json!({"status":"unavailable", "message":"Repository check timed out. Try again.", "method":"device", "originRepository":null})).into_response(),
    };
    let mut response = with_cookies(response, cookies);
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response
}

/// Query pairs as a JSON object; a repeated key keeps its last value.
fn query_object(uri: &axum::http::Uri) -> Value {
    Value::Object(
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .map(|(key, value)| (key.into_owned(), json!(value.into_owned())))
            .collect(),
    )
}

/// The configured tracker, else the project's GitHub Issues.
async fn issues(
    State(state): State<AppState>,
    ValidPath(ProjectIdParams { project_id }): ValidPath<ProjectIdParams>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    headers: HeaderMap,
) -> Response {
    let query = match valid::<IssueSearchQuery>(query_object(&uri)) {
        Ok(search) => search.query,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let project =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => project,
            Err(source) => {
                return with_cookies(ApiError::response(source), cookies);
            }
        };
    let tracker = match &project.integration {
        Some(integration) => serde_json::to_value(&integration.tracker).unwrap_or_default(),
        None => project.repository.as_ref().map_or(
            Value::Null,
            |repository| json!({"kind": "github", "repository": repository}),
        ),
    };
    if tracker.is_null() {
        return with_cookies(axum::Json(json!({"issues": []})).into_response(), cookies);
    }
    let found = async {
        crate::integrations::issue_tracker::IssueTracker::new(&tracker)
            .await?
            .search(&query)
            .await
    };
    let response = match found.await {
        Ok(issues) => axum::Json(json!({"issues": issues})).into_response(),
        Err(error) => ApiError::response(error.to_string().into()),
    };
    with_cookies(response, cookies)
}

async fn task_sources(
    State(state): State<AppState>,
    ValidPath(ProjectIdParams { project_id }): ValidPath<ProjectIdParams>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    headers: HeaderMap,
) -> Response {
    let kind = match valid::<TaskSourceQuery>(query_object(&uri)) {
        Ok(query) => query.kind,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let project =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => project,
            Err(source) => {
                return with_cookies(ApiError::response(source), cookies);
            }
        };
    let response = match crate::tasks::sources::discover(&project, &kind).await {
        Ok(sources) => axum::Json(sources).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn create(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
    Valid(body): Valid<ProjectCreateBody>,
) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(roots) = state.project_roots.clone() else {
        return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
    };
    if let Err(error) = state
        .with_database(|database| service::admit_configuration(database, &user_id, &company_id))
    {
        return with_cookies(ApiError::response(error), cookies);
    }
    let operation = tokio::spawn(async move {
        let response =
            match service::create_project(&state, &roots, &user_id, &company_id, &body).await {
                Ok(project) => (
                    StatusCode::CREATED,
                    axum::Json(service::response_project(&project)),
                )
                    .into_response(),
                Err(error) => ApiError::response(error),
            };
        with_cookies(response, cookies)
    });
    operation
        .await
        .unwrap_or_else(|_| auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"))
}

fn list_for(state: AppState, headers: HeaderMap, company_id: Option<String>) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result =
        state.with_database(|database| service::list(database, &user_id, company_id.as_deref()));
    let response = match result {
        Ok(projects) => axum::Json(json!({"projects": projects.iter().map(service::response_project).collect::<Vec<_>>() })).into_response(),
        Err(source) => ApiError::response(source),
    };
    with_cookies(response, cookies)
}

async fn list_all(State(state): State<AppState>, headers: HeaderMap) -> Response {
    list_for(state, headers, None)
}

async fn list_company(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
) -> Response {
    list_for(state, headers, Some(company_id))
}

async fn get_one(
    State(state): State<AppState>,
    ValidPath(ProjectIdParams { project_id }): ValidPath<ProjectIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => axum::Json(service::response_project(&project)).into_response(),
            Err(source) => ApiError::response(source),
        };
    with_cookies(response, cookies)
}

/// A full project body replaces the configuration; any other body patches the
/// fields it names.
async fn update(
    State(state): State<AppState>,
    ValidPath(ProjectIdParams { project_id }): ValidPath<ProjectIdParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match auth::parsed_body(&headers, &body) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let patch = match checked(ProjectPatch::parse(parsed.as_ref())) {
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
    let Some(roots) = state.project_roots.clone() else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    let existing = match state.with_database(|database| {
        let existing = service::get(database, &user_id, &project_id)?;
        service::admit_configuration(database, &user_id, &existing.company_id)?;
        Ok::<_, Box<dyn Error>>(existing)
    }) {
        Ok(existing) => existing,
        Err(error) => {
            return with_cookies(ApiError::response(error), cookies);
        }
    };
    let response = if let Ok(full) = LocalProjectCreate::parse(parsed.as_ref()) {
        service::replace_project(&state, &roots, &user_id, &existing, &full).await
    } else {
        service::patch_project(&state, &roots, &user_id, &existing, &patch).await
    };
    let response = match response {
        Ok(project) => axum::Json(service::response_project(&project)).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn repository_defaults(
    State(state): State<AppState>,
    ValidPath(ProjectIdParams { project_id }): ValidPath<ProjectIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => {
                let (setup_command, verification_command) =
                    provisioning::infer_commands(std::path::Path::new(&project.repository_path));
                axum::Json(json!({
                    "setupCommand": setup_command,
                    "verificationCommand": verification_command
                }))
                .into_response()
            }
            Err(source) => ApiError::response(source),
        };
    with_cookies(response, cookies)
}

async fn provider_instances(
    State(state): State<AppState>,
    ValidPath(ProjectIdParams { project_id }): ValidPath<ProjectIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state
        .with_database(|database| service::list_provider_instances(database, &user_id, &project_id))
    {
        Ok(instances) => axum::Json(json!({"instances": instances})).into_response(),
        Err(source) => ApiError::response(source),
    };
    with_cookies(response, cookies)
}

async fn repository_owners(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = state
        .with_database(|database| {
            crate::identity::companies::require_company_access(database, &user_id, &company_id)
        })
        .map(|_| ())
        .map_err(ApiError::response)
    {
        return with_cookies(response, cookies);
    }
    let result = provisioning::github_owners(&state.project_github).await;
    let response = match result {
        Ok(owners) => axum::Json(json!({"owners": owners})).into_response(),
        Err(error) => ApiError::response(Box::new(error)),
    };
    with_cookies(response, cookies)
}

async fn owner_repositories(
    State(state): State<AppState>,
    ValidPath(OwnerParams { company_id, owner }): ValidPath<OwnerParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = state
        .with_database(|database| {
            crate::identity::companies::require_company_access(database, &user_id, &company_id)
        })
        .map(|_| ())
        .map_err(ApiError::response)
    {
        return with_cookies(response, cookies);
    }
    let result = provisioning::github_repositories(&state.project_github, &owner).await;
    let response = match result {
        Ok(repositories) => axum::Json(json!({"repositories": repositories})).into_response(),
        Err(error) => ApiError::response(Box::new(error)),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/projects.rs");
