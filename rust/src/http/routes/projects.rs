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
    projects::{
        provisioning, repository,
        service::{self, ProjectFailure},
    },
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

/// Query pairs as a JSON object; a repeated key keeps its last value.
fn query_object(uri: &axum::http::Uri) -> serde_json::Value {
    serde_json::Value::Object(
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .map(|(key, value)| (key.into_owned(), json!(value.into_owned())))
            .collect(),
    )
}

pub(super) fn source_error(error: Box<dyn Error>) -> Response {
    match error.downcast::<crate::tasks::sources::TaskSourceFailure>() {
        Ok(failure) => (
            StatusCode::from_u16(failure.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            axum::Json(json!({"error": failure.message, "code": failure.code})),
        )
            .into_response(),
        Err(error) => match error.downcast::<crate::tasks::commands::TaskFailure>() {
            Ok(failure) if failure.code == "experimental_not_ported" => auth::not_ported(),
            Ok(failure) => auth::error(
                StatusCode::from_u16(failure.status_code)
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                &failure.public_message,
            ),
            Err(error) => service_error(error),
        },
    }
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
            Err(source) => return with_cookies(service_error(source), cookies),
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
            Err(source) => return with_cookies(service_error(source), cookies),
        };
    let response = match crate::tasks::sources::discover(&project, &kind).await {
        Ok(sources) => axum::Json(sources).into_response(),
        Err(error) => source_error(error),
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
                service_error(Box::new(ProjectFailure {
                    message: "Company is not active",
                    status_code: 409,
                    findings: vec![repository::Finding {
                        code: "company-inactive".to_owned(),
                        field: "companyId".to_owned(),
                        message: "Project configuration requires an active company".to_owned(),
                    }],
                })),
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
            Err(source) => service_error(source),
        },
        Err(findings) => service_error(Box::new(ProjectFailure {
            message: "Project configuration is invalid",
            status_code: 422,
            findings,
        })),
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
        return service_error(Box::new(ProjectFailure {
            message: "Repository URL is invalid",
            status_code: 422,
            findings: Vec::new(),
        }));
    };
    if coordinate.host != "github" {
        return service_error(Box::new(ProjectFailure {
            message: "Select the repository host and its credentials",
            status_code: 422,
            findings: Vec::new(),
        }));
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
        return service_error(Box::new(error));
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
            Err(error) => return service_error(Box::new(error)),
        }
    };
    if owner.is_empty() {
        return service_error(Box::new(ProjectFailure {
            message: "Repository name is invalid",
            status_code: 422,
            findings: vec![repository::Finding {
                code: "repository-name".to_owned(),
                field: "repositoryName".to_owned(),
                message: "Use workspace/name for a Bitbucket repository".to_owned(),
            }],
        }));
    }
    let name = second.unwrap_or(first);
    let coordinate =
        repository::repository_coordinate(&format!("https://github.com/{owner}/{name}"));
    let base_branch = requested_base_branch.unwrap_or("main").to_owned();
    let Some(coordinate) = coordinate.filter(|_| repository::valid_branch(&base_branch)) else {
        return service_error(Box::new(ProjectFailure {
            message: "Repository name is invalid",
            status_code: 422,
            findings: vec![repository::Finding {
                code: "repository-name".to_owned(),
                field: "repositoryName".to_owned(),
                message: "Use letters, numbers, dots, dashes, and underscores".to_owned(),
            }],
        }));
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
        return service_error(Box::new(error));
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

fn service_error(source: Box<dyn Error>) -> Response {
    match source.downcast::<ProjectFailure>() {
        Ok(failure) => (
            StatusCode::from_u16(failure.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            axum::Json(json!({"error": failure.message, "findings": failure.findings})),
        )
            .into_response(),
        Err(source) => auth::service_error(source),
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
        Err(source) => service_error(source),
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
            Err(source) => service_error(source),
        };
    with_cookies(response, cookies)
}

fn invalid(findings: Vec<repository::Finding>) -> Response {
    service_error(Box::new(ProjectFailure {
        message: "Project configuration is invalid",
        status_code: 422,
        findings,
    }))
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
                service_error(Box::new(ProjectFailure {
                    message: "Company is not active",
                    status_code: 409,
                    findings: vec![repository::Finding {
                        code: "company-inactive".to_owned(),
                        field: "companyId".to_owned(),
                        message: "Project configuration requires an active company".to_owned(),
                    }],
                })),
                cookies,
            );
        }
        Err(source) => return with_cookies(service_error(source), cookies),
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
        Err(source) => service_error(source),
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
        Err(source) => service_error(source),
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
            Err(source) => service_error(source),
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
        Err(source) => service_error(source),
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
        Err(error) => service_error(Box::new(error)),
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
        Err(error) => service_error(Box::new(error)),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path as FilePath,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use axum::{
        body::to_bytes,
        http::{HeaderValue, header},
    };
    use chrono::DateTime;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::{
        identity::{auth as identity_auth, companies},
        platform::database::{OpenMode, SuplexDatabase},
    };

    fn git(args: &[&str], cwd: &FilePath) {
        let output = std::process::Command::new("/usr/bin/git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn project_reads_serialize_normalized_configuration_and_enforce_scope() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            identity_auth::random_hex_id("suplex_project_http").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Projects", now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, integration_json, execution_json, provider_policy_json, agent_task_policy_json, created_at, updated_at) VALUES ('project_http', ?1, 'Project', '/tmp/repository', '/tmp/worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?2, NULL, '{}', ?3, ?3)",
            rusqlite::params![company.id, r#"{"instructions":"Build"}"#, now.to_rfc3339()],
        ).unwrap();
        let member_now = Utc::now();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('project_member', 'Member', 'user_v1_project_member', 'member', 'active', ?1, ?1, 1)",
            [member_now.to_rfc3339()],
        ).unwrap();
        let member_hash = Sha256::digest(b"project_member_token")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        database.connection().execute(
            "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('project_member_session', ?1, 'project_member', ?2, ?3, 1)",
            rusqlite::params![member_hash, (member_now + chrono::Duration::days(1)).to_rfc3339(), member_now.to_rfc3339()],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let malformed = "x".repeat(257);
        let anonymous = get_one(
            State(state.clone()),
            Path(malformed.clone()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::BAD_REQUEST);
        let anonymous_body = to_bytes(anonymous.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&anonymous_body)
                .unwrap()
                .contains("projectId")
        );
        let mut member_headers = HeaderMap::new();
        member_headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=project_member_token"),
        );
        let member_malformed = get_one(
            State(state.clone()),
            Path(malformed),
            member_headers.clone(),
        )
        .await;
        assert_eq!(member_malformed.status(), StatusCode::BAD_REQUEST);
        let member_scoped = get_one(
            State(state.clone()),
            Path("project_http".to_owned()),
            member_headers,
        )
        .await;
        assert_eq!(member_scoped.status(), StatusCode::NOT_FOUND);
        let response = get_one(
            State(state.clone()),
            Path("project_http".to_owned()),
            headers.clone(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body = std::str::from_utf8(&body).unwrap();
        assert!(body.contains(r#""instructions":"Build""#));
        assert!(body.contains(r#""skillDirectories":[]"#));
        let defaults = repository_defaults(
            State(state.clone()),
            Path("project_http".to_owned()),
            headers.clone(),
        )
        .await;
        assert_eq!(defaults.status(), StatusCode::OK);
        let defaults_body = to_bytes(defaults.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(
            &defaults_body[..],
            br#"{"setupCommand":"pnpm install","verificationCommand":"pnpm test"}"#
        );
        let instances = provider_instances(
            State(state.clone()),
            Path("project_http".to_owned()),
            headers.clone(),
        )
        .await;
        assert_eq!(instances.status(), StatusCode::OK);
        let instances_body = to_bytes(instances.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(&instances_body[..], br#"{"instances":[]}"#);
        let response = list_company(State(state), Path(company.id), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&body)
                .unwrap()
                .contains(r#""instructions":"Build""#)
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn admitted_project_create_finishes_after_request_task_is_dropped() {
        let root =
            std::env::temp_dir().join(identity_auth::random_hex_id("suplex_project_drop").unwrap());
        let repositories = root.join("repositories");
        let worktrees = root.join("worktrees");
        let repository = repositories.join("owner/repo");
        let worktree = worktrees.join("owner/repo");
        let bare = root.join("bare.git");
        let new_bare = root.join("owner/new.git");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&worktree).unwrap();
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
                "--bare",
                "--initial-branch=main",
                new_bare.to_str().unwrap(),
            ],
            &root,
        );
        git(&["init", "--quiet", "--initial-branch=main"], &repository);
        git(
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "initial",
            ],
            &repository,
        );
        git(
            &["remote", "add", "origin", bare.to_str().unwrap()],
            &repository,
        );
        git(&["push", "--quiet", "origin", "main"], &repository);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        let rewrite = format!("url.file://{}.insteadOf", bare.display());
        git(
            &[
                "config",
                "--local",
                &rewrite,
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        // GitHub stands in on loopback; Git reaches `https://github.com/` through
        // the file URLs under `root`.
        let github_calls = Arc::new(AtomicUsize::new(0));
        let counted = |calls: &Arc<AtomicUsize>| {
            calls.fetch_add(1, Ordering::SeqCst);
        };
        let api = axum::Router::new()
            .route(
                "/user",
                axum::routing::get({
                    let calls = github_calls.clone();
                    move || async move {
                        counted(&calls);
                        axum::Json(json!({"login": "owner"}))
                    }
                }),
            )
            .route("/user/orgs", axum::routing::get(|| async { axum::Json(json!([])) }))
            .route(
                "/graphql",
                axum::routing::post({
                    let calls = github_calls.clone();
                    move || async move {
                        counted(&calls);
                        axum::Json(json!({"data": {"repositoryOwner": {"repositories": {
                            "nodes": [{"name": "zeta", "defaultBranchRef": null}, {"name": "Alpha", "defaultBranchRef": {"name": "release"}}],
                            "pageInfo": {"hasNextPage": false, "endCursor": null}
                        }}}}))
                    }
                }),
            )
            .route(
                "/repos/{owner}/{name}",
                axum::routing::get({
                    let calls = github_calls.clone();
                    move |Path((owner, name)): Path<(String, String)>| async move {
                        counted(&calls);
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        axum::Json(json!({
                            "full_name": format!("{owner}/{name}"),
                            "html_url": format!("https://github.com/{owner}/{name}")
                        }))
                    }
                }),
            )
            .route(
                "/user/repos",
                axum::routing::post(|| async { axum::Json(json!({})) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });
        let mut database =
            SuplexDatabase::open(&root.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Create", now).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        )
        .with_project_roots(repositories, worktrees)
        .with_project_github(crate::projects::repository::Github {
            api: Some((api_base, "fixture-token".to_owned())),
            git: Some(format!("file://{}/", root.display())),
        });
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "name": "Project", "repositoryPath": repository, "worktreeRoot": worktree,
                "repository": "owner/repo", "baseBranch": "main", "setupCommand": "pnpm install",
                "verificationCommand": "pnpm test", "rootProfileId": "profile_native_root",
                "workerProfileId": "profile_native_worker",
                "integration": {"repository": {"kind": "github"}},
                "execution": {"instructions": "Build carefully"}
            }))
            .unwrap(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let denied = create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            body.clone(),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call before authorization"
        );
        let malformed_company = "x".repeat(257);
        let malformed_create = create(
            State(state.clone()),
            Path(malformed_company.clone()),
            headers.clone(),
            body.clone(),
        )
        .await;
        assert_eq!(malformed_create.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call for invalid paths"
        );
        let malformed_picker = owner_repositories(
            State(state.clone()),
            Path((malformed_company, "bad_name".to_owned())),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(malformed_picker.status(), StatusCode::BAD_REQUEST);
        let malformed_picker_body = to_bytes(malformed_picker.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let malformed_picker_body = std::str::from_utf8(&malformed_picker_body).unwrap();
        assert!(
            malformed_picker_body.find(".companyId").unwrap()
                < malformed_picker_body.find(".owner").unwrap()
        );
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call for invalid paths"
        );
        let denied_owners = repository_owners(
            State(state.clone()),
            Path(company.id.clone()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(denied_owners.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            github_calls.load(Ordering::SeqCst),
            0,
            "no GitHub call before authorization"
        );
        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:4113"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let owners = repository_owners(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(owners.status(), StatusCode::OK);
        let owner_body = to_bytes(owners.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(&owner_body[..], br#"{"owners":["owner"]}"#);
        let repositories = owner_repositories(
            State(state.clone()),
            Path((company.id.clone(), "owner".to_owned())),
            headers.clone(),
        )
        .await;
        assert_eq!(repositories.status(), StatusCode::OK);
        let repositories_body = to_bytes(repositories.into_body(), 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            &repositories_body[..],
            br#"{"repositories":[{"name":"Alpha","defaultBranch":"release"},{"name":"zeta","defaultBranch":"main"}]}"#
        );
        let bad_owner = owner_repositories(
            State(state.clone()),
            Path((company.id.clone(), "bad_name".to_owned())),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(bad_owner.status(), StatusCode::BAD_REQUEST);
        let before = github_calls.load(Ordering::SeqCst);
        let request = tokio::spawn(create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            body,
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while github_calls.load(Ordering::SeqCst) == before {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        let _ = request.await;
        let count = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let count: i64 = state.with_database(|database| database.connection().query_row("SELECT COUNT(*) FROM suplex_projects WHERE repository_identity = 'owner/repo'", [], |row| row.get(0)).unwrap());
                if count > 0 { break count; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.unwrap();
        assert_eq!(
            count, 1,
            "admitted create continues after handler cancellation"
        );
        let stored: (Option<String>, Option<String>) = state.with_database(|database| {
            database.connection().query_row(
                "SELECT integration_json, execution_json FROM suplex_projects WHERE repository_identity = 'owner/repo'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap()
        });
        assert!(stored.0.unwrap().contains(r#""kind":"github""#));
        assert!(
            stored
                .1
                .unwrap()
                .contains(r#""instructions":"Build carefully""#)
        );
        let url_body = Bytes::from(
            serde_json::to_vec(&json!({
                "repositoryUrl": "https://github.com/owner/repo",
                "integration": {"repository": {"kind": "github"}}
            }))
            .unwrap(),
        );
        let duplicate = create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            url_body,
        )
        .await;
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        let duplicate_body = to_bytes(duplicate.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&duplicate_body)
                .unwrap()
                .contains("already-assigned")
        );
        let new_body = Bytes::from_static(br#"{"repositoryName":"owner/new"}"#);
        let created = create(
            State(state.clone()),
            Path(company.id.clone()),
            headers.clone(),
            new_body,
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let created_body = to_bytes(created.into_body(), 1024 * 1024).await.unwrap();
        assert!(
            std::str::from_utf8(&created_body)
                .unwrap()
                .contains(r#""repository":"owner/new""#)
        );
        assert!(root.join("repositories/owner/new/.git").is_dir());
        let short_name = Bytes::from_static(br#"{"repositoryName":"new"}"#);
        let duplicate = create(State(state.clone()), Path(company.id), headers, short_name).await;
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        drop(state);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn issue_search_and_task_sources_follow_the_configured_tracker() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            identity_auth::random_hex_id("suplex_project_sources").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Sources", now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, integration_json, agent_task_policy_json, created_at, updated_at) VALUES ('project_sources', ?1, 'Project', '/tmp/repository', '/tmp/worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', '{}', ?2, ?2)",
            rusqlite::params![company.id, now.to_rfc3339()],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let uri = |value: &str| axum::extract::OriginalUri(value.parse().unwrap());
        let body = |response: Response| async move {
            serde_json::from_slice::<serde_json::Value>(
                &to_bytes(response.into_body(), 1024 * 1024).await.unwrap(),
            )
            .unwrap()
        };
        let long = format!(
            "/api/projects/project_sources/issues?query={}",
            "x".repeat(201)
        );
        let rejected = issues(
            State(state.clone()),
            Path("project_sources".into()),
            uri(&long),
            headers.clone(),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        // An integration without a tracker searches nothing; it never falls back to GitHub Issues.
        let none = issues(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/issues?query=bug"),
            headers.clone(),
        )
        .await;
        assert_eq!(none.status(), StatusCode::OK);
        assert_eq!(body(none).await, json!({"issues": []}));
        let invalid = task_sources(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/task-sources?kind=tag"),
            headers.clone(),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let mismatch = task_sources(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/task-sources?kind=issue"),
            headers.clone(),
        )
        .await;
        assert_eq!(mismatch.status(), StatusCode::OK);
        assert_eq!(
            body(mismatch).await,
            json!({"available": false, "reason": "The source issue does not match the configured tracker.", "sources": []})
        );
        let anonymous = task_sources(
            State(state.clone()),
            Path("project_sources".into()),
            uri("/api/projects/project_sources/task-sources?kind=issue"),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn project_patch_replaces_or_patches_and_checks_git_only_for_repository_changes() {
        let root = std::env::temp_dir()
            .join(identity_auth::random_hex_id("suplex_project_patch").unwrap());
        let repositories = root.join("repositories");
        let worktrees = root.join("worktrees");
        let repository = repositories.join("owner/repo");
        let worktree = worktrees.join("owner/repo");
        let bare = root.join("bare.git");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&worktree).unwrap();
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
        git(&["init", "--quiet", "--initial-branch=main"], &repository);
        git(
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "initial",
            ],
            &repository,
        );
        git(
            &["remote", "add", "origin", bare.to_str().unwrap()],
            &repository,
        );
        git(&["push", "--quiet", "origin", "main"], &repository);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        git(
            &[
                "config",
                "--local",
                &format!("url.file://{}.insteadOf", bare.display()),
                "https://github.com/owner/repo.git",
            ],
            &repository,
        );
        let api_base = crate::projects::repository::fixtures::github_api(
            axum::Router::new()
                .route(
                    "/user",
                    axum::routing::get(|| async { axum::Json(json!({"login": "owner"})) }),
                )
                .route(
                    "/repos/{owner}/{name}",
                    axum::routing::get(|Path((owner, name)): Path<(String, String)>| async move {
                        axum::Json(json!({
                            "full_name": format!("{owner}/{name}"),
                            "html_url": format!("https://github.com/{owner}/{name}")
                        }))
                    }),
                ),
        )
        .await;
        let repository = fs::canonicalize(&repository).unwrap();
        let worktree = fs::canonicalize(&worktree).unwrap();
        let mut database =
            SuplexDatabase::open(&root.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let company =
            companies::create_company(&mut database, &admin.user.id, "Patch", now).unwrap();
        // The stored paths do not exist: a patch that leaves the repository alone must not read Git.
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('project_patch', ?1, 'Project', '/tmp/suplex-missing-repository', '/tmp/suplex-missing-worktrees', 'owner/repo', 'main', 'pnpm install', 'pnpm test', 'profile_native_root', 'profile_native_worker', '{}', ?2, ?2)",
            rusqlite::params![company.id, now.to_rfc3339()],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES ('instance_patch', 'claude-code', 'patch', '/private/patch', ?1, ?1)",
            [now.to_rfc3339()],
        ).unwrap();
        let provider: String = database
            .connection()
            .query_row(
                "SELECT provider FROM suplex_profiles WHERE id = 'profile_native_root'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        )
        .with_project_roots(repositories, worktrees)
        .with_project_github(crate::projects::repository::Github {
            api: Some((api_base, "fixture-token".to_owned())),
            git: None,
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:4113"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let patch = |body: serde_json::Value, headers: HeaderMap| {
            update(
                State(state.clone()),
                Path("project_patch".to_owned()),
                headers,
                Bytes::from(serde_json::to_vec(&body).unwrap()),
            )
        };
        let read = |response: Response| async move {
            let status = response.status();
            let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            )
        };
        let (status, renamed) =
            read(patch(json!({"name": " Renamed again "}), headers.clone()).await).await;
        assert_eq!(status, StatusCode::OK, "{renamed}");
        assert_eq!(renamed["name"], "Renamed again");
        assert_eq!(renamed["repositoryPath"], "/tmp/suplex-missing-repository");
        let (status, empty) = read(patch(json!({}), headers.clone()).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(empty["findings"][0]["code"], "invalid-custom");
        let mut foreign = headers.clone();
        foreign.insert(
            "origin",
            HeaderValue::from_static("https://foreign.example"),
        );
        let (status, invalid) = read(patch(json!({"name": ""}), foreign.clone()).await).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "validation precedes the origin check"
        );
        assert_eq!(invalid["findings"][0]["field"], ".name");
        let (status, _) = read(patch(json!({"name": "Other"}), foreign).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, policy) = read(
            patch(
                json!({"providerPolicy": {"allowedProviders": [provider, "claude-code"], "allowedInstanceIds": ["instance_patch"]}}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{policy}");
        assert_eq!(
            policy["providerPolicy"]["allowedInstanceIds"],
            json!(["instance_patch"])
        );
        let (status, missing) = read(
            patch(
                json!({"providerPolicy": {"allowedProviders": [], "allowedInstanceIds": ["instance_missing"]}}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(missing["findings"][0]["code"], "instance-ineligible");
        let (status, execution) = read(
            patch(
                json!({"execution": {"instructions": "Build carefully"}}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            execution["execution"],
            json!({"instructions":"Build carefully","skillDirectories":[],"environment":{},"mcp":[]})
        );
        // A repository change reads Git and the repository host again.
        let (status, moved) = read(
            patch(
                json!({"repositoryPath": repository, "worktreeRoot": worktree}),
                headers.clone(),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{moved}");
        assert_eq!(moved["repositoryPath"], json!(repository));
        let (status, branch) =
            read(patch(json!({"baseBranch": "missing"}), headers.clone()).await).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(branch["findings"][0]["code"], "repository-unavailable");
        let full = json!({
            "name": "Replaced", "repositoryPath": repository, "worktreeRoot": worktree,
            "repository": "owner/repo", "baseBranch": "main", "setupCommand": "pnpm install",
            "verificationCommand": "pnpm test", "rootProfileId": "profile_native_root",
            "workerProfileId": "profile_native_worker"
        });
        let (status, replaced) = read(patch(full.clone(), headers.clone()).await).await;
        assert_eq!(status, StatusCode::OK, "{replaced}");
        assert_eq!(replaced["name"], "Replaced");
        assert_eq!(
            replaced["execution"]["instructions"], "Build carefully",
            "a full body without execution keeps the stored execution"
        );
        let mut ineligible = full;
        ineligible["rootProfileId"] = json!("profile_native_worker");
        let (status, ineligible) = read(patch(ineligible, headers.clone()).await).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(ineligible["findings"][0]["field"], "rootProfileId");
        let stored = state
            .with_database(|database| service::get(database, &admin.user.id, "project_patch"))
            .unwrap();
        assert_eq!(stored.name, "Replaced");
        let audits: i64 = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'project_updated'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(audits, 5);
        drop(state);
        let _ = fs::remove_dir_all(root);
    }
}
