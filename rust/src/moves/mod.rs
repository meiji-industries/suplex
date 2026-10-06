//! Moves: saved, parameterized prompts that start Suplex tasks. A run records
//! what it started. The tasks own their own status.

pub mod prompt;
pub mod recommend;
pub mod shell;

use std::{collections::BTreeMap, error::Error};

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

pub use crate::http::contracts::typed::moves::{MoveBody, MoveRunBody};
use serde_json::{Map, Value, json};
use ts_rs::TS;

use crate::{
    coordination::{workflow_records::normalize_workflow_input, workflows::Workflow},
    http::{AppState, contracts::typed::Contract, contracts::typed::tasks::TaskCreateBody},
    identity::companies,
    identity::external_agents::Principal,
    platform::database::SuplexDatabase,
    projects::service::{self as projects, Project},
    shared::{hash::sha256_hex, ids::random_hex_id, time::now_millis_rfc3339},
    tasks::{TaskError, agent_api, control::DeliveryTarget, creation, response::VisualEvidence},
    terminals::host::HostTerminals,
};

/// The principal which admitted a Move run. Keeping this explicit prevents an
/// agent start from silently taking the browser/user creation path.
#[derive(Clone, Copy)]
pub enum RunActor<'a> {
    User(&'a str),
    Agent(&'a Principal),
}

impl<'a> RunActor<'a> {
    fn request_identity(self) -> Value {
        match self {
            Self::User(user_id) => json!({"user": user_id}),
            Self::Agent(principal) => json!({"agent": principal.agent_id}),
        }
    }

    fn user_id(self) -> Option<&'a str> {
        match self {
            Self::User(id) => Some(id),
            Self::Agent(_) => None,
        }
    }

    fn agent(self) -> Option<&'a Principal> {
        match self {
            Self::User(_) => None,
            Self::Agent(principal) => Some(principal),
        }
    }
}

fn agent_not_found() -> Box<dyn Error> {
    TaskError::Agent {
        status: 404,
        code: "resource_not_found",
        message: "Not found".into(),
        details: Map::new(),
    }
    .into()
}

fn agent_failure(status: u16, code: &'static str, message: impl Into<String>) -> Box<dyn Error> {
    TaskError::Agent {
        status,
        code,
        message: message.into(),
        details: Map::new(),
    }
    .into()
}

/// Checks the persisted grant rather than trusting an MCP session snapshot.
fn agent_scope(
    database: &SuplexDatabase,
    principal: &Principal,
    company_id: &str,
    project_id: &str,
) -> Result<(), Box<dyn Error>> {
    let permitted: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_external_agents a JOIN suplex_external_agent_project_grants g ON g.agent_id = a.id AND g.company_id = a.company_id WHERE a.id = ?1 AND a.company_id = ?2 AND a.status = 'paired' AND a.revoked_at IS NULL AND a.moves_granted_at IS NOT NULL AND g.project_id = ?3)",
        params![principal.agent_id, company_id, project_id], |row| row.get(0),
    )?;
    if permitted {
        Ok(())
    } else {
        Err(agent_not_found())
    }
}

fn agent_stored(
    database: &SuplexDatabase,
    principal: &Principal,
    move_id: &str,
) -> Result<StoredMove, Box<dyn Error>> {
    let stored = database
        .connection()
        .query_row(
            &format!("{MOVE_COLUMNS} WHERE id = ?1"),
            [move_id],
            stored_move,
        )
        .optional()?
        .ok_or_else(agent_not_found)?;
    agent_scope(database, principal, &stored.company_id, &stored.project_id)?;
    Ok(stored)
}

pub fn agent_list(
    database: &SuplexDatabase,
    principal: &Principal,
    project_id: &str,
) -> Result<MovesResponse, Box<dyn Error>> {
    agent_scope(database, principal, &principal.company_id, project_id)?;
    let mut statement = database.connection().prepare(&format!(
        "{MOVE_COLUMNS} WHERE company_id = ?1 AND project_id = ?2 ORDER BY name COLLATE NOCASE, id"
    ))?;
    let rows = statement
        .query_map(params![principal.company_id, project_id], stored_move)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(MovesResponse {
        moves: rows
            .into_iter()
            .map(|row| response(database, row))
            .collect::<Result<_, _>>()?,
    })
}

pub fn agent_get(
    database: &SuplexDatabase,
    principal: &Principal,
    move_id: &str,
) -> Result<MoveResponse, Box<dyn Error>> {
    response(database, agent_stored(database, principal, move_id)?)
}

