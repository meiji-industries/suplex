use crate::projects::ProjectError;
use std::error::Error;

use axum::{
    Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use serde_json::json;

use crate::{
    http::{
        AppState,
        contracts::{
            self,
            typed::projects::{self as project_contracts, ProjectCreateBody, RepositoryConnection},
        },
        session,
    },
    projects::{provisioning, repository, service},
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
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.ProjectIdParamsSchema", "projectId", &project_id)
    {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let project =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => project,
            Err(error) => return with_cookies(auth::service_error(error), cookies),
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
        return with_cookies(auth::service_error(error), cookies);
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
fn query_object(uri: &axum::http::Uri) -> serde_json::Value {
    serde_json::Value::Object(
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .map(|(key, value)| (key.into_owned(), json!(value.into_owned())))
            .collect(),
    )
}

/// TypeScript `searchIssues`: the configured tracker, else the project's GitHub Issues.
async fn issues(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.ProjectIdParamsSchema", "projectId", &project_id)
    {
        return *response;
    }
    let query = query_object(&uri)["query"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if query.encode_utf16().count() > 200 {
        return auth::validation_error(vec![json!({"code": "too_big", "path": ["query"]})]);
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let project =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => project,
            Err(source) => return with_cookies(auth::service_error(source), cookies),
        };
    let tracker = match &project.integration {
        Some(integration) => serde_json::to_value(&integration.tracker).unwrap_or_default(),
        None => project.repository.as_ref().map_or(
            serde_json::Value::Null,
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
        Err(error) => auth::service_error(error.to_string().into()),
    };
    with_cookies(response, cookies)
}

/// TypeScript `discoverTaskSources`.
async fn task_sources(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.ProjectIdParamsSchema", "projectId", &project_id)
    {
        return *response;
    }
    let query = query_object(&uri);
    match contracts::validate("projects.TaskSourceQuerySchema", Some(&query)) {
        Some(Ok(_)) => {}
        Some(Err(issues)) => return auth::validation_error(issues),
        None => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
    let kind = query["kind"].as_str().unwrap_or("").to_owned();
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let project =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => project,
            Err(source) => return with_cookies(auth::service_error(source), cookies),
        };
    let response = match crate::tasks::sources::discover(&project, &kind).await {
        Ok(sources) => axum::Json(sources).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

fn validated_path(contract: &str, name: &str, value: &str) -> Result<(), Box<Response>> {
    let mut path = serde_json::Map::new();
    path.insert(name.to_owned(), json!(value));
    match contracts::validate(contract, Some(&serde_json::Value::Object(path))) {
        Some(Ok(_)) => Ok(()),
        Some(Err(issues)) => Err(Box::new(auth::validation_error(issues))),
        None => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn bitbucket_connection(body: &ProjectCreateBody) -> bool {
    let integration = match body {
        ProjectCreateBody::Local(value) => value.integration.as_ref(),
        ProjectCreateBody::ExistingRepository(value) => value.integration.as_ref(),
        ProjectCreateBody::NewRepository(value) => value.integration.as_ref(),
    };
    matches!(
        integration.map(|value| &value.repository),
        Some(RepositoryConnection::Bitbucket { .. })
    )
}

async fn create(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_path("common.CompanyIdParamsSchema", "companyId", &company_id)
    {
        return *response;
    }
    let body = match auth::validated_typed_body(&headers, &body, project_contracts::parse_create) {
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
    let Some(roots) = state.project_roots.clone() else {
        return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
    };
    let admission = state
        .with_database(|database| {
            crate::identity::companies::require_company_access(database, &user_id, &company_id)
        })
        .map_err(auth::service_error);
    match admission {
        Ok(company) if company.status != "active" => {
            return with_cookies(
                auth::service_error(
                    ProjectError::Rejected {
                        message: "Company is not active",
                        status: 409,
                        findings: vec![repository::Finding {
                            code: "company-inactive".to_owned(),
                            field: "companyId".to_owned(),
                            message: "Project configuration requires an active company".to_owned(),
                        }],
                    }
                    .into(),
                ),
                cookies,
            );
        }
        Err(response) => return with_cookies(response, cookies),
        Ok(_) => {}
    }
    if bitbucket_connection(&body) {
        return with_cookies(auth::not_ported(), cookies);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let response = match &body {
            ProjectCreateBody::ExistingRepository(value) => {
                create_from_repository(
                    &state,
                    &roots,
                    &user_id,
                    &company_id,
                    &body,
                    &value.repository_url,
                    value.base_branch.as_deref(),
                )
                .await
            }
            ProjectCreateBody::NewRepository(value) => {
                create_with_new_repository(
                    &state,
                    &roots,
                    &user_id,
                    &company_id,
                    &body,
                    &value.repository_name,
                    value.base_branch.as_deref(),
                )
                .await
            }
            ProjectCreateBody::Local(value) => {
                let fields = [
                    value.name.clone(),
                    value.repository_path.clone(),
                    value.worktree_root.clone(),
                    value.repository.clone(),
                    value.base_branch.clone(),
                    value.setup_command.clone(),
                    value.verification_command.clone(),
                    value.root_profile_id.clone(),
                    value.worker_profile_id.clone(),
                ];
                finish_local_project(&state, &roots, &user_id, &company_id, &body, &fields).await
            }
        };
        let _ = sender.send(with_cookies(response, cookies));
    });
    receiver
        .await
        .unwrap_or_else(|_| auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"))
}

async fn finish_local_project(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    company_id: &str,
    body: &ProjectCreateBody,
    fields: &[String; 9],
) -> Response {
    let input = repository::LocalProjectInput {
        name: &fields[0],
        repository_path: &fields[1],
        worktree_root: &fields[2],
        repository: &fields[3],
        base_branch: &fields[4],
        setup_command: &fields[5],
        verification_command: &fields[6],
    };
    match repository::prepare_local_project(
        &state.project_github,
        &roots.repositories,
        &roots.worktrees,
        &input,
    )
    .await
    {
        Ok(prepared) => match state.with_database(|database| {
            service::create_local(
                database,
                user_id,
                company_id,
                &prepared,
                service::CreateLocalOptions {
                    root_profile_id: &fields[7],
                    worker_profile_id: &fields[8],
                    configuration: Some(body),
                    now: Utc::now(),
                },
            )
        }) {
            Ok(project) => (
                StatusCode::CREATED,
                axum::Json(service::response_project(&project)),
            )
                .into_response(),
            Err(source) => auth::service_error(source),
        },
        Err(findings) => auth::service_error(
            ProjectError::Rejected {
                message: "Project configuration is invalid",
                status: 422,
                findings,
            }
            .into(),
        ),
    }
}

async fn create_from_repository(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    company_id: &str,
    body: &ProjectCreateBody,
    raw_url: &str,
    requested_base_branch: Option<&str>,
) -> Response {
    let Some(coordinate) = repository::repository_coordinate(raw_url) else {
        return auth::service_error(
            ProjectError::new("Repository URL is invalid", 422, Vec::new()).into(),
        );
    };
    if coordinate.host != "github" {
        return auth::service_error(
            ProjectError::new(
                "Select the repository host and its credentials",
                422,
                Vec::new(),
            )
            .into(),
        );
    }
    let base_branch = requested_base_branch.unwrap_or("main").to_owned();
    create_coordinate(
        state,
        roots,
        user_id,
        company_id,
        body,
        coordinate,
        base_branch,
    )
    .await
}

async fn create_coordinate(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    company_id: &str,
    body: &ProjectCreateBody,
    coordinate: repository::Coordinate,
    base_branch: String,
) -> Response {
    let mut parts = coordinate.repository.split('/');
    let owner = parts.next().expect("validated coordinate owner");
    let name = parts.next().expect("validated coordinate name");
    let repository_path = roots.repositories.join(owner).join(name);
    let worktree_root = roots.worktrees.join(owner).join(name);
    if let Err(error) = provisioning::ensure(
        &state.project_github,
        &coordinate.clone_url,
        &coordinate.repository,
        &repository_path,
        &worktree_root,
    )
    .await
    {
        return auth::service_error(Box::new(error));
    }
    let (setup, verification) = provisioning::infer_commands(&repository_path);
    let fields = [
        coordinate.name,
        repository_path.to_string_lossy().into_owned(),
        worktree_root.to_string_lossy().into_owned(),
        coordinate.repository,
        base_branch,
        setup,
        verification,
        "profile_native_root".to_owned(),
        "profile_native_worker".to_owned(),
    ];
    finish_local_project(state, roots, user_id, company_id, body, &fields).await
}

async fn create_with_new_repository(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    company_id: &str,
    body: &ProjectCreateBody,
    repository_name: &str,
    requested_base_branch: Option<&str>,
) -> Response {
    let mut parts = repository_name.trim().split('/');
    let first = parts.next().unwrap_or_default();
    let second = parts.next();
    let owner = if second.is_some() {
        first.to_owned()
    } else {
        match provisioning::github_owners(&state.project_github).await {
            Ok(owners) => owners.into_iter().next().unwrap_or_default(),
            Err(error) => return auth::service_error(Box::new(error)),
        }
    };
    if owner.is_empty() {
        return auth::service_error(
            ProjectError::Rejected {
                message: "Repository name is invalid",
                status: 422,
                findings: vec![repository::Finding {
                    code: "repository-name".to_owned(),
                    field: "repositoryName".to_owned(),
                    message: "Use workspace/name for a Bitbucket repository".to_owned(),
                }],
            }
            .into(),
        );
    }
    let name = second.unwrap_or(first);
    let coordinate =
        repository::repository_coordinate(&format!("https://github.com/{owner}/{name}"));
    let base_branch = requested_base_branch.unwrap_or("main").to_owned();
    let Some(coordinate) = coordinate.filter(|_| repository::valid_branch(&base_branch)) else {
        return auth::service_error(
            ProjectError::Rejected {
                message: "Repository name is invalid",
                status: 422,
                findings: vec![repository::Finding {
                    code: "repository-name".to_owned(),
                    field: "repositoryName".to_owned(),
                    message: "Use letters, numbers, dots, dashes, and underscores".to_owned(),
                }],
            }
            .into(),
        );
    };
    let mut parts = coordinate.repository.split('/');
    let owner = parts.next().expect("validated coordinate owner");
    let name = parts.next().expect("validated coordinate name");
    let repository_path = roots.repositories.join(owner).join(name);
    if let Err(error) = provisioning::create(
        &state.project_github,
        &coordinate,
        &coordinate.clone_url,
        &repository_path,
        &base_branch,
    )
    .await
    {
        return auth::service_error(Box::new(error));
    }
    create_coordinate(
        state,
        roots,
        user_id,
        company_id,
        body,
        coordinate,
        base_branch,
    )
    .await
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
        None => Err(Box::new(auth::error(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        ))),
    }
}

fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
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
        Err(source) => auth::service_error(source),
    };
    with_cookies(response, cookies)
}

async fn list_all(State(state): State<AppState>, headers: HeaderMap) -> Response {
    list_for(state, headers, None)
}

async fn list_company(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.CompanyIdParamsSchema", "companyId", &company_id)
    {
        return *response;
    }
    list_for(state, headers, Some(company_id))
}

async fn get_one(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.ProjectIdParamsSchema", "projectId", &project_id)
    {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response =
        match state.with_database(|database| service::get(database, &user_id, &project_id)) {
            Ok(project) => axum::Json(service::response_project(&project)).into_response(),
            Err(source) => auth::service_error(source),
        };
    with_cookies(response, cookies)
}

fn invalid(findings: Vec<repository::Finding>) -> Response {
    auth::service_error(
        ProjectError::Rejected {
            message: "Project configuration is invalid",
            status: 422,
            findings,
        }
        .into(),
    )
}

/// A full project body replaces the configuration; any other body patches the
/// fields it names.
async fn update(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_path("common.ProjectIdParamsSchema", "projectId", &project_id)
    {
        return *response;
    }
    let parsed = match auth::parsed_body(&headers, &body) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let patch = match project_contracts::parse_patch(parsed.as_ref()) {
        Ok(value) => value,
        Err(contracts::typed::ContractFailure::Issues(findings)) => {
            return crate::http::validation::validation_error_public(findings);
        }
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
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
        let company = crate::identity::companies::require_company_access(
            database,
            &user_id,
            &existing.company_id,
        )?;
        Ok::<_, Box<dyn Error>>((existing, company.status == "active"))
    }) {
        Ok((existing, true)) => existing,
        Ok((_, false)) => {
            return with_cookies(
                auth::service_error(
                    ProjectError::Rejected {
                        message: "Company is not active",
                        status: 409,
                        findings: vec![repository::Finding {
                            code: "company-inactive".to_owned(),
                            field: "companyId".to_owned(),
                            message: "Project configuration requires an active company".to_owned(),
                        }],
                    }
                    .into(),
                ),
                cookies,
            );
        }
        Err(source) => return with_cookies(auth::service_error(source), cookies),
    };
    let response = if let Ok(full) = project_contracts::parse_body(parsed.as_ref()) {
        replace_project(&state, &roots, &user_id, &existing, &full).await
    } else {
        patch_project(&state, &roots, &user_id, &existing, &patch).await
    };
    with_cookies(response, cookies)
}

async fn replace_project(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    existing: &service::Project,
    body: &project_contracts::LocalProjectCreate,
) -> Response {
    let integration = body.integration.as_ref().or(existing.integration.as_ref());
    if matches!(
        integration.map(|value| &value.repository),
        Some(RepositoryConnection::Bitbucket { .. })
    ) {
        return auth::not_ported();
    }
    let input = repository::LocalProjectInput {
        name: &body.name,
        repository_path: &body.repository_path,
        worktree_root: &body.worktree_root,
        repository: &body.repository,
        base_branch: &body.base_branch,
        setup_command: &body.setup_command,
        verification_command: &body.verification_command,
    };
    let prepared = match repository::prepare_local_project(
        &state.project_github,
        &roots.repositories,
        &roots.worktrees,
        &input,
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(findings) => return invalid(findings),
    };
    match state.with_database(|database| {
        service::update_local(database, user_id, existing, &prepared, body, Utc::now())
    }) {
        Ok(project) => axum::Json(service::response_project(&project)).into_response(),
        Err(source) => auth::service_error(source),
    }
}

async fn patch_project(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    existing: &service::Project,
    patch: &project_contracts::ProjectPatch,
) -> Response {
    let plan = service::plan_patch(existing, patch);
    let mut findings = plan.findings;
    let mut paths = (
        plan.candidate.repository_path.clone(),
        plan.candidate.worktree_root.clone(),
    );
    if plan.repository_changed {
        let Some((repository_path, worktree_root, errors)) = service::validate_patched_repository(
            &state.project_github,
            (&roots.repositories, &roots.worktrees),
            &plan.candidate,
            patch.worktree_root.is_some(),
            plan.remote_changed,
        )
        .await
        else {
            return auth::not_ported();
        };
        paths = (repository_path, worktree_root);
        findings.extend(errors);
    }
    if !findings.is_empty() {
        return invalid(findings);
    }
    match state.with_database(|database| {
        service::apply_patch(
            database,
            user_id,
            existing,
            patch,
            (&paths.0, &paths.1),
            Utc::now(),
        )
    }) {
        Ok(project) => axum::Json(service::response_project(&project)).into_response(),
        Err(source) => auth::service_error(source),
    }
}

async fn repository_defaults(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.ProjectIdParamsSchema", "projectId", &project_id)
    {
        return *response;
    }
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
            Err(source) => auth::service_error(source),
        };
    with_cookies(response, cookies)
}

async fn provider_instances(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.ProjectIdParamsSchema", "projectId", &project_id)
    {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state
        .with_database(|database| service::list_provider_instances(database, &user_id, &project_id))
    {
        Ok(instances) => axum::Json(json!({"instances": instances})).into_response(),
        Err(source) => auth::service_error(source),
    };
    with_cookies(response, cookies)
}

async fn repository_owners(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_path("common.CompanyIdParamsSchema", "companyId", &company_id)
    {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = state
        .with_database(|database| {
            crate::identity::companies::require_company_access(database, &user_id, &company_id)
        })
        .map(|_| ())
        .map_err(auth::service_error)
    {
        return with_cookies(response, cookies);
    }
    let result = provisioning::github_owners(&state.project_github).await;
    let response = match result {
        Ok(owners) => axum::Json(json!({"owners": owners})).into_response(),
        Err(error) => auth::service_error(Box::new(error)),
    };
    with_cookies(response, cookies)
}

async fn owner_repositories(
    State(state): State<AppState>,
    Path((company_id, owner)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let mut issues = match contracts::validate(
        "common.CompanyIdParamsSchema",
        Some(&json!({"companyId": company_id})),
    ) {
        Some(Ok(_)) => Vec::new(),
        Some(Err(issues)) => issues,
        None => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let valid_owner = owner.len() <= 39
        && owner
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && owner
            .bytes()
            .skip(1)
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !valid_owner {
        let pattern = "/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/";
        issues.push(json!({
            "origin": "string", "code": "invalid_format", "format": "regex", "pattern": pattern,
            "path": ["owner"], "message": format!("Invalid string: must match pattern {pattern}")
        }));
    }
    if !issues.is_empty() {
        return auth::validation_error(issues);
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = state
        .with_database(|database| {
            crate::identity::companies::require_company_access(database, &user_id, &company_id)
        })
        .map(|_| ())
        .map_err(auth::service_error)
    {
        return with_cookies(response, cookies);
    }
    let result = provisioning::github_repositories(&state.project_github, &owner).await;
    let response = match result {
        Ok(repositories) => axum::Json(json!({"repositories": repositories})).into_response(),
        Err(error) => auth::service_error(Box::new(error)),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/projects.rs");
