//! Agent profiles and project default agents for a paired agent.
//!
//! Every paired agent can list profiles and read the default agents of its
//! granted projects. A change to a project's default agents also needs the
//! administrator's project agents grant, read from the database on each
//! request.

use chrono::Utc;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    http::contracts::typed::agent_api::{ProfileListQuery, ProjectAgentsBody},
    identity::external_agents::Principal,
    platform::database::{DatabaseResult, SuplexDatabase},
    profiles::{
        agent_profiles::policy_allows,
        defaults::{self, DefaultSlot, ProfileDefaults},
    },
    projects::{
        ProjectError, ProjectProviderPolicy,
        service::{self as projects, AgentSelection, Project},
    },
    shared::{hash::sha256_hex, js_json, time::rfc3339_millis},
    tasks::{
        TaskError,
        control::{HarnessKind, ReasoningLevel, SessionKind},
    },
};

use super::agent_api::{fail, fail_with, require_scope};

/// `GET /api/agent/profiles`.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct AgentProfiles {
    pub profiles: Vec<AgentProfileSummary>,
}

/// One agent profile as a paired agent reads it.
#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileSummary {
    id: String,
    name: String,
    role: SessionKind,
    provider: HarnessKind,
    model: String,
    reasoning_level: ReasoningLevel,
    archived: bool,
    /// New projects receive this profile for its role: the Coordinator slot
    /// for a `root` profile, the Worker slot for a `worker` profile.
    is_default_for_role: bool,
    /// Every default slot this profile fills, including the Alt Coordinator.
    default_slots: Vec<DefaultSlot>,
    /// Each granted project, and whether its provider policy allows this
    /// profile. An archived profile is not allowed anywhere.
    projects: Vec<AgentProfileProject>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileProject {
    project_id: String,
    allowed: bool,
}

/// The default agents of a granted project. `updatedAt` is the concurrency
/// token of `PATCH /api/agent/projects/{projectId}/agents`.
#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentProjectAgents {
    pub project_id: String,
    pub root_profile_id: String,
    pub worker_profile_id: String,
    pub alt_profile_id: String,
    pub provider_policy: Option<ProjectProviderPolicy>,
    pub updated_at: String,
}

impl From<&Project> for AgentProjectAgents {
    fn from(project: &Project) -> Self {
        Self {
            project_id: project.id.clone(),
            root_profile_id: project.root_profile_id.clone(),
            worker_profile_id: project.worker_profile_id.clone(),
            alt_profile_id: project.alt_profile_id.clone(),
            provider_policy: project.provider_policy.clone(),
            updated_at: project.updated_at.clone(),
        }
    }
}

