use super::{provisioning, git};
use crate::http::{AppState, contracts::typed::projects::RepositoryConnection};
use crate::identity::IdentityError;
use crate::projects::ProjectError;
use crate::shared::ids::random_hex_id;
use crate::shared::time::rfc3339_millis;
use std::error::Error;

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    http::contracts::typed::projects::{
        self as project_contracts, LocalProjectCreate, ProjectAgentTaskPolicy, ProjectCreateBody,
        ProjectExecution, ProjectIntegration, ProjectPatch, ProjectProviderPolicy, ProjectResponse,
    },
    identity::{auth, companies},
    platform::database::{DatabaseResult, SuplexDatabase},
};

use super::git::{Finding, PreparedLocalProject};

fn failure(message: &'static str, status: u16, findings: Vec<Finding>) -> Box<ProjectError> {
    ProjectError::new(message, status, findings).into()
}

fn finding(code: &str, field: &str, message: &str) -> Finding {
    Finding {
        code: code.to_owned(),
        field: field.to_owned(),
        message: message.to_owned(),
    }
}

fn project_id() -> DatabaseResult<String> {
    Ok(format!("project_{}", crate::shared::ids::random_hex(12)?))
}

/// Internal database view. HTTP output still requires the full project
/// integration, execution, provider policy, and response contracts.
#[derive(Clone, Debug)]
pub struct Project {
    pub integration: Option<ProjectIntegration>,
    pub execution: Option<ProjectExecution>,
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub repository_path: String,
    pub worktree_root: String,
    pub repository: Option<String>,
    pub base_branch: String,
    pub setup_command: String,
    pub verification_command: String,
    pub root_profile_id: String,
    pub worker_profile_id: String,
    pub agent_task_policy: ProjectAgentTaskPolicy,
    pub provider_policy: Option<ProjectProviderPolicy>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn response_project(project: &Project) -> ProjectResponse {
    ProjectResponse {
        integration: project.integration.clone(),
        execution: project.execution.clone(),
        id: project.id.clone(),
        company_id: project.company_id.clone(),
        name: project.name.clone(),
        repository_path: project.repository_path.clone(),
        worktree_root: project.worktree_root.clone(),
        repository: project.repository.clone(),
        base_branch: project.base_branch.clone(),
        setup_command: project.setup_command.clone(),
        verification_command: project.verification_command.clone(),
        root_profile_id: project.root_profile_id.clone(),
        worker_profile_id: project.worker_profile_id.clone(),
        agent_task_policy: project.agent_task_policy.clone(),
        provider_policy: project.provider_policy.clone(),
        created_at: project.created_at.clone(),
        updated_at: project.updated_at.clone(),
    }
}

struct StoredProject {
    integration_json: Option<String>,
    execution_json: Option<String>,
    provider_policy_json: Option<String>,
    id: String,
    company_id: String,
    name: String,
    repository_path: String,
    worktree_root: String,
    repository: Option<String>,
    base_branch: String,
    setup_command: String,
    verification_command: String,
    root_profile_id: String,
    worker_profile_id: String,
    agent_task_policy_json: String,
    created_at: String,
    updated_at: String,
}

const SELECTION: &str = "SELECT p.integration_json, p.execution_json, p.provider_policy_json, p.id, p.company_id, p.name, p.repository_path, p.worktree_root, p.repository_identity, p.base_branch, p.setup_command, p.verification_command, p.root_profile_id, p.worker_profile_id, p.agent_task_policy_json, p.created_at, p.updated_at FROM suplex_projects p";

fn stored(row: &Row<'_>) -> rusqlite::Result<StoredProject> {
    Ok(StoredProject {
        integration_json: row.get(0)?,
        execution_json: row.get(1)?,
        provider_policy_json: row.get(2)?,
        id: row.get(3)?,
        company_id: row.get(4)?,
        name: row.get(5)?,
        repository_path: row.get(6)?,
        worktree_root: row.get(7)?,
        repository: row.get(8)?,
        base_branch: row.get(9)?,
        setup_command: row.get(10)?,
        verification_command: row.get(11)?,
        root_profile_id: row.get(12)?,
        worker_profile_id: row.get(13)?,
        agent_task_policy_json: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn default_policy(root_profile_id: &str, worker_profile_id: &str) -> Value {
    json!({
        "workflowIds": ["workflow_native_standard"],
        "defaultWorkflowId": "workflow_native_standard",
        "templateIds": [],
        "rootProfileIds": [root_profile_id],
        "workerProfileIds": [worker_profile_id],
        "advisorProfileIds": { "reviewer": [], "planner_a": [], "planner_b": [], "rater": [] },
        "deliveryTarget": "pull_request_draft",
        "runProjectTests": true,
        "visualEvidence": "off"
    })
}

fn json_text<T: Serialize>(value: &T) -> DatabaseResult<String> {
    Ok(crate::shared::js_json::stringify(&serde_json::to_value(
        value,
    )?))
}

fn profile_provider(
    database: &SuplexDatabase,
    profile_id: &str,
    role: &str,
) -> DatabaseResult<Option<(String, Option<String>)>> {
    database.connection().query_row(
        "SELECT provider, provider_instance_id FROM suplex_profiles WHERE id = ?1 AND role = ?2 AND archived_at IS NULL",
        params![profile_id, role],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(Into::into)
}

fn validate_provider_policy(
    database: &SuplexDatabase,
    policy: &ProjectProviderPolicy,
    root_profile_id: &str,
    worker_profile_id: &str,
) -> DatabaseResult<()> {
    for instance_id in &policy.allowed_instance_ids {
        let exists: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_provider_instances WHERE id = ?1)",
            [instance_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(failure(
                "Project configuration is invalid",
                422,
                vec![finding(
                    "instance-ineligible",
                    "providerPolicy",
                    "Select an existing provider login",
                )],
            ));
        }
    }
    for (role, profile_id) in [("root", root_profile_id), ("worker", worker_profile_id)] {
        let (provider, instance) =
            profile_provider(database, profile_id, role)?.ok_or_else(|| {
                failure(
                    "Project configuration is invalid",
                    422,
                    vec![finding(
                        "profile-ineligible",
                        &format!("{role}ProfileId"),
                        "Select an active profile with the matching role",
                    )],
                )
            })?;
        let allowed = instance.as_ref().map_or_else(
            || policy.allowed_providers.contains(&provider),
            |instance| policy.allowed_instance_ids.contains(instance),
        );
        if !allowed {
            return Err(failure(
                "Project configuration is invalid",
                422,
                vec![finding(
                    "profile-provider-ineligible",
                    &format!("{role}ProfileId"),
                    "Select an agent with a provider and login allowed by this project",
                )],
            ));
        }
    }
    Ok(())
}

fn validate_agent_policy(
    database: &SuplexDatabase,
    policy: &ProjectAgentTaskPolicy,
    project_id: &str,
) -> DatabaseResult<()> {
    for workflow_id in &policy.workflow_ids {
        let exists: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_workflows WHERE id = ?1 AND archived_at IS NULL)",
            [workflow_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(failure(
                "Project configuration is invalid",
                422,
                vec![finding(
                    "workflow-ineligible",
                    "agentTaskPolicy.workflowIds",
                    "Select active workflows",
                )],
            ));
        }
    }
    if !policy.workflow_ids.contains(&policy.default_workflow_id) {
        return Err(failure(
            "Project configuration is invalid",
            422,
            vec![finding(
                "workflow-default-ineligible",
                "agentTaskPolicy.defaultWorkflowId",
                "Select one allowed workflow as the default",
            )],
        ));
    }
    for template_id in &policy.template_ids {
        let exists: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_templates WHERE id = ?1 AND project_id = ?2)",
            params![template_id, project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(failure(
                "Project configuration is invalid",
                422,
                vec![finding(
                    "template-ineligible",
                    "agentTaskPolicy.templateIds",
                    "Select templates that belong to this project",
                )],
            ));
        }
    }
    for role in ["root", "worker"] {
        let profile_ids = if role == "root" {
            &policy.root_profile_ids
        } else {
            &policy.worker_profile_ids
        };
        for profile_id in profile_ids {
            if profile_provider(database, profile_id, role)?.is_none() {
                return Err(failure(
                    "Project configuration is invalid",
                    422,
                    vec![finding(
                        "profile-ineligible",
                        "agentTaskPolicy",
                        "Select active profiles with matching roles",
                    )],
                ));
            }
        }
    }
    for profile_ids in [
        &policy.advisor_profile_ids.reviewer,
        &policy.advisor_profile_ids.planner_a,
        &policy.advisor_profile_ids.planner_b,
        &policy.advisor_profile_ids.rater,
    ] {
        for profile_id in profile_ids {
            if profile_provider(database, profile_id, "root")?.is_none() {
                return Err(failure(
                    "Project configuration is invalid",
                    422,
                    vec![finding(
                        "profile-ineligible",
                        "agentTaskPolicy",
                        "Select active Advisor profiles",
                    )],
                ));
            }
        }
    }
    Ok(())
}

fn stored_contract<T>(
    raw: &str,
    parse: fn(Option<&Value>) -> project_contracts::ContractResult<T>,
) -> DatabaseResult<T> {
    let parsed: Value = serde_json::from_str(raw)?;
    parse(Some(&parsed)).map_err(|error| {
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Stored project configuration is invalid: {error:?}"),
        )) as Box<dyn Error>
    })
}

