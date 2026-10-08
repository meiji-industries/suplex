//! Task creation orchestration shared by browser and agent entry points.
use crate::{
    http::{AppState, contracts::typed::tasks as task_contracts},
    identity::companies,
    projects::{git, service as projects},
    shared::{PublicFailure, public_failure},
    tasks::{
        TaskError, commands,
        images::{self, DecodedTaskImage},
        response::{self as task_response, TaskResponse},
    },
};
use chrono::Utc;
use serde_json::Value;
use std::error::Error;

pub async fn create_browser(
    state: AppState,
    company_id: String,
    user_id: String,
    request: task_contracts::TaskCreateBody,
) -> Result<(bool, TaskResponse), PublicFailure> {
    let (project, existing) = {
        let admission =
            state.with_database(|database| -> Result<_, Box<dyn Error + Send + Sync>> {
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
            Err(error) => return Err(public_failure(error)),
        }
    };
    if let Some((status, id, snapshot)) = existing {
        if status == crate::tasks::control::TaskStatus::Active
            && let Some(host) = &state.task_host
        {
            host.wake(id);
        }
        return Ok((false, snapshot));
    }
    let Some(project) = project else {
        return Err(PublicFailure::internal());
    };
    let Some(repository) = project.repository.clone() else {
        return Err(PublicFailure::new(
            422,
            "Configure the project repository before creating a task",
        ));
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
                return Err(public_failure(Box::new(commands::pull_request_rejection(
                    rejection,
                ))));
            }
        };
    let profiles = {
        let selected = state.with_database(|database| {
            commands::select_local_profiles(database, &project, &request)
        });
        match selected {
            Ok(profiles) => profiles,
            Err(error) => return Err(public_failure(error)),
        }
    };
    let decoded_images = match request
        .images
        .iter()
        .map(images::decode_task_image)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(images) => images,
        Err(failure) => return Err(public_failure(Box::new(failure))),
    };
    let operation = tokio::spawn(finish_admitted_create(
        state,
        AdmittedCreate {
            company_id,
            user_id,
            project,
            request,
            profiles,
            decoded_images,
            pull_requests,
        },
    ));
    match operation.await {
        Ok(response) => response,
        Err(_) => Err(PublicFailure::internal()),
    }
}

/// Once authorization and policy admit creation, the Git fetch and database
/// transaction keep running even if the HTTP waiter goes away.
struct AdmittedCreate {
    company_id: String,
    user_id: String,
    project: projects::Project,
    request: task_contracts::TaskCreateBody,
    profiles: commands::LocalProfiles,
    decoded_images: Vec<DecodedTaskImage>,
    pull_requests: Vec<Value>,
}

async fn finish_admitted_create(
    state: AppState,
    admitted: AdmittedCreate,
) -> Result<(bool, TaskResponse), PublicFailure> {
    let AdmittedCreate {
        company_id,
        user_id,
        project,
        request,
        profiles,
        decoded_images,
        pull_requests,
    } = admitted;
    let (pinned, base_sha) = capture(&state, &project, &request, |error, _| error)
        .await
        .map_err(public_failure)?;
    let now = Utc::now();
    let host = state.task_host.clone();
    let written = state.with_database(|database| -> Result<_, Box<dyn Error + Send + Sync>> {
        let mut prepared = commands::prepare_local_user_task(
            &company_id,
            &user_id,
            &project,
            &request,
            profiles,
            &base_sha,
            now,
        )?;
        crate::tasks::sources::apply(&mut prepared, pinned)?;
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
    written.map_err(public_failure)
}

/// Both entry points pin the source and capture Git before entering their
/// principal-specific writing transaction. Agent source failures carry field details.
pub async fn capture(
    state: &AppState,
    project: &projects::Project,
    request: &task_contracts::TaskCreateBody,
    source_error: impl FnOnce(
        Box<dyn Error + Send + Sync>,
        Option<&Value>,
    ) -> Box<dyn Error + Send + Sync>,
) -> crate::platform::database::DatabaseResult<(super::sources::CreationSource, String)> {
    let selector = request
        .source
        .as_ref()
        .map(serde_json::to_value)
        .transpose()?;
    let issue = request
        .issue
        .as_ref()
        .map(|issue| issue.as_ref().map(serde_json::to_value).transpose())
        .transpose()?;
    let source = super::sources::creation_source(
        project,
        &request.title,
        &request.description,
        selector.as_ref(),
        issue.as_ref().map(Option::as_ref),
    )
    .await
    .map_err(|error| source_error(error, selector.as_ref()))?;
    let host = match project
        .integration
        .as_ref()
        .map(|integration| &integration.repository)
    {
        Some(crate::http::contracts::typed::projects::RepositoryConnection::Bitbucket {
            ..
        }) => "bitbucket",
        _ => "github",
    };
    let base_sha = git::capture_local_task_heads(
        &state.project_github,
        std::path::Path::new(&project.repository_path),
        &project.base_branch,
        host,
    )
    .await
    .map_err(|findings| {
        crate::projects::ProjectError::new(
            "Project configuration could not be captured",
            422,
            findings,
        )
    })?;
    Ok((source, base_sha))
}
