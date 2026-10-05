//! Task authority, projections, creation, and lifecycle commands for paired agents.
//!
//! Reads cover every task in the agent's current project grants. Commands,
//! dependency writes, and duplicates stay limited to tasks the agent created.

use crate::coordination::workflows::{Completion, DeliveryWait};
use crate::projects::ProjectError;
use crate::shared::hash::sha256_hex;
use crate::shared::time::rfc3339_millis;
use crate::tasks::TaskError;
use crate::tasks::control::{PullRequestReference, TaskProfile, TaskStatus};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use base64::{Engine, engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{
    coordination::root_session_store,
    http::{
        AppState,
        contracts::typed::{
            ContractFailure,
            agent_api::{
                ANSWER_HUMAN_QUESTION, TaskCommandBody, TaskCreateBody, TaskDependenciesBody,
                TaskListQuery, TaskUpdateBody,
            },
            task_templates,
            tasks::{self as task_contracts, TaskImage},
        },
    },
    identity::external_agents::{self, Principal},
    integrations::github_delivery::{Github, Observation},
    platform::{
        artifacts,
        database::{DatabaseResult, SuplexDatabase},
    },
    projects::service::{self as projects, Project},
};

use super::{
    archive::operations as archive,
    commands, images, integration, pull_request_dependencies,
    repository::{self, TaskCreator},
    response, sources,
};

fn fail(message: &str, status: u16, code: &'static str) -> Box<dyn Error> {
    fail_with(message, status, code, Value::Null)
}

fn fail_with(message: &str, status: u16, code: &'static str, details: Value) -> Box<dyn Error> {
    TaskError::Agent {
        status,
        code,
        message: message.to_owned(),
        details: details.as_object().cloned().unwrap_or_default(),
    }
    .into()
}

fn not_found() -> Box<dyn Error> {
    fail("Not found", 404, "resource_not_found")
}

/// HMAC-SHA256 as `createHmac("sha256", key)`, encoded as base64url.
fn hmac(key: &str, message: &str) -> String {
    let mut block = [0_u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key.as_bytes()));
    } else {
        block[..key.len()].copy_from_slice(key.as_bytes());
    }
    let pad = |byte: u8| block.iter().map(|value| value ^ byte).collect::<Vec<_>>();
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message.as_bytes())
        .finalize();
    let outer = Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize();
    URL_SAFE_NO_PAD.encode(outer)
}

pub const TASK_COMMANDS: [&str; 10] = crate::http::contracts::typed::agent_api::TASK_COMMANDS;
/// ponytail: one page of rows feeds upstream dependency lookup; page it if an agent ever owns more.
const UPSTREAM_POOL: usize = 200;

/// The lifecycle commands an agent may send; answers need the answer grant.
pub fn task_commands(answers: bool) -> Vec<&'static str> {
    TASK_COMMANDS
        .into_iter()
        .filter(|command| answers || *command != ANSWER_HUMAN_QUESTION)
        .collect()
}

/// The task row fields authority and paging read.
#[derive(Clone, Debug)]
struct Row {
    id: String,
    company_id: String,
    project_id: String,
    command_revision: i64,
}

const ROW_SELECT: &str =
    "SELECT t.id, t.company_id, t.project_id, t.command_revision FROM suplex_tasks t";

fn row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: row.get(0)?,
        company_id: row.get(1)?,
        project_id: row.get(2)?,
        command_revision: row.get(3)?,
    })
}

fn task_row(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Option<Row>> {
    Ok(database
        .connection()
        .query_row(
            &format!("{ROW_SELECT} WHERE t.id = ?1"),
            [task_id],
            row_from,
        )
        .optional()?)
}

/// The rejection a caller names when an unavailable project is a request field.
struct ScopeFailure<'a> {
    code: &'static str,
    field: &'a str,
    value: &'a str,
    reason: &'a str,
}

fn project_scope_failure(project_id: &str) -> ScopeFailure<'_> {
    ScopeFailure {
        code: "project_not_found",
        field: "projectId",
        value: project_id,
        reason: "The project is not available.",
    }
}

fn require_scope(
    database: &SuplexDatabase,
    principal: &Principal,
    company_id: &str,
    project_id: &str,
    active: bool,
    failure: Option<ScopeFailure<'_>>,
) -> DatabaseResult<()> {
    let denied = |failure: Option<ScopeFailure<'_>>| match failure {
        Some(failure) => fail_with(
            failure.reason,
            422,
            failure.code,
            json!({"code": failure.code, "field": failure.field, "value": failure.value, "reason": failure.reason}),
        ),
        None => not_found(),
    };
    if principal.company_id != company_id {
        return Err(denied(failure));
    }
    let status: Option<String> = database.connection().query_row(
        "SELECT c.status FROM suplex_external_agents a JOIN suplex_external_agent_project_grants g ON g.agent_id = a.id AND g.company_id = a.company_id JOIN suplex_companies c ON c.id = a.company_id WHERE a.id = ?1 AND a.company_id = ?2 AND a.status = 'paired' AND a.revoked_at IS NULL AND g.project_id = ?3",
        params![principal.agent_id, company_id, project_id],
        |row| row.get(0),
    ).optional()?;
    match status {
        None => Err(denied(failure)),
        Some(status) if active && status != "active" => {
            Err(fail("The company is not active", 409, "task_failure"))
        }
        Some(_) => Ok(()),
    }
}

fn require_readable(
    database: &SuplexDatabase,
    principal: &Principal,
    task_id: &str,
) -> DatabaseResult<Row> {
    let row = task_row(database, task_id)?.ok_or_else(not_found)?;
    require_scope(
        database,
        principal,
        &row.company_id,
        &row.project_id,
        false,
        None,
    )?;
    Ok(row)
}

/// Commands, dependency writes, and delivery operations are open to any agent
/// with access to the task's project, as on the board.
fn require_owned(
    database: &SuplexDatabase,
    principal: &Principal,
    task_id: &str,
) -> DatabaseResult<Row> {
    require_readable(database, principal, task_id)
}

/// The live archive authority an agent holds over a task in a granted project.
fn agent_authority(
    principal: &Principal,
) -> impl Fn(&SuplexDatabase, &repository::TaskRecord) -> DatabaseResult<()> + Sync + '_ {
    move |database, task| require_owned(database, principal, &task.id).map(|_| ())
}

fn task_json(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Value> {
    let task = response::get(database, task_id)?.ok_or_else(not_found)?;
    Ok(serde_json::to_value(task)?)
}

/// A plain Coordinator question. Task limit decisions and command cleanup stay human-only.
fn agent_answerable(task: &response::TaskResponse) -> bool {
    matches!(
        task.human_question,
        Some(response::TaskHumanQuestion::Question {
            requires_command_cleanup: false,
            ..
        })
    )
}

fn permitted_commands(task: &response::TaskResponse, principal: &Principal) -> Vec<&'static str> {
    let archived = task.archived_at.is_some();
    let mut commands = if archived {
        vec!["unarchive_task"]
    } else {
        match task.status {
            TaskStatus::Backlog => vec![
                "start_task",
                "cancel_task",
                "archive_task",
                "duplicate_task",
            ],
            TaskStatus::Queued => vec![
                "move_to_front",
                "disarm_task",
                "cancel_task",
                "archive_task",
                "duplicate_task",
            ],
            TaskStatus::Active => vec!["cancel_task", "duplicate_task", "send_task_note"],
            TaskStatus::WaitingHuman => vec!["cancel_task", "duplicate_task"],
            TaskStatus::Cancelled | TaskStatus::Delivered => vec!["archive_task", "duplicate_task"],
        }
    };
    if !archived && task.workflow_state.delivery_wait.is_some() && task.status == TaskStatus::Active
    {
        commands.push("recheck_delivery_wait");
    }
    if !archived
        && task.status == TaskStatus::WaitingHuman
        && agent_answerable(task)
        && principal.answer_grant.is_some()
    {
        commands.push(ANSWER_HUMAN_QUESTION);
    }
    commands
}

/// An offered option's identifier: its 1-based position in the current question.
/// The question id changes with every new question, so the pair is deterministic.
fn option_id(index: usize) -> String {
    format!("option-{}", index + 1)
}

fn option_index(id: &str) -> Option<usize> {
    id.strip_prefix("option-")?
        .parse::<usize>()
        .ok()?
        .checked_sub(1)
}

/// The current question with the identifiers an agent answers with.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentQuestion<'a> {
    id: &'a str,
    kind: &'static str,
    requires_command_cleanup: bool,
    options: Vec<AgentQuestionOption<'a>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentQuestionOption<'a> {
    id: String,
    label: &'a str,
    description: &'a str,
    recommended: bool,
}

fn agent_question(question: &response::TaskHumanQuestion) -> AgentQuestion<'_> {
    let (id, kind, options, requires_command_cleanup) = match question {
        response::TaskHumanQuestion::Question {
            id,
            options,
            requires_command_cleanup,
            ..
        } => (id, "question", options, *requires_command_cleanup),
        response::TaskHumanQuestion::TaskLimit { id, options, .. } => {
            (id, "task_limit", options, false)
        }
    };
    AgentQuestion {
        id,
        kind,
        requires_command_cleanup,
        options: options
            .iter()
            .enumerate()
            .map(|(index, option)| AgentQuestionOption {
                id: option_id(index),
                label: &option.label,
                description: &option.description,
                recommended: option.recommended,
            })
            .collect(),
    }
}

fn selection(task: &response::TaskResponse) -> (Option<&str>, Option<&str>, Option<&str>) {
    match &task.configuration.hermes_selection {
        Some(selection) => (
            selection.workflow_id.as_deref(),
            selection.workflow_name.as_deref(),
            selection.template_id.as_deref(),
        ),
        None => (None, None, None),
    }
}

/// Response order for a pull request prerequisite follows the agent schema, which puts `url` before `state`.
fn response_blocker(item: &Value) -> Value {
    let Some(fields) = item.as_object() else {
        return item.clone();
    };
    let mut ordered = Map::new();
    for name in [
        "id",
        "title",
        "status",
        "kind",
        "number",
        "url",
        "state",
        "observedAt",
    ] {
        if let Some(value) = fields.get(name) {
            ordered.insert(name.to_owned(), value.clone());
        }
    }
    Value::Object(ordered)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTaskProjection<'a> {
    id: &'a str,
    issue_key: Option<&'a str>,
    project_id: &'a str,
    project: Value,
    title: &'a str,
    source: &'a Option<task_contracts::TaskSource>,
    status: &'a str,
    queue_priority: i64,
    queue: &'a response::TaskQueue,
    depends_on: &'a [String],
    blocked_by: Vec<Value>,
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    permitted_commands: Vec<&'static str>,
    human_question: Option<String>,
    question: Option<AgentQuestion<'a>>,
    blocker: Value,
    workflow_stage: String,
    workflow: Value,
    template_id: Option<&'a str>,
    delivery_target: &'a str,
    run_project_tests: bool,
    visual_evidence: &'a str,
    delivery: Value,
    created_at: &'a str,
    updated_at: &'a str,
}

/// The agent API workflow stage of a task.
fn workflow_stage(
    status: TaskStatus,
    completion: &Option<Completion>,
    question: bool,
    wait: &Option<DeliveryWait>,
) -> String {
    if status == TaskStatus::Cancelled {
        "cancelled".to_owned()
    } else if completion.is_some() || status == TaskStatus::Delivered {
        "completed".to_owned()
    } else if question {
        "waiting_human".to_owned()
    } else if wait.is_some() {
        "waiting_delivery".to_owned()
    } else if status == TaskStatus::Active {
        "working".to_owned()
    } else {
        status.as_str().to_owned()
    }
}

/// The pull request, delivery wait, and completion, or null when there is none.
fn delivery_summary(
    pull: &Option<PullRequestReference>,
    wait: &Option<DeliveryWait>,
    completion: &Option<Completion>,
) -> Value {
    if pull.is_none() && wait.is_none() && completion.is_none() {
        return Value::Null;
    }
    json!({
        "pullRequest": pull.as_ref().map(|pull| json!({"number": pull.number, "url": pull.url, "state": pull.state, "mergedAt": pull.merged_at})),
        "checks": null,
        "waiting": wait.as_ref().map(|wait| json!({"reason": wait.reason, "since": wait.since})),
        "completion": completion.as_ref().map(|completion| json!({"kind": completion.kind, "pullRequestNumber": completion.pull_request_number, "observedAt": completion.observed_at})),
    })
}