fn parse_optional<T>(
    raw: Option<String>,
    parse: fn(Option<&Value>) -> project_contracts::ContractResult<T>,
) -> DatabaseResult<Option<T>> {
    raw.filter(|value| !value.is_empty())
        .map(|value| stored_contract(&value, parse))
        .transpose()
}

fn public_project(stored: StoredProject) -> DatabaseResult<Project> {
    let legacy = default_policy(&stored.root_profile_id, &stored.worker_profile_id);
    let policy = if stored.agent_task_policy_json == "{}" {
        serde_json::from_value(legacy).expect("generated default agent task policy is valid")
    } else {
        stored_contract(
            &stored.agent_task_policy_json,
            project_contracts::parse_agent_policy,
        )
        .map_err(|_| {
            failure(
                "Project agent policy is invalid",
                422,
                vec![finding(
                    "agent-task-policy-invalid",
                    "agentTaskPolicy",
                    "Project agent task policy must be repaired before it can be used",
                )],
            ) as Box<dyn Error>
        })?
    };
    Ok(Project {
        integration: parse_optional(
            stored.integration_json,
            project_contracts::parse_integration,
        )?,
        execution: parse_optional(stored.execution_json, project_contracts::parse_execution)?,
        id: stored.id,
        company_id: stored.company_id,
        name: stored.name,
        repository_path: stored.repository_path,
        worktree_root: stored.worktree_root,
        repository: stored.repository,
        base_branch: stored.base_branch,
        setup_command: stored.setup_command,
        verification_command: stored.verification_command,
        root_profile_id: stored.root_profile_id,
        worker_profile_id: stored.worker_profile_id,
        agent_task_policy: policy,
        provider_policy: parse_optional(
            stored.provider_policy_json,
            project_contracts::parse_provider_policy,
        )?,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
    })
}

fn active_role(database: &SuplexDatabase, actor_user_id: &str) -> DatabaseResult<String> {
    database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [actor_user_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            Box::new(IdentityError::auth(
                "Authentication required",
                401,
                "auth_failure",
            )) as _
        })
}

pub fn get(
    database: &SuplexDatabase,
    actor_user_id: &str,
    project_id: &str,
) -> DatabaseResult<Project> {
    let role = active_role(database, actor_user_id)?;
    let sql = if role == "admin" {
        format!("{SELECTION} WHERE p.id = ?1")
    } else {
        format!(
            "{SELECTION} JOIN suplex_memberships m ON m.company_id = p.company_id WHERE p.id = ?1 AND m.user_id = ?2"
        )
    };
    let result = if role == "admin" {
        database
            .connection()
            .query_row(&sql, [project_id], stored)
            .optional()?
    } else {
        database
            .connection()
            .query_row(&sql, params![project_id, actor_user_id], stored)
            .optional()?
    };
    public_project(result.ok_or_else(|| failure("Not found", 404, vec![]) as Box<dyn Error>)?)
}

/// `getProjectInCompany`: the caller already holds the company authority.
pub fn get_in_company(
    database: &SuplexDatabase,
    company_id: &str,
    id: &str,
) -> DatabaseResult<Project> {
    let sql = format!("{SELECTION} WHERE p.id = ?1 AND p.company_id = ?2");
    let row = database
        .connection()
        .query_row(&sql, params![id, company_id], stored)
        .optional()?;
    public_project(row.ok_or_else(|| failure("Not found", 404, vec![]) as Box<dyn Error>)?)
}