/// Agent creation is idempotent per agent.  The hash includes the agent, so a
/// key cannot be replayed by another principal.
pub fn agent_create(
    database: &mut SuplexDatabase,
    principal: &Principal,
    body: MoveBody,
    idempotency_key: &str,
) -> Result<(bool, MoveResponse), Box<dyn Error>> {
    agent_scope(database, principal, &principal.company_id, &body.project_id)?;
    let project = projects::get_in_company(database, &principal.company_id, &body.project_id)?;
    let body = checked_body(database, &project, body)?;
    let hash = sha256_hex(crate::shared::js_json::stringify(
        &json!({"agent": principal.agent_id, "body": serde_json::to_value(&body)?}),
    ));
    let id = random_hex_id("move")?;
    let stamp = now_millis_rfc3339();
    let replay = database.transaction(false, |database| {
        agent_scope(database, principal, &principal.company_id, &body.project_id)?;
        let existing: Option<(String, String)> = database.connection().query_row(
            "SELECT id, request_hash FROM suplex_moves WHERE created_by_external_agent_id = ?1 AND idempotency_key = ?2",
            params![principal.agent_id, idempotency_key], |r| Ok((r.get(0)?, r.get(1)?))
        ).optional()?;
        if let Some((existing, stored_hash)) = existing {
            if stored_hash == hash { return Ok(Some(existing)); }
            return Err(agent_failure(409, "idempotency_conflict", "This idempotency key belongs to a different request"));
        }
        name_taken(database, &body.project_id, &body.name, "")?;
        database.connection().execute(
            "INSERT INTO suplex_moves (id, company_id, project_id, name, prompt, runner, profile_id, confirm, workflow, delivery_target, run_project_tests, visual_evidence, created_by_external_agent_id, idempotency_key, request_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)",
            params![id, principal.company_id, body.project_id, body.name, body.prompt, body.runner, body.profile_id, body.confirm, body.workflow.unwrap_or(Workflow::Standard), body.delivery_target.unwrap_or(DeliveryTarget::PullRequestReady), body.run_project_tests, body.visual_evidence, principal.agent_id, idempotency_key, hash, stamp]
        )?;
        Ok(None)
    })?;
    let move_id = replay.clone().unwrap_or(id);
    Ok((replay.is_none(), agent_get(database, principal, &move_id)?))
}

pub fn agent_update(
    database: &mut SuplexDatabase,
    principal: &Principal,
    move_id: &str,
    body: MoveBody,
    updated_at: &str,
) -> Result<MoveResponse, Box<dyn Error>> {
    let stored = agent_stored(database, principal, move_id)?;
    agent_scope(database, principal, &principal.company_id, &body.project_id)?;
    let project = projects::get_in_company(database, &principal.company_id, &body.project_id)?;
    let body = checked_body(database, &project, body)?;
    database.transaction(false, |database| {
        agent_scope(database, principal, &stored.company_id, &stored.project_id)?;
        agent_scope(database, principal, &principal.company_id, &body.project_id)?;
        name_taken(database, &body.project_id, &body.name, move_id)?;
        let changed = database.connection().execute("UPDATE suplex_moves SET project_id=?1,name=?2,prompt=?3,runner=?4,profile_id=?5,confirm=?6,workflow=?7,delivery_target=?8,run_project_tests=?9,visual_evidence=?10,updated_at=?11 WHERE id=?12 AND updated_at=?13", params![body.project_id,body.name,body.prompt,body.runner,body.profile_id,body.confirm,body.workflow.unwrap_or(Workflow::Standard),body.delivery_target.unwrap_or(DeliveryTarget::PullRequestReady),body.run_project_tests,body.visual_evidence,now_millis_rfc3339(),move_id,updated_at])?;
        if changed == 0 { return Err(agent_failure(412, "revision_stale", "Move revision is stale")); }
        Ok(())
    })?;
    agent_get(database, principal, move_id)
}