/// `agentApiProjection`: the stored-state projection and its revision.
fn projection_of(
    database: &SuplexDatabase,
    principal: &Principal,
    row: &Row,
) -> DatabaseResult<Value> {
    let task = response::get(database, &row.id)?.ok_or_else(not_found)?;
    let project: Option<(String, String)> = database
        .connection()
        .query_row(
            "SELECT id, name FROM suplex_projects WHERE id = ?1 AND company_id = ?2",
            params![row.project_id, row.company_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (project_id, project_name) =
        project.ok_or_else(|| fail("Not found", 404, "task_failure"))?;
    let question = task.human_question.as_ref().map(|question| match question {
        response::TaskHumanQuestion::Question { text, .. }
        | response::TaskHumanQuestion::TaskLimit { text, .. } => text.clone(),
    });
    let wait = &task.workflow_state.delivery_wait;
    let completion = &task.workflow_state.completion;
    let status = task.status;
    let blocker = if question.is_some() {
        json!({"kind": "human_question"})
    } else if let Some(wait) = wait {
        json!({"kind": "delivery_wait", "reason": wait.reason})
    } else {
        Value::Null
    };
    let stage = workflow_stage(status, completion, question.is_some(), wait);
    let delivery = delivery_summary(&task.pull_request, wait, completion);
    let (workflow_id, workflow_name, template_id) = selection(&task);
    let source = &task.configuration.source;
    let archived = task.archived_at.is_some();
    let permitted = permitted_commands(&task, principal);
    let mut value = AgentTaskProjection {
        id: &task.id,
        issue_key: task.issue_key.as_deref(),
        project_id: &task.project_id,
        project: json!({"id": project_id, "name": project_name}),
        title: &task.title,
        source,
        status: status.as_str(),
        queue_priority: task.queue_priority,
        queue: &task.queue,
        depends_on: &task.depends_on,
        blocked_by: task
            .blocked_by
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<_, _>>()?,
        archived,
        revision: None,
        permitted_commands: permitted,
        human_question: question,
        question: task.human_question.as_ref().map(agent_question),
        blocker,
        workflow_stage: stage,
        workflow: json!({"id": workflow_id, "engine": task.workflow, "name": workflow_name}),
        template_id,
        delivery_target: task.delivery_target.as_str(),
        run_project_tests: task.configuration.run_project_tests,
        visual_evidence: task.configuration.visual_evidence.as_str(),
        delivery,
        created_at: &task.created_at,
        updated_at: &task.updated_at,
    };
    let hash = |value: &Value| {
        URL_SAFE_NO_PAD.encode(Sha256::digest(
            crate::shared::js_json::stringify(value).as_bytes(),
        ))
    };
    // Host sweeps and delivery observation move `updatedAt` and `delivery` on a running task.
    // They form a separate revision part so a poll sees them and a command does not conflict on them.
    let mut stable = serde_json::to_value(&value)?;
    let observed = json!([stable["updatedAt"].take(), stable["delivery"].take()]);
    value.revision = Some(format!(
        "{}.{}",
        hash(&json!({"value": stable, "commandRevision": row.command_revision})),
        hash(&observed)
    ));
    value.blocked_by = value.blocked_by.iter().map(response_blocker).collect();
    Ok(serde_json::to_value(value)?)
}

/// `getAgentApiTask`: any task in a granted project.
pub fn projection(
    database: &SuplexDatabase,
    principal: &Principal,
    task_id: &str,
) -> DatabaseResult<Value> {
    let row = require_readable(database, principal, task_id)?;
    projection_of(database, principal, &row)
}

pub fn identity(database: &SuplexDatabase, principal: &Principal) -> DatabaseResult<Value> {
    let mut statement = database.connection().prepare(
        "SELECT p.id, p.name FROM suplex_external_agent_project_grants g JOIN suplex_projects p ON p.id = g.project_id AND p.company_id = g.company_id JOIN suplex_external_agents a ON a.id = g.agent_id AND a.company_id = g.company_id WHERE a.id = ?1 AND a.company_id = ?2 AND a.status = 'paired' ORDER BY p.name COLLATE NOCASE, p.id",
    )?;
    let rows = statement
        .query_map(params![principal.agent_id, principal.company_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut projects_json = Vec::new();
    for (id, name) in rows {
        let policy =
            projects::get_in_company(database, &principal.company_id, &id)?.agent_task_policy;
        // A project fixes exactly one permitted delivery target; the list keeps room for more.
        projects_json.push(json!({"id": id, "name": name, "agentTaskPolicy": {"deliveryTargets": [policy.delivery_target], "runProjectTests": policy.run_project_tests, "visualEvidence": policy.visual_evidence}}));
    }
    let name: String = database.connection().query_row(
        "SELECT name FROM suplex_agents WHERE id = ?1",
        [&principal.agent_id],
        |row| row.get(0),
    )?;
    Ok(json!({
        "agent": {"id": principal.agent_id, "name": name, "profileId": principal.profile_id},
        "capabilities": {"taskDiscovery": true, "taskRead": true, "taskCreate": true, "humanAnswers": principal.answer_grant.is_some(), "taskCommands": task_commands(principal.answer_grant.is_some())},
        "answerGrant": principal.answer_grant.as_ref().map(|grant| json!({"userId": grant.user_id, "userName": grant.user_name})),
        "projects": projects_json,
    }))
}

pub fn workflows(
    database: &SuplexDatabase,
    principal: &Principal,
    project_id: &str,
) -> DatabaseResult<Vec<Value>> {
    require_scope(
        database,
        principal,
        &principal.company_id,
        project_id,
        false,
        None,
    )?;
    let mut statement = database.connection().prepare(
        "SELECT id, name, description FROM suplex_workflows WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|(id, name, description)| {
            json!({"id": id, "name": name, "description": description, "permittedForAgentTaskCreation": true})
        })
        .collect())
}

pub fn templates(
    database: &SuplexDatabase,
    principal: &Principal,
    project_id: &str,
) -> DatabaseResult<Vec<Value>> {
    require_scope(
        database,
        principal,
        &principal.company_id,
        project_id,
        false,
        None,
    )?;
    let mut statement = database.connection().prepare(
        "SELECT id, name, configuration_json FROM suplex_task_templates WHERE project_id = ?1 ORDER BY name COLLATE NOCASE, id",
    )?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, name, configuration)| {
            let configuration = task_templates::parse_stored_configuration(serde_json::from_str(&configuration)?)?;
            Ok(json!({"id": id, "name": name, "description": configuration.description, "permittedForAgentTaskCreation": true}))
        })
        .collect()
}

#[derive(Default)]
struct RowFilter<'a> {
    creator_agent_id: Option<&'a str>,
    project_id: Option<&'a str>,
    status: Option<&'a str>,
    pull_request_number: Option<u64>,
    source_branch: Option<&'a str>,
    title_contains: Option<&'a str>,
    archived: Option<bool>,
    attention: Option<bool>,
    blocker: Option<bool>,
    updated_since: Option<&'a str>,
    cursor: Option<(String, String)>,
    limit: Option<usize>,
}

