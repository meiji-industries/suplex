use std::{error::Error, fmt};

use chrono::{DateTime, SecondsFormat, Utc};
use openssl::rand::rand_bytes;
use rusqlite::{OptionalExtension, Row, params};
use serde_json::{Value, json};

use crate::{
    http::contracts,
    identity::{auth, companies},
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::js_json::JsDocument,
};

use super::repository::{Finding, PreparedLocalProject};

#[derive(Debug)]
pub struct ProjectFailure {
    pub message: &'static str,
    pub status_code: u16,
    pub findings: Vec<Finding>,
}

impl fmt::Display for ProjectFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for ProjectFailure {}

fn failure(message: &'static str, status_code: u16, findings: Vec<Finding>) -> Box<ProjectFailure> {
    Box::new(ProjectFailure {
        message,
        status_code,
        findings,
    })
}

fn finding(code: &str, field: &str, message: &str) -> Finding {
    Finding {
        code: code.to_owned(),
        field: field.to_owned(),
        message: message.to_owned(),
    }
}

fn project_id() -> DatabaseResult<String> {
    let mut bytes = [0_u8; 12];
    rand_bytes(&mut bytes)?;
    Ok(format!(
        "project_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

/// Internal database view. HTTP output still requires the full project
/// integration, execution, provider policy, and response contracts.
#[derive(Clone, Debug)]
pub struct Project {
    pub integration: Option<JsDocument>,
    pub execution: Option<JsDocument>,
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
    pub agent_task_policy: JsDocument,
    pub provider_policy: Option<JsDocument>,
    pub created_at: String,
    pub updated_at: String,
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

fn stored_contract(raw: &str, contract: &'static str) -> DatabaseResult<JsDocument> {
    let parsed = JsDocument::parse(raw).map_err(|message| {
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )) as Box<dyn Error>
    })?;
    contracts::validate_js_detailed(contract, Some(&parsed))
        .ok_or_else(|| {
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Project contract is unavailable: {contract}"),
            )) as Box<dyn Error>
        })?
        .map_err(|_| {
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Stored project {contract} is invalid"),
            )) as Box<dyn Error>
        })
}

fn parse_optional(
    raw: Option<String>,
    contract: &'static str,
) -> DatabaseResult<Option<JsDocument>> {
    raw.filter(|value| !value.is_empty())
        .map(|value| stored_contract(&value, contract))
        .transpose()
}

fn public_project(stored: StoredProject) -> DatabaseResult<Project> {
    let legacy = default_policy(&stored.root_profile_id, &stored.worker_profile_id);
    let policy = if stored.agent_task_policy_json == "{}" {
        JsDocument::parse(&crate::shared::js_json::stringify(&legacy))
            .expect("generated default agent task policy is JSON")
    } else {
        stored_contract(
            &stored.agent_task_policy_json,
            "projects.ProjectAgentTaskPolicySchema",
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
        integration: parse_optional(stored.integration_json, "projects.ProjectIntegrationSchema")?,
        execution: parse_optional(stored.execution_json, "projects.ProjectExecutionSchema")?,
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
            "projects.ProjectProviderPolicySchema",
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
            Box::new(auth::AuthFailure::new(
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

pub fn create_local_default(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
    prepared: &PreparedLocalProject,
    root_profile_id: &str,
    worker_profile_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Project> {
    let root_profile_id = auth::js_trim(root_profile_id);
    let worker_profile_id = auth::js_trim(worker_profile_id);
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
    let audit_id = auth::random_hex_id("audit")?;
    let stamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let policy = default_policy(root_profile_id, worker_profile_id);
    let policy_json = crate::shared::js_json::stringify(&policy);
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
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            params![id, company_id, prepared.name, prepared.repository_path.to_string_lossy(), prepared.worktree_root.to_string_lossy(), prepared.repository, prepared.base_branch, prepared.setup_command, prepared.verification_command, root_profile_id, worker_profile_id, policy_json, stamp],
        )?;
        database.connection().execute(
            "INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, ?2, NULL, 'project_created', NULL, ?3, ?4, ?5)",
            params![audit_id, actor_user_id, company_id, crate::shared::js_json::stringify(&json!({"projectId": id})), stamp],
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::platform::database::OpenMode;

    use super::*;

    #[test]
    fn local_create_audits_once_and_reads_follow_live_membership() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            auth::random_hex_id("suplex_project").unwrap()
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
        let created = create_local_default(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            " profile_native_root ",
            " profile_native_worker ",
            now,
        )
        .unwrap();
        assert!(created.id.starts_with("project_"));
        assert_eq!(created.id.len(), 32);
        assert_eq!(created.repository.as_deref(), Some("owner/local"));
        assert_eq!(created.root_profile_id, "profile_native_root");
        assert_eq!(
            created
                .agent_task_policy
                .to_serde_if_representable()
                .unwrap()["rootProfileIds"],
            json!(["profile_native_root"])
        );
        assert_eq!(
            list(&database, &admin.id, Some(&company.id)).unwrap().len(),
            1
        );
        assert!(list(&database, "project_member", None).unwrap().is_empty());
        assert_eq!(
            get(&database, "project_member", &created.id)
                .unwrap_err()
                .downcast_ref::<ProjectFailure>()
                .unwrap()
                .status_code,
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
            duplicate
                .downcast_ref::<ProjectFailure>()
                .unwrap()
                .status_code,
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
                .downcast_ref::<ProjectFailure>()
                .unwrap()
                .status_code,
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
            .downcast_ref::<ProjectFailure>()
            .unwrap()
            .status_code,
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
                .downcast_ref::<ProjectFailure>()
                .unwrap()
                .status_code,
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
                .stringify(),
            created.agent_task_policy.stringify()
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
                .downcast_ref::<ProjectFailure>()
                .unwrap()
                .status_code,
            404
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn stored_configuration_contracts_normalize_without_losing_utf16() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            auth::random_hex_id("suplex_project_json").unwrap()
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
            r#"UPDATE suplex_projects SET integration_json = '{}', execution_json = '{"instructions":"\ud800","mcp":[{"name":"context7","transport":{"type":"http","url":"https://example.test/mcp","extra":true},"grants":{"root":[],"advisor":[],"worker":[],"extra":true},"extra":true}]}', provider_policy_json = '{"allowedProviders":["codex"],"allowedInstanceIds":["instance_a"]}', agent_task_policy_json = '{"workflowIds":["workflow_native_standard"],"defaultWorkflowId":"workflow_native_standard","rootProfileIds":["\ud800"],"workerProfileIds":["profile_native_worker"]}' WHERE id = ?1"#,
            [&created.id],
        ).unwrap();
        let normalized = get(&database, &admin.id, &created.id).unwrap();
        assert_eq!(
            normalized.integration.unwrap().stringify(),
            r#"{"repository":{"kind":"github"},"tracker":null}"#
        );
        let execution = normalized.execution.unwrap().stringify();
        assert!(execution.contains(r#""instructions":"\ud800""#));
        assert!(!execution.contains("extra"));
        assert!(execution.contains(r#""skillDirectories":[]"#));
        assert_eq!(
            normalized.provider_policy.unwrap().stringify(),
            r#"{"allowedProviders":["codex"],"allowedInstanceIds":["instance_a"]}"#
        );
        assert!(
            normalized
                .agent_task_policy
                .stringify()
                .contains(r#""rootProfileIds":["\ud800"]"#)
        );
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