pub fn list(
    database: &SuplexDatabase,
    actor_user_id: &str,
    company_id: Option<&str>,
) -> DatabaseResult<Vec<Project>> {
    let role = active_role(database, actor_user_id)?;
    if let Some(company_id) = company_id {
        companies::require_company_access(database, actor_user_id, company_id)?;
    }
    let sql = if role == "admin" {
        if company_id.is_some() {
            format!("{SELECTION} WHERE p.company_id = ?1 ORDER BY p.name")
        } else {
            format!("{SELECTION} ORDER BY p.name")
        }
    } else if company_id.is_some() {
        format!(
            "{SELECTION} JOIN suplex_memberships m ON m.company_id = p.company_id WHERE m.user_id = ?1 AND p.company_id = ?2 ORDER BY p.name"
        )
    } else {
        format!(
            "{SELECTION} JOIN suplex_memberships m ON m.company_id = p.company_id WHERE m.user_id = ?1 ORDER BY p.name"
        )
    };
    let mut statement = database.connection().prepare(&sql)?;
    let rows = match (role == "admin", company_id) {
        (true, Some(company_id)) => statement
            .query_map([company_id], stored)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (true, None) => statement
            .query_map([], stored)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (false, Some(company_id)) => statement
            .query_map(params![actor_user_id, company_id], stored)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        (false, None) => statement
            .query_map([actor_user_id], stored)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    rows.into_iter().map(public_project).collect()
}

#[derive(Serialize)]
pub struct ProviderInstance {
    pub id: String,
    pub provider: String,
    pub label: String,
}

pub fn list_provider_instances(
    database: &SuplexDatabase,
    actor_user_id: &str,
    project_id: &str,
) -> DatabaseResult<Vec<ProviderInstance>> {
    get(database, actor_user_id, project_id)?;
    let mut statement = database.connection().prepare(
        "SELECT id, provider, label FROM suplex_provider_instances ORDER BY provider, label COLLATE NOCASE, id",
    )?;
    Ok(statement
        .query_map([], |row| {
            Ok(ProviderInstance {
                id: row.get(0)?,
                provider: row.get(1)?,
                label: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn create_local_default(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
    prepared: &PreparedLocalProject,
    root_profile_id: &str,
    worker_profile_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Project> {
    create_local(
        database,
        actor_user_id,
        company_id,
        prepared,
        CreateLocalOptions {
            root_profile_id,
            worker_profile_id,
            configuration: None,
            now,
        },
    )
}

pub struct CreateLocalOptions<'a> {
    pub root_profile_id: &'a str,
    pub worker_profile_id: &'a str,
    pub configuration: Option<&'a ProjectCreateBody>,
    pub now: DateTime<Utc>,
}

pub fn create_local(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
    prepared: &PreparedLocalProject,
    options: CreateLocalOptions<'_>,
) -> DatabaseResult<Project> {
    let root_profile_id = auth::js_trim(options.root_profile_id);
    let worker_profile_id = auth::js_trim(options.worker_profile_id);
    let (integration, execution, explicit_policy, provider_policy) = match options.configuration {
        Some(ProjectCreateBody::Local(value)) => (
            value.integration.clone(),
            value.execution.clone(),
            value.agent_task_policy.clone(),
            value.provider_policy.clone().flatten(),
        ),
        Some(ProjectCreateBody::ExistingRepository(value)) => {
            (value.integration.clone(), None, None, None)
        }
        Some(ProjectCreateBody::NewRepository(value)) => {
            (value.integration.clone(), None, None, None)
        }
        None => (None, None, None, None),
    };
    let company = companies::require_company_access(database, actor_user_id, company_id)?;
    if company.status != "active" {
        return Err(failure(
            "Company is not active",
            409,
            vec![finding(
                "company-inactive",
                "companyId",
                "Project configuration requires an active company",
            )],
        ));
    }
    let id = project_id()?;
    let audit_id = random_hex_id("audit")?;
    let stamp = rfc3339_millis(options.now);
    let policy_json = match &explicit_policy {
        Some(policy) => json_text(policy)?,
        None => {
            crate::shared::js_json::stringify(&default_policy(root_profile_id, worker_profile_id))
        }
    };
    let integration_json = integration.as_ref().map(json_text).transpose()?;
    let execution_json = execution.as_ref().map(json_text).transpose()?;
    let provider_policy_json = provider_policy.as_ref().map(json_text).transpose()?;
    let result = database.transaction(false, |database| {
        let company = companies::require_company_access(database, actor_user_id, company_id)?;
        if company.status != "active" {
            return Err(failure("Company is not active", 409, vec![]));
        }
        for (role, profile_id) in [("root", root_profile_id), ("worker", worker_profile_id)] {
            let exists: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_profiles WHERE id = ?1 AND role = ?2 AND archived_at IS NULL)",
                params![profile_id, role],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(failure(
                    "Project configuration is invalid",
                    422,
                    vec![finding("profile-ineligible", &format!("{role}ProfileId"), "Select an active profile with the matching role")],
                ));
            }
        }
        if let Some(policy) = &provider_policy {
            validate_provider_policy(database, policy, root_profile_id, worker_profile_id)?;
        }
        if let Some(policy) = &explicit_policy {
            validate_agent_policy(database, policy, &id)?;
        }
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            params![id, company_id, prepared.name, prepared.repository_path.to_string_lossy(), prepared.worktree_root.to_string_lossy(), prepared.repository, prepared.base_branch, prepared.setup_command, prepared.verification_command, root_profile_id, worker_profile_id, policy_json, stamp],
        )?;
        database.connection().execute(
            "UPDATE suplex_projects SET integration_json = ?1, execution_json = ?2 WHERE id = ?3",
            params![integration_json, execution_json, id],
        )?;
        crate::identity::audit::record(
database, &audit_id, (Some(actor_user_id), None), "project_created", None, Some(company_id), &crate::shared::js_json::stringify(&json!({"projectId": id})), &stamp
)?;
        database.connection().execute(
            "UPDATE suplex_projects SET provider_policy_json = ?1 WHERE id = ?2",
            params![provider_policy_json, id],
        )?;
        Ok(())
    });
    if let Err(error) = result {
        let message = error.to_string();
        let field = if message.contains("suplex_projects.repository_path") {
            Some("repositoryPath")
        } else if message.contains("suplex_projects.worktree_root") {
            Some("worktreeRoot")
        } else if message.contains("suplex_projects.repository_identity") {
            Some("repository")
        } else if message.contains("suplex_projects.company_id")
            && message.contains("suplex_projects.name")
        {
            Some("name")
        } else {
            None
        };
        if let Some(field) = field {
            return Err(failure(
                "Project configuration is invalid",
                409,
                vec![finding(
                    "already-assigned",
                    field,
                    "This coordinate is already assigned to another project",
                )],
            ));
        }
        return Err(error);
    }
    get(database, actor_user_id, &id)
}

fn already_assigned(error: Box<dyn Error>) -> Box<dyn Error> {
    let message = error.to_string();
    let field = if message.contains("suplex_projects.repository_path") {
        "repositoryPath"
    } else if message.contains("suplex_projects.worktree_root") {
        "worktreeRoot"
    } else if message.contains("suplex_projects.repository_identity") {
        "repository"
    } else if message.contains("suplex_projects.company_id")
        && message.contains("suplex_projects.name")
    {
        "name"
    } else {
        return error;
    };
    failure(
        "Project configuration is invalid",
        409,
        vec![finding(
            "already-assigned",
            field,
            "This coordinate is already assigned to another project",
        )],
    )
}

fn stored_row(
    database: &SuplexDatabase,
    project_id: &str,
) -> DatabaseResult<Option<StoredProject>> {
    Ok(database
        .connection()
        .query_row(
            &format!("{SELECTION} WHERE p.id = ?1"),
            [project_id],
            stored,
        )
        .optional()?)
}

/// The stored agent policy; the legacy `{}` means the default for these agents.
fn stored_policy(raw: &str, root: &str, worker: &str) -> DatabaseResult<ProjectAgentTaskPolicy> {
    if raw == "{}" {
        return Ok(serde_json::from_value(default_policy(root, worker))?);
    }
    stored_contract(raw, project_contracts::parse_agent_policy).map_err(|_| {
        failure(
            "Project agent policy is invalid",
            422,
            vec![finding(
                "agent-task-policy-invalid",
                "agentTaskPolicy",
                "Project agent task policy must be repaired before it can be used",
            )],
        ) as Box<dyn Error>
    })
}

/// Without an explicit policy the stored allowlists still admit the project's own defaults.
fn admitted_policy(
    mut policy: ProjectAgentTaskPolicy,
    root: &str,
    worker: &str,
) -> ProjectAgentTaskPolicy {
    for (ids, profile_id) in [
        (&mut policy.root_profile_ids, root),
        (&mut policy.worker_profile_ids, worker),
    ] {
        if !ids.iter().any(|id| id == profile_id) {
            ids.push(profile_id.to_owned());
        }
    }
    policy
}

fn require_profile(database: &SuplexDatabase, role: &str, profile_id: &str) -> DatabaseResult<()> {
    if profile_provider(database, profile_id, role)?.is_none() {
        return Err(failure(
            "Project configuration is invalid",
            422,
            vec![finding(
                "profile-ineligible",
                &format!("{role}ProfileId"),
                "Select an active profile with the matching role",
            )],
        ));
    }
    Ok(())
}

fn audit_update(
    database: &SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
    project_id: &str,
    stamp: &str,
) -> DatabaseResult<()> {
    crate::identity::audit::record(
        database,
        &random_hex_id("audit")?,
        (Some(actor_user_id), None),
        "project_updated",
        None,
        Some(company_id),
        &crate::shared::js_json::stringify(&json!({"projectId": project_id})),
        stamp,
    )?;
    Ok(())
}

fn require_active_company(
    database: &SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
) -> DatabaseResult<()> {
    if companies::require_company_access(database, actor_user_id, company_id)?.status != "active" {
        return Err(failure("Company is not active", 409, vec![]));
    }
    Ok(())
}

/// TypeScript `updateProject`: a full configuration replaces the project. The
/// caller has already checked the paths, Git, and the repository host.
pub fn update_local(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    existing: &Project,
    prepared: &PreparedLocalProject,
    body: &LocalProjectCreate,
    now: DateTime<Utc>,
) -> DatabaseResult<Project> {
    let root = auth::js_trim(&body.root_profile_id);
    let worker = auth::js_trim(&body.worker_profile_id);
    let stamp = rfc3339_millis(now);
    let company_id = existing.company_id.as_str();
    let project_id = existing.id.as_str();
    database
        .transaction(false, |database| {
            require_active_company(database, actor_user_id, company_id)?;
            require_profile(database, "root", root)?;
            require_profile(database, "worker", worker)?;
            let stored = stored_row(database, project_id)?;
            let provider_policy_json = match &body.provider_policy {
                None => stored.as_ref().and_then(|row| row.provider_policy_json.clone()),
                Some(None) => None,
                Some(Some(policy)) => Some(json_text(policy)?),
            };
            if let Some(policy) = &provider_policy_json {
                let policy = stored_contract(policy, project_contracts::parse_provider_policy)?;
                for instance_id in &policy.allowed_instance_ids {
                    let exists: bool = database.connection().query_row(
                        "SELECT EXISTS(SELECT 1 FROM suplex_provider_instances WHERE id = ?1)",
                        [instance_id],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(failure(
                            "Project configuration is invalid",
                            422,
                            vec![finding(
                                "instance-ineligible",
                                "providerPolicy",
                                "Select an existing provider login",
                            )],
                        ));
                    }
                }
            }
            let policy = match (&body.agent_task_policy, &stored) {
                (Some(policy), _) => {
                    validate_agent_policy(database, policy, project_id)?;
                    policy.clone()
                }
                (None, Some(row)) => admitted_policy(
                    stored_policy(&row.agent_task_policy_json, root, worker)?,
                    root,
                    worker,
                ),
                (None, None) => serde_json::from_value(default_policy(root, worker))?,
            };
            let Some(stored) = stored.filter(|row| row.company_id == company_id) else {
                return Err(failure("Not found", 404, vec![]));
            };
            database.connection().execute(
                "UPDATE suplex_projects SET name = ?1, repository_path = ?2, worktree_root = ?3, repository_identity = ?4, base_branch = ?5, setup_command = ?6, verification_command = ?7, root_profile_id = ?8, worker_profile_id = ?9, agent_task_policy_json = ?10, updated_at = ?11 WHERE id = ?12",
                params![prepared.name, prepared.repository_path.to_string_lossy(), prepared.worktree_root.to_string_lossy(), prepared.repository, prepared.base_branch, prepared.setup_command, prepared.verification_command, root, worker, json_text(&policy)?, stamp, project_id],
            )?;
            let integration_json = match &body.integration {
                Some(integration) => Some(json_text(integration)?),
                None => stored.integration_json,
            };
            let execution_json = match &body.execution {
                Some(execution) => Some(json_text(execution)?),
                None => stored.execution_json,
            };
            database.connection().execute(
                "UPDATE suplex_projects SET integration_json = ?1, execution_json = ?2 WHERE id = ?3",
                params![integration_json, execution_json, project_id],
            )?;
            audit_update(database, actor_user_id, company_id, project_id, &stamp)?;
            database.connection().execute(
                "UPDATE suplex_projects SET provider_policy_json = ?1 WHERE id = ?2",
                params![provider_policy_json, project_id],
            )?;
            Ok(())
        })
        .map_err(already_assigned)?;
    get(database, actor_user_id, project_id)
}

/// A patch merged over the stored project, before any repository check.
pub struct PatchPlan {
    pub candidate: Project,
    pub findings: Vec<Finding>,
    pub repository_changed: bool,
    pub remote_changed: bool,
}

pub fn plan_patch(existing: &Project, patch: &ProjectPatch) -> PatchPlan {
    let mut candidate = existing.clone();
    for (field, value) in [
        (&mut candidate.repository_path, &patch.repository_path),
        (&mut candidate.worktree_root, &patch.worktree_root),
        (&mut candidate.base_branch, &patch.base_branch),
    ] {
        if let Some(value) = value {
            field.clone_from(value);
        }
    }
    if patch.repository.is_some() {
        candidate.repository.clone_from(&patch.repository);
    }
    if patch.integration.is_some() {
        candidate.integration.clone_from(&patch.integration);
    }
    let mut findings = Vec::new();
    if patch
        .name
        .as_deref()
        .is_some_and(|name| !super::git::valid_name(auth::js_trim(name)))
    {
        findings.push(finding("invalid-name", "name", "Project name is invalid"));
    }
    for (field, command) in [
        ("setupCommand", &patch.setup_command),
        ("verificationCommand", &patch.verification_command),
    ] {
        if command
            .as_deref()
            .is_some_and(|command| !super::git::valid_command(command))
        {
            findings.push(finding(
                "unapproved-command",
                field,
                "Command must be a single non-empty line without secrets",
            ));
        }
    }
    let connection = |integration: Option<&ProjectIntegration>| {
        integration.map_or_else(
            || json!({"kind": "github"}),
            |integration| serde_json::to_value(&integration.repository).unwrap_or_default(),
        )
    };
    let connection_changed = patch.integration.is_some()
        && connection(patch.integration.as_ref()) != connection(existing.integration.as_ref());
    let path_changed = patch
        .repository_path
        .as_ref()
        .is_some_and(|path| *path != existing.repository_path);
    let identity_changed = patch.repository.as_deref().is_some_and(|repository| {
        Some(auth::js_trim(repository).to_lowercase()) != existing.repository
    });
    let repository_changed = path_changed
        || patch
            .worktree_root
            .as_ref()
            .is_some_and(|root| *root != existing.worktree_root)
        || identity_changed
        || patch
            .base_branch
            .as_deref()
            .is_some_and(|branch| auth::js_trim(branch) != existing.base_branch)
        || connection_changed;
    PatchPlan {
        candidate,
        findings,
        repository_changed,
        remote_changed: path_changed || identity_changed || connection_changed,
    }
}

/// TypeScript `validatePatchedRepository`.
pub async fn validate_patched_repository(
    github: &super::git::Github,
    roots: (&std::path::Path, &std::path::Path),
    candidate: &Project,
    validate_worktree_write: bool,
    validate_remote: bool,
) -> (String, String, Vec<Finding>) {
    use super::git as checks;
    let repository =
        checks::canonical_directory(&candidate.repository_path, roots.0, "repositoryPath");
    let worktree = checks::canonical_directory(&candidate.worktree_root, roots.1, "worktreeRoot");
    let mut findings = Vec::new();
    for result in [&repository, &worktree] {
        if let Err(errors) = result {
            findings.extend(errors.iter().cloned());
        }
    }
    if let (Ok(repository), Ok(worktree)) = (&repository, &worktree)
        && (checks::within_root(repository, worktree) || checks::within_root(worktree, repository))
    {
        findings.push(finding(
            "worktree-separation",
            "worktreeRoot",
            "Worktree root must be separate from the repository",
        ));
    }
    let identity = candidate
        .repository
        .as_deref()
        .map(|repository| auth::js_trim(repository).to_lowercase())
        .unwrap_or_default();
    let base_branch = auth::js_trim(&candidate.base_branch);
    if !checks::valid_repository(&identity) {
        findings.push(finding(
            "repository-identity",
            "repository",
            "Repository must use owner/name identity without credentials",
        ));
    }
    if !checks::valid_branch(base_branch) {
        findings.push(finding(
            "unsafe-branch",
            "baseBranch",
            "Base branch is unsafe",
        ));
    }
    if checks::secret_shaped(&identity) || checks::secret_shaped(&candidate.base_branch) {
        findings.push(finding(
            "secret-shaped-value",
            "configuration",
            "Secret-shaped configuration values are not accepted",
        ));
    }
    if validate_worktree_write
        && let Ok(worktree) = &worktree
        && !checks::writable(worktree)
    {
        findings.push(finding(
            "worktree-unwritable",
            "worktreeRoot",
            "Worktree root must be writable",
        ));
    }
    let absolute = |raw: &str| std::path::absolute(raw).unwrap_or_else(|_| raw.into());
    let repository_path = repository.unwrap_or_else(|_| absolute(&candidate.repository_path));
    let worktree_root = worktree.unwrap_or_else(|_| absolute(&candidate.worktree_root));
    let bitbucket = matches!(
        candidate
            .integration
            .as_ref()
            .map(|integration| &integration.repository),
        Some(project_contracts::RepositoryConnection::Bitbucket { .. })
    );
    let mut access = None;
    if findings.is_empty() {
        let host = if bitbucket { "bitbucket" } else { "github" };
        access = if bitbucket {
            None
        } else {
            github.access().await.ok()
        };
        match checks::inspect_with(access.as_ref(), &repository_path, base_branch, host).await {
            Err(errors) => findings.extend(errors),
            Ok(inspection) => {
                if inspection.canonical_path != repository_path {
                    findings.push(finding(
                        "repository-path-mismatch",
                        "repositoryPath",
                        "Repository path is not canonical",
                    ));
                }
                if inspection.base_sha.is_empty() {
                    findings.push(finding(
                        "branch-unavailable",
                        "baseBranch",
                        "Configured branches must resolve to commits",
                    ));
                }
                if bitbucket {
                    if inspection.remote_repository != identity {
                        findings.push(finding(
                            "repository-mismatch",
                            "repository",
                            "Local origin does not match configured repository identity",
                        ));
                    }
                } else if let Err(error) =
                    checks::verify_origin(access.as_ref(), &inspection.remote_repository, &identity)
                        .await
                {
                    findings.push(error);
                }
            }
        }
    }
    if validate_remote && findings.is_empty() {
        let verified = if bitbucket {
            let connection = &candidate
                .integration
                .as_ref()
                .expect("Bitbucket integration")
                .repository;
            let client = crate::integrations::bitbucket::BitbucketClient::new(
                &serde_json::to_value(connection).expect("repository connection serializes"),
            );
            verify_bitbucket(&client, &identity).await
        } else {
            checks::verify_github(access.as_ref(), &identity).await
        };
        if let Err(error) = verified {
            findings.push(error);
        }
    }
    (
        repository_path.to_string_lossy().into_owned(),
        worktree_root.to_string_lossy().into_owned(),
        findings,
    )
}

/// TypeScript `patchProject` after its repository checks: write only the
/// fields the caller sent.
pub fn apply_patch(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    existing: &Project,
    patch: &ProjectPatch,
    (repository_path, worktree_root): (&str, &str),
    now: DateTime<Utc>,
) -> DatabaseResult<Project> {
    let stamp = rfc3339_millis(now);
    let company_id = existing.company_id.as_str();
    let project_id = existing.id.as_str();
    database
        .transaction(false, |database| {
            require_active_company(database, actor_user_id, company_id)?;
            let Some(stored) =
                stored_row(database, project_id)?.filter(|row| row.company_id == company_id)
            else {
                return Err(failure("Not found", 404, vec![]));
            };
            let update = |column: &str, value: Option<String>| -> DatabaseResult<()> {
                database.connection().execute(
                    &format!("UPDATE suplex_projects SET {column} = ?1 WHERE id = ?2"),
                    params![value, project_id],
                )?;
                Ok(())
            };
            let trimmed = |value: &Option<String>| {
                value
                    .as_deref()
                    .map(|value| auth::js_trim(value).to_owned())
            };
            if patch.name.is_some() {
                update("name", trimmed(&patch.name))?;
            }
            if patch.repository_path.is_some() {
                update("repository_path", Some(repository_path.to_owned()))?;
            }
            if patch.worktree_root.is_some() {
                update("worktree_root", Some(worktree_root.to_owned()))?;
            }
            if patch.repository.is_some() {
                update(
                    "repository_identity",
                    trimmed(&patch.repository).map(|value| value.to_lowercase()),
                )?;
            }
            if patch.base_branch.is_some() {
                update("base_branch", trimmed(&patch.base_branch))?;
            }
            if patch.setup_command.is_some() {
                update("setup_command", trimmed(&patch.setup_command))?;
            }
            if patch.verification_command.is_some() {
                update("verification_command", trimmed(&patch.verification_command))?;
            }
            if let Some(integration) = &patch.integration {
                update("integration_json", Some(json_text(integration)?))?;
            }
            if let Some(changes) = &patch.execution {
                let mut execution = match &stored.execution_json {
                    Some(raw) if !raw.is_empty() => serde_json::from_str(raw)?,
                    _ => serde_json::Map::new(),
                };
                execution.extend(changes.clone());
                let execution = project_contracts::parse_execution(Some(&Value::Object(execution)))
                    .map_err(|error| format!("Project execution is invalid: {error:?}"))?;
                update("execution_json", Some(json_text(&execution)?))?;
            }
            if patch.root_profile_id.is_some()
                || patch.worker_profile_id.is_some()
                || patch.agent_task_policy.is_some()
                || patch.provider_policy.is_some()
            {
                patch_agent_configuration(database, &stored, patch)?;
            }
            update("updated_at", Some(stamp.clone()))?;
            audit_update(database, actor_user_id, company_id, project_id, &stamp)
        })
        .map_err(already_assigned)?;
    get(database, actor_user_id, project_id)
}

fn patch_agent_configuration(
    database: &SuplexDatabase,
    stored: &StoredProject,
    patch: &ProjectPatch,
) -> DatabaseResult<()> {
    let root = patch
        .root_profile_id
        .as_deref()
        .map_or(stored.root_profile_id.as_str(), auth::js_trim);
    let worker = patch
        .worker_profile_id
        .as_deref()
        .map_or(stored.worker_profile_id.as_str(), auth::js_trim);
    require_profile(database, "root", root)?;
    require_profile(database, "worker", worker)?;
    let provider_policy = match &patch.provider_policy {
        Some(policy) => policy.clone(),
        None => parse_optional(
            stored.provider_policy_json.clone(),
            project_contracts::parse_provider_policy,
        )?,
    };
    if let Some(policy) = &provider_policy {
        validate_provider_policy(database, policy, root, worker)?;
    }
    let policy = match &patch.agent_task_policy {
        Some(policy) => {
            validate_agent_policy(database, policy, &stored.id)?;
            policy.clone()
        }
        None => admitted_policy(
            stored_policy(&stored.agent_task_policy_json, root, worker)?,
            root,
            worker,
        ),
    };
    let connection = database.connection();
    if patch.root_profile_id.is_some() {
        connection.execute(
            "UPDATE suplex_projects SET root_profile_id = ?1 WHERE id = ?2",
            params![root, stored.id],
        )?;
    }
    if patch.worker_profile_id.is_some() {
        connection.execute(
            "UPDATE suplex_projects SET worker_profile_id = ?1 WHERE id = ?2",
            params![worker, stored.id],
        )?;
    }
    if patch.agent_task_policy.is_some()
        || patch.root_profile_id.is_some()
        || patch.worker_profile_id.is_some()
    {
        connection.execute(
            "UPDATE suplex_projects SET agent_task_policy_json = ?1 WHERE id = ?2",
            params![json_text(&policy)?, stored.id],
        )?;
    }
    if patch.provider_policy.is_some() {
        connection.execute(
            "UPDATE suplex_projects SET provider_policy_json = ?1 WHERE id = ?2",
            params![
                provider_policy.as_ref().map(json_text).transpose()?,
                stored.id
            ],
        )?;
    }
    Ok(())
}

fn repository_connection(body: &ProjectCreateBody) -> Option<&RepositoryConnection> {
    match body {
        ProjectCreateBody::Local(value) => value.integration.as_ref(),
        ProjectCreateBody::ExistingRepository(value) => value.integration.as_ref(),
        ProjectCreateBody::NewRepository(value) => value.integration.as_ref(),
    }
    .map(|integration| &integration.repository)
}
fn repository_host(connection: Option<&RepositoryConnection>) -> &'static str {
    if matches!(connection, Some(RepositoryConnection::Bitbucket { .. })) {
        "bitbucket"
    } else {
        "github"
    }
}
async fn verify_bitbucket(
    client: &crate::integrations::bitbucket::BitbucketClient,
    identity: &str,
) -> Result<(), Finding> {
    let (_, href) = client.repository(identity).await.map_err(|_| {
        finding(
            "github-repository-unavailable",
            "repository",
            "GitHub repository identity could not be verified",
        )
    })?;
    let url = url::Url::parse(&href).map_err(|_| {
        finding(
            "provider-host",
            "repository",
            "GitHub provider returned a URL outside github.com",
        )
    })?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url
            .path()
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .trim_start_matches('/')
            .to_lowercase()
            != identity
    {
        return Err(finding(
            "provider-path",
            "repository",
            "GitHub provider URL does not match configured repository identity",
        ));
    }
    Ok(())
}
async fn prepare_local_project(
    github: &git::Github,
    roots: &crate::http::ProjectRoots,
    input: &git::LocalProjectInput<'_>,
    connection: Option<&RepositoryConnection>,
) -> Result<PreparedLocalProject, Vec<Finding>> {
    let prepared = git::prepare_local_project(
        github,
        &roots.repositories,
        &roots.worktrees,
        input,
        repository_host(connection),
    )
    .await?;
    if let Some(connection @ RepositoryConnection::Bitbucket { .. }) = connection {
        let client = crate::integrations::bitbucket::BitbucketClient::new(
            &serde_json::to_value(connection).expect("repository connection serializes"),
        );
        verify_bitbucket(&client, &prepared.repository)
            .await
            .map_err(|error| vec![error])?;
    }
    Ok(prepared)
}

pub async fn create_project(
    state: &crate::http::AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    company_id: &str,
    body: &ProjectCreateBody,
) -> DatabaseResult<Project> {
    match body {
        ProjectCreateBody::ExistingRepository(value) => {
            create_from_repository(
                state,
                roots,
                user_id,
                company_id,
                body,
                &value.repository_url,
                value.base_branch.as_deref(),
            )
            .await
        }
        ProjectCreateBody::NewRepository(value) => {
            create_with_new_repository(
                state,
                roots,
                user_id,
                company_id,
                body,
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
            finish_local_project(state, roots, user_id, company_id, body, &fields).await
        }
    }
}

pub(crate) fn admit_configuration(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> DatabaseResult<()> {
    let company = companies::require_company_access(database, user_id, company_id)?;
    if company.status != "active" {
        return Err(ProjectError::new(
            "Company is not active",
            409,
            vec![finding(
                "company-inactive",
                "companyId",
                "Project configuration requires an active company",
            )],
        )
        .into());
    }
    Ok(())
}

async fn finish_local_project(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    company_id: &str,
    body: &ProjectCreateBody,
    fields: &[String; 9],
) -> DatabaseResult<Project> {
    let input = git::LocalProjectInput {
        name: &fields[0],
        repository_path: &fields[1],
        worktree_root: &fields[2],
        repository: &fields[3],
        base_branch: &fields[4],
        setup_command: &fields[5],
        verification_command: &fields[6],
    };
    let prepared = prepare_local_project(
        &state.project_github,
        roots,
        &input,
        repository_connection(body),
    )
    .await
    .map_err(|findings| ProjectError::new("Project configuration is invalid", 422, findings))?;
    state.with_database(|database| {
        create_local(
            database,
            user_id,
            company_id,
            &prepared,
            CreateLocalOptions {
                root_profile_id: &fields[7],
                worker_profile_id: &fields[8],
                configuration: Some(body),
                now: Utc::now(),
            },
        )
    })
}

async fn create_from_repository(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    company_id: &str,
    body: &ProjectCreateBody,
    raw_url: &str,
    requested_base_branch: Option<&str>,
) -> DatabaseResult<Project> {
    let Some(coordinate) = git::repository_coordinate(raw_url) else {
        return Err(ProjectError::new("Repository URL is invalid", 422, Vec::new()).into());
    };
    if coordinate.host != repository_host(repository_connection(body)) {
        return Err(ProjectError::new(
            "Select the repository host and its credentials",
            422,
            Vec::new(),
        )
        .into());
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
    coordinate: git::Coordinate,
    base_branch: String,
) -> DatabaseResult<Project> {
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
        return Err(Box::new(error));
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
) -> DatabaseResult<Project> {
    let mut parts = repository_name.trim().split('/');
    let first = parts.next().unwrap_or_default();
    let second = parts.next();
    let bitbucket = repository_host(repository_connection(body)) == "bitbucket";
    let owner = if second.is_some() {
        first.to_owned()
    } else if bitbucket {
        String::new()
    } else {
        match provisioning::github_owners(&state.project_github).await {
            Ok(owners) => owners.into_iter().next().unwrap_or_default(),
            Err(error) => return Err(Box::new(error)),
        }
    };
    if owner.is_empty() {
        return Err(ProjectError::Rejected {
            message: "Repository name is invalid",
            status: 422,
            findings: vec![git::Finding {
                code: "repository-name".to_owned(),
                field: "repositoryName".to_owned(),
                message: "Use workspace/name for a Bitbucket repository".to_owned(),
            }],
        }
        .into());
    }
    let name = second.unwrap_or(first);
    let coordinate = git::repository_coordinate(&format!(
        "https://{}/{owner}/{name}",
        if bitbucket {
            "bitbucket.org"
        } else {
            "github.com"
        }
    ));
    let base_branch = requested_base_branch.unwrap_or("main").to_owned();
    let Some(coordinate) = coordinate.filter(|_| git::valid_branch(&base_branch)) else {
        return Err(ProjectError::Rejected {
            message: "Repository name is invalid",
            status: 422,
            findings: vec![git::Finding {
                code: "repository-name".to_owned(),
                field: "repositoryName".to_owned(),
                message: "Use letters, numbers, dots, dashes, and underscores".to_owned(),
            }],
        }
        .into());
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
        repository_connection(body),
    )
    .await
    {
        return Err(Box::new(error));
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

pub async fn replace_project(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    existing: &Project,
    body: &project_contracts::LocalProjectCreate,
) -> DatabaseResult<Project> {
    let integration = body.integration.as_ref().or(existing.integration.as_ref());
    let input = git::LocalProjectInput {
        name: &body.name,
        repository_path: &body.repository_path,
        worktree_root: &body.worktree_root,
        repository: &body.repository,
        base_branch: &body.base_branch,
        setup_command: &body.setup_command,
        verification_command: &body.verification_command,
    };
    let prepared = match prepare_local_project(
        &state.project_github,
        roots,
        &input,
        integration.map(|integration| &integration.repository),
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(findings) => {
            return Err(
                ProjectError::new("Project configuration is invalid", 422, findings).into(),
            );
        }
    };
    state.with_database(|database| {
        update_local(database, user_id, existing, &prepared, body, Utc::now())
    })
}

pub async fn patch_project(
    state: &AppState,
    roots: &crate::http::ProjectRoots,
    user_id: &str,
    existing: &Project,
    patch: &project_contracts::ProjectPatch,
) -> DatabaseResult<Project> {
    let plan = plan_patch(existing, patch);
    let mut findings = plan.findings;
    let mut paths = (
        plan.candidate.repository_path.clone(),
        plan.candidate.worktree_root.clone(),
    );
    if plan.repository_changed {
        let (repository_path, worktree_root, errors) = validate_patched_repository(
            &state.project_github,
            (&roots.repositories, &roots.worktrees),
            &plan.candidate,
            patch.worktree_root.is_some(),
            plan.remote_changed,
        )
        .await;
        paths = (repository_path, worktree_root);
        findings.extend(errors);
    }
    if !findings.is_empty() {
        return Err(ProjectError::new("Project configuration is invalid", 422, findings).into());
    }
    state.with_database(|database| {
        apply_patch(
            database,
            user_id,
            existing,
            patch,
            (&paths.0, &paths.1),
            Utc::now(),
        )
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::platform::database::OpenMode;

    use super::*;

    #[tokio::test]
    async fn bitbucket_repository_validation_uses_provider_identity_and_reports_access_failures() {
        use crate::integrations::bitbucket::BitbucketClient;
        use axum::{
            Json, Router, extract::Path, http::StatusCode, response::IntoResponse, routing::get,
        };
        let app = Router::new().route("/2.0/repositories/team/{name}", get(|Path(name): Path<String>| async move {
            if name == "denied" { return StatusCode::FORBIDDEN.into_response(); }
            let path = if name == "wrong_path" { "other" } else { &name };
            Json(json!({"full_name":format!("team/{name}"),"links":{"html":{"href":format!("https://bitbucket.org/team/{path}")}}})).into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // This credential name belongs only to this test.
        unsafe { std::env::set_var("SUPLEX_P3_BITBUCKET_VALIDATION_TOKEN", "fixture") };
        let client = BitbucketClient::with_origin(
            &json!({"tokenEnvironment":"SUPLEX_P3_BITBUCKET_VALIDATION_TOKEN"}),
            &origin,
        );
        verify_bitbucket(&client, "team/repo").await.unwrap();
        assert_eq!(
            verify_bitbucket(&client, "team/wrong_path")
                .await
                .unwrap_err()
                .code,
            "provider-path"
        );
        assert_eq!(
            verify_bitbucket(&client, "team/denied")
                .await
                .unwrap_err()
                .code,
            "github-repository-unavailable"
        );
        use git::fixtures::{github_checkout, temporary};
        let root = temporary("suplex-bitbucket-project");
        let local = root.join("repo");
        let bare = root.join("bare");
        let checkout = github_checkout(&local, &bare, "team/repo");
        let origin = "https://bitbucket.org/team/repo.git";
        checkout.remote_set_url("origin", origin).unwrap();
        checkout
            .config()
            .unwrap()
            .set_str(&format!("url.file://{}.insteadOf", bare.display()), origin)
            .unwrap();
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&worktrees).unwrap();
        let input = git::LocalProjectInput {
            name: "Bitbucket",
            repository_path: local.to_str().unwrap(),
            worktree_root: worktrees.to_str().unwrap(),
            repository: "team/repo",
            base_branch: "main",
            setup_command: "true",
            verification_command: "true",
        };
        let github = git::Github::default();
        let prepared =
            git::prepare_local_project(&github, &root, &root, &input, "bitbucket")
                .await
                .unwrap();
        assert_eq!(prepared.repository, "team/repo");
        let roots = crate::http::ProjectRoots {
            repositories: root.clone(),
            worktrees: root.clone(),
        };
        let connection = serde_json::from_value(
            json!({"kind":"bitbucket", "tokenEnvironment":"SUPLEX_P3_BITBUCKET_MISSING_TOKEN"}),
        )
        .unwrap();
        let findings = prepare_local_project(&github, &roots, &input, Some(&connection))
            .await
            .unwrap_err();
        assert_eq!(findings[0].code, "github-repository-unavailable");
        drop(checkout);
        std::fs::remove_dir_all(root).unwrap();
        server.abort();
    }

    fn local_configuration(fields: Value) -> ProjectCreateBody {
        let mut base = json!({
            "name":"Local repository",
            "repositoryPath":"/tmp/project-local-repository",
            "worktreeRoot":"/tmp/project-local-worktrees",
            "repository":"owner/local",
            "baseBranch":"main",
            "setupCommand":"pnpm install",
            "verificationCommand":"pnpm test",
            "rootProfileId":"profile_native_root",
            "workerProfileId":"profile_native_worker"
        });
        base.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn local_create_audits_once_and_reads_follow_live_membership() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            random_hex_id("suplex_project").unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap().user;
        let company =
            companies::create_company(&mut database, &admin.id, "Local projects", now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('project_member', 'Member', 'user_v1_project_member', 'member', 'active', ?1, ?1, 1)",
            [now.to_rfc3339()],
        ).unwrap();
        let prepared = PreparedLocalProject {
            name: "Local repository".to_owned(),
            repository_path: PathBuf::from("/tmp/project-local-repository"),
            worktree_root: PathBuf::from("/tmp/project-local-worktrees"),
            repository: "owner/local".to_owned(),
            base_branch: "main".to_owned(),
            setup_command: "pnpm install".to_owned(),
            verification_command: "pnpm test".to_owned(),
        };
        let configured = local_configuration(
            json!({"integration":{"repository":{"kind":"github"}},"execution":{"instructions":"Build"},"agentTaskPolicy":{"workflowIds":["workflow_native_standard"],"defaultWorkflowId":"workflow_native_standard","rootProfileIds":["profile_native_root"],"workerProfileIds":["profile_native_worker"]},"providerPolicy":null}),
        );
        let created = create_local(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            CreateLocalOptions {
                root_profile_id: " profile_native_root ",
                worker_profile_id: " profile_native_worker ",
                configuration: Some(&configured),
                now,
            },
        )
        .unwrap();
        assert!(created.id.starts_with("project_"));
        assert_eq!(created.id.len(), 32);
        assert_eq!(created.repository.as_deref(), Some("owner/local"));
        assert_eq!(created.root_profile_id, "profile_native_root");
        assert_eq!(
            serde_json::to_value(created.integration.as_ref().unwrap()).unwrap(),
            json!({"repository":{"kind":"github"},"tracker":null})
        );
        assert!(created.execution.unwrap().instructions == "Build");
        assert_eq!(
            created.agent_task_policy.root_profile_ids,
            vec!["profile_native_root"]
        );
        assert_eq!(
            list(&database, &admin.id, Some(&company.id)).unwrap().len(),
            1
        );
        assert!(list(&database, "project_member", None).unwrap().is_empty());
        assert_eq!(
            get(&database, "project_member", &created.id)
                .unwrap_err()
                .downcast_ref::<ProjectError>()
                .unwrap()
                .status(),
            404
        );
        database.connection().execute(
            "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES ('project_member', ?1, ?2)",
            params![company.id, now.to_rfc3339()],
        ).unwrap();
        assert_eq!(list(&database, "project_member", None).unwrap().len(), 1);
        assert_eq!(
            get(&database, "project_member", &created.id).unwrap().id,
            created.id
        );
        let missing_instance = local_configuration(
            json!({"providerPolicy":{"allowedProviders":[],"allowedInstanceIds":["missing_instance"]}}),
        );
        let rejected_instance = create_local(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            CreateLocalOptions {
                root_profile_id: "profile_native_root",
                worker_profile_id: "profile_native_worker",
                configuration: Some(&missing_instance),
                now,
            },
        )
        .unwrap_err();
        let rejected_instance = rejected_instance.downcast_ref::<ProjectError>().unwrap();
        assert_eq!(rejected_instance.status(), 422);
        assert_eq!(rejected_instance.findings()[0].code, "instance-ineligible");
        let missing_workflow = local_configuration(
            json!({"agentTaskPolicy":{"workflowIds":["missing_workflow"],"defaultWorkflowId":"missing_workflow","rootProfileIds":["profile_native_root"],"workerProfileIds":["profile_native_worker"]}}),
        );
        let rejected_workflow = create_local(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            CreateLocalOptions {
                root_profile_id: "profile_native_root",
                worker_profile_id: "profile_native_worker",
                configuration: Some(&missing_workflow),
                now,
            },
        )
        .unwrap_err();
        let rejected_workflow = rejected_workflow.downcast_ref::<ProjectError>().unwrap();
        assert_eq!(rejected_workflow.status(), 422);
        assert_eq!(rejected_workflow.findings()[0].code, "workflow-ineligible");
        let duplicate = create_local_default(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            "profile_native_root",
            "profile_native_worker",
            now,
        )
        .unwrap_err();
        assert_eq!(
            duplicate.downcast_ref::<ProjectError>().unwrap().status(),
            409
        );
        let rejected_profile = create_local_default(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            "missing_root",
            "profile_native_worker",
            now,
        )
        .unwrap_err();
        assert_eq!(
            rejected_profile
                .downcast_ref::<ProjectError>()
                .unwrap()
                .status(),
            422
        );
        let audit: String = database
            .connection()
            .query_row(
                "SELECT metadata_json FROM suplex_audit_events WHERE action = 'project_created'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit, format!("{{\"projectId\":\"{}\"}}", created.id));
        let audit_count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'project_created'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1);
        let count: i64 = database
            .connection()
            .query_row("SELECT COUNT(*) FROM suplex_projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        database
            .connection()
            .execute(
                "UPDATE suplex_companies SET status = 'suspended' WHERE id = ?1",
                [&company.id],
            )
            .unwrap();
        assert_eq!(
            create_local_default(
                &mut database,
                &admin.id,
                &company.id,
                &prepared,
                "profile_native_root",
                "profile_native_worker",
                now,
            )
            .unwrap_err()
            .downcast_ref::<ProjectError>()
            .unwrap()
            .status(),
            409
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_projects SET agent_task_policy_json = '{broken' WHERE id = ?1",
                [&created.id],
            )
            .unwrap();
        assert_eq!(
            get(&database, &admin.id, &created.id)
                .unwrap_err()
                .downcast_ref::<ProjectError>()
                .unwrap()
                .status(),
            422
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_projects SET agent_task_policy_json = '{}' WHERE id = ?1",
                [&created.id],
            )
            .unwrap();
        assert_eq!(
            get(&database, &admin.id, &created.id)
                .unwrap()
                .agent_task_policy
                .workflow_ids,
            created.agent_task_policy.workflow_ids
        );
        database
            .connection()
            .execute(
                "DELETE FROM suplex_memberships WHERE user_id = 'project_member'",
                [],
            )
            .unwrap();
        assert_eq!(
            get(&database, "project_member", &created.id)
                .unwrap_err()
                .downcast_ref::<ProjectError>()
                .unwrap()
                .status(),
            404
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn stored_configuration_contracts_normalize_defaults_and_unknown_fields() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            random_hex_id("suplex_project_json").unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap().user;
        let company =
            companies::create_company(&mut database, &admin.id, "Stored JSON", now).unwrap();
        let prepared = PreparedLocalProject {
            name: "Local repository".to_owned(),
            repository_path: PathBuf::from("/tmp/project-json-repository"),
            worktree_root: PathBuf::from("/tmp/project-json-worktrees"),
            repository: "owner/json".to_owned(),
            base_branch: "main".to_owned(),
            setup_command: String::new(),
            verification_command: String::new(),
        };
        let created = create_local_default(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            "profile_native_root",
            "profile_native_worker",
            now,
        )
        .unwrap();
        database.connection().execute(
            r#"UPDATE suplex_projects SET integration_json = '{}', execution_json = '{"instructions":"Build","mcp":[{"name":"context7","transport":{"type":"http","url":"https://example.test/mcp","extra":true},"grants":{"root":[],"advisor":[],"worker":[],"extra":true},"extra":true}]}', provider_policy_json = '{"allowedProviders":["codex"],"allowedInstanceIds":["instance_a"]}', agent_task_policy_json = '{"workflowIds":["workflow_native_standard"],"defaultWorkflowId":"workflow_native_standard","rootProfileIds":["profile_native_root"],"workerProfileIds":["profile_native_worker"]}' WHERE id = ?1"#,
            [&created.id],
        ).unwrap();
        let normalized = get(&database, &admin.id, &created.id).unwrap();
        let response = serde_json::to_value(response_project(&normalized)).unwrap();
        assert_eq!(response["execution"]["instructions"], "Build");
        assert_eq!(
            response["agentTaskPolicy"]["rootProfileIds"],
            json!(["profile_native_root"])
        );
        assert_eq!(response["execution"]["skillDirectories"], json!([]));
        assert!(!response.to_string().contains("extra"));
        assert_eq!(
            serde_json::to_value(normalized.integration.as_ref().unwrap()).unwrap(),
            json!({"repository":{"kind":"github"},"tracker":null})
        );
        let execution = serde_json::to_value(normalized.execution.as_ref().unwrap()).unwrap();
        assert_eq!(execution["instructions"], "Build");
        assert!(!execution.to_string().contains("extra"));
        assert_eq!(execution["skillDirectories"], json!([]));
        assert_eq!(
            serde_json::to_value(normalized.provider_policy.as_ref().unwrap()).unwrap(),
            json!({"allowedProviders":["codex"],"allowedInstanceIds":["instance_a"]})
        );
        assert!(normalized.agent_task_policy.root_profile_ids == vec!["profile_native_root"]);
        database.connection().execute(
            "UPDATE suplex_projects SET execution_json = '{\"environment\":{\"PATH\":\"x\"}}' WHERE id = ?1",
            [&created.id],
        ).unwrap();
        assert!(get(&database, &admin.id, &created.id).is_err());
        database
            .connection()
            .execute(
                "UPDATE suplex_projects SET execution_json = '{bad' WHERE id = ?1",
                [&created.id],
            )
            .unwrap();
        assert!(get(&database, &admin.id, &created.id).is_err());
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