pub fn agent_delete(
    database: &mut SuplexDatabase,
    principal: &Principal,
    move_id: &str,
    updated_at: &str,
) -> Result<(), Box<dyn Error>> {
    let stored = agent_stored(database, principal, move_id)?;
    database.transaction(false, |database| {
        agent_scope(database, principal, &stored.company_id, &stored.project_id)?;
        let changed = database.connection().execute(
            "DELETE FROM suplex_moves WHERE id = ?1 AND updated_at = ?2",
            params![move_id, updated_at],
        )?;
        if changed == 0 {
            return Err(agent_failure(
                412,
                "revision_stale",
                "Move revision is stale",
            ));
        }
        Ok(())
    })
}
pub fn agent_runs(
    database: &SuplexDatabase,
    principal: &Principal,
    move_id: &str,
) -> Result<MoveRunsResponse, Box<dyn Error>> {
    agent_stored(database, principal, move_id)?;
    Ok(MoveRunsResponse {
        runs: runs_of(database, move_id, 50)?,
    })
}
pub fn agent_run(
    database: &SuplexDatabase,
    principal: &Principal,
    run_id: &str,
) -> Result<MoveRunResponse, Box<dyn Error>> {
    let run = database
        .connection()
        .query_row(&format!("{RUN_COLUMNS} WHERE r.id = ?1"), [run_id], run_row)
        .optional()?
        .map(run_response)
        .transpose()?
        .ok_or_else(agent_not_found)?;
    agent_stored(database, principal, &run.move_id)?;
    Ok(run)
}
pub fn agent_transcript(
    database: &SuplexDatabase,
    principal: &Principal,
    run_id: &str,
) -> Result<MoveRunTranscript, Box<dyn Error>> {
    agent_run(database, principal, run_id)?;
    let stored: Option<String> = database.connection().query_row(
        "SELECT transcript_json FROM suplex_move_runs WHERE id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&stored.ok_or_else(agent_not_found)?)?)
}

/// Shared Agent API stop operation. Authorization is checked against live
/// grants before the host terminal is touched.
pub fn agent_stop(
    database: &SuplexDatabase,
    principal: &Principal,
    run_id: &str,
) -> Result<(), Box<dyn Error>> {
    agent_run(database, principal, run_id).map(|_| ())
}

/// Archive one run once. The caller closes its terminal only after this live
/// authorization and persistence operation succeeds.
pub fn agent_archive(
    database: &SuplexDatabase,
    principal: &Principal,
    run_id: &str,
) -> Result<(), Box<dyn Error>> {
    agent_run(database, principal, run_id)?;
    database.connection().execute(
        "UPDATE suplex_move_runs SET archived_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        params![now_millis_rfc3339(), run_id],
    )?;
    Ok(())
}

pub use prompt::MoveInput;

crate::shared::wire_enum! {
    /// TypeScript `MoveRunner`.
    pub enum MoveRunner {
        Prompt = "prompt",
        Script = "script",
        PullRequestTasks = "pull_request_tasks",
        Task = "task",
    }
}

crate::shared::wire_enum! {
    /// TypeScript `MoveOutcomeKind`.
    pub enum MoveOutcomeKind {
        Created = "created",
        Excluded = "excluded",
        HasTask = "has_task",
        Failed = "failed",
    }
}

/// What a run did for one task or one pull request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    pub kind: MoveOutcomeKind,
    pub pull_request: Option<i64>,
    pub title: String,
    pub task_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MoveRunResponse {
    pub id: String,
    pub move_id: String,
    pub move_name: String,
    pub runner: MoveRunner,
    pub prompt: String,
    pub inputs: BTreeMap<String, String>,
    pub excluded_pull_requests: Vec<i64>,
    pub outcomes: Vec<MoveOutcome>,
    pub started_by: Option<String>,
    pub started_by_id: Option<String>,
    pub started_at: String,
    /// Whether the run's terminal is open, observed from the host terminals.
    pub live: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MoveResponse {
    pub id: String,
    pub company_id: String,
    pub project_id: String,
    pub name: String,
    pub prompt: String,
    pub runner: MoveRunner,
    /// The agent profile for a prompt. None means the project's Worker.
    pub profile_id: Option<String>,
    pub confirm: bool,
    /// The settings of the task that a `task` move starts. Other runners keep the defaults.
    pub workflow: Workflow,
    pub delivery_target: DeliveryTarget,
    pub run_project_tests: bool,
    pub visual_evidence: VisualEvidence,
    pub inputs: Vec<MoveInput>,
    pub last_run: Option<MoveRunResponse>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct MovesResponse {
    pub moves: Vec<MoveResponse>,
}

/// A shell run's terminal as it was when its process ended.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MoveRunTranscript {
    pub cols: u16,
    pub rows: u16,
    /// Terminal output that reproduces the screen and scrollback on a reset xterm.
    pub output: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct MoveRunsResponse {
    pub runs: Vec<MoveRunResponse>,
}

struct StoredMove {
    id: String,
    company_id: String,
    project_id: String,
    name: String,
    prompt: String,
    runner: MoveRunner,
    profile_id: Option<String>,
    confirm: bool,
    workflow: Workflow,
    delivery_target: DeliveryTarget,
    run_project_tests: bool,
    visual_evidence: VisualEvidence,
    created_at: String,
    updated_at: String,
}

const MOVE_COLUMNS: &str = "SELECT id, company_id, project_id, name, prompt, runner, profile_id, confirm, workflow, delivery_target, run_project_tests, visual_evidence, created_at, updated_at FROM suplex_moves";

fn stored_move(row: &Row<'_>) -> rusqlite::Result<StoredMove> {
    Ok(StoredMove {
        id: row.get(0)?,
        company_id: row.get(1)?,
        project_id: row.get(2)?,
        name: row.get(3)?,
        prompt: row.get(4)?,
        runner: row.get(5)?,
        profile_id: row.get(6)?,
        confirm: row.get(7)?,
        workflow: row.get(8)?,
        delivery_target: row.get(9)?,
        run_project_tests: row.get(10)?,
        visual_evidence: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

const RUN_COLUMNS: &str = "SELECT r.id, r.move_id, r.move_name, r.runner, r.prompt, r.inputs_json, r.excluded_pull_requests_json, r.outcomes_json, COALESCE(u.display_name, a.name), COALESCE(r.started_by_user_id, r.started_by_external_agent_id), r.started_at FROM suplex_move_runs r LEFT JOIN suplex_users u ON u.id = r.started_by_user_id LEFT JOIN suplex_agents a ON a.id = r.started_by_external_agent_id";

type RunRow = (
    String,
    String,
    String,
    MoveRunner,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

fn run_row(row: &Row<'_>) -> rusqlite::Result<RunRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
    ))
}

fn run_response(
    (
        id,
        move_id,
        move_name,
        runner,
        prompt,
        inputs,
        excluded,
        outcomes,
        started_by,
        started_by_id,
        started_at,
    ): RunRow,
) -> Result<MoveRunResponse, Box<dyn Error>> {
    Ok(MoveRunResponse {
        id,
        move_id,
        move_name,
        runner,
        prompt,
        inputs: serde_json::from_str(&inputs)?,
        excluded_pull_requests: serde_json::from_str(&excluded)?,
        outcomes: serde_json::from_str(&outcomes)?,
        started_by,
        started_by_id,
        started_at,
        live: false,
    })
}

fn runs_of(
    database: &SuplexDatabase,
    move_id: &str,
    limit: i64,
) -> Result<Vec<MoveRunResponse>, Box<dyn Error>> {
    let mut statement = database.connection().prepare(&format!(
        "{RUN_COLUMNS} WHERE r.move_id = ?1 AND r.archived_at IS NULL ORDER BY r.started_at DESC, r.id DESC LIMIT ?2"
    ))?;
    let rows = statement
        .query_map(params![move_id, limit], run_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(run_response).collect()
}

fn response(database: &SuplexDatabase, stored: StoredMove) -> Result<MoveResponse, Box<dyn Error>> {
    Ok(MoveResponse {
        inputs: prompt::inputs(&stored.prompt),
        last_run: runs_of(database, &stored.id, 1)?.into_iter().next(),
        id: stored.id,
        company_id: stored.company_id,
        project_id: stored.project_id,
        name: stored.name,
        prompt: stored.prompt,
        runner: stored.runner,
        profile_id: stored.profile_id,
        confirm: stored.confirm,
        workflow: stored.workflow,
        delivery_target: stored.delivery_target,
        run_project_tests: stored.run_project_tests,
        visual_evidence: stored.visual_evidence,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
    })
}

/// The move, after checking that the user can access its project.
fn accessible(
    database: &SuplexDatabase,
    user_id: &str,
    move_id: &str,
) -> Result<(StoredMove, Project), Box<dyn Error>> {
    let stored = database
        .connection()
        .query_row(
            &format!("{MOVE_COLUMNS} WHERE id = ?1"),
            [move_id],
            stored_move,
        )
        .optional()?
        .ok_or_else(TaskError::not_found)?;
    let project = projects::get(database, user_id, &stored.project_id)?;
    Ok((stored, project))
}

fn company_project(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
    project_id: &str,
) -> Result<Project, Box<dyn Error>> {
    companies::require_company_access(database, user_id, company_id)?;
    let project = projects::get(database, user_id, project_id)?;
    if project.company_id != company_id {
        return Err(TaskError::not_found().into());
    }
    Ok(project)
}

/// The body to store: a prompt or script needs text. A script keeps no agent
/// profile. A prompt's agent must have a terminal command line, and each pull
/// request task can use any Worker profile the project allows. A task move
/// needs a workflow and a delivery target, and uses the project's agents and no
/// confirmation. Other runners keep the default task settings.
fn checked_body(
    database: &SuplexDatabase,
    project: &Project,
    mut body: MoveBody,
) -> Result<MoveBody, Box<dyn Error>> {
    match body.runner {
        MoveRunner::Prompt if body.prompt.trim().is_empty() => {
            return Err(TaskError::new("Write the prompt for this move", 422).into());
        }
        MoveRunner::Script if body.prompt.trim().is_empty() => {
            return Err(TaskError::new("Write the script for this move", 422).into());
        }
        MoveRunner::Task => {
            match body.workflow {
                None => {
                    return Err(TaskError::new("Select a workflow for this move", 422).into());
                }
                Some(Workflow::RefinePullRequest) => {
                    return Err(TaskError::new(
                        "Review and repair needs a pull request. Select \"for each pull request\" to use it",
                        422,
                    )
                    .into());
                }
                Some(_) => {}
            }
            if body.delivery_target.is_none() {
                return Err(TaskError::new("Select a delivery target for this move", 422).into());
            }
            body.profile_id = None;
            body.confirm = false;
        }
        MoveRunner::Prompt | MoveRunner::PullRequestTasks => {}
        MoveRunner::Script => body.profile_id = None,
    }
    if body.runner != MoveRunner::Task {
        body.workflow = None;
        body.delivery_target = None;
        body.run_project_tests = true;
        body.visual_evidence = VisualEvidence::Off;
    }
    if let Some(profile_id) = body.profile_id.as_deref() {
        let profile = crate::tasks::commands::selected_profile(
            database,
            project,
            Some(profile_id),
            &project.worker_profile_id,
            "worker",
        )?;
        if body.runner == MoveRunner::Prompt {
            shell::check_provider(&profile)?;
        }
    }
    Ok(body)
}

fn name_taken(
    database: &SuplexDatabase,
    project_id: &str,
    name: &str,
    id: &str,
) -> Result<(), Box<dyn Error>> {
    let taken: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_moves WHERE project_id = ?1 AND name = ?2 AND id <> ?3)",
        params![project_id, name, id],
        |row| row.get(0),
    )?;
    if taken {
        return Err(TaskError::new("This project already has a move with this name", 409).into());
    }
    Ok(())
}

pub fn list(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> Result<MovesResponse, Box<dyn Error>> {
    companies::require_company_access(database, user_id, company_id)?;
    let mut moves = list_company(database, company_id)?;
    moves.retain(|item| projects::get(database, user_id, &item.project_id).is_ok());
    Ok(MovesResponse { moves })
}

/// Every move of the company, for the sync feed. The caller authorizes.
pub(crate) fn list_company(
    database: &SuplexDatabase,
    company_id: &str,
) -> Result<Vec<MoveResponse>, Box<dyn Error>> {
    let mut statement = database.connection().prepare(&format!(
        "{MOVE_COLUMNS} WHERE company_id = ?1 ORDER BY name COLLATE NOCASE, id"
    ))?;
    let stored = statement
        .query_map([company_id], stored_move)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    stored
        .into_iter()
        .map(|stored| response(database, stored))
        .collect()
}

/// A run is live while its host terminal is open. The terminal is the authority.
pub fn observed(terminals: &HostTerminals, mut run: MoveRunResponse) -> MoveRunResponse {
    run.live = terminals.contains(&shell::terminal_id(&run.id));
    run
}

pub fn create(
    database: &mut SuplexDatabase,
    user_id: &str,
    company_id: &str,
    body: MoveBody,
) -> Result<MoveResponse, Box<dyn Error>> {
    let project = company_project(database, user_id, company_id, &body.project_id)?;
    let body = checked_body(database, &project, body)?;
    let id = random_hex_id("move")?;
    let stamp = now_millis_rfc3339();
    database.transaction(false, |database| {
        name_taken(database, &body.project_id, &body.name, "")?;
        database.connection().execute(
            "INSERT INTO suplex_moves (id, company_id, project_id, name, prompt, runner, profile_id, confirm, workflow, delivery_target, run_project_tests, visual_evidence, created_by_user_id, idempotency_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?1, ?14, ?14)",
            params![id, company_id, body.project_id, body.name, body.prompt, body.runner, body.profile_id, body.confirm, body.workflow.unwrap_or(Workflow::Standard), body.delivery_target.unwrap_or(DeliveryTarget::PullRequestReady), body.run_project_tests, body.visual_evidence, user_id, stamp],
        )?;
        Ok(())
    })?;
    get(database, user_id, &id)
}

pub fn get(
    database: &SuplexDatabase,
    user_id: &str,
    move_id: &str,
) -> Result<MoveResponse, Box<dyn Error>> {
    let (stored, _) = accessible(database, user_id, move_id)?;
    response(database, stored)
}

pub fn update(
    database: &mut SuplexDatabase,
    user_id: &str,
    move_id: &str,
    body: MoveBody,
) -> Result<MoveResponse, Box<dyn Error>> {
    let (stored, _) = accessible(database, user_id, move_id)?;
    let project = company_project(database, user_id, &stored.company_id, &body.project_id)?;
    let body = checked_body(database, &project, body)?;
    database.transaction(false, |database| {
        name_taken(database, &body.project_id, &body.name, move_id)?;
        database.connection().execute(
            "UPDATE suplex_moves SET project_id = ?1, name = ?2, prompt = ?3, runner = ?4, profile_id = ?5, confirm = ?6, workflow = ?7, delivery_target = ?8, run_project_tests = ?9, visual_evidence = ?10, updated_at = ?11 WHERE id = ?12",
            params![body.project_id, body.name, body.prompt, body.runner, body.profile_id, body.confirm, body.workflow.unwrap_or(Workflow::Standard), body.delivery_target.unwrap_or(DeliveryTarget::PullRequestReady), body.run_project_tests, body.visual_evidence, now_millis_rfc3339(), move_id],
        )?;
        Ok(())
    })?;
    get(database, user_id, move_id)
}

pub fn delete(
    database: &mut SuplexDatabase,
    user_id: &str,
    move_id: &str,
) -> Result<(), Box<dyn Error>> {
    accessible(database, user_id, move_id)?;
    database
        .connection()
        .execute("DELETE FROM suplex_moves WHERE id = ?1", [move_id])?;
    Ok(())
}

pub fn runs(
    database: &SuplexDatabase,
    user_id: &str,
    move_id: &str,
) -> Result<MoveRunsResponse, Box<dyn Error>> {
    accessible(database, user_id, move_id)?;
    Ok(MoveRunsResponse {
        runs: runs_of(database, move_id, 50)?,
    })
}

fn existing_run(
    database: &SuplexDatabase,
    move_id: &str,
    idempotency_key: &str,
) -> Result<Option<MoveRunResponse>, Box<dyn Error>> {
    database
        .connection()
        .query_row(
            &format!("{RUN_COLUMNS} WHERE r.move_id = ?1 AND r.idempotency_key = ?2"),
            params![move_id, idempotency_key],
            run_row,
        )
        .optional()?
        .map(run_response)
        .transpose()
}

/// One open pull request, as the task source discovery presents it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenPullRequest {
    pub number: i64,
    pub title: String,
    pub has_task: bool,
}

/// Each open pull request is excluded, already has a task, or gets a task.
pub fn plan_pull_requests(open: &[OpenPullRequest], excluded: &[i64]) -> Vec<MoveOutcome> {
    open.iter()
        .map(|pull| MoveOutcome {
            kind: if excluded.contains(&pull.number) {
                MoveOutcomeKind::Excluded
            } else if pull.has_task {
                MoveOutcomeKind::HasTask
            } else {
                MoveOutcomeKind::Created
            },
            pull_request: Some(pull.number),
            title: pull.title.clone(),
            task_id: None,
            reason: None,
        })
        .collect()
}

fn open_pull_requests(sources: &Value) -> Result<Vec<OpenPullRequest>, Box<dyn Error>> {
    if sources["available"] == false {
        let reason = sources["reason"]
            .as_str()
            .unwrap_or("GitHub did not return the open pull requests");
        return Err(TaskError::new(reason, 503).into());
    }
    Ok(sources["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|source| {
            Some(OpenPullRequest {
                number: source["number"].as_i64()?,
                title: source["title"].as_str().unwrap_or_default().to_owned(),
                has_task: !source["usedBy"].is_null(),
            })
        })
        .collect())
}

/// Create one task through the authority which admitted the Move run.
async fn create_task(
    state: &AppState,
    company_id: &str,
    actor: RunActor<'_>,
    mut fields: Map<String, Value>,
    outcome: &mut MoveOutcome,
) {
    let request = normalize_workflow_input(&mut fields, true).and_then(|()| {
        TaskCreateBody::parse(Some(&Value::Object(fields)))
            .map_err(|failure| format!("{failure:?}"))
    });
    let request = match request {
        Ok(request) => request,
        Err(reason) => {
            outcome.kind = MoveOutcomeKind::Failed;
            outcome.reason = Some(reason);
            return;
        }
    };
    let result: Result<Value, Box<dyn Error>> = match actor {
        RunActor::User(user_id) => creation::create_browser(
            state.clone(),
            company_id.to_owned(),
            user_id.to_owned(),
            request,
        )
        .await
        .map_err(|error| Box::new(error) as Box<dyn Error>)
        .and_then(|(_, task)| serde_json::to_value(task).map_err(Into::into)),
        RunActor::Agent(principal) => {
            // The browser request has `startImmediately` and a workflow engine,
            // whereas the Agent API deliberately accepts `queue` and a workflow
            // record.  Build its contract directly: serialising the browser
            // body leaks those browser-only keys into `extra`, which the Agent
            // API correctly rejects.
            let raw = crate::http::contracts::typed::agent_api::TaskCreateBody {
                project_id: request.project_id.clone(),
                title: request.title.clone(),
                description: Some(request.description.clone()),
                idempotency_key: request.idempotency_key.clone(),
                depends_on: Some(request.depends_on.clone()),
                blocked_by_pull_requests: Some(request.blocked_by_pull_requests.clone()),
                queue: Some(true),
                images: request.images.clone(),
                source: request.source.clone(),
                workflow_id: Some(format!("workflow_native_{}", request.workflow.as_str())),
                template_id: None,
                root_profile_id: request.root_profile_id.clone(),
                worker_profile_id: request.worker_profile_id.clone(),
                advisor_profile_ids: request.advisor_profile_ids.clone(),
                delivery_target: Some(request.delivery_target),
                run_project_tests: Some(request.run_project_tests),
                visual_evidence: Some(request.visual_evidence.clone()),
                dry_run: None,
                extra: Map::new(),
            };
            match agent_api::create(state, principal, &raw, None).await {
                Ok(agent_api::Creation::Task { id, active, .. }) => {
                    if active && let Some(host) = &state.task_host {
                        host.wake(id.clone());
                    }
                    Ok::<Value, Box<dyn Error>>(json!({"id": id}))
                }
                Ok(agent_api::Creation::DryRun(_)) => Err(Box::new(TaskError::new(
                    "Move task creation unexpectedly dry-ran",
                    500,
                ))),
                Err(error) => Err(error),
            }
        }
    };
    match result {
        Ok(task) => {
            outcome.task_id = task["id"].as_str().map(str::to_owned);
        }
        Err(failure) => {
            outcome.kind = MoveOutcomeKind::Failed;
            outcome.reason = Some(failure.to_string());
        }
    }
}

/// Start a run: create its tasks and record what happened. A retry with the
/// same idempotency key returns the recorded run; task keys make a retry after
/// a partial failure create only the missing tasks.
pub async fn start(
    state: &AppState,
    actor: RunActor<'_>,
    move_id: &str,
    body: MoveRunBody,
) -> Result<(bool, MoveRunResponse), Box<dyn Error>> {
    let request_hash = sha256_hex(crate::shared::js_json::stringify(
        &json!({"actor": actor.request_identity(), "inputs": body.inputs, "excluded": body.excluded_pull_requests}),
    ));
    let (stored, project, replay) = state.with_database(|database| {
        let (stored, project) = match actor {
            RunActor::User(user_id) => accessible(database, user_id, move_id)?,
            RunActor::Agent(principal) => {
                let stored = agent_stored(database, principal, move_id)?;
                let project =
                    projects::get_in_company(database, &stored.company_id, &stored.project_id)?;
                (stored, project)
            }
        };
        let replay = existing_run(database, move_id, &body.idempotency_key)?;
        Ok::<_, Box<dyn Error>>((stored, project, replay))
    })?;
    if let Some(run) = replay {
        let hash: Option<String> = state.with_database(|database| {
            database.connection().query_row(
                "SELECT request_hash FROM suplex_move_runs WHERE id=?1",
                [&run.id],
                |row| row.get(0),
            )
        })?;
        if hash.as_deref().is_some_and(|hash| hash != request_hash) {
            return Err(agent_failure(
                409,
                "idempotency_conflict",
                "This idempotency key belongs to a different request",
            ));
        }
        return Ok((false, run));
    }
    let resolved = prompt::resolve(&prompt::inputs(&stored.prompt), &body.inputs)
        .map_err(|message| TaskError::new(message, 422))?;
    let rendered = prompt::render(&stored.prompt, &resolved);
    let run_id = random_hex_id("moverun")?;
    // A reserved row survives a crash after admission. Errors before an effect
    // release it below so the caller can safely retry the same key.
    let reserved = state.with_database(|database| database.transaction(false, |database| {
        if let Some(existing) = existing_run(database, move_id, &body.idempotency_key)? {
            let stored_hash: Option<String> = database.connection().query_row("SELECT request_hash FROM suplex_move_runs WHERE id=?1", [&existing.id], |r| r.get(0))?;
            if stored_hash.as_deref().is_none_or(|hash| hash == request_hash) { return Ok(Some(existing)); }
            return Err(agent_failure(409, "idempotency_conflict", "This idempotency key belongs to a different request"));
        }
        database.connection().execute("INSERT INTO suplex_move_runs (id, move_id, company_id, project_id, move_name, runner, prompt, inputs_json, excluded_pull_requests_json, outcomes_json, started_by_user_id, started_by_external_agent_id, started_at, idempotency_key, request_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'[]',?10,?11,?12,?13,?14)", params![run_id, move_id, stored.company_id, stored.project_id, stored.name, stored.runner, rendered, serde_json::to_string(&resolved)?, serde_json::to_string(&body.excluded_pull_requests)?, actor.user_id(), actor.agent().map(|p| &p.agent_id), now_millis_rfc3339(), body.idempotency_key, request_hash])?;
        Ok(None)
    }))?;
    if let Some(run) = reserved {
        return Ok((false, run));
    }
    let task_key = |suffix: &str| format!("move:{move_id}:{}:{suffix}", body.idempotency_key);
    let outcomes = async {
        Ok::<_, Box<dyn Error>>(match stored.runner {
        MoveRunner::Prompt | MoveRunner::Script => {
            let command = if stored.runner == MoveRunner::Script {
                shell::script(&rendered)
            } else {
                let profile = state.with_database(|database| {
                    crate::tasks::commands::selected_profile(
                        database,
                        &project,
                        stored.profile_id.as_deref(),
                        &project.worker_profile_id,
                        "worker",
                    )
                })?;
                shell::command(&profile, &project.base_branch, &rendered)?
            };
            let worktree =
                std::path::Path::new(&project.worktree_root).join(format!("move-{run_id}"));
            let (repository, base, at) = (
                std::path::PathBuf::from(&project.repository_path),
                project.base_branch.clone(),
                worktree.clone(),
            );
            tokio::task::spawn_blocking(move || {
                shell::prepare_worktree(&repository, &at, &base).map_err(|error| error.to_string())
            })
            .await?
            .map_err(|reason| TaskError::new(reason, 422))?;
            let (saving, saved_run) = (state.clone(), run_id.clone());
            // ponytail: the run row is written just after the terminal opens, so a
            // command that ends within that moment keeps no transcript.
            let spec = crate::terminals::host::Spec::move_run(&command, worktree).with_transcript(
                move |transcript| {
                    if let Err(error) = saving
                        .with_database(|database| save_transcript(database, &saved_run, transcript))
                    {
                        eprintln!("Suplex could not save the move run transcript: {error}");
                    }
                },
            );
            state
                .host_terminals
                .open(&shell::terminal_id(&run_id), spec, 120, 32)?;
            Vec::new()
        }
        MoveRunner::PullRequestTasks => {
            let mut sources = crate::tasks::sources::discover(&project, "pull_request").await?;
            crate::http::routes::projects::annotate_pull_request_owners(
                state,
                &project,
                &mut sources,
            )?;
            let mut outcomes =
                plan_pull_requests(&open_pull_requests(&sources)?, &body.excluded_pull_requests);
            for outcome in outcomes
                .iter_mut()
                .filter(|outcome| outcome.kind == MoveOutcomeKind::Created)
            {
                let number = outcome.pull_request.unwrap_or_default();
                let mut fields = json!({
                    "projectId": project.id, "title": outcome.title,
                    "workflow": "refine_pull_request",
                    "source": {"kind": "pull_request", "number": number},
                    "startImmediately": true,
                    "idempotencyKey": task_key(&number.to_string()),
                });
                if let Some(profile_id) = &stored.profile_id {
                    fields["workerProfileId"] = json!(profile_id);
                }
                if !rendered.trim().is_empty() {
                    fields["description"] = json!(rendered);
                }
                let fields = fields.as_object().cloned().unwrap_or_default();
                create_task(state, &stored.company_id, actor, fields, outcome).await;
            }
            outcomes
        }
        MoveRunner::Task => {
            let mut outcome = MoveOutcome {
                kind: MoveOutcomeKind::Created,
                pull_request: None,
                title: stored.name.clone(),
                task_id: None,
                reason: None,
            };
            let mut fields = json!({
                "projectId": project.id, "title": stored.name,
                "workflow": stored.workflow, "deliveryTarget": stored.delivery_target,
                "runProjectTests": stored.run_project_tests, "visualEvidence": stored.visual_evidence,
                "startImmediately": true,
                "idempotencyKey": task_key("task"),
            });
            if !rendered.trim().is_empty() {
                fields["description"] = json!(rendered);
            }
            let fields = fields.as_object().cloned().unwrap_or_default();
            create_task(state, &stored.company_id, actor, fields, &mut outcome).await;
            vec![outcome]
        }
        })
    }
    .await;
    let outcomes = match outcomes {
        Ok(outcomes) => outcomes,
        Err(error) => {
            // No task outcome or terminal was recorded, so no effect escaped the
            // reservation. Delete only this still-empty row; a crash leaves it
            // durable for replay protection.
            state.with_database(|database| {
                database.connection().execute(
                    "DELETE FROM suplex_move_runs WHERE id = ?1 AND outcomes_json = '[]'",
                    [&run_id],
                )
            })?;
            return Err(error);
        }
    };
    state.with_database(|database| {
        database.connection().execute(
            "UPDATE suplex_move_runs SET outcomes_json=?1 WHERE id=?2",
            params![serde_json::to_string(&outcomes)?, run_id],
        )?;
        let run = existing_run(database, move_id, &body.idempotency_key)?
            .ok_or("the recorded run disappeared")?;
        Ok((true, run))
    })
}

/// One run, after checking that the user can access its move's project.
pub fn get_run(
    database: &SuplexDatabase,
    user_id: &str,
    run_id: &str,
) -> Result<MoveRunResponse, Box<dyn Error>> {
    let run = database
        .connection()
        .query_row(&format!("{RUN_COLUMNS} WHERE r.id = ?1"), [run_id], run_row)
        .optional()?
        .map(run_response)
        .transpose()?
        .ok_or_else(TaskError::not_found)?;
    accessible(database, user_id, &run.move_id)?;
    Ok(run)
}

/// Hide a run from its move's history and from Activity. The run stays readable by its ID.
pub fn archive_run(
    database: &SuplexDatabase,
    user_id: &str,
    run_id: &str,
) -> Result<(), Box<dyn Error>> {
    get_run(database, user_id, run_id)?;
    database.connection().execute(
        "UPDATE suplex_move_runs SET archived_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        params![now_millis_rfc3339(), run_id],
    )?;
    Ok(())
}

pub(crate) fn save_transcript(
    database: &SuplexDatabase,
    run_id: &str,
    transcript: crate::terminals::host::Transcript,
) -> Result<(), Box<dyn Error>> {
    let stored = MoveRunTranscript {
        cols: transcript.cols,
        rows: transcript.rows,
        output: String::from_utf8_lossy(&transcript.output).into_owned(),
    };
    database.connection().execute(
        "UPDATE suplex_move_runs SET transcript_json = ?1 WHERE id = ?2",
        params![serde_json::to_string(&stored)?, run_id],
    )?;
    Ok(())
}

/// The saved terminal of a run whose process ended.
pub fn transcript(
    database: &SuplexDatabase,
    user_id: &str,
    run_id: &str,
) -> Result<MoveRunTranscript, Box<dyn Error>> {
    get_run(database, user_id, run_id)?;
    let stored: Option<String> = database.connection().query_row(
        "SELECT transcript_json FROM suplex_move_runs WHERE id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(
        &stored.ok_or_else(TaskError::not_found)?,
    )?)
}