/// The projects the agent holds a grant to, in name order.
pub(super) fn granted_projects(
    database: &SuplexDatabase,
    principal: &Principal,
) -> DatabaseResult<Vec<Project>> {
    let mut statement = database.connection().prepare(
        "SELECT p.id FROM suplex_external_agent_project_grants g JOIN suplex_projects p ON p.id = g.project_id AND p.company_id = g.company_id JOIN suplex_external_agents a ON a.id = g.agent_id AND a.company_id = g.company_id WHERE a.id = ?1 AND a.company_id = ?2 AND a.status = 'paired' ORDER BY p.name COLLATE NOCASE, p.id",
    )?;
    let ids = statement
        .query_map(params![principal.agent_id, principal.company_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter()
        .map(|id| projects::get_in_company(database, &principal.company_id, id))
        .collect()
}

/// The profile that new projects receive for a role. Suplex stores one
/// default for each slot; see `profiles::defaults`.
fn is_default_for_role(defaults: &ProfileDefaults, role: SessionKind, profile_id: &str) -> bool {
    let slot = match role {
        SessionKind::Root => DefaultSlot::Root,
        SessionKind::Worker => DefaultSlot::Worker,
    };
    defaults.get(slot) == profile_id
}

struct StoredProfile {
    id: String,
    name: String,
    role: SessionKind,
    provider: HarnessKind,
    model: String,
    reasoning_level: ReasoningLevel,
    provider_instance_id: Option<String>,
    archived: bool,
}

/// `GET /api/agent/profiles`: every agent profile, with the granted projects
/// whose provider policy allows it. A `projectId` names a granted project and
/// keeps only the profiles that project allows.
pub fn list(
    database: &SuplexDatabase,
    principal: &Principal,
    query: &ProfileListQuery,
) -> DatabaseResult<AgentProfiles> {
    if let Some(project_id) = &query.project_id {
        require_scope(
            database,
            principal,
            &principal.company_id,
            project_id,
            false,
            None,
        )?;
    }
    let granted = granted_projects(database, principal)?
        .into_iter()
        .filter(|project| {
            query
                .project_id
                .as_ref()
                .is_none_or(|project_id| &project.id == project_id)
        })
        .collect::<Vec<_>>();
    let defaults = defaults::resolve_all(database)?;
    let mut statement = database.connection().prepare(
        "SELECT id, name, role, provider, model, reasoning_level, provider_instance_id, archived_at IS NOT NULL FROM suplex_profiles WHERE (?1 IS NULL OR role = ?1) AND (?2 OR archived_at IS NULL) ORDER BY role, name COLLATE NOCASE, id",
    )?;
    let stored = statement
        .query_map(params![query.role, query.include_archived], |row| {
            Ok(StoredProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                provider: row.get(3)?,
                model: row.get(4)?,
                reasoning_level: row.get(5)?,
                provider_instance_id: row.get(6)?,
                archived: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let profiles = stored
        .into_iter()
        .map(|profile| {
            let projects = granted
                .iter()
                .map(|project| AgentProfileProject {
                    project_id: project.id.clone(),
                    allowed: !profile.archived
                        && policy_allows(
                            project.provider_policy.as_ref(),
                            profile.provider,
                            profile.provider_instance_id.as_deref(),
                        ),
                })
                .collect::<Vec<_>>();
            AgentProfileSummary {
                is_default_for_role: is_default_for_role(&defaults, profile.role, &profile.id),
                default_slots: DefaultSlot::ALL
                    .into_iter()
                    .filter(|slot| defaults.get(*slot) == profile.id)
                    .collect(),
                id: profile.id,
                name: profile.name,
                role: profile.role,
                provider: profile.provider,
                model: profile.model,
                reasoning_level: profile.reasoning_level,
                archived: profile.archived,
                projects,
            }
        })
        .filter(|profile| {
            query.project_id.is_none() || profile.projects.iter().any(|project| project.allowed)
        })
        .collect();
    Ok(AgentProfiles { profiles })
}

/// The administrator's project agents grant, as stored now. Without it the
/// agent receives the same `404` for every project.
fn require_project_agents_grant(
    database: &SuplexDatabase,
    principal: &Principal,
) -> DatabaseResult<()> {
    let granted: Option<bool> = database
        .connection()
        .query_row(
            "SELECT project_agents_granted_at IS NOT NULL FROM suplex_external_agents WHERE id = ?1 AND company_id = ?2 AND status = 'paired' AND revoked_at IS NULL",
            params![principal.agent_id, principal.company_id],
            |row| row.get(0),
        )
        .optional()?;
    if granted == Some(true) {
        return Ok(());
    }
    Err(fail(
        "Not found. An administrator must turn on \"Change project agents\" for this agent in its actions on the Agents page.",
        404,
        "project_agents_grant_required",
    ))
}

/// A Project > Agents refusal as the field, value, and reason of the agent API.
fn field_failure(
    error: Box<dyn std::error::Error + Send + Sync>,
    body: &ProjectAgentsBody,
    before: &Project,
) -> Box<dyn std::error::Error + Send + Sync> {
    let Some(rejected) = error.downcast_ref::<ProjectError>() else {
        return error;
    };
    let Some(finding) = rejected
        .findings()
        .first()
        .filter(|_| rejected.status() == 422)
    else {
        return error;
    };
    let (code, value) = match finding.field.as_str() {
        "rootProfileId" => (
            "root_profile_not_found",
            body.root_profile_id
                .as_deref()
                .unwrap_or(&before.root_profile_id),
        ),
        "workerProfileId" => (
            "worker_profile_not_found",
            body.worker_profile_id
                .as_deref()
                .unwrap_or(&before.worker_profile_id),
        ),
        "altProfileId" => (
            "alt_profile_not_found",
            body.alt_profile_id
                .as_deref()
                .unwrap_or(&before.alt_profile_id),
        ),
        _ => ("profile_not_allowed", ""),
    };
    let code = if finding.code == "profile-provider-ineligible" {
        "profile_not_allowed"
    } else {
        code
    };
    TaskError::field(code, finding.message.clone(), &finding.field, value).into()
}

/// `PATCH /api/agent/projects/{projectId}/agents`: the Project > Agents write,
/// with its validation. The same idempotency key and body replay the first
/// result without a second write; a stale `updatedAt` writes nothing.
pub fn update_project_agents(
    database: &mut SuplexDatabase,
    principal: &Principal,
    project_id: &str,
    body: &ProjectAgentsBody,
) -> DatabaseResult<Value> {
    require_project_agents_grant(database, principal)?;
    require_scope(
        database,
        principal,
        &principal.company_id,
        project_id,
        true,
        None,
    )?;
    let hash = sha256_hex(js_json::stringify(
        &json!({"projectId": project_id, "body": serde_json::to_value(body)?}),
    ));
    let now = Utc::now();
    database.transaction(true, |database| {
        let stored: Option<(String, String)> = database
            .connection()
            .query_row(
                "SELECT request_hash, result_json FROM suplex_external_agent_project_receipts WHERE agent_id = ?1 AND project_id = ?2 AND idempotency_key = ?3",
                params![principal.agent_id, project_id, body.idempotency_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((stored_hash, result)) = stored {
            if stored_hash != hash {
                return Err(fail(
                    "This idempotency key belongs to a different request",
                    409,
                    "idempotency_conflict",
                ));
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let before = projects::get_in_company(database, &principal.company_id, project_id)?;
        let selection = AgentSelection {
            root: body.root_profile_id.as_deref(),
            worker: body.worker_profile_id.as_deref(),
            alt: body.alt_profile_id.as_deref(),
        };
        let written = projects::set_agents_from_agent(
            database,
            &principal.agent_id,
            &principal.company_id,
            project_id,
            selection,
            &body.updated_at,
            now,
        )
        .map_err(|error| field_failure(error, body, &before))?;
        let Some(project) = written else {
            return Err(fail_with(
                "Project revision is stale. Read the project again and send its updatedAt.",
                412,
                "revision_stale",
                json!({"updatedAt": before.updated_at}),
            ));
        };
        let result = serde_json::to_value(AgentProjectAgents::from(&project))?;
        database.connection().execute(
            "INSERT INTO suplex_external_agent_project_receipts (agent_id, project_id, idempotency_key, request_hash, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                principal.agent_id,
                project_id,
                body.idempotency_key,
                hash,
                js_json::stringify(&result),
                rfc3339_millis(now)
            ],
        )?;
        Ok(result)
    })
}
