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
    platform::database::SuplexDatabase,
    projects::service::{self as projects, Project},
    shared::{ids::random_hex_id, time::now_millis_rfc3339},
    tasks::{TaskError, control::DeliveryTarget, creation, response::VisualEvidence},
};

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

#[derive(Clone, Debug, Serialize, TS)]
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

#[derive(Clone, Debug, Serialize, TS)]
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

const RUN_COLUMNS: &str = "SELECT r.id, r.move_id, r.move_name, r.runner, r.prompt, r.inputs_json, r.excluded_pull_requests_json, r.outcomes_json, u.display_name, r.started_by_user_id, r.started_at FROM suplex_move_runs r LEFT JOIN suplex_users u ON u.id = r.started_by_user_id";

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
    let mut statement = database.connection().prepare(&format!(
        "{MOVE_COLUMNS} WHERE company_id = ?1 ORDER BY name COLLATE NOCASE, id"
    ))?;
    let stored = statement
        .query_map([company_id], stored_move)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let moves = stored
        .into_iter()
        .filter(|stored| projects::get(database, user_id, &stored.project_id).is_ok())
        .map(|stored| response(database, stored))
        .collect::<Result<_, _>>()?;
    Ok(MovesResponse { moves })
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
            "INSERT INTO suplex_moves (id, company_id, project_id, name, prompt, runner, profile_id, confirm, workflow, delivery_target, run_project_tests, visual_evidence, created_by_user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
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

/// Create one task through the browser creation path and its authorization.
async fn create_task(
    state: &AppState,
    company_id: &str,
    user_id: &str,
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
    match creation::create_browser(
        state.clone(),
        company_id.to_owned(),
        user_id.to_owned(),
        request,
    )
    .await
    {
        Ok((_, task)) => {
            outcome.task_id = serde_json::to_value(&task)
                .ok()
                .and_then(|task| task["id"].as_str().map(str::to_owned));
        }
        Err(failure) => {
            outcome.kind = MoveOutcomeKind::Failed;
            outcome.reason = Some(failure.message);
        }
    }
}

/// Start a run: create its tasks and record what happened. A retry with the
/// same idempotency key returns the recorded run; task keys make a retry after
/// a partial failure create only the missing tasks.
pub async fn start(
    state: &AppState,
    user_id: &str,
    move_id: &str,
    body: MoveRunBody,
) -> Result<(bool, MoveRunResponse), Box<dyn Error>> {
    let (stored, project, replay) = state.with_database(|database| {
        let (stored, project) = accessible(database, user_id, move_id)?;
        let replay = existing_run(database, move_id, &body.idempotency_key)?;
        Ok::<_, Box<dyn Error>>((stored, project, replay))
    })?;
    if let Some(run) = replay {
        return Ok((false, run));
    }
    let resolved = prompt::resolve(&prompt::inputs(&stored.prompt), &body.inputs)
        .map_err(|message| TaskError::new(message, 422))?;
    let rendered = prompt::render(&stored.prompt, &resolved);
    let run_id = random_hex_id("moverun")?;
    let task_key = |suffix: &str| format!("move:{move_id}:{}:{suffix}", body.idempotency_key);
    let outcomes = match stored.runner {
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
                create_task(state, &stored.company_id, user_id, fields, outcome).await;
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
            create_task(state, &stored.company_id, user_id, fields, &mut outcome).await;
            vec![outcome]
        }
    };
    state.with_database(|database| {
        if let Some(run) = existing_run(database, move_id, &body.idempotency_key)? {
            return Ok((false, run));
        }
        database.connection().execute(
            "INSERT INTO suplex_move_runs (id, move_id, company_id, project_id, move_name, runner, prompt, inputs_json, excluded_pull_requests_json, outcomes_json, started_by_user_id, started_at, idempotency_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                run_id, move_id, stored.company_id, stored.project_id, stored.name, stored.runner,
                rendered, serde_json::to_string(&resolved)?, serde_json::to_string(&body.excluded_pull_requests)?,
                serde_json::to_string(&outcomes)?, user_id, now_millis_rfc3339(), body.idempotency_key,
            ],
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