/// `agentApiRows`: tasks in the agent's live grants, newest activity first.
fn rows(
    database: &SuplexDatabase,
    principal: &Principal,
    filter: RowFilter<'_>,
) -> DatabaseResult<Vec<Row>> {
    let activity = "CASE WHEN julianday(t.updated_at) >= julianday(COALESCE(control.updated_at, t.updated_at)) THEN t.updated_at ELSE control.updated_at END";
    let mut conditions = vec![
        "t.company_id = ?".to_owned(),
        "a.status = 'paired'".into(),
        "a.revoked_at IS NULL".into(),
    ];
    let mut values: Vec<SqlValue> = vec![
        principal.agent_id.clone().into(),
        principal.company_id.clone().into(),
    ];
    let text = |value: &str| SqlValue::Text(value.to_owned());
    if let Some(creator) = filter.creator_agent_id {
        conditions.push("t.creator_agent_id = ?".into());
        values.push(text(creator));
    }
    if let Some(project_id) = filter.project_id {
        conditions.push("t.project_id = ?".into());
        values.push(text(project_id));
    }
    if let Some(status) = filter.status {
        conditions.push("control.status = ?".into());
        values.push(text(status));
    }
    if let Some(number) = filter.pull_request_number {
        conditions.push("((json_extract(t.configuration_json, '$.source.kind') = 'pull_request' AND json_extract(t.configuration_json, '$.source.number') = ?) OR json_extract(control.pull_request_json, '$.number') = ?)".into());
        values.push(SqlValue::Integer(number as i64));
        values.push(SqlValue::Integer(number as i64));
    }
    if let Some(branch) = filter.source_branch {
        conditions.push("json_extract(t.configuration_json, '$.source.branch') = ?".into());
        values.push(text(branch));
    }
    if let Some(title) = filter.title_contains {
        conditions.push("lower(t.title) LIKE ?".into());
        values.push(text(&format!("%{}%", title.to_lowercase())));
    }
    if let Some(archived) = filter.archived {
        conditions.push(
            if archived {
                "t.archived_at IS NOT NULL"
            } else {
                "t.archived_at IS NULL"
            }
            .into(),
        );
    }
    if let Some(attention) = filter.attention {
        conditions.push(
            if attention {
                "control.human_question IS NOT NULL AND control.human_question_id IS NOT NULL"
            } else {
                "(control.human_question IS NULL OR control.human_question_id IS NULL)"
            }
            .into(),
        );
    }
    if let Some(blocker) = filter.blocker {
        conditions.push(if blocker { "((control.human_question IS NOT NULL AND control.human_question_id IS NOT NULL) OR json_extract(control.workflow_state_json, '$.deliveryWait') IS NOT NULL)" } else { "((control.human_question IS NULL OR control.human_question_id IS NULL) AND json_extract(control.workflow_state_json, '$.deliveryWait') IS NULL)" }.into());
    }
    if let Some(since) = filter.updated_since {
        conditions.push(format!("julianday({activity}) >= julianday(?)"));
        values.push(text(since));
    }
    if let Some((updated_at, id)) = &filter.cursor {
        conditions.push(format!("(julianday({activity}) < julianday(?) OR (julianday({activity}) = julianday(?) AND t.id > ?))"));
        values.extend([text(updated_at), text(updated_at), text(id)]);
    }
    let limit = match filter.limit {
        Some(limit) => {
            values.push(SqlValue::Integer(limit as i64));
            " LIMIT ?"
        }
        None => "",
    };
    let sql = format!(
        "SELECT t.id, t.company_id, t.project_id, t.command_revision FROM suplex_tasks t JOIN suplex_companies c ON c.id = t.company_id LEFT JOIN suplex_task_controls control ON control.task_id = t.id JOIN suplex_external_agents a ON a.id = ? AND a.company_id = t.company_id JOIN suplex_external_agent_project_grants g ON g.agent_id = a.id AND g.company_id = t.company_id AND g.project_id = t.project_id WHERE {} ORDER BY julianday({activity}) DESC, t.id{limit}",
        conditions.join(" AND ")
    );
    let mut statement = database.connection().prepare(&sql)?;
    Ok(statement
        .query_map(params_from_iter(values), row_from)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn cursor_filter(query: &TaskListQuery) -> Value {
    let flag = |value: &Option<String>| {
        value
            .as_ref()
            .map_or(Value::Null, |value| json!(value == "true"))
    };
    json!({
        "projectId": query.project_id, "status": query.status, "pullRequestNumber": query.pull_request_number,
        "sourceBranch": query.source_branch, "titleContains": query.title_contains, "archived": flag(&query.archived),
        "attention": flag(&query.attention), "blocker": flag(&query.blocker), "updatedSince": query.updated_since,
    })
}

fn invalid_cursor() -> Box<dyn Error> {
    fail("Invalid cursor", 400, "cursor_invalid")
}

fn parse_cursor(
    value: &str,
    principal: &Principal,
    filter: &Value,
) -> DatabaseResult<(String, String)> {
    let parts = value.split('.').collect::<Vec<_>>();
    let [payload, signature] = parts.as_slice() else {
        return Err(invalid_cursor());
    };
    if payload.is_empty() || signature.is_empty() {
        return Err(invalid_cursor());
    }
    let expected = hmac(&principal.cursor_key, payload);
    if !bool::from(subtle::ConstantTimeEq::ct_eq(
        signature.as_bytes(),
        expected.as_bytes(),
    )) {
        return Err(invalid_cursor());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .ok_or_else(invalid_cursor)?;
    let fields = decoded.as_object().ok_or_else(invalid_cursor)?;
    let (
        Some(Value::String(agent_id)),
        Some(Value::Object(cursor_filter)),
        Some(Value::String(updated_at)),
        Some(Value::String(id)),
    ) = (
        fields.get("agentId"),
        fields.get("filter"),
        fields.get("updatedAt"),
        fields.get("id"),
    )
    else {
        return Err(invalid_cursor());
    };
    let stringify = crate::shared::js_json::stringify;
    if fields.len() != 4
        || !crate::http::contracts::typed::agent_api::zod_datetime(updated_at)
        || agent_id != &principal.agent_id
        || stringify(&Value::Object(cursor_filter.clone())) != stringify(filter)
    {
        return Err(invalid_cursor());
    }
    Ok((updated_at.clone(), id.clone()))
}

fn create_cursor(principal: &Principal, filter: &Value, task: &Value) -> String {
    let payload = URL_SAFE_NO_PAD.encode(crate::shared::js_json::stringify(&json!({
        "agentId": principal.agent_id, "filter": filter, "updatedAt": task["updatedAt"], "id": task["id"],
    })));
    let signature = hmac(&principal.cursor_key, &payload);
    format!("{payload}.{signature}")
}

/// `listAgentApiTasks`: one page of stored projections and its opaque cursor.
fn list_page(
    database: &SuplexDatabase,
    principal: &Principal,
    query: &TaskListQuery,
) -> DatabaseResult<(Vec<Value>, Option<String>)> {
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
    let filter = cursor_filter(query);
    let cursor = query
        .cursor
        .as_deref()
        .map(|cursor| parse_cursor(cursor, principal, &filter))
        .transpose()?;
    let limit = query.limit as usize;
    let flag = |value: &Option<String>| value.as_ref().map(|value| value == "true");
    let found = rows(
        database,
        principal,
        RowFilter {
            project_id: query.project_id.as_deref(),
            status: query.status.map(super::control::TaskStatus::as_str),
            pull_request_number: query.pull_request_number,
            source_branch: query.source_branch.as_deref(),
            title_contains: query.title_contains.as_deref(),
            archived: flag(&query.archived),
            attention: flag(&query.attention),
            blocker: flag(&query.blocker),
            updated_since: query.updated_since.as_deref(),
            cursor,
            limit: Some(limit + 1),
            ..RowFilter::default()
        },
    )?;
    let more = found.len() > limit;
    let tasks = found
        .iter()
        .take(limit)
        .map(|row| projection_of(database, principal, row))
        .collect::<DatabaseResult<Vec<_>>>()?;
    let next = match tasks.last() {
        Some(last) if more => Some(create_cursor(principal, &filter, last)),
        _ => None,
    };
    Ok((tasks, next))
}

fn summary(task: &Value) -> Value {
    let mut fields = Map::new();
    for name in ["id", "title", "status", "queuePriority", "archived"] {
        fields.insert(name.into(), task[name].clone());
    }
    if !task["workflow"]["name"].is_null() {
        fields.insert("workflow".into(), task["workflow"]["name"].clone());
    }
    if !task["source"].is_null() {
        fields.insert("source".into(), task["source"].clone());
    }
    if !task["delivery"].is_null() && !task["delivery"]["pullRequest"].is_null() {
        fields.insert(
            "pullRequestNumber".into(),
            task["delivery"]["pullRequest"]["number"].clone(),
        );
    }
    fields.insert("dependsOn".into(), task["dependsOn"].clone());
    fields.insert("updatedAt".into(), task["updatedAt"].clone());
    Value::Object(fields)
}

// Integration health: `withAgentApiIntegration` over `tasks/integration.rs`
// with live GitHub observations taken outside the database lock.

struct Observed {
    observation: Option<Observation>,
    failure: Option<String>,
}

async fn observe(github: &mut Option<Result<Github, String>>, task: &Value) -> Observed {
    if !integration::observable_delivery(task) {
        return Observed {
            observation: None,
            failure: None,
        };
    }
    if github.is_none() {
        *github = Some(
            Github::load()
                .await
                .map_err(|failure| failure.code.to_owned()),
        );
    }
    let client = match github.as_ref().expect("GitHub client loaded") {
        Ok(client) => client,
        Err(code) => {
            return Observed {
                observation: None,
                failure: Some(code.clone()),
            };
        }
    };
    let configuration = &task["configuration"];
    let number = task["pullRequest"]["number"].as_u64();
    let repository = configuration["repository"].as_str().unwrap_or_default();
    let branch = configuration["branch"].as_str().unwrap_or_default();
    match client
        .observe_pull_request(repository, branch, number)
        .await
    {
        Ok(observation) => Observed {
            observation: Some(observation),
            failure: None,
        },
        Err(failure) => Observed {
            observation: None,
            failure: Some(failure.code.to_owned()),
        },
    }
}

/// The stored facts integration reads: each target row and task, and the agent's upstream pool.
struct Targets {
    targets: Vec<(Row, Value)>,
    pool: Vec<Value>,
}

fn targets(
    database: &SuplexDatabase,
    principal: &Principal,
    projections: &[Value],
) -> DatabaseResult<Targets> {
    let targets = projections
        .iter()
        .map(|projection| {
            let id = projection["id"].as_str().unwrap_or_default();
            Ok((
                task_row(database, id)?.ok_or_else(not_found)?,
                task_json(database, id)?,
            ))
        })
        .collect::<DatabaseResult<Vec<_>>>()?;
    let pool = rows(
        database,
        principal,
        RowFilter {
            limit: Some(UPSTREAM_POOL),
            ..RowFilter::default()
        },
    )?
    .iter()
    .map(|row| task_json(database, &row.id))
    .collect::<DatabaseResult<Vec<_>>>()?;
    Ok(Targets { targets, pool })
}

async fn with_integration(projections: Vec<Value>, stored: Targets) -> Vec<Value> {
    let Targets { targets, pool } = stored;
    let observed_at = crate::shared::time::now_millis_rfc3339();
    let upstreams = targets
        .iter()
        .map(|(_, task)| {
            pool.iter()
                .filter(|other| integration::is_upstream_of(other, task))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut github = None;
    let mut integrations = std::collections::HashMap::new();
    for task in targets
        .iter()
        .map(|(_, task)| task)
        .chain(upstreams.iter().flatten().copied())
    {
        let id = task["id"].as_str().unwrap_or_default().to_owned();
        if integrations.contains_key(&id) {
            continue;
        }
        let observed = observe(&mut github, task).await;
        let value = integration::derive_task_integration(
            task,
            observed.observation.as_ref(),
            observed.failure.as_deref(),
            &observed_at,
        );
        integrations.insert(id, value);
    }
    projections
        .into_iter()
        .zip(targets.iter().zip(&upstreams))
        .map(|(mut projection, ((_, task), upstream))| {
            let id = task["id"].as_str().unwrap_or_default();
            let integration = integrations[id].clone();
            let blocking = upstream
                .iter()
                .find(|other| integrations.get(other["id"].as_str().unwrap_or_default()).is_none_or(|value| value["integrated"] != true));
            let upstream = blocking.map_or(Value::Null, |other| json!({"taskId": other["id"], "pullRequestNumber": other["pullRequest"].get("number").cloned().unwrap_or(Value::Null)}));
            let required = integration::derive_action_required(task, &integration, &upstream);
            let status = projection["status"].clone();
            if let Some(fields) = projection.as_object_mut() {
                fields.insert("implementation".into(), json!({"status": status}));
                fields.insert("integration".into(), integration);
                fields.insert("actionRequired".into(), required);
            }
            projection
        })
        .collect()
}

/// `readAgentApiTask`: the stored projection plus observed integration health.
pub async fn read(state: &AppState, principal: &Principal, task_id: &str) -> DatabaseResult<Value> {
    let (projection, stored) = state.with_database(|database| {
        let projection = projection(database, principal, task_id)?;
        let stored = targets(database, principal, std::slice::from_ref(&projection))?;
        Ok::<_, Box<dyn Error>>((projection, stored))
    })?;
    Ok(with_integration(vec![projection], stored).await.remove(0))
}

/// `readAgentApiTasks`; `view` defaults differ between HTTP (full) and MCP (summary).
pub async fn read_list(
    state: &AppState,
    principal: &Principal,
    query: &TaskListQuery,
    view: &str,
) -> DatabaseResult<Value> {
    let (tasks, next) = state.with_database(|database| list_page(database, principal, query))?;
    if view == "summary" && query.filter.is_none() {
        return Ok(
            json!({"tasks": tasks.iter().map(summary).collect::<Vec<_>>(), "nextCursor": next}),
        );
    }
    let stored = state.with_database(|database| targets(database, principal, &tasks))?;
    let tasks = with_integration(tasks, stored).await;
    // Integration health comes from GitHub, not the query, so the filter narrows a page already drawn.
    let tasks = tasks
        .into_iter()
        .filter(|task| {
            query.filter.as_deref().is_none_or(|filter| {
                integration::matches_agent_api_filter(
                    &task["integration"],
                    &task["actionRequired"],
                    filter,
                )
            })
        })
        .map(|task| {
            if view == "summary" {
                summary(&task)
            } else {
                task
            }
        })
        .collect::<Vec<_>>();
    Ok(json!({"tasks": tasks, "nextCursor": next}))
}

// Creation.

const ADVISOR_ROLES: [&str; 4] = ["reviewer", "planner_a", "planner_b", "rater"];

fn advisor_roles(workflow: &str) -> &'static [&'static str] {
    match workflow {
        "independent_review" => &["reviewer"],
        "competing_plans" => &["planner_a", "planner_b"],
        "refine_pull_request" => &["rater"],
        _ => &[],
    }
}

fn workflow_input_failure(message: &str) -> Box<dyn Error> {
    fail(message, 422, "task_failure")
}

/// `normalizeWorkflowInput(raw, { requireSource: true })`.
fn validate_advisors(advisors: &Value) -> DatabaseResult<()> {
    let valid = advisors.as_object().is_some_and(|ids| {
        ids.iter().all(|(role, id)| {
            ADVISOR_ROLES.contains(&role.as_str())
                && id
                    .as_str()
                    .is_some_and(|id| (1..=256).contains(&id.encode_utf16().count()))
        })
    });
    if !valid {
        return Err(workflow_input_failure(
            "The Advisor profile selection is not valid",
        ));
    }
    Ok(())
}

fn validate_workflow(
    workflow: &str,
    advisors: &Value,
    delivery_target: Option<&Value>,
    has_pull_request: bool,
) -> DatabaseResult<()> {
    validate_advisors(advisors)?;
    let allowed = advisor_roles(workflow);
    let extra = ADVISOR_ROLES
        .into_iter()
        .filter(|role| advisors.get(*role).is_some() && !allowed.contains(role))
        .map(|role| match role {
            "reviewer" => "Reviewer",
            "planner_a" => "Plan A",
            "planner_b" => "Plan B",
            _ => "Rater",
        })
        .collect::<Vec<_>>();
    if !extra.is_empty() {
        let name = match workflow {
            "standard" => "Standard",
            "direct_build" => "Direct build",
            "independent_review" => "Second opinion",
            "competing_plans" => "Combined planning",
            _ => "Pull request repair",
        };
        return Err(workflow_input_failure(&format!(
            "The {name} workflow has no {} Advisor",
            extra.join(", ")
        )));
    }
    if workflow == "refine_pull_request" {
        if delivery_target.is_some_and(|value| value != "merged") {
            return Err(workflow_input_failure(
                "Pull request repair always delivers a merged pull request",
            ));
        }
        if !has_pull_request {
            return Err(workflow_input_failure(
                "Select a pull request source for Pull request repair",
            ));
        }
    }
    Ok(())
}

fn normalize_workflow(fields: &mut Map<String, Value>) -> DatabaseResult<()> {
    let workflow = fields
        .get("workflow")
        .and_then(Value::as_str)
        .unwrap_or("standard")
        .to_owned();
    if ![
        "standard",
        "direct_build",
        "independent_review",
        "competing_plans",
        "refine_pull_request",
    ]
    .contains(&workflow.as_str())
    {
        return Err(workflow_input_failure(
            "The selected workflow does not exist",
        ));
    }
    let advisors = fields
        .get("advisorProfileIds")
        .cloned()
        .unwrap_or_else(|| json!({}));
    validate_workflow(
        &workflow,
        &advisors,
        fields.get("deliveryTarget"),
        fields.get("source").and_then(|source| source.get("kind")) == Some(&json!("pull_request")),
    )?;
    fields.insert("workflow".into(), json!(workflow));
    fields.insert("advisorProfileIds".into(), advisors);
    if workflow == "refine_pull_request" {
        fields.insert("deliveryTarget".into(), json!("merged"));
    }
    Ok(())
}

/// `TaskInputSchema.parse` of normalized input; a schema failure is an unhandled 500 in TypeScript.
fn task_input(mut fields: Map<String, Value>) -> DatabaseResult<task_contracts::TaskCreateBody> {
    normalize_workflow(&mut fields)?;
    task_contracts::parse_task_create(Some(&Value::Object(fields))).map_err(|error| match error {
        ContractFailure::Issues(issues) => {
            TaskError::internal(format!("task input is invalid: {issues:?}")).into()
        }
        other => TaskError::internal(format!("task input is invalid: {other:?}")).into(),
    })
}

/// Sort object keys the way `localeCompare` orders these ASCII field names.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        Value::Object(fields) => {
            let mut entries = fields.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| {
                left.to_lowercase()
                    .cmp(&right.to_lowercase())
                    .then_with(|| left.cmp(right))
            });
            Value::Object(
                entries
                    .into_iter()
                    .map(|(name, value)| (name.clone(), sorted(value)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// `agentApiRequestHash`: the semantic caller request, before policy resolution.
fn request_hash(raw: &TaskCreateBody, agent_id: &str) -> DatabaseResult<String> {
    let mut input = serde_json::to_value(raw)?;
    if let Some(fields) = input.as_object_mut() {
        fields.remove("dryRun");
    }
    let payload = sorted(&json!({"input": input, "creator": {"kind": "agent", "id": agent_id}}));
    Ok(sha256_hex(crate::shared::js_json::stringify(&payload)))
}

fn is_legacy_request(raw: &TaskCreateBody) -> bool {
    raw.queue != Some(true)
        && raw.depends_on.as_ref().is_none_or(Vec::is_empty)
        && raw.images.is_empty()
        && raw.source.is_none()
        && raw.workflow_id.is_none()
        && raw.template_id.is_none()
        && raw.root_profile_id.is_none()
        && raw.worker_profile_id.is_none()
        && serde_json::to_value(&raw.advisor_profile_ids)
            .is_ok_and(|ids| ids.as_object().is_none_or(Map::is_empty))
        && raw.delivery_target.is_none()
        && raw.run_project_tests.is_none()
        && raw.visual_evidence.is_none()
}

/// `taskRequestHash(legacyAgentApiRequest(raw), creator)`: the pre-feature Standard hash shape.
fn legacy_hash(raw: &TaskCreateBody, agent_id: &str) -> DatabaseResult<String> {
    let input = task_input(
        json!({"projectId": raw.project_id, "title": raw.title, "description": raw.description.clone().unwrap_or_default(), "idempotencyKey": raw.idempotency_key})
            .as_object()
            .cloned()
            .unwrap_or_default(),
    )?;
    let mut fields = serde_json::to_value(input)?
        .as_object()
        .cloned()
        .unwrap_or_default();
    for name in [
        "workflow",
        "advisorProfileIds",
        "dependsOn",
        "blockedByPullRequests",
    ] {
        fields.remove(name);
    }
    let payload = json!({"input": fields, "creator": {"kind": "agent", "id": agent_id}});
    Ok(sha256_hex(crate::shared::js_json::stringify(&payload)))
}

fn conflict() -> Box<dyn Error> {
    fail(
        "This idempotency key belongs to a different request",
        409,
        "task_failure",
    )
}

/// `TaskRepository.existing` for an agent creator.
fn existing(
    database: &SuplexDatabase,
    company_id: &str,
    key: &str,
    hash: &str,
    agent_id: &str,
) -> DatabaseResult<Option<String>> {
    let found: Option<(String, String, Option<String>)> = database
        .connection()
        .query_row(
            "SELECT id, request_hash, creator_agent_id FROM suplex_tasks WHERE company_id = ?1 AND idempotency_key = ?2",
            params![company_id, key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match found {
        None => Ok(None),
        Some((id, stored, creator)) if stored == hash && creator.as_deref() == Some(agent_id) => {
            Ok(Some(id))
        }
        Some(_) => Err(conflict()),
    }
}

struct Resolved {
    request: task_contracts::TaskCreateBody,
    selection: Value,
    signature: String,
}

fn profile_not_available(profile_id: &str, role: &str, field: &str) -> Box<dyn Error> {
    let code = if role == "worker" {
        "worker_profile_not_found"
    } else if field == "rootProfileId" {
        "root_profile_not_found"
    } else {
        "advisor_profile_not_found"
    };
    let reason = "The selected agent profile is not available.";
    fail_with(
        reason,
        422,
        code,
        json!({"field": field, "value": profile_id, "reason": reason}),
    )
}

fn profile(database: &SuplexDatabase, profile_id: &str, role: &str) -> DatabaseResult<TaskProfile> {
    crate::profiles::agent_profiles::read_profile(database, profile_id, role)?.ok_or_else(|| {
        fail(
            "The selected agent profile does not exist",
            422,
            "task_failure",
        )
    })
}

/// `projectProfile`: an explicit selection, the project default when allowed, or the first allowed profile.
fn project_profile(
    database: &SuplexDatabase,
    explicit: Option<&str>,
    default_id: &str,
    role: &str,
    project: &Project,
) -> DatabaseResult<TaskProfile> {
    if let Some(explicit) = explicit {
        return profile(database, explicit, role);
    }
    let preferred = profile(database, default_id, role)?;
    if crate::profiles::agent_profiles::allowed_profile(
        project.provider_policy.as_ref(),
        &preferred,
    ) {
        return Ok(preferred);
    }
    let mut statement = database
        .connection()
        .prepare("SELECT id FROM suplex_profiles WHERE role = ?1 AND archived_at IS NULL ORDER BY created_at, id")?;
    let ids = statement
        .query_map([role], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        let candidate = profile(database, &id, role)?;
        if crate::profiles::agent_profiles::allowed_profile(
            project.provider_policy.as_ref(),
            &candidate,
        ) {
            return Ok(candidate);
        }
    }
    Err(fail(
        "Create an agent with a provider and login allowed by this project",
        422,
        "task_failure",
    ))
}

/// The caller's request, before a workflow or template applies. Delivery
/// settings the caller leaves out come from the project.
fn base_request(raw: &TaskCreateBody, project: &Project) -> task_contracts::TaskCreateBody {
    let policy = &project.agent_task_policy;
    task_contracts::TaskCreateBody {
        project_id: raw.project_id.clone(),
        title: raw.title.clone(),
        description: raw.description.clone().unwrap_or_default(),
        idempotency_key: raw.idempotency_key.clone(),
        images: raw.images.clone(),
        root_profile_id: raw.root_profile_id.clone(),
        worker_profile_id: raw.worker_profile_id.clone(),
        start_immediately: raw.queue.unwrap_or(false),
        delivery_target: raw.delivery_target.unwrap_or(policy.delivery_target),
        run_project_tests: raw.run_project_tests.unwrap_or(policy.run_project_tests),
        visual_evidence: raw
            .visual_evidence
            .clone()
            .unwrap_or_else(|| policy.visual_evidence.clone()),
        source: raw.source.clone(),
        issue: None,
        workflow: crate::coordination::workflows::Workflow::Standard,
        advisor_profile_ids: raw.advisor_profile_ids.clone(),
        depends_on: raw.depends_on.clone().unwrap_or_default(),
        blocked_by_pull_requests: raw.blocked_by_pull_requests.clone().unwrap_or_default(),
    }
}

/// Apply a project template: its workflow, and its description, profiles, and
/// delivery settings where the caller left them out. Returns the selection record.
fn apply_template(
    database: &SuplexDatabase,
    project: &Project,
    raw: &TaskCreateBody,
    template_id: &str,
    request: &mut task_contracts::TaskCreateBody,
) -> DatabaseResult<Value> {
    let details =
        |reason: &str| json!({"field": "templateId", "value": template_id, "reason": reason});
    let stored: Option<String> = database
        .connection()
        .query_row(
            "SELECT configuration_json FROM suplex_task_templates WHERE id = ?1 AND project_id = ?2",
            params![template_id, project.id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored) = stored else {
        return Err(fail_with(
            "The selected template is not available",
            422,
            "template_not_found",
            details("The selected template is not available."),
        ));
    };
    let template = task_templates::parse_stored_configuration(serde_json::from_str(&stored)?)?;
    request.workflow = template.workflow;
    if raw.delivery_target.is_none() {
        request.delivery_target = template.delivery_target;
    }
    if raw.run_project_tests.is_none() {
        request.run_project_tests = template.run_project_tests;
    }
    if raw.visual_evidence.is_none() {
        request.visual_evidence = template.visual_evidence;
    }
    if raw.description.is_none() {
        request.description = template.description;
    }
    request.root_profile_id = request.root_profile_id.take().or(template.root_profile_id);
    request.worker_profile_id = request
        .worker_profile_id
        .take()
        .or(template.worker_profile_id);
    if !has_advisors(raw)? {
        request.advisor_profile_ids = template.advisor_profile_ids;
    }
    Ok(json!({"workflowId": null, "workflowName": null, "templateId": template_id}))
}

/// The name, configuration, and engine of an unarchived workflow record.
fn workflow_record(
    database: &SuplexDatabase,
    workflow_id: &str,
) -> DatabaseResult<Option<(String, String, String)>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT name, configuration_json, engine FROM suplex_workflows WHERE id = ?1 AND archived_at IS NULL",
            [workflow_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

/// Apply the named workflow, or Standard when none is named: its engine, and
/// its Advisor profiles, agent profiles, and screenshots where the caller left
/// them out. Returns the selection record.
fn apply_workflow(
    database: &SuplexDatabase,
    raw: &TaskCreateBody,
    request: &mut task_contracts::TaskCreateBody,
) -> DatabaseResult<Value> {
    let workflow_id = raw
        .workflow_id
        .clone()
        .unwrap_or_else(|| "workflow_native_standard".to_owned());
    let details =
        |reason: &str| json!({"field": "workflowId", "value": workflow_id, "reason": reason});
    let Some((name, configuration, engine)) = workflow_record(database, &workflow_id)? else {
        return Err(fail_with(
            "The selected workflow is not available",
            422,
            "workflow_not_found",
            details("The selected workflow is not available."),
        ));
    };
    let configuration: Value = serde_json::from_str(&configuration)?;
    request.workflow = crate::coordination::workflows::Workflow::parse(&engine)
        .ok_or_else(|| workflow_input_failure("The selected workflow does not exist"))?;
    if raw.visual_evidence.is_none()
        && let Some(visual_evidence) = configuration.get("visualEvidence").and_then(Value::as_str)
    {
        visual_evidence.clone_into(&mut request.visual_evidence);
    }
    if raw.run_project_tests.is_none()
        && let Some(run_project_tests) = configuration
            .get("runProjectTests")
            .and_then(Value::as_bool)
    {
        request.run_project_tests = run_project_tests;
    }
    // Pull request repair always merges.
    if request.workflow == crate::coordination::workflows::Workflow::RefinePullRequest
        && raw.delivery_target.is_none()
    {
        request.delivery_target = crate::tasks::control::DeliveryTarget::Merged;
    }
    if !has_advisors(raw)? {
        let advisors = configuration
            .get("advisorProfileIds")
            .cloned()
            .unwrap_or_else(|| json!({}));
        validate_advisors(&advisors)?;
        request.advisor_profile_ids = serde_json::from_value(advisors)?;
    }
    let selected_profile = |name: &str| {
        configuration
            .get(name)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    };
    request.root_profile_id = request
        .root_profile_id
        .take()
        .or_else(|| selected_profile("rootProfileId"));
    request.worker_profile_id = request
        .worker_profile_id
        .take()
        .or_else(|| selected_profile("workerProfileId"));
    let name = crate::identity::auth::js_trim(&name).to_owned();
    Ok(json!({"workflowId": workflow_id, "workflowName": name, "templateId": null}))
}

/// The caller named at least one Advisor profile.
fn has_advisors(raw: &TaskCreateBody) -> DatabaseResult<bool> {
    let raw_advisors = serde_json::to_value(&raw.advisor_profile_ids)?;
    Ok(raw_advisors.as_object().is_some_and(|ids| !ids.is_empty()))
}

/// Trim the text fields and validate the resolved request as a task create body.
fn validate_resolved(request: &mut task_contracts::TaskCreateBody) -> DatabaseResult<()> {
    request.title = crate::identity::auth::js_trim(&request.title).to_owned();
    request.description = crate::identity::auth::js_trim(&request.description).to_owned();
    let advisors = serde_json::to_value(&request.advisor_profile_ids)?;
    validate_workflow(
        request.workflow.as_str(),
        &advisors,
        Some(&json!(request.delivery_target)),
        request
            .source
            .as_ref()
            .is_some_and(|source| matches!(source, task_contracts::TaskSource::PullRequest { .. })),
    )?;
    use garde::Validate;
    request.validate().map_err(|report| {
        TaskError::internal(format!(
            "task input is invalid: {:?}",
            crate::http::contracts::typed::garde_findings(&report, &*request)
        ))
    })?;
    Ok(())
}

/// Each profile the caller named must exist.
fn check_requested_profiles(database: &SuplexDatabase, raw: &TaskCreateBody) -> DatabaseResult<()> {
    if let Some(id) = &raw.root_profile_id {
        crate::profiles::agent_profiles::read_profile(database, id, "root")?
            .ok_or_else(|| profile_not_available(id, "root", "rootProfileId"))?;
    }
    if let Some(id) = &raw.worker_profile_id {
        crate::profiles::agent_profiles::read_profile(database, id, "worker")?
            .ok_or_else(|| profile_not_available(id, "worker", "workerProfileId"))?;
    }
    Ok(())
}

/// An Advisor profile the caller names must exist. An unnamed role follows its
/// workflow or project default.
fn check_advisor_profiles(
    database: &SuplexDatabase,
    raw: &TaskCreateBody,
    request: &task_contracts::TaskCreateBody,
) -> DatabaseResult<()> {
    let raw_advisors = serde_json::to_value(&raw.advisor_profile_ids)?;
    for role in crate::coordination::workflows::advisor_roles(request.workflow.as_str()) {
        let role = role.as_str();
        if let Some(profile_id) = raw_advisors[role].as_str() {
            let field = format!("advisorProfileIds.{role}");
            crate::profiles::agent_profiles::read_profile(database, profile_id, "root")?
                .ok_or_else(|| profile_not_available(profile_id, "root", &field))?;
        }
    }
    Ok(())
}

/// `resolveAgentApiRequest`: the workflow or template the project permits, applied under its policy.
fn resolve(
    database: &SuplexDatabase,
    company_id: &str,
    raw: &TaskCreateBody,
) -> DatabaseResult<Resolved> {
    let project = projects::get_in_company(database, company_id, &raw.project_id)?;
    let mut request = base_request(raw, &project);
    let selection = match &raw.template_id {
        Some(template_id) => apply_template(database, &project, raw, template_id, &mut request)?,
        None => apply_workflow(database, raw, &mut request)?,
    };
    validate_resolved(&mut request)?;
    check_requested_profiles(database, raw)?;
    let root = project_profile(
        database,
        request.root_profile_id.as_deref(),
        &project.root_profile_id,
        "root",
        &project,
    )?;
    let worker = project_profile(
        database,
        request.worker_profile_id.as_deref(),
        &project.worker_profile_id,
        "worker",
        &project,
    )?;
    check_advisor_profiles(database, raw, &request)?;
    request.root_profile_id = Some(root.profile_id);
    request.worker_profile_id = Some(worker.profile_id);
    let signature =
        crate::shared::js_json::stringify(&json!({"request": request, "selection": selection}));
    Ok(Resolved {
        request,
        selection,
        signature,
    })
}

fn project_signature(project: &Project) -> Value {
    json!({
        "repository": project.repository, "repositoryPath": project.repository_path, "worktreeRoot": project.worktree_root,
        "baseBranch": project.base_branch, "setupCommand": project.setup_command, "verificationCommand": project.verification_command,
        "providerPolicy": project.provider_policy, "integration": project.integration, "execution": project.execution,
    })
}

fn dependency_unavailable(dependency: &str) -> Box<dyn Error> {
    let reason = "The dependency is not available.";
    fail_with(
        reason,
        422,
        "dependency_not_found",
        json!({"field": "dependsOn", "value": dependency, "reason": reason}),
    )
}

fn would_start(task: &Value) -> Value {
    match task["status"].as_str() {
        Some("backlog") => json!({"wouldStart": "backlog", "blockingPrerequisiteIds": []}),
        Some("active") => json!({"wouldStart": "now", "blockingPrerequisiteIds": []}),
        _ => {
            json!({"wouldStart": "waiting", "blockingPrerequisiteIds": task["queue"]["waitingOn"].as_array().into_iter().flatten().map(|wait| wait["id"].clone()).collect::<Vec<_>>()})
        }
    }
}

fn merged(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        base.extend(extra.clone());
    }
    base
}

/// The outcome the routes and MCP runtime present.
pub enum Creation {
    /// `created` is false for an idempotent replay.
    Task {
        id: String,
        created: bool,
        active: bool,
    },
    DryRun(Value),
}

#[derive(Debug)]
struct DryRunRollback(Value);

impl fmt::Display for DryRunRollback {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Dry-run rollback")
    }
}

impl Error for DryRunRollback {}

enum Admission {
    Done(Creation),
    Capture(Box<Pending>),
}

struct Pending {
    resolved: Resolved,
    project: Project,
    hash: String,
    images: Vec<images::DecodedTaskImage>,
    /// The GitHub observations of `blockedByPullRequests`.
    pull_requests: Vec<Value>,
}

/// The task an earlier identical request created, as an idempotent replay.
fn replayed(
    database: &SuplexDatabase,
    principal: &Principal,
    idempotency_key: &str,
    hash: &str,
) -> DatabaseResult<Option<Creation>> {
    let Some(id) = existing(
        database,
        &principal.company_id,
        idempotency_key,
        hash,
        &principal.agent_id,
    )?
    else {
        return Ok(None);
    };
    let active = task_json(database, &id)?["status"] == "active";
    Ok(Some(Creation::Task {
        id,
        created: false,
        active,
    }))
}

/// The task an earlier request with this idempotency key created. A legacy
/// request also matches its legacy hash.
fn existing_request(
    database: &SuplexDatabase,
    principal: &Principal,
    raw: &TaskCreateBody,
    hash: &str,
) -> DatabaseResult<Option<String>> {
    match existing(
        database,
        &principal.company_id,
        &raw.idempotency_key,
        hash,
        &principal.agent_id,
    ) {
        Err(error)
            if error.to_string() == "This idempotency key belongs to a different request" =>
        {
            if !is_legacy_request(raw) {
                return Err(error);
            }
            let legacy = legacy_hash(raw, &principal.agent_id)?;
            existing(
                database,
                &principal.company_id,
                &raw.idempotency_key,
                &legacy,
                &principal.agent_id,
            )
        }
        other => other,
    }
}

/// The project has a repository and supports the delivery target.
fn check_project_delivery(
    project: &Project,
    request: &task_contracts::TaskCreateBody,
) -> DatabaseResult<()> {
    let bitbucket = matches!(
        project
            .integration
            .as_ref()
            .map(|integration| &integration.repository),
        Some(crate::http::contracts::typed::projects::RepositoryConnection::Bitbucket { .. })
    );
    if bitbucket && !request.delivery_target.bitbucket_supports() {
        return Err(fail(
            "Bitbucket supports draft pull requests. Select a supported delivery target.",
            422,
            "task_failure",
        ));
    }
    if project.repository.is_none() {
        return Err(fail(
            "Configure the project repository before creating a task",
            422,
            "task_failure",
        ));
    }
    Ok(())
}

/// Everything before the live Git capture: authority, idempotency, policy, and local-engine support.
fn admit(
    database: &SuplexDatabase,
    principal: &Principal,
    raw: &TaskCreateBody,
) -> DatabaseResult<Admission> {
    if raw
        .extra
        .keys()
        .any(|name| !["companyId", "agentId", "startImmediately"].contains(&name.as_str()))
    {
        return Err(fail("Invalid request", 400, "request_invalid"));
    }
    let hash = request_hash(raw, &principal.agent_id)?;
    require_scope(
        database,
        principal,
        &principal.company_id,
        &raw.project_id,
        true,
        Some(project_scope_failure(&raw.project_id)),
    )?;
    if let Some(id) = existing_request(database, principal, raw, &hash)? {
        if raw.dry_run == Some(true) {
            return Ok(Admission::Done(Creation::DryRun(
                json!({"dryRun": true, "status": 200, "existingTaskId": id}),
            )));
        }
        let active = task_json(database, &id)?["status"] == "active";
        return Ok(Admission::Done(Creation::Task {
            id,
            created: false,
            active,
        }));
    }
    let resolved = resolve(database, &principal.company_id, raw)?;
    let request = &resolved.request;
    require_scope(
        database,
        principal,
        &principal.company_id,
        &request.project_id,
        true,
        Some(project_scope_failure(&request.project_id)),
    )?;
    if let Some(creation) = replayed(database, principal, &request.idempotency_key, &hash)? {
        return Ok(Admission::Done(creation));
    }
    let project = projects::get_in_company(database, &principal.company_id, &request.project_id)?;
    check_project_delivery(&project, request)?;
    for dependency in &request.depends_on {
        task_row(database, dependency)?.ok_or_else(|| dependency_unavailable(dependency))?;
        require_readable(database, principal, dependency)
            .map_err(|_| dependency_unavailable(dependency))?;
    }
    let images = request
        .images
        .iter()
        .map(images::decode_task_image)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|failure| Box::new(failure) as Box<dyn Error>)?;
    Ok(Admission::Capture(Box::new(Pending {
        resolved,
        project,
        hash,
        images,
        pull_requests: Vec::new(),
    })))
}

/// The local task the admission writes, marked as created by this agent.
fn prepare_agent_task(
    database: &SuplexDatabase,
    principal: &Principal,
    pending: &Pending,
    base_sha: &str,
    source: sources::CreationSource,
    copied_from: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<repository::PreparedTask> {
    let request = &pending.resolved.request;
    let profiles = commands::select_local_profiles(database, &pending.project, request)?;
    let mut prepared = commands::prepare_local_user_task(
        &principal.company_id,
        &principal.agent_id,
        &pending.project,
        request,
        profiles,
        base_sha,
        now,
    )?;
    sources::apply(&mut prepared, source)?;
    prepared.creator = TaskCreator::Agent(principal.agent_id.clone());
    prepared.pull_request_dependencies = pending.pull_requests.clone();
    prepared.request_hash = pending.hash.clone();
    prepared.copied_from_task_id = copied_from.map(str::to_owned);
    if let Some(configuration) = prepared.configuration.as_object_mut() {
        let source = configuration.remove("source").unwrap_or(Value::Null);
        let captured = configuration.remove("capturedAt").unwrap_or(Value::Null);
        configuration.insert("hermesSelection".into(), pending.resolved.selection.clone());
        configuration.insert("source".into(), source);
        configuration.insert("capturedAt".into(), captured);
    }
    Ok(prepared)
}

/// Inside the admission transaction: the project policy and agent profiles
/// still match the captured snapshot, and every dependency stays readable.
fn recheck_policy(
    database: &SuplexDatabase,
    principal: &Principal,
    raw: &TaskCreateBody,
    pending: &Pending,
    prepared: &mut repository::PreparedTask,
) -> DatabaseResult<Project> {
    let request = &pending.resolved.request;
    let current = resolve(database, &principal.company_id, raw)?;
    let project = projects::get_in_company(database, &principal.company_id, &request.project_id)?;
    if current.signature != pending.resolved.signature
        || project_signature(&project) != project_signature(&pending.project)
    {
        return Err(fail(
            "Project task configuration changed",
            409,
            "task_failure",
        ));
    }
    prepared.root_profile = profile(
        database,
        current
            .request
            .root_profile_id
            .as_deref()
            .unwrap_or_default(),
        "root",
    )?;
    prepared.worker_profile = profile(
        database,
        current
            .request
            .worker_profile_id
            .as_deref()
            .unwrap_or_default(),
        "worker",
    )?;
    if [&prepared.root_profile, &prepared.worker_profile]
        .iter()
        .any(|profile| {
            !crate::profiles::agent_profiles::allowed_profile(
                project.provider_policy.as_ref(),
                profile,
            )
        })
    {
        return Err(fail(
            "Select agents with providers and logins allowed by this project",
            422,
            "task_failure",
        ));
    }
    for dependency in &request.depends_on {
        require_readable(database, principal, dependency)?;
    }
    Ok(project)
}

/// The dry-run response: what the admission would create and start.
fn dry_run_preview(task: &Value, project: &Project, selection: &Value) -> Value {
    merged(
        json!({
            "dryRun": true, "projectId": task["projectId"], "project": {"id": project.id, "name": project.name},
            "title": task["title"],
            "workflow": {"id": selection["workflowId"], "engine": task["workflow"], "name": selection["workflowName"]},
            "templateId": selection["templateId"], "deliveryTarget": task["deliveryTarget"],
            "branch": task["configuration"]["branch"], "dependsOn": task["dependsOn"],
        }),
        would_start(task),
    )
}

/// Insert the task, with its images unless this is a dry run, and save a
/// non-Standard workflow on its control.
fn insert_agent_task(
    database: &mut SuplexDatabase,
    prepared: &repository::PreparedTask,
    pending: &Pending,
    artifact_root: Option<&std::path::Path>,
    dry_run: bool,
    now: DateTime<Utc>,
    written: &mut Vec<artifacts::StoredArtifact>,
) -> DatabaseResult<repository::TaskWrite> {
    let result = match artifact_root {
        Some(root) if !dry_run && !pending.images.is_empty() => {
            repository::create_with_images(database, prepared, root, &pending.images, now, written)?
        }
        None if !dry_run && !pending.images.is_empty() => {
            return Err("Artifact root is not configured".into());
        }
        _ => repository::create(database, prepared, now)?,
    };
    let workflow = pending.resolved.request.workflow;
    if result.created && workflow != crate::coordination::workflows::Workflow::Standard {
        database.connection().execute(
            "UPDATE suplex_task_controls SET workflow = ?1 WHERE task_id = ?2",
            params![workflow, result.task.id],
        )?;
    }
    Ok(result)
}

/// The admission transaction: recheck authority and policy against the captured snapshot, then write once.
fn write(
    database: &mut SuplexDatabase,
    principal: &Principal,
    raw: &TaskCreateBody,
    pending: &Pending,
    captured: (sources::CreationSource, String),
    copied_from: Option<&str>,
    artifact_root: Option<&std::path::Path>,
) -> DatabaseResult<Creation> {
    let (source, base_sha) = captured;
    let now = Utc::now();
    let dry_run = raw.dry_run == Some(true);
    let request = &pending.resolved.request;
    let mut prepared = prepare_agent_task(
        database,
        principal,
        pending,
        &base_sha,
        source,
        copied_from,
        now,
    )?;
    let mut written = Vec::new();
    let result = database.transaction(true, |database| {
        require_scope(
            database,
            principal,
            &principal.company_id,
            &request.project_id,
            true,
            None,
        )?;
        if let Some(creation) =
            replayed(database, principal, &request.idempotency_key, &pending.hash)?
        {
            return Ok(creation);
        }
        let project = recheck_policy(database, principal, raw, pending, &mut prepared)?;
        let result = insert_agent_task(
            database,
            &prepared,
            pending,
            artifact_root,
            dry_run,
            now,
            &mut written,
        )?;
        let task = task_json(database, &result.task.id)?;
        if dry_run {
            let preview = dry_run_preview(&task, &project, &pending.resolved.selection);
            return Err(Box::new(DryRunRollback(preview)));
        }
        Ok(Creation::Task {
            id: result.task.id,
            created: result.created,
            active: task["status"] == "active",
        })
    });
    match result {
        Err(error) if error.is::<DryRunRollback>() => {
            let preview = error
                .downcast::<DryRunRollback>()
                .map_err(|_| "dry run failed")?
                .0;
            Ok(Creation::DryRun(preview))
        }
        Err(error) => {
            if let Some(root) = artifact_root {
                for artifact in &written {
                    artifacts::remove_written(root, artifact);
                }
            }
            Err(error)
        }
        ok => ok,
    }
}

/// `createTaskForAgentApi`. The live Git capture runs outside the database lock.
pub async fn create(
    state: &AppState,
    principal: &Principal,
    raw: &TaskCreateBody,
    copied_from: Option<&str>,
) -> DatabaseResult<Creation> {
    let mut pending = match state.with_database(|database| admit(database, principal, raw))? {
        Admission::Done(creation) => return Ok(creation),
        Admission::Capture(pending) => pending,
    };
    let numbers = pending
        .resolved
        .request
        .blocked_by_pull_requests
        .iter()
        .map(|dependency| dependency.number)
        .collect::<Vec<_>>();
    let repository = pending.project.repository.clone().unwrap_or_default();
    pending.pull_requests = pull_request_dependencies::observe(&repository, &numbers)
        .await
        .map_err(pull_request_unavailable)?;
    let captured = super::creation::capture(
        state,
        &pending.project,
        &pending.resolved.request,
        source_rejection,
    )
    .await?;
    let artifact_root = state.artifact_root.clone();
    state.with_database(|database| {
        write(
            database,
            principal,
            raw,
            &pending,
            captured,
            copied_from,
            artifact_root.as_deref(),
        )
    })
}

/// A rejected source names its field, value, and reason; provider outages keep their own failure.
fn source_rejection(error: Box<dyn Error>, selector: Option<&Value>) -> Box<dyn Error> {
    let reason = if let Some(TaskError::Source {
        status, message, ..
    }) = error.downcast_ref()
    {
        (*status < 500).then(|| (*message).to_owned())
    } else if let Some(failure) = error.downcast_ref::<ProjectError>() {
        (failure.status() < 500).then(|| failure.to_string())
    } else {
        None
    };
    let (Some(reason), Some(selector)) = (reason, selector) else {
        return error;
    };
    let (field, code, value) = match selector["kind"].as_str() {
        Some("issue") => (
            "source.issue",
            "source_issue_rejected",
            selector["number"].to_string(),
        ),
        Some("pull_request") => (
            "source.pullRequest",
            "source_pull_request_rejected",
            selector["number"].to_string(),
        ),
        _ => (
            "source.branch",
            "source_branch_rejected",
            selector["branch"].as_str().unwrap_or_default().to_owned(),
        ),
    };
    fail_with(
        &reason,
        422,
        code,
        json!({"field": field, "value": value, "reason": reason}),
    )
}

// Dependencies.

fn audit(
    database: &SuplexDatabase,
    principal: &Principal,
    action: &str,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let state = database
        .connection()
        .query_row(
            "SELECT c.status, t.archived_at IS NOT NULL FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?
        .map_or_else(|| "unknown".to_owned(), |(status, archived)| json!({"status": status, "archived": archived}).to_string());
    let mut metadata = json!({"taskId": task_id, "resultingState": state})
        .as_object()
        .cloned()
        .unwrap_or_default();
    if action == "task_answered"
        && let Some(grant) = &principal.answer_grant
    {
        metadata.insert("answeredForUserId".into(), json!(grant.user_id));
    }
    external_agents::audit(
        database,
        (None, Some(&principal.agent_id)),
        action,
        &principal.company_id,
        metadata,
        now,
    )
}

/// The synchronous array form used by MCP and dry runs.
fn set_dependency_ids(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    depends_on: &[String],
    now: DateTime<Utc>,
) -> DatabaseResult<Value> {
    let row = require_owned(database, principal, task_id)?;
    for dependency in depends_on {
        require_readable(database, principal, dependency)?;
    }
    super::dependencies::replace(database, task_id, &row.company_id, depends_on, now, true)?;
    audit(
        database,
        principal,
        "task_dependencies_updated",
        task_id,
        now,
    )?;
    projection(database, principal, task_id)
}

pub fn set_dependencies_array(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    depends_on: &[String],
) -> DatabaseResult<Value> {
    set_dependency_ids(database, principal, task_id, depends_on, Utc::now())
}

/// TypeScript `observePullRequestDependencies` for an agent: every rejection names the pull request.
pub fn pull_request_unavailable(rejection: pull_request_dependencies::Rejection) -> Box<dyn Error> {
    let (pull_request_dependencies::Rejection::Unobservable(number)
    | pull_request_dependencies::Rejection::NotFound(number)) = rejection;
    let reason = "The pull request is not available.";
    fail_with(
        reason,
        422,
        "dependency_not_found",
        json!({"field": "blockedByPullRequests", "value": number.to_string(), "reason": reason}),
    )
}

/// The authority and task prerequisite checks before GitHub observes the pull
/// request prerequisites; returns the task repository.
pub fn dependency_repository(
    database: &SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    body: &TaskDependenciesBody,
) -> DatabaseResult<String> {
    require_owned(database, principal, task_id)?;
    for dependency in &body.depends_on {
        task_row(database, dependency)?.ok_or_else(|| dependency_unavailable(dependency))?;
        require_readable(database, principal, dependency)
            .map_err(|_| dependency_unavailable(dependency))?;
    }
    Ok(task_json(database, task_id)?["configuration"]["repository"]
        .as_str()
        .unwrap_or("")
        .to_owned())
}

/// The HTTP body form: pull request prerequisites are replaced with the task prerequisites.
/// `pull_requests` are the GitHub observations of `blockedByPullRequests`.
pub fn set_dependencies(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    body: &TaskDependenciesBody,
    pull_requests: &[Value],
) -> DatabaseResult<Value> {
    let now = Utc::now();
    let row = require_owned(database, principal, task_id)?;
    for dependency in &body.depends_on {
        task_row(database, dependency)?.ok_or_else(|| dependency_unavailable(dependency))?;
        require_readable(database, principal, dependency)
            .map_err(|_| dependency_unavailable(dependency))?;
    }
    super::dependencies::replace(
        database,
        task_id,
        &row.company_id,
        &body.depends_on,
        now,
        false,
    )?;
    // Replace every prerequisite before a queued task is considered for admission.
    database.transaction(true, |database| {
        pull_request_dependencies::replace(database, task_id, pull_requests)?;
        repository::reconcile_dependency_release(database, task_id, now).map(|_| ())
    })?;
    audit(
        database,
        principal,
        "task_dependencies_updated",
        task_id,
        now,
    )?;
    projection(database, principal, task_id)
}

/// `previewAgentApiTaskDependencies`: the array replacement, rolled back.
pub fn preview_dependencies(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    depends_on: &[String],
) -> DatabaseResult<Value> {
    let result = database.transaction(true, |database| {
        let task = set_dependency_ids(database, principal, task_id, depends_on, Utc::now())?;
        let preview = merged(
            json!({"dryRun": true, "dependsOn": task["dependsOn"]}),
            would_start(&task),
        );
        Err::<(), _>(Box::new(DryRunRollback(preview)) as Box<dyn Error>)
    });
    match result {
        Err(error) if error.is::<DryRunRollback>() => Ok(error
            .downcast::<DryRunRollback>()
            .map_err(|_| "dry run failed")?
            .0),
        Err(error) => Err(error),
        Ok(()) => Err("dry run did not roll back".into()),
    }
}

// Lifecycle commands.

fn commands_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

struct InFlight(String);

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Ok(mut active) = commands_in_flight().lock() {
            active.remove(&self.0);
        }
    }
}

fn command_audit(command: &str) -> &'static str {
    match command {
        "start_task" => "task_started",
        "move_to_front" => "task_moved_to_front",
        "disarm_task" => "task_disarmed",
        "cancel_task" => "task_cancelled",
        "archive_task" => "task_archived",
        "unarchive_task" => "task_unarchived",
        "send_task_note" => "task_note_added",
        ANSWER_HUMAN_QUESTION => "task_answered",
        "duplicate_task" => "task_duplicated",
        _ => "delivery_wait_recheck_requested",
    }
}

/// Commands the route follows with a host wake.
pub fn wakes_host(command: &str) -> bool {
    matches!(
        command,
        "start_task"
            | "cancel_task"
            | "send_task_note"
            | "recheck_delivery_wait"
            | ANSWER_HUMAN_QUESTION
    )
}

fn stale() -> Box<dyn Error> {
    fail("Task revision is stale", 412, "revision_stale")
}

enum Claim {
    Replay(Value),
    Claimed {
        guard: InFlight,
        hash: String,
        command_revision: i64,
    },
}

/// A stored receipt replays; otherwise the request must name the current
/// revision and be legal for the task it reads.
fn claim(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    request: &impl serde::Serialize,
    revision: &str,
    idempotency_key: &str,
    legal: impl FnOnce(&SuplexDatabase, &Value) -> DatabaseResult<()>,
) -> DatabaseResult<Claim> {
    let hash = sha256_hex(crate::shared::js_json::stringify(&serde_json::to_value(
        request,
    )?));
    require_owned(database, principal, task_id)?;
    // This historical table name preserves idempotency receipts across the public rename.
    let stored: Option<(String, String)> = database
        .connection()
        .query_row(
            "SELECT request_hash, result_json FROM suplex_hermes_task_command_receipts WHERE agent_id = ?1 AND task_id = ?2 AND idempotency_key = ?3",
            params![principal.agent_id, task_id, idempotency_key],
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
        return Ok(Claim::Replay(serde_json::from_str(&result)?));
    }
    let key =
        crate::shared::js_json::stringify(&json!([principal.agent_id, task_id, idempotency_key]));
    let inserted = commands_in_flight()
        .lock()
        .map_err(|_| "command state is unavailable")?
        .insert(key.clone());
    if !inserted {
        return Err(fail(
            "This command is still being processed",
            409,
            "command_in_progress",
        ));
    }
    let guard = InFlight(key);
    let row = require_owned(database, principal, task_id)?;
    let before = projection_of(database, principal, &row)?;
    let command_part = |revision: &str| revision.split('.').next().unwrap_or_default().to_owned();
    if before["revision"].as_str().map(command_part) != Some(command_part(revision)) {
        return Err(stale());
    }
    legal(database, &before)?;
    Ok(Claim::Claimed {
        guard,
        hash,
        command_revision: row.command_revision,
    })
}

/// A lifecycle command's claim: a command the task permits, and its revision advanced.
fn claim_command(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    input: &TaskCommandBody,
) -> DatabaseResult<Claim> {
    if input.command == ANSWER_HUMAN_QUESTION && principal.answer_grant.is_none() {
        require_owned(database, principal, task_id)?;
        return Err(fail(
            "An administrator must let this agent answer questions",
            403,
            "answer_grant_required",
        ));
    }
    let claimed = claim(
        database,
        principal,
        task_id,
        input,
        &input.revision,
        &input.idempotency_key,
        |database, task| {
            if input.command == ANSWER_HUMAN_QUESTION {
                require_answerable(database, task_id, input)?;
            }
            if task["permittedCommands"]
                .as_array()
                .is_some_and(|commands| commands.contains(&json!(input.command)))
            {
                Ok(())
            } else {
                Err(fail(
                    "This command is not legal for the current task",
                    409,
                    "illegal_command",
                ))
            }
        },
    )?;
    if let Claim::Claimed {
        command_revision, ..
    } = &claimed
    {
        advance(database, task_id, *command_revision)?;
    }
    Ok(claimed)
}

/// The revision claim is the optimistic lock: a concurrent write on the same revision loses here.
fn advance(
    database: &mut SuplexDatabase,
    task_id: &str,
    command_revision: i64,
) -> DatabaseResult<()> {
    let claimed = database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_tasks SET command_revision = command_revision + 1 WHERE id = ?1 AND command_revision = ?2",
            params![task_id, command_revision],
        )?)
    })?;
    if claimed != 1 {
        return Err(stale());
    }
    Ok(())
}

/// The answer names the current plain question; the board's check decides it.
fn require_answerable(
    database: &SuplexDatabase,
    task_id: &str,
    input: &TaskCommandBody,
) -> DatabaseResult<()> {
    let question_id = input.question_id.as_deref().unwrap_or_default();
    match commands::answerable(database, task_id, question_id)? {
        Ok(()) => {
            let task = response::get(database, task_id)?.ok_or_else(not_found)?;
            answer_text(&task, input).map(|_| ())
        }
        Err(commands::Unanswerable::NotWaiting) => Err(fail(
            "The task is not waiting for an answer",
            409,
            "task_not_waiting",
        )),
        Err(commands::Unanswerable::QuestionChanged) => Err(fail(
            "The question changed. Read the current question before answering",
            409,
            "question_stale",
        )),
        Err(commands::Unanswerable::TaskLimit | commands::Unanswerable::CommandCleanup) => {
            Err(fail(
                "Only a person can answer this decision",
                409,
                "human_decision_required",
            ))
        }
    }
}

/// The answer text: the offered option as the board sends it, or the free text.
fn answer_text(task: &response::TaskResponse, input: &TaskCommandBody) -> DatabaseResult<String> {
    if let Some(answer) = &input.answer {
        return Ok(answer.clone());
    }
    let options = match &task.human_question {
        Some(response::TaskHumanQuestion::Question { options, .. }) => options.as_slice(),
        _ => &[],
    };
    input
        .option_id
        .as_deref()
        .and_then(option_index)
        .and_then(|index| options.get(index))
        .map(|option| format!("{}: {}", option.label, option.description))
        .ok_or_else(|| {
            fail_with(
                "The option is not offered by the current question",
                422,
                "option_not_offered",
                json!({"code": "option_not_offered", "field": "optionId", "value": input.option_id, "reason": "The option is not offered by the current question."}),
            )
        })
}

fn finish(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    result_task_id: &str,
    idempotency_key: &str,
    hash: &str,
    action: &str,
) -> DatabaseResult<Value> {
    let now = Utc::now();
    let result = projection(database, principal, result_task_id)?;
    database.transaction(false, |database| {
        database.connection().execute(
            "INSERT INTO suplex_hermes_task_command_receipts (agent_id, task_id, idempotency_key, request_hash, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![principal.agent_id, task_id, idempotency_key, hash, crate::shared::js_json::stringify(&result), rfc3339_millis(now)],
        )?;
        Ok(())
    })?;
    audit(database, principal, action, task_id, now)?;
    Ok(result)
}

fn apply(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    input: &TaskCommandBody,
) -> DatabaseResult<()> {
    let now = Utc::now();
    match input.command.as_str() {
        "start_task" => {
            if archive::in_progress(task_id) {
                return Err(fail(
                    "Archive cleanup is in progress",
                    409,
                    "illegal_command",
                ));
            }
            repository::start(database, task_id, now)?;
        }
        "disarm_task" => {
            repository::disarm(database, task_id, now)?;
        }
        "move_to_front" => {
            if !repository::move_to_front(database, task_id, now)? {
                return Err(fail(
                    "Only a queued task can move to the front",
                    409,
                    "illegal_command",
                ));
            }
        }
        "cancel_task" => {
            root_session_store::cancel_task(database, task_id, now)?;
        }
        "unarchive_task" => {
            archive::unarchive_task(database, &agent_authority(principal), task_id)?;
        }
        "send_task_note" => {
            require_owned(database, principal, task_id)?;
            let task = task_json(database, task_id)?;
            if !task["archivedAt"].is_null()
                || !matches!(task["status"].as_str(), Some("active" | "delivered"))
            {
                return Err(fail(
                    "Start the task or answer its current decision before you send a message.",
                    409,
                    "illegal_command",
                ));
            }
            let label = format!("Agent note ({})", principal.agent_id);
            root_session_store::send_labeled_note(
                database,
                task_id,
                input.note.as_deref().unwrap_or_default(),
                &label,
                now,
            )?;
        }
        ANSWER_HUMAN_QUESTION => {
            let Some(grant) = &principal.answer_grant else {
                return Err(fail(
                    "An administrator must let this agent answer questions",
                    403,
                    "answer_grant_required",
                ));
            };
            let task = response::get(database, task_id)?.ok_or_else(not_found)?;
            let answer = answer_text(&task, input)?;
            // The Coordinator store re-checks the question and refuses command cleanup.
            root_session_store::answer_human(
                database,
                task_id,
                input.question_id.as_deref().unwrap_or_default(),
                &answer,
                false,
                Some(&root_session_store::AnsweredBy {
                    agent_id: principal.agent_id.clone(),
                    agent_name: grant.agent_name.clone(),
                    user_id: grant.user_id.clone(),
                    user_name: grant.user_name.clone(),
                }),
                now,
            )?;
        }
        // TaskHost owns delivery observation; the route wakes it after this returns.
        _ => {}
    }
    Ok(())
}

fn duplicate_title(title: &str) -> String {
    let (base, copy) = match title.rsplit_once(" (") {
        Some((base, rest))
            if rest.strip_suffix(')').is_some_and(|number| {
                !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
            }) =>
        {
            (
                base,
                rest.trim_end_matches(')')
                    .parse::<u64>()
                    .map_or(2, |number| number + 1),
            )
        }
        _ => (title, 2),
    };
    let base = base.trim_end();
    let base = if base.is_empty() { title } else { base };
    format!("{base} ({copy})")
}

/// The copy's create request: the source configuration the project still permits.
fn duplicate_request(
    database: &SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    key: &str,
    artifact_root: Option<&std::path::Path>,
) -> DatabaseResult<TaskCreateBody> {
    require_owned(database, principal, task_id)?;
    let source = task_json(database, task_id)?;
    let project_id = source["projectId"].as_str().unwrap_or_default().to_owned();
    let policy =
        projects::get_in_company(database, &principal.company_id, &project_id)?.agent_task_policy;
    let mut images = Vec::new();
    for image in source["images"].as_array().into_iter().flatten() {
        let artifact: Option<(String, String, String)> = database
            .connection()
            .query_row(
                "SELECT filename, mime_type, storage_path FROM suplex_artifacts WHERE id = ?1 AND task_id = ?2 AND company_id = ?3",
                params![image["artifactId"].as_str().unwrap_or_default(), task_id, principal.company_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (Some((filename, mime_type, storage_path)), Some(root)) = (artifact, artifact_root)
        else {
            return Err(fail(
                "A source task image is no longer available",
                409,
                "illegal_command",
            ));
        };
        let bytes = artifacts::read(root, &principal.company_id, &storage_path)?;
        images.push(TaskImage {
            filename,
            mime_type,
            base64: STANDARD.encode(bytes),
        });
    }
    let engine = source["workflow"].as_str().unwrap_or("standard");
    let workflow_id = policy
        .workflow_ids
        .iter()
        .find(|id| {
            database
                .connection()
                .query_row(
                    "SELECT engine FROM suplex_workflows WHERE id = ?1 AND archived_at IS NULL",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
                .as_deref()
                == Some(engine)
        })
        .cloned()
        .unwrap_or_else(|| policy.default_workflow_id.clone());
    // A profile removed since the source task ran falls back to its default.
    let existing = |id: &Value, role: &str| -> DatabaseResult<Option<String>> {
        let Some(id) = id.as_str() else {
            return Ok(None);
        };
        Ok(
            crate::profiles::agent_profiles::read_profile(database, id, role)?
                .map(|_| id.to_owned()),
        )
    };
    let mut advisor_ids = Map::new();
    if let Some(stored) = source["advisorProfiles"].as_object() {
        for (role, profile) in stored {
            if let Some(id) = existing(&profile["profileId"], "root")? {
                advisor_ids.insert(role.clone(), json!(id));
            }
        }
    }
    let task_source = source["configuration"]
        .get("source")
        .filter(|value| !value.is_null())
        .cloned();
    Ok(TaskCreateBody {
        project_id,
        title: duplicate_title(source["title"].as_str().unwrap_or_default()),
        description: Some(
            source["description"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        ),
        idempotency_key: format!("duplicate-{}", sha256_hex(format!("{task_id}:{key}"))),
        depends_on: None,
        blocked_by_pull_requests: None,
        queue: None,
        images,
        source: task_source.map(serde_json::from_value).transpose()?,
        workflow_id: Some(workflow_id),
        template_id: None,
        root_profile_id: existing(&source["rootProfile"]["profileId"], "root")?,
        worker_profile_id: existing(&source["workerProfile"]["profileId"], "worker")?,
        advisor_profile_ids: serde_json::from_value(Value::Object(advisor_ids))?,
        delivery_target: None,
        run_project_tests: None,
        visual_evidence: None,
        dry_run: None,
        extra: Map::new(),
    })
}

/// `commandAgentApiTask`: revision, receipt, and creator authority, then one effect.
pub async fn command(
    state: &AppState,
    principal: &Principal,
    task_id: &str,
    input: &TaskCommandBody,
) -> DatabaseResult<Value> {
    let claimed =
        state.with_database(|database| claim_command(database, principal, task_id, input))?;
    let (guard, hash) = match claimed {
        Claim::Replay(result) => return Ok(result),
        Claim::Claimed { guard, hash, .. } => (guard, hash),
    };
    let mut result_task_id = task_id.to_owned();
    match input.command.as_str() {
        "archive_task" => {
            let path = state
                .with_database(|database| database.connection().path().map(PathBuf::from))
                .ok_or("Database path is unavailable")?;
            let archiving = principal.clone();
            let id = task_id.to_owned();
            let outcome = tokio::task::spawn_blocking(move || {
                archive::archive_task(&path, &agent_authority(&archiving), &id, false)
                    .map_err(crossed)
            })
            .await?;
            match outcome {
                Ok(archive::ArchiveOutcome::ConfirmationRequired(_)) => {
                    return Err(fail(
                        "Discard dirty worktree changes before archiving",
                        409,
                        "illegal_command",
                    ));
                }
                Ok(archive::ArchiveOutcome::Archived(_)) => {
                    state.host_terminals.close_task(task_id, false);
                }
                Err(error) => return Err(uncrossed(error)),
            }
        }
        "duplicate_task" => {
            let root = state.artifact_root.clone();
            let request = state.with_database(|database| {
                duplicate_request(
                    database,
                    principal,
                    task_id,
                    &input.idempotency_key,
                    root.as_deref(),
                )
            })?;
            match create(state, principal, &request, Some(task_id)).await? {
                Creation::Task { id, active, .. } => {
                    if active && let Some(host) = &state.task_host {
                        host.wake(id.clone());
                    }
                    result_task_id = id;
                }
                Creation::DryRun(_) => return Err("duplicate cannot be a dry run".into()),
            }
        }
        _ => state.with_database(|database| apply(database, principal, task_id, input))?,
    }
    let result = state.with_database(|database| {
        finish(
            database,
            principal,
            task_id,
            &result_task_id,
            &input.idempotency_key,
            &hash,
            command_audit(&input.command),
        )
    });
    drop(guard);
    result
}

/// The board's detail edit an agent update states. `workflowId` names the
/// engine and the workflow selection the projection reports.
fn detail_edit(
    database: &SuplexDatabase,
    input: &TaskUpdateBody,
) -> DatabaseResult<(task_contracts::TaskDetailsBody, Option<Value>)> {
    let mut selection = None;
    let mut workflow = None;
    if let Some(workflow_id) = &input.workflow_id {
        let Some((name, _, engine)) = workflow_record(database, workflow_id)? else {
            return Err(TaskError::field(
                "workflow_not_found",
                "The selected workflow is not available",
                "workflowId",
                workflow_id,
            )
            .into());
        };
        workflow = Some(
            crate::coordination::workflows::Workflow::parse(&engine)
                .ok_or_else(|| workflow_input_failure("The selected workflow does not exist"))?,
        );
        let name = crate::identity::auth::js_trim(&name);
        selection =
            Some(json!({"workflowId": workflow_id, "workflowName": name, "templateId": null}));
    }
    let details = task_contracts::TaskDetailsBody {
        title: input.title.clone(),
        description: input.description.clone(),
        root_profile_id: input.root_profile_id.clone(),
        worker_profile_id: input.worker_profile_id.clone(),
        delivery_target: input.delivery_target,
        run_project_tests: input.run_project_tests,
        visual_evidence: input.visual_evidence.clone(),
        workflow,
        advisor_profile_ids: input.advisor_profile_ids.clone(),
    };
    Ok((details, selection))
}

/// `PATCH /api/agent/tasks/{taskId}`: the board's detail edit of a backlog or
/// queued task, under the command revision and receipt. A running or delivered
/// task accepts only a later delivery target, which the Coordinator continues
/// toward. A refused edit keeps the revision and writes no receipt or audit event.
pub fn update(
    database: &mut SuplexDatabase,
    principal: &Principal,
    task_id: &str,
    input: &TaskUpdateBody,
) -> DatabaseResult<Value> {
    // The guarded edit decides legality; a refusal rolls back the revision.
    let claimed = claim(
        database,
        principal,
        task_id,
        input,
        &input.revision,
        &input.idempotency_key,
        |_, _| Ok(()),
    )?;
    let (guard, hash, command_revision) = match claimed {
        Claim::Replay(result) => return Ok(result),
        Claim::Claimed {
            guard,
            hash,
            command_revision,
        } => (guard, hash, command_revision),
    };
    let running = matches!(
        repository::task_by_id(database, task_id)?.map(|task| task.status),
        Some(TaskStatus::Active | TaskStatus::Delivered)
    );
    if running {
        let result = database.transaction(true, |database| {
            advance(database, task_id, command_revision)?;
            let other_fields = input.title.is_some()
                || input.description.is_some()
                || input.workflow_id.is_some()
                || input.root_profile_id.is_some()
                || input.worker_profile_id.is_some()
                || input.advisor_profile_ids.is_some()
                || input.run_project_tests.is_some()
                || input.visual_evidence.is_some();
            let Some(target) = input.delivery_target.filter(|_| !other_fields) else {
                return Err(fail(
                    "A running or delivered task accepts only a later deliveryTarget.",
                    409,
                    "illegal_command",
                ));
            };
            root_session_store::continue_delivery(database, task_id, target)?;
            finish(
                database,
                principal,
                task_id,
                task_id,
                &input.idempotency_key,
                &hash,
                "task_details_updated",
            )
        });
        drop(guard);
        return result;
    }
    let (details, selection) = detail_edit(database, input)?;
    let now = Utc::now();
    let result = database.transaction(true, |database| {
        advance(database, task_id, command_revision)?;
        commands::update_task_details(database, task_id, &details, now).map_err(|error| {
            match error.downcast_ref::<TaskError>() {
                Some(TaskError::Failure { status: 409, .. }) => fail(
                    "Only tasks in the backlog or queue can be edited. Open archived tasks before editing them.",
                    409,
                    "illegal_command",
                ),
                _ => error,
            }
        })?;
        if let Some(selection) = &selection {
            repository::select_workflow(database, task_id, selection)?;
        }
        finish(
            database,
            principal,
            task_id,
            task_id,
            &input.idempotency_key,
            &hash,
            "task_details_updated",
        )
    });
    drop(guard);
    result
}

/// A failure that crosses the blocking-thread boundary keeps its domain type.
enum Crossed {
    Task(TaskError),
    Other(String),
}

fn crossed(error: Box<dyn Error>) -> Crossed {
    match error.downcast::<TaskError>() {
        Ok(failure)
            if matches!(
                *failure,
                TaskError::Failure { .. } | TaskError::Agent { .. }
            ) =>
        {
            Crossed::Task(*failure)
        }
        Ok(failure) => Crossed::Other(failure.to_string()),
        Err(error) => Crossed::Other(error.to_string()),
    }
}

fn uncrossed(error: Crossed) -> Box<dyn Error> {
    match error {
        Crossed::Task(failure) => failure.into(),
        // TypeScript turns any other archive failure into a 409 task failure.
        Crossed::Other(message) => fail(&message, 409, "task_failure"),
    }
}

#[cfg(test)]
mod retirement_admission_tests {
    use super::*;
    use crate::http::routes::agent_api::tests::agent;

    fn request(key: &str) -> TaskCreateBody {
        serde_json::from_value(json!({
            "projectId": "project_api", "title": "Admission boundary", "idempotencyKey": key,
            "images": [], "advisorProfileIds": {}
        }))
        .unwrap()
    }

    fn pending(state: &AppState, principal: &Principal, raw: &TaskCreateBody) -> Box<Pending> {
        match state
            .with_database(|database| admit(database, principal, raw))
            .unwrap()
        {
            Admission::Capture(pending) => pending,
            Admission::Done(_) => panic!("new request must enter capture"),
        }
    }

    async fn captured(
        pending: &Pending,
        raw: &TaskCreateBody,
    ) -> (sources::CreationSource, String) {
        let source = sources::creation_source(
            &pending.project,
            &raw.title,
            raw.description.as_deref().unwrap_or_default(),
            None,
            None,
        )
        .await
        .unwrap();
        let repository = git2::Repository::open(&pending.project.repository_path).unwrap();
        let base = repository.head().unwrap().target().unwrap().to_string();
        (source, base)
    }

    fn count(state: &AppState, table: &str) -> i64 {
        state.with_database(|database| {
            database
                .connection()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
    }

    #[tokio::test]
    async fn pre_feature_request_hash_replays_only_the_original_payload() {
        let fixture = agent().await;
        let raw: TaskCreateBody = serde_json::from_value(json!({
            "projectId": "project_api", "title": "Legacy hash", "description": "Original",
            "idempotencyKey": "legacy-hash-001", "images": [], "advisorProfileIds": {}
        }))
        .unwrap();
        let (status, created) = fixture
            .call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(serde_json::to_value(&raw).unwrap()),
            )
            .await;
        assert_eq!(status, 201, "{created}");
        let hash = legacy_hash(&raw, &fixture.agent_id).unwrap();
        fixture.server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_tasks SET request_hash = ?1 WHERE id = ?2",
                    rusqlite::params![hash, created["id"].as_str().unwrap()],
                )
                .unwrap();
        });
        let (status, replay) = fixture
            .call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(serde_json::to_value(&raw).unwrap()),
            )
            .await;
        assert_eq!((status, replay["id"].clone()), (200, created["id"].clone()));
        let mut changed = serde_json::to_value(&raw).unwrap();
        changed["description"] = json!("Changed");
        let (status, conflict) = fixture
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(changed))
            .await;
        assert_eq!(status, 409, "{conflict}");
        assert_eq!(count(&fixture.server.state, "suplex_tasks"), 1);
    }

    /// Pull request repair takes the caller's project tests choice, then the
    /// workflow record's, then the project's; it still merges.
    #[tokio::test]
    async fn pull_request_repair_takes_the_chosen_then_default_project_tests() {
        // The pinned pull request source needs no Git fetch, so this fixture has no origin.
        let (state, path) = crate::http::routes::auth::tests::state();
        let server =
            crate::http::routes::external_agent_administration::tests::server(Some((state, path)))
                .await;
        let state = &server.state;
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_projects SET root_profile_id = 'profile_native_root', worker_profile_id = 'profile_native_worker', repository_identity = 'acme/demo', agent_task_policy_json = ?1 WHERE id = 'project_api'",
                [json!({"workflowIds": ["workflow_native_standard"], "defaultWorkflowId": "workflow_native_standard", "rootProfileIds": ["profile_native_root"], "workerProfileIds": ["profile_native_worker"], "deliveryTarget": "local_worktree"}).to_string()],
            ).unwrap();
        });
        let (credential, _) =
            crate::http::routes::agent_api::tests::pair(&server, "Repair Bot", &["project_api"]);
        let principal = state.with_database(|database| {
            external_agents::authenticate(database, &credential, Utc::now()).unwrap()
        });
        let repair = |key: &str, tests: Option<bool>| -> TaskCreateBody {
            let mut body = json!({
                "projectId": "project_api", "title": "Repair", "idempotencyKey": key,
                "images": [], "advisorProfileIds": {},
                "workflowId": "workflow_native_refine_pull_request",
                "source": {"kind": "pull_request", "number": 7}
            });
            if let Some(tests) = tests {
                body["runProjectTests"] = json!(tests);
            }
            serde_json::from_value(body).unwrap()
        };
        let raw = repair("repair-tests-off", Some(false));
        let snapshot = pending(state, &principal, &raw);
        let base = "b".repeat(40);
        let source = sources::captured_pull_request_for_test(7, &"a".repeat(40), &base);
        let created = state
            .with_database(|database| {
                write(
                    database,
                    &principal,
                    &raw,
                    &snapshot,
                    (source, base),
                    None,
                    state.artifact_root.as_deref(),
                )
            })
            .unwrap();
        let Creation::Task { id, .. } = created else {
            panic!("the repair task must be created");
        };
        let task = state.with_database(|database| task_json(database, &id).unwrap());
        assert_eq!(
            (
                &task["workflow"],
                &task["deliveryTarget"],
                &task["configuration"]["runProjectTests"]
            ),
            (
                &json!("refine_pull_request"),
                &json!("merged"),
                &json!(false)
            ),
            "{task}"
        );
        let resolved_tests = |record: &str| {
            state.with_database(|database| {
                database
                    .connection()
                    .execute(
                        "UPDATE suplex_workflows SET configuration_json = ?1 WHERE id = 'workflow_native_refine_pull_request'",
                        [record],
                    )
                    .unwrap();
                resolve(database, &principal.company_id, &repair("repair-default", None))
                    .unwrap()
                    .request
                    .run_project_tests
            })
        };
        assert!(!resolved_tests(r#"{"runProjectTests":false}"#));
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_projects SET agent_task_policy_json = json_set(agent_task_policy_json, '$.runProjectTests', json('false')) WHERE id = 'project_api'",
                    [],
                )
                .unwrap()
        });
        assert!(resolved_tests(r#"{"runProjectTests":true}"#));
        assert!(!resolved_tests("{}"));
    }

    #[tokio::test]
    async fn admission_rechecks_live_grants_profile_and_project_configuration_after_capture() {
        let fixture = agent().await;
        let state = &fixture.server.state;
        let principal = state.with_database(|database| {
            external_agents::authenticate(database, &fixture.credential, Utc::now()).unwrap()
        });
        let artifact_root = state.artifact_root.as_deref();
        let baseline = (
            count(state, "suplex_tasks"),
            count(state, "suplex_task_controls"),
            count(state, "suplex_artifacts"),
        );

        let raw = request("delayed-grant-001");
        let snapshot = pending(state, &principal, &raw);
        let source = captured(&snapshot, &raw).await;
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "DELETE FROM suplex_external_agent_project_grants WHERE agent_id = ?1",
                    [&fixture.agent_id],
                )
                .unwrap()
        });
        assert!(
            state
                .with_database(|database| write(
                    database,
                    &principal,
                    &raw,
                    &snapshot,
                    source,
                    None,
                    artifact_root
                ))
                .is_err()
        );
        assert_eq!(
            (
                count(state, "suplex_tasks"),
                count(state, "suplex_task_controls"),
                count(state, "suplex_artifacts")
            ),
            baseline
        );
        state.with_database(|database| database.connection().execute("INSERT INTO suplex_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES (?1, 'company_api', 'project_api', ?2)", rusqlite::params![fixture.agent_id, rfc3339_millis(Utc::now())]).unwrap());

        let raw = request("delayed-profile-001");
        let snapshot = pending(state, &principal, &raw);
        let source = captured(&snapshot, &raw).await;
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_profiles SET archived_at = ?1 WHERE id = 'profile_native_root'",
                    [rfc3339_millis(Utc::now())],
                )
                .unwrap()
        });
        assert!(
            state
                .with_database(|database| write(
                    database,
                    &principal,
                    &raw,
                    &snapshot,
                    source,
                    None,
                    artifact_root
                ))
                .is_err()
        );
        assert_eq!(
            (
                count(state, "suplex_tasks"),
                count(state, "suplex_task_controls"),
                count(state, "suplex_artifacts")
            ),
            baseline
        );
        state.with_database(|database| database.connection().execute("UPDATE suplex_profiles SET archived_at = NULL WHERE id = 'profile_native_root'", []).unwrap());

        for (key, update) in [
            (
                "delayed-setup-001",
                "UPDATE suplex_projects SET setup_command = 'changed' WHERE id = 'project_api'",
            ),
            (
                "delayed-verification-001",
                "UPDATE suplex_projects SET verification_command = 'changed' WHERE id = 'project_api'",
            ),
            (
                "delayed-repository-001",
                "UPDATE suplex_projects SET repository_identity = 'acme/changed' WHERE id = 'project_api'",
            ),
        ] {
            let raw = request(key);
            let snapshot = pending(state, &principal, &raw);
            let source = captured(&snapshot, &raw).await;
            state.with_database(|database| database.connection().execute(update, []).unwrap());
            assert!(
                state
                    .with_database(|database| write(
                        database,
                        &principal,
                        &raw,
                        &snapshot,
                        source,
                        None,
                        artifact_root
                    ))
                    .is_err(),
                "{key}"
            );
            assert_eq!(
                (
                    count(state, "suplex_tasks"),
                    count(state, "suplex_task_controls"),
                    count(state, "suplex_artifacts")
                ),
                baseline,
                "{key}"
            );
            state.with_database(|database| database.connection().execute("UPDATE suplex_projects SET setup_command = '', verification_command = '', repository_identity = 'acme/demo' WHERE id = 'project_api'", []).unwrap());
        }

        let raw = request("delayed-metadata-001");
        let snapshot = pending(state, &principal, &raw);
        let source = captured(&snapshot, &raw).await;
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_projects SET name = 'Renamed project' WHERE id = 'project_api'",
                    [],
                )
                .unwrap()
        });
        let created = state
            .with_database(|database| {
                write(
                    database,
                    &principal,
                    &raw,
                    &snapshot,
                    source,
                    None,
                    artifact_root,
                )
            })
            .unwrap();
        assert!(matches!(created, Creation::Task { created: true, .. }));
        assert_eq!(count(state, "suplex_tasks"), baseline.0 + 1);
    }

    #[tokio::test]
    async fn paused_retry_replays_concurrent_winner_before_policy_recheck() {
        let fixture = agent().await;
        let state = &fixture.server.state;
        let principal = state.with_database(|database| {
            external_agents::authenticate(database, &fixture.credential, Utc::now()).unwrap()
        });
        let raw = request("delayed-retry-001");
        let snapshot = pending(state, &principal, &raw);
        let source = captured(&snapshot, &raw).await;
        let winner = fixture
            .create("Admission boundary", "delayed-retry-001")
            .await;
        state.with_database(|database| database.connection().execute("UPDATE suplex_projects SET setup_command = 'changed after winner' WHERE id = 'project_api'", []).unwrap());
        let replay = state
            .with_database(|database| {
                write(
                    database,
                    &principal,
                    &raw,
                    &snapshot,
                    source,
                    None,
                    state.artifact_root.as_deref(),
                )
            })
            .unwrap();
        assert!(
            matches!(replay, Creation::Task { created: false, ref id, .. } if id == winner["id"].as_str().unwrap())
        );
        assert_eq!(count(state, "suplex_tasks"), 1);
    }

    #[tokio::test]
    async fn in_flight_command_replay_is_held_and_other_key_loses_revision() {
        let fixture = agent().await;
        let task = fixture
            .create("In flight command", "in-flight-create-001")
            .await;
        let id = task["id"].as_str().unwrap();
        let principal = fixture.server.state.with_database(|database| {
            external_agents::authenticate(database, &fixture.credential, Utc::now()).unwrap()
        });
        let command: TaskCommandBody = serde_json::from_value(json!({"command":"cancel_task", "revision":task["revision"], "idempotencyKey":"in-flight-cancel-001"})).unwrap();
        let first = fixture
            .server
            .state
            .with_database(|database| claim_command(database, &principal, id, &command))
            .unwrap();
        assert!(matches!(first, Claim::Claimed { .. }));
        let Err(replay) = fixture
            .server
            .state
            .with_database(|database| claim_command(database, &principal, id, &command))
        else {
            panic!("same key admitted twice");
        };
        assert!(replay.to_string().contains("still being processed"));
        let other: TaskCommandBody = serde_json::from_value(json!({"command":"cancel_task", "revision":task["revision"], "idempotencyKey":"in-flight-other-001"})).unwrap();
        let Err(loser) = fixture
            .server
            .state
            .with_database(|database| claim_command(database, &principal, id, &other))
        else {
            panic!("stale revision admitted");
        };
        assert!(loser.to_string().contains("revision is stale"));
        let count: i64 = fixture.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM suplex_hermes_task_command_receipts WHERE task_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!(count, 0);
        drop(first);
    }
}
