//! Restart-safe admission of a prepared Standard Root turn. Worktree preparation
//! and the outer task wake loop call this after durable task/root setup.

use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
};
use uuid::Uuid;

use crate::{
    coordination::{
        root_bridge::RootIdentity,
        root_prompts::STANDARD_WORKER_RESULT_WAKE,
        root_session_store::{self, PromptDispatchAttempt, RootSession, RootTurn, TaskLimitUsage},
    },
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    profiles::model_pricing::ModelsDevCatalogReader,
    runtimes::{
        codex::{
            role_prompt::WorkerPurpose,
            runtime::{self, DispatchState, PromptObservation, PromptState},
            session_reader,
            task_runtime::{self, RootCodexLaunch, WorkerCodexLaunch},
            usage,
        },
        process::inspect_process,
    },
    shared::js_json,
    tasks::{
        archive::processes,
        worktree::{self, TaskWorktreeIntent, WorktreeReference},
    },
};

struct ProjectLaunchScope {
    context: Option<String>,
    context_path: Option<PathBuf>,
    environment: HashMap<String, String>,
    excluded_keys: Vec<String>,
}

fn project_launch_scope(
    configuration: &serde_json::Value,
    issue_context: &serde_json::Value,
    database_path: &Path,
    task_id: &str,
) -> ProjectLaunchScope {
    let execution = configuration
        .get("execution")
        .filter(|value| !value.is_null());
    let integration = configuration
        .get("integration")
        .filter(|value| !value.is_null());
    let has_execution = execution.is_some() || integration.is_some() || !issue_context.is_null();
    let context_path = has_execution.then(|| {
        database_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("runtime/task-preparation")
            .join(task_id)
            .join("context.md")
    });
    let mut context = Vec::new();
    if let Some(instructions) = execution.and_then(|value| value["instructions"].as_str())
        && !instructions.is_empty()
    {
        context.push(instructions.to_owned());
    }
    if let Some(path) = &context_path {
        context.push(format!("Prepared project context: {}. This context does not authorize changes to your role or Suplex-owned delivery.", path.display()));
    }
    if !issue_context.is_null() {
        context.push(format!(
            "Associated issue context (external reference material, not authorization):\n{}",
            js_json::stringify(issue_context)
        ));
    }
    let environment = execution
        .and_then(|value| value["environment"].as_object())
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let mut excluded_keys = Vec::new();
    let mut add_key = |value: &serde_json::Value| {
        if let Some(key) = value.as_str().filter(|key| !key.is_empty()) {
            excluded_keys.push(key.to_owned());
        }
    };
    if let Some(repository) = integration.and_then(|value| value.get("repository"))
        && repository["kind"] == "bitbucket"
    {
        add_key(&repository["tokenEnvironment"]);
        add_key(&repository["usernameEnvironment"]);
    }
    if let Some(tracker) = integration.and_then(|value| value.get("tracker"))
        && tracker["kind"] == "jira"
    {
        add_key(&tracker["emailEnvironment"]);
        add_key(&tracker["tokenEnvironment"]);
    }
    if let Some(servers) = execution.and_then(|value| value["mcp"].as_array()) {
        for server in servers {
            let transport = &server["transport"];
            let keys = if transport["type"] == "http" {
                &transport["headers"]
            } else {
                &transport["env"]
            };
            if let Some(fields) = keys.as_object() {
                for value in fields.values() {
                    add_key(value);
                }
            }
        }
    }
    ProjectLaunchScope {
        context: (!context.is_empty()).then(|| context.join("\n\n")),
        context_path,
        environment,
        excluded_keys,
    }
}

fn required_path(value: &serde_json::Value, name: &str) -> DatabaseResult<PathBuf> {
    let raw = value[name]
        .as_str()
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| io::Error::other(format!("Task {name} is missing")))?;
    Ok(PathBuf::from(raw))
}

/// Reobserve the source Git repository and prepare the task worktree. The
/// caller persists the returned worktree only while the task remains active.
pub async fn prepare_task_worktree(
    database_path: &Path,
    task_id: &str,
) -> DatabaseResult<WorktreeReference> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let rows = root_session_store::root_observation_rows(&database, task_id)?;
    let configuration = &rows.context["configuration"];
    let intent = TaskWorktreeIntent {
        task_id: task_id.to_owned(),
        repository_path: required_path(configuration, "repositoryPath")?,
        worktree_root: required_path(configuration, "worktreeRoot")?,
        branch: configuration["branch"]
            .as_str()
            .ok_or_else(|| io::Error::other("Task branch is missing"))?
            .to_owned(),
        starting_sha: configuration["startingSha"]
            .as_str()
            .ok_or_else(|| io::Error::other("Task starting SHA is missing"))?
            .to_owned(),
    };
    tokio::task::spawn_blocking(move || {
        worktree::prepare_local_task_worktree(&intent).map_err(|error| error.to_string())
    })
    .await?
    .map_err(|error| io::Error::other(error).into())
}

fn current_owner_still_running(session: &RootSession) -> bool {
    let Some(pid) = session
        .launch_owner_pid
        .and_then(|pid| u32::try_from(pid).ok())
    else {
        return false;
    };
    inspect_process(pid).is_some_and(|observed| {
        session.launch_owner_start_time.as_deref() == Some(observed.start_time.as_str())
    })
}

fn dispatch_state(turn: &RootTurn) -> DispatchState {
    if turn.status == "pending_prompt" && turn.dispatch_attempt.is_none() {
        DispatchState::NotSubmitted
    } else {
        DispatchState::Ambiguous
    }
}

fn observe_or_recover_fenced(
    database: &mut SuplexDatabase,
    database_path: &Path,
    session: &RootSession,
    native_id: &str,
    turn: &RootTurn,
    owner: &str,
) -> DatabaseResult<(PromptObservation, bool)> {
    let observed = observe_turn(database_path, session, native_id, turn)?;
    if turn.status == "pending_prompt" && turn.dispatch_attempt.is_none() {
        let replayable = observed.retry_allowed;
        return Ok((observed, replayable));
    }
    let Some(attempt) = turn.dispatch_attempt.as_ref() else {
        return Ok((observed, false));
    };
    if turn.status != "unknown" || observed.admission_observed {
        return Ok((observed, false));
    }
    let claimed_at = DateTime::parse_from_rfc3339(&attempt.claimed_at)?;
    if Utc::now()
        .signed_duration_since(claimed_at)
        .num_milliseconds()
        < 30_000
    {
        return Ok((observed, false));
    }
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let record_path = directory.join(format!("dispatch-{}.json", attempt.server_generation));
    if let Some(record) = crate::runtimes::headless::read_record(&record_path)? {
        crate::runtimes::headless::stop_owned(&record)?;
    }
    crate::runtimes::headless::stop_execution(&directory, &attempt.server_generation)?;
    let recovered = runtime::observe(
        &directory,
        native_id,
        &turn.id,
        DispatchState::NotSubmitted,
        Some(&attempt.server_generation),
    )?;
    if recovered.retry_allowed {
        root_session_store::requeue_fenced_prompt(database, turn, attempt, owner, Utc::now())?;
    }
    // A requeued turn is admitted on the next host sweep, after native usage
    // has been observed again. This call's usage was computed before recovery.
    Ok((recovered, false))
}

fn observe_turn(
    database_path: &Path,
    session: &RootSession,
    native_id: &str,
    turn: &RootTurn,
) -> DatabaseResult<PromptObservation> {
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let attempt = turn
        .dispatch_attempt
        .as_ref()
        .map(|attempt: &PromptDispatchAttempt| attempt.server_generation.as_str());
    Ok(runtime::observe(
        &directory,
        native_id,
        &turn.id,
        dispatch_state(turn),
        attempt,
    )?)
}

fn persist_native_admission(
    database: &mut SuplexDatabase,
    turn: &RootTurn,
    observation: &PromptObservation,
) -> DatabaseResult<()> {
    if !observation.admission_observed {
        return Ok(());
    }
    root_session_store::mark_prompted(database, turn, None, Utc::now())?;
    Ok(())
}

fn terminal(state: PromptState) -> bool {
    matches!(
        state,
        PromptState::Completed | PromptState::Error | PromptState::Interrupted
    )
}

fn terminal_state(state: PromptState) -> &'static str {
    match state {
        PromptState::Completed => "completed",
        PromptState::Error => "error",
        PromptState::Interrupted => "interrupted",
        PromptState::Running => "running",
        PromptState::Unknown => "unknown",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalObservation<'a> {
    state: &'static str,
    native: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interrupted_execution: Option<InterruptedExecution>,
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InterruptedExecution {
    stopped_server_generation: String,
}

fn stopped_generation(directory: &Path, turn: &RootTurn) -> DatabaseResult<String> {
    let record_path = turn.dispatch_attempt.as_ref().map_or_else(
        || directory.join("turn.json"),
        |attempt| directory.join(format!("dispatch-{}.json", attempt.server_generation)),
    );
    let record = crate::runtimes::headless::read_record(&record_path)?
        .ok_or_else(|| io::Error::other("Interrupted native dispatch record is missing"))?;
    if record.turn_id != turn.id {
        return Err(io::Error::other("Interrupted native dispatch record changed").into());
    }
    Ok(record.generation)
}

fn terminal_observation<'a>(
    observation: &PromptObservation,
    native: serde_json::Value,
    text: &'a str,
    directory: &Path,
    turn: &RootTurn,
) -> DatabaseResult<TerminalObservation<'a>> {
    let interrupted_execution = (observation.state == PromptState::Interrupted)
        .then(|| stopped_generation(directory, turn))
        .transpose()?
        .map(|stopped_server_generation| InterruptedExecution {
            stopped_server_generation,
        });
    Ok(TerminalObservation {
        state: terminal_state(observation.state),
        native,
        reason: (observation.state != PromptState::Completed).then_some(observation.reason),
        interrupted_execution,
        text,
    })
}

fn complete_root_if_terminal(
    database: &mut SuplexDatabase,
    database_path: &Path,
    session: &RootSession,
    turn: &RootTurn,
    observation: &PromptObservation,
) -> DatabaseResult<bool> {
    if !terminal(observation.state) || !observation.admission_observed {
        return Ok(false);
    }
    let rows = root_session_store::root_observation_rows(database, &session.task_id)?;
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let text = runtime::result_text(&directory, &turn.id)?;
    let native = serde_json::json!({
        "messageID":turn.id,"parentID":turn.id,"providerID":"codex",
        "modelID":rows.control["rootProfile"]["model"],"mode":"suplex-root",
        "agent":"suplex-root","cwd":rows.control["worktree"]["path"],
        "root":rows.control["worktree"]["path"],
    });
    let terminal_observation = terminal_observation(observation, native, &text, &directory, turn)?;
    let continuation = (observation.state == PromptState::Interrupted).then_some("The previous execution stopped before a final response. Its admitted message will not be replayed. Observe current task, worktree and GitHub state, preserve any partial work, and continue from that evidence.");
    let completed = root_session_store::complete_root_turn(
        database,
        &turn.id,
        &serde_json::to_string(&terminal_observation)?,
        continuation,
        Utc::now(),
    )?;
    if completed && observation.state == PromptState::Error {
        let reason = if observation.reason.is_empty() {
            text.as_str()
        } else {
            observation.reason
        };
        let question = format!(
            "The agent stopped the Coordinator turn (error). {reason} Can you resolve the failure and continue?"
        );
        root_session_store::ask_human_for_root(
            database,
            &session.task_id,
            &session.id,
            session.generation,
            &question,
            &serde_json::json!([]),
            Utc::now(),
        )?;
    }
    Ok(completed)
}

fn worker_result_wake(
    receipt: &str,
    turn: &RootTurn,
    observation: &PromptObservation,
    text: &str,
    purpose: WorkerPurpose,
) -> String {
    let mut units = 0;
    let summary = text
        .trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= 1_200
        })
        .collect::<String>();
    let summary = if summary.is_empty() {
        "(no Worker summary)"
    } else {
        &summary
    };
    let range = if purpose == WorkerPurpose::Verification {
        " No check-only range shortcut was recorded. This alone does not invalidate implementation or historical command evidence; inspect native command and Git evidence before deciding whether a check is missing."
    } else {
        ""
    };
    format!(
        "Worker result {receipt}. {STANDARD_WORKER_RESULT_WAKE}{range} Worker reported ({}): {summary}\nCall suplex_root read_worker_evidence with turnId {} for the compact tool index. Then select the exact toolId, field, and position tail to read its final evidence. Use position head and the returned field cursor only when you need earlier content. Do not rerun commands only to obtain logs.",
        terminal_state(observation.state),
        turn.id
    )
}

fn complete_worker_if_terminal(
    database: &mut SuplexDatabase,
    database_path: &Path,
    session: &RootSession,
    native_id: &str,
    turn: &RootTurn,
    observation: &PromptObservation,
    purpose: WorkerPurpose,
) -> DatabaseResult<bool> {
    if !terminal(observation.state) || !observation.admission_observed {
        return Ok(false);
    }
    let rows = root_session_store::root_observation_rows(database, &session.task_id)?;
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let text = runtime::result_text(&directory, &turn.id)?;
    let native = serde_json::json!({
        "messageID":turn.id,"parentID":turn.id,"providerID":"codex",
        "modelID":rows.control["workerProfile"]["model"],"mode":"suplex-worker",
        "agent":"suplex-worker","cwd":rows.control["worktree"]["path"],
        "root":rows.control["worktree"]["path"],
    });
    let terminal_observation = terminal_observation(observation, native, &text, &directory, turn)?;
    let receipt = format!(
        "{native_id}:{}:{}",
        turn.id,
        terminal_state(observation.state)
    );
    let prompt = worker_result_wake(&receipt, turn, observation, &text, purpose);
    let result = root_session_store::StandardWorkerResult {
        task_id: &session.task_id,
        session_id: &session.id,
        generation: session.generation,
        receipt_id: &receipt,
        observation: &serde_json::to_string(&terminal_observation)?,
        native_turn_id: (observation.state == PromptState::Completed).then_some(turn.id.as_str()),
        wake_prompt: &prompt,
    };
    Ok(
        root_session_store::record_standard_worker_result_and_wake(database, &result, Utc::now())?
            .is_some(),
    )
}

async fn observed_usage(database_path: &Path, task_id: &str) -> DatabaseResult<TaskLimitUsage> {
    let (sessions, budget, max_turns, admitted_turns) = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        let (budget_override, turns_override): (Option<f64>, Option<i64>) =
            database.connection().query_row(
                "SELECT budget_usd,max_turns FROM suplex_task_controls WHERE task_id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        let (default_budget, default_turns): (f64, i64) = database.connection().query_row(
            "SELECT default_budget_usd,default_max_turns FROM suplex_environment_settings WHERE id = 'host'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap_or((15.0, 40));
        let admitted_turns: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompted_at IS NOT NULL",
            [task_id],
            |row| row.get(0),
        )?;
        let mut statement = database.connection().prepare(
            "SELECT DISTINCT s.id,s.native_session_id,s.kind FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id WHERE s.task_id = ?1 AND s.native_session_id IS NOT NULL AND (t.prompted_at IS NOT NULL OR t.status = 'unknown') ORDER BY s.created_at,s.id",
        )?;
        let sessions = statement
            .query_map([task_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (
            sessions,
            budget_override.unwrap_or(default_budget),
            turns_override.unwrap_or(default_turns),
            admitted_turns,
        )
    };
    if (max_turns > 0 && admitted_turns >= max_turns) || budget == 0.0 {
        return Ok(TaskLimitUsage {
            estimated_cost_usd: None,
        });
    }
    if sessions.is_empty() {
        return Ok(TaskLimitUsage {
            estimated_cost_usd: Some(0.0),
        });
    }
    let native_database_path = database_path.to_path_buf();
    let observed = tokio::task::spawn_blocking(
        move || -> Result<Vec<(String, String, String, usage::CodexUsageObservation)>, String> {
            let mut observed = Vec::new();
            for (session_id, native_id, role) in sessions {
                let directory =
                    session_reader::session_directory(&native_database_path, &session_id)
                        .map_err(|error| error.to_string())?;
                let snapshot = usage::observe_session(&directory, &native_id, None)
                    .map_err(|error| error.to_string())?;
                observed.push((session_id, native_id, role, snapshot));
            }
            Ok(observed)
        },
    )
    .await?
    .map_err(io::Error::other)?;
    if observed
        .iter()
        .any(|(_, _, _, session)| session.turns.is_empty())
    {
        return Err(
            io::Error::other("Codex turn usage is not available; observation will retry").into(),
        );
    }
    static PRICING: OnceLock<Result<ModelsDevCatalogReader, String>> = OnceLock::new();
    let unpriced = observed.iter().any(|(_, _, _, session)| {
        session.turns.iter().any(|turn| {
            !turn.priced
                && turn.tokens.input
                    + turn.tokens.output
                    + turn.tokens.reasoning
                    + turn.tokens.cache_read
                    + turn.tokens.cache_write
                    > 0.0
        })
    });
    let pricing = if unpriced {
        let reader = PRICING
            .get_or_init(|| ModelsDevCatalogReader::new().map_err(|error| error.to_string()));
        match reader {
            Ok(reader) => reader.read().await,
            Err(_) => None,
        }
    } else {
        None
    };
    let cost = replace_observed_usage(database_path, task_id, observed, pricing.as_deref())?;
    Ok(TaskLimitUsage {
        estimated_cost_usd: Some(cost),
    })
}

fn replace_observed_usage(
    database_path: &Path,
    task_id: &str,
    observed: Vec<(String, String, String, usage::CodexUsageObservation)>,
    pricing: Option<&crate::profiles::model_pricing::ModelPricingCatalog>,
) -> DatabaseResult<f64> {
    if observed
        .iter()
        .any(|(_, _, _, session)| session.turns.is_empty())
    {
        return Err(
            io::Error::other("Codex turn usage is not available; observation will retry").into(),
        );
    }
    let mut snapshots = Vec::new();
    let mut cost = 0.0;
    for (_, native_id, role, session) in observed {
        let live_turn_id = session.live_turn_id.clone();
        for turn in session.turns {
            let listed = pricing.and_then(|catalog| catalog.get(&format!("openai/{}", turn.model)));
            let turn_cost = listed.map_or(turn.cost_usd, |price| price.estimate(turn.tokens));
            cost += turn_cost;
            snapshots.push((native_id.clone(), serde_json::json!({
                "sessionId":native_id,"messageId":turn.turn_id,"turnId":turn.turn_id,
                "role":role,"provider":"openai","model":turn.model,
                "startedAt":turn.updated_at_ms,
                "completedAt":(live_turn_id.as_deref() != Some(turn.turn_id.as_str())).then_some(turn.updated_at_ms),
                "failed":turn.failed,"summary":false,"steps":1,"cost":turn_cost,
                "subsidized":turn_cost > 0.0,
                "tokens":{"input":turn.tokens.input,"output":turn.tokens.output,
                    "reasoning":turn.tokens.reasoning,"cache":{"read":turn.tokens.cache_read,
                        "write":turn.tokens.cache_write}},"source":"message",
            })));
        }
    }
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    database.transaction(false, |database| {
        for (session_id, _) in &snapshots {
            let belongs: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions WHERE task_id = ?1 AND native_session_id = ?2)",
                rusqlite::params![task_id, session_id], |row| row.get(0),
            )?;
            if !belongs { return Err(io::Error::other("Native usage does not match a task session").into()); }
        }
        database.connection().execute("DELETE FROM suplex_task_usage WHERE task_id = ?1", [task_id])?;
        let time = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        for (session_id, snapshot) in &snapshots {
            database.connection().execute(
                "INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?1,?2,?3,?4,?5)",
                rusqlite::params![task_id, session_id, snapshot["messageId"].as_str(), snapshot.to_string(), time],
            )?;
        }
        Ok(())
    })?;
    Ok(cost)
}

fn needs_admission_usage(database_path: &Path, task_id: &str, kind: &str) -> DatabaseResult<bool> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    Ok(database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ?1 AND s.kind = ?2 AND s.is_current = 1 AND t.status = 'pending_prompt' AND t.dispatch_attempt_json IS NULL)",
        rusqlite::params![task_id, kind], |row| row.get(0),
    )?)
}

fn recover_prepared_root_blocking(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    codex_executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
    usage: TaskLimitUsage,
) -> DatabaseResult<Option<PromptObservation>> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let Some(session) = root_session_store::current_root(&database, task_id)? else {
        return Ok(None);
    };
    root_session_store::assert_current_root(&database, task_id, &session.id, session.generation)?;
    let Some(turn) = root_session_store::pending_turns(&database, &session.id)?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    if current_owner_still_running(&session) {
        return Ok(None);
    }
    let Some(self_identity) = inspect_process(std::process::id()) else {
        return Ok(None);
    };
    let owner = Uuid::new_v4().to_string();
    if !root_session_store::claim_session_operation(
        &mut database,
        &session,
        &owner,
        i64::from(self_identity.pid),
        &self_identity.start_time,
        Utc::now(),
    )? {
        return Ok(None);
    }
    let result = (|| -> DatabaseResult<PromptObservation> {
        let native_id = session
            .native_session_id
            .clone()
            .unwrap_or_else(|| format!("codex-{}", Uuid::new_v4()));
        if !root_session_store::bind_native_session(
            &mut database,
            &session,
            &native_id,
            Utc::now(),
        )? {
            return Err(io::Error::other("Native Root session changed before dispatch").into());
        }
        let (before, replayable) = observe_or_recover_fenced(
            &mut database,
            database_path,
            &session,
            &native_id,
            &turn,
            &owner,
        )?;
        if !before.retry_allowed || !replayable {
            persist_native_admission(&mut database, &turn, &before)?;
            complete_root_if_terminal(&mut database, database_path, &session, &turn, &before)?;
            return Ok(before);
        }
        let rows = root_session_store::root_observation_rows(&database, task_id)?;
        let worktree = rows.control["worktree"]["path"]
            .as_str()
            .ok_or_else(|| io::Error::other("Task worktree is not prepared"))?;
        if rows.control["rootProfile"]["provider"] != "codex" {
            return Err(
                io::Error::other("Only Codex Standard Root execution is implemented").into(),
            );
        }
        let model = rows.control["rootProfile"]["model"]
            .as_str()
            .ok_or_else(|| io::Error::other("Root model is missing"))?;
        let reasoning = rows.control["rootProfile"]["reasoningLevel"]
            .as_str()
            .ok_or_else(|| io::Error::other("Root reasoning level is missing"))?;
        let project_scope = project_launch_scope(
            &rows.context["configuration"],
            &rows.context["issueContext"],
            database_path,
            task_id,
        );
        let identity = RootIdentity {
            task_id: task_id.to_owned(),
            session_id: session.id.clone(),
            generation: session.generation,
        };
        let launch = RootCodexLaunch {
            database_path,
            artifact_root,
            identity: &identity,
            native_session_id: &native_id,
            turn_id: &turn.id,
            worktree: Path::new(worktree),
            prompt: &turn.prompt_text,
            project_context: project_scope.context.as_deref(),
            project_context_path: project_scope.context_path.as_deref(),
            project_environment: &project_scope.environment,
            excluded_environment_keys: &project_scope.excluded_keys,
            model,
            reasoning_effort: reasoning,
            codex_executable,
            inherited_environment,
        };
        let observation = task_runtime::dispatch_codex_root(launch, |server_generation| {
            root_session_store::claim_prompt(
                &mut database,
                &turn,
                &owner,
                server_generation,
                usage,
                Utc::now(),
            )
        })?;
        persist_native_admission(&mut database, &turn, &observation)?;
        complete_root_if_terminal(&mut database, database_path, &session, &turn, &observation)?;
        Ok(observation)
    })();
    root_session_store::release_session_operation(&mut database, &session.id, &owner, Utc::now())?;
    result.map(Some)
}

/// Observe native evidence first, then dispatch only a turn whose absence is
/// proven. A claimed ambiguous turn is never replayed after restart.
pub async fn recover_prepared_root(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    codex_executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<Option<PromptObservation>> {
    let usage = if needs_admission_usage(database_path, task_id, "root")? {
        observed_usage(database_path, task_id).await?
    } else {
        TaskLimitUsage {
            estimated_cost_usd: None,
        }
    };
    let database_path = database_path.to_path_buf();
    let artifact_root = artifact_root.to_path_buf();
    let task_id = task_id.to_owned();
    let codex_executable: Option<PathBuf> = codex_executable.map(Path::to_path_buf);
    let inherited_environment = inherited_environment.clone();
    tokio::task::spawn_blocking(move || {
        recover_prepared_root_blocking(
            &database_path,
            &artifact_root,
            &task_id,
            codex_executable.as_deref(),
            &inherited_environment,
            usage,
        )
        .map_err(|error| error.to_string())
    })
    .await?
    .map_err(|error| io::Error::other(error).into())
}

fn recover_prepared_worker_blocking(
    database_path: &Path,
    task_id: &str,
    codex_executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
    usage: TaskLimitUsage,
) -> DatabaseResult<Option<PromptObservation>> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let Some(session) = root_session_store::current_worker(&database, task_id)? else {
        return Ok(None);
    };
    let Some(turn) = root_session_store::pending_turns(&database, &session.id)?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    if current_owner_still_running(&session) {
        return Ok(None);
    }
    let Some(self_identity) = inspect_process(std::process::id()) else {
        return Ok(None);
    };
    let owner = Uuid::new_v4().to_string();
    if !root_session_store::claim_session_operation(
        &mut database,
        &session,
        &owner,
        i64::from(self_identity.pid),
        &self_identity.start_time,
        Utc::now(),
    )? {
        return Ok(None);
    }
    let result = (|| -> DatabaseResult<PromptObservation> {
        let native_id = session
            .native_session_id
            .clone()
            .unwrap_or_else(|| format!("codex-{}", Uuid::new_v4()));
        if !root_session_store::bind_native_session(
            &mut database,
            &session,
            &native_id,
            Utc::now(),
        )? {
            return Err(io::Error::other("Native Worker session changed before dispatch").into());
        }
        let rows = root_session_store::root_observation_rows(&database, task_id)?;
        let worker = rows
            .worker
            .as_ref()
            .ok_or_else(|| io::Error::other("Current Worker is missing"))?;
        let purpose = if worker["workflowInput"]["purpose"] == "verification" {
            WorkerPurpose::Verification
        } else {
            WorkerPurpose::Implementation
        };
        let (before, replayable) = observe_or_recover_fenced(
            &mut database,
            database_path,
            &session,
            &native_id,
            &turn,
            &owner,
        )?;
        if !before.retry_allowed || !replayable {
            persist_native_admission(&mut database, &turn, &before)?;
            complete_worker_if_terminal(
                &mut database,
                database_path,
                &session,
                &native_id,
                &turn,
                &before,
                purpose,
            )?;
            return Ok(before);
        }
        let worktree = rows.control["worktree"]["path"]
            .as_str()
            .ok_or_else(|| io::Error::other("Task worktree is not prepared"))?;
        let profile = &rows.control["workerProfile"];
        if profile["provider"] != "codex" {
            return Err(
                io::Error::other("Only Codex Standard Worker execution is implemented").into(),
            );
        }
        let model = profile["model"]
            .as_str()
            .ok_or_else(|| io::Error::other("Worker model is missing"))?;
        let reasoning = profile["reasoningLevel"]
            .as_str()
            .ok_or_else(|| io::Error::other("Worker reasoning level is missing"))?;
        let project_scope = project_launch_scope(
            &rows.context["configuration"],
            &rows.context["issueContext"],
            database_path,
            task_id,
        );
        let launch = WorkerCodexLaunch {
            database_path,
            session_id: &session.id,
            native_session_id: &native_id,
            turn_id: &turn.id,
            worktree: Path::new(worktree),
            prompt: &turn.prompt_text,
            project_context: project_scope.context.as_deref(),
            project_context_path: project_scope.context_path.as_deref(),
            project_environment: &project_scope.environment,
            excluded_environment_keys: &project_scope.excluded_keys,
            purpose,
            model,
            reasoning_effort: reasoning,
            codex_executable,
            inherited_environment,
        };
        let observation = task_runtime::dispatch_codex_worker(launch, |server_generation| {
            root_session_store::claim_prompt(
                &mut database,
                &turn,
                &owner,
                server_generation,
                usage,
                Utc::now(),
            )
        })?;
        persist_native_admission(&mut database, &turn, &observation)?;
        complete_worker_if_terminal(
            &mut database,
            database_path,
            &session,
            &native_id,
            &turn,
            &observation,
            purpose,
        )?;
        Ok(observation)
    })();
    root_session_store::release_session_operation(&mut database, &session.id, &owner, Utc::now())?;
    result.map(Some)
}

pub async fn recover_prepared_worker(
    database_path: &Path,
    task_id: &str,
    codex_executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<Option<PromptObservation>> {
    let usage = if needs_admission_usage(database_path, task_id, "worker")? {
        observed_usage(database_path, task_id).await?
    } else {
        TaskLimitUsage {
            estimated_cost_usd: None,
        }
    };
    let database_path = database_path.to_path_buf();
    let task_id = task_id.to_owned();
    let codex_executable = codex_executable.map(Path::to_path_buf);
    let inherited_environment = inherited_environment.clone();
    tokio::task::spawn_blocking(move || {
        recover_prepared_worker_blocking(
            &database_path,
            &task_id,
            codex_executable.as_deref(),
            &inherited_environment,
            usage,
        )
        .map_err(|error| error.to_string())
    })
    .await?
    .map_err(|error| io::Error::other(error).into())
}

#[derive(Clone)]
pub struct TaskHostHandle {
    wake_tx: mpsc::UnboundedSender<String>,
    shutdown_tx: watch::Sender<bool>,
    finished_rx: watch::Receiver<bool>,
}

impl TaskHostHandle {
    pub fn wake(&self, task_id: String) {
        let _ = self.wake_tx.send(task_id);
    }

    pub async fn stop(&self) {
        let _ = self.shutdown_tx.send(true);
        let mut finished = self.finished_rx.clone();
        while !*finished.borrow() && finished.changed().await.is_ok() {}
    }
}

/// Resume every active task from durable intent. The periodic scan covers
/// starts committed before this process booted and notifications lost on crash.
pub fn spawn_task_host(database_path: PathBuf, artifact_root: PathBuf) -> TaskHostHandle {
    let (wake_tx, mut wake_rx) = mpsc::unbounded_channel::<String>();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let (finished_tx, finished_rx) = watch::channel(false);
    let handle = TaskHostHandle {
        wake_tx,
        shutdown_tx,
        finished_rx,
    };
    tokio::spawn(async move {
        let environment = std::env::vars().collect::<HashMap<_, _>>();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        let mut running = HashSet::new();
        let mut operations = JoinSet::<(String, Result<(), String>)>::new();
        loop {
            let candidates = tokio::select! {
                result = shutdown_rx.changed() => {
                    if result.is_err() || *shutdown_rx.borrow() { break; }
                    Vec::new()
                },
                Some(task_id) = wake_rx.recv() => vec![task_id],
                _ = interval.tick() => match due_task_ids(&database_path) {
                    Ok(ids) => ids,
                    Err(error) => { eprintln!("Task scheduling will retry: {error}"); Vec::new() },
                },
                finished = operations.join_next(), if !operations.is_empty() => {
                    if let Some(Ok((task_id, result))) = finished {
                        running.remove(&task_id);
                        if let Err(error) = result { eprintln!("Task {task_id} recovery will retry: {error}"); }
                    }
                    Vec::new()
                },
            };
            for task_id in candidates {
                if running.len() >= 4 {
                    break;
                }
                if !running.insert(task_id.clone()) {
                    continue;
                }
                let database_path = database_path.clone();
                let artifact_root = artifact_root.clone();
                let environment = environment.clone();
                operations.spawn(async move {
                    let result =
                        sweep_task(&database_path, &artifact_root, &task_id, None, &environment)
                            .await
                            .map_err(|error| error.to_string());
                    (task_id, result)
                });
            }
        }
        while let Some(finished) = operations.join_next().await {
            if let Ok((task_id, Err(error))) = finished {
                eprintln!("Task {task_id} recovery will retry after restart: {error}");
            }
        }
        let _ = finished_tx.send(true);
    });
    handle
}

fn due_task_ids(database_path: &Path) -> DatabaseResult<Vec<String>> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let mut statement = database.connection().prepare(
        "SELECT c.task_id FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE (t.archived_at IS NULL AND c.status IN ('active','waiting_human') AND (c.wake_at IS NULL OR c.wake_at <= ?1)) OR (c.status = 'delivered' AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = c.task_id AND s.stopped_at IS NULL)) OR EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = c.task_id AND s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL) ORDER BY COALESCE(c.wake_at,c.created_at)",
    )?;
    Ok(statement
        .query_map(
            [Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub async fn sweep_active_tasks(
    database_path: &Path,
    artifact_root: &Path,
    codex_executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<()> {
    let task_ids = due_task_ids(database_path)?;
    for task_id in task_ids {
        if let Err(error) = sweep_task(
            database_path,
            artifact_root,
            &task_id,
            codex_executable,
            inherited_environment,
        )
        .await
        {
            eprintln!("Task {task_id} observation will retry: {error}");
        }
    }
    Ok(())
}

async fn stop_retired_sessions(database_path: &Path, task_id: &str) -> DatabaseResult<()> {
    let sessions = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        let mut statement = database.connection().prepare(
            "SELECT id,native_session_id,launch_owner_pid,launch_owner_start_time FROM suplex_task_sessions WHERE task_id = ?1 AND stop_requested_at IS NOT NULL AND stopped_at IS NULL",
        )?;
        statement
            .query_map([task_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let outstanding_count = sessions.len();
    let mut stopped = Vec::new();
    let mut failures = Vec::new();
    for (session_id, native_id, owner_pid, owner_start) in sessions {
        if let Some(pid) = owner_pid.and_then(|pid| u32::try_from(pid).ok())
            && owner_start.as_deref().is_some_and(|start| {
                inspect_process(pid).is_some_and(|observed| start == observed.start_time)
            })
        {
            continue;
        }
        let directory = session_reader::session_directory(database_path, &session_id)?;
        match tokio::task::spawn_blocking(move || {
            crate::runtimes::headless::stop_session(&directory, native_id.as_deref())
        })
        .await?
        {
            Ok(()) => stopped.push(session_id),
            Err(error) => failures.push(error.to_string()),
        }
    }
    let (status, worktree): (String, Option<String>) = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        database.connection().query_row(
            "SELECT status,json_extract(worktree_json,'$.path') FROM suplex_task_controls WHERE task_id = ?1",
            [task_id], |row| Ok((row.get(0)?,row.get(1)?)),
        )?
    };
    if failures.is_empty()
        && status == "cancelled"
        && !stopped.is_empty()
        && outstanding_count == stopped.len()
        && let Some(path) = worktree
    {
        tokio::task::spawn_blocking(move || processes::stop_worktree_processes(Path::new(&path)))
            .await??;
    }
    for session_id in stopped {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        let time = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        database.connection().execute(
            "UPDATE suplex_task_sessions SET stopped_at = ?1, launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, updated_at = ?1 WHERE id = ?2 AND stop_requested_at IS NOT NULL AND stopped_at IS NULL",
            rusqlite::params![time, session_id],
        )?;
    }
    if !failures.is_empty() && ["cancelled", "delivered"].contains(&status.as_str()) {
        return Err(io::Error::other(format!(
            "Some agent sessions could not be stopped: {}",
            failures.join("; ")
        ))
        .into());
    }
    Ok(())
}

pub async fn sweep_task(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    codex_executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<()> {
    {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        root_session_store::retire_delivered_sessions(&mut database, task_id, Utc::now())?;
    }
    stop_retired_sessions(database_path, task_id).await?;
    let (active, needs_worktree) = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        let rows = root_session_store::root_observation_rows(&database, task_id)?;
        (
            rows.control["status"] == "active",
            rows.control["worktree"].is_null(),
        )
    };
    if !active {
        return Ok(());
    }
    if needs_worktree {
        let prepared = prepare_task_worktree(database_path, task_id).await?;
        let worktree = serde_json::json!({
            "path":prepared.path,"branch":prepared.branch,"baseSha":prepared.base_sha,
            "headSha":prepared.head_sha,"dirty":prepared.dirty,
        });
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        root_session_store::set_worktree(&mut database, task_id, &worktree, Utc::now())?;
    }
    crate::coordination::root_controller::prepare_root(database_path, task_id)?;
    recover_prepared_worker(
        database_path,
        task_id,
        codex_executable,
        inherited_environment,
    )
    .await?;
    recover_prepared_root(
        database_path,
        artifact_root,
        task_id,
        codex_executable,
        inherited_environment,
    )
    .await?;
    {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        let rows = root_session_store::root_observation_rows(&database, task_id)?;
        let prompt = idle_root_prompt(&rows.dependencies);
        root_session_store::wake_idle_root(&mut database, task_id, &prompt, Utc::now())?;
    }
    let database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let now = Utc::now();
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = ?1,updated_at = ?2 WHERE task_id = ?3 AND status IN ('active','waiting_human')",
        rusqlite::params![(now + chrono::Duration::seconds(15)).to_rfc3339_opts(SecondsFormat::Millis, true), now.to_rfc3339_opts(SecondsFormat::Millis, true), task_id],
    )?;
    Ok(())
}

const IDLE_ROOT_PROMPT: &str = "Observe the current task, worktree, and GitHub state and continue toward the delivery target. Adopt out-of-band progress. If checks or another external operation are pending, report what you are waiting for. Ask a specific human question only if a necessary decision or external failure requires it.";

fn idle_root_prompt(dependencies: &[serde_json::Value]) -> String {
    if dependencies.is_empty() {
        return IDLE_ROOT_PROMPT.to_owned();
    }
    let list = dependencies
        .iter()
        .map(|dependency| {
            format!(
                "{} \"{}\" ({})",
                dependency["id"].as_str().unwrap_or_default(),
                dependency["title"].as_str().unwrap_or_default(),
                dependency["status"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{IDLE_ROOT_PROMPT}\n\n[Suplex prerequisite status]\nCurrent prerequisites: {list}. Prerequisites constrain delivery ordering. Suplex resumes native work when all are delivered. Observe actual Git and GitHub state before integration.\n[/Suplex prerequisite status]"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

    use crate::{
        coordination::root_controller,
        delivery::operations,
        identity::auth,
        profiles::model_pricing::ModelPricing,
        runtimes::codex::usage::{CodexTurnUsage, CodexUsageObservation, UsageTokens},
        tasks::{
            commands,
            repository::{self, PreparedTask, TaskCreator},
        },
    };

    #[test]
    fn claimed_or_prompted_turns_are_never_assumed_absent() {
        let mut turn = RootTurn {
            id: "msg_one".into(),
            task_id: "task_one".into(),
            session_id: "session_one".into(),
            generation: 1,
            prompt_text: "Work".into(),
            status: "pending_prompt".into(),
            dispatch_attempt: None,
            native_turn_id: None,
        };
        assert_eq!(dispatch_state(&turn), DispatchState::NotSubmitted);
        turn.dispatch_attempt = Some(PromptDispatchAttempt {
            server_generation: "generation".into(),
            claimed_at: "now".into(),
        });
        assert_eq!(dispatch_state(&turn), DispatchState::Ambiguous);
        turn.status = "unknown".into();
        assert_eq!(dispatch_state(&turn), DispatchState::Ambiguous);
    }

    #[test]
    fn standard_worker_wake_matches_pinned_typescript_bytes() {
        let turn = RootTurn {
            id: "msg-one".into(),
            task_id: "task-one".into(),
            session_id: "worker-one".into(),
            generation: 1,
            prompt_text: String::new(),
            status: "completed".into(),
            dispatch_attempt: None,
            native_turn_id: Some("msg-one".into()),
        };
        let observation = PromptObservation {
            state: PromptState::Completed,
            admission_observed: true,
            retry_allowed: false,
            reason: "native_turn_completed",
            unsettled_tool_ids: Vec::new(),
            native_final_observed: true,
            process_running: false,
        };
        let prompt = worker_result_wake(
            "codex-one:msg-one:completed",
            &turn,
            &observation,
            "  Worker completed the fixture.  ",
            WorkerPurpose::Implementation,
        );
        assert_eq!(
            format!("{:x}", sha2::Sha256::digest(prompt.as_bytes())),
            "0006b216cc05f1c1ec971806987c6347b055fc06ea7e566704453e26feeb2267"
        );
    }

    #[test]
    fn interrupted_terminal_uses_native_record_generation() {
        let directory =
            std::env::temp_dir().join(format!("suplex-native-terminal-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::write(
            directory.join("dispatch-database-attempt.json"),
            serde_json::json!({
                "generation":"native-generation","turnId":"msg-one","sessionID":"codex-one",
                "pid":1,"processIdentity":{"command":"codex","executable":"/bin/codex",
                    "argv":[],"processGroup":1,"startTime":"one","ownerUid":1},
                "dispatchArguments":[],
            })
            .to_string(),
        )
        .unwrap();
        let turn = RootTurn {
            id: "msg-one".into(),
            task_id: "task-one".into(),
            session_id: "session-one".into(),
            generation: 1,
            prompt_text: String::new(),
            status: "prompted".into(),
            dispatch_attempt: Some(PromptDispatchAttempt {
                server_generation: "database-attempt".into(),
                claimed_at: "now".into(),
            }),
            native_turn_id: None,
        };
        let observation = PromptObservation {
            state: PromptState::Interrupted,
            admission_observed: true,
            retry_allowed: false,
            reason: "dispatch_process_stopped",
            unsettled_tool_ids: Vec::new(),
            native_final_observed: false,
            process_running: false,
        };
        let terminal =
            terminal_observation(&observation, serde_json::json!({}), "", &directory, &turn)
                .unwrap();
        assert_eq!(
            serde_json::to_string(&terminal).unwrap(),
            "{\"state\":\"interrupted\",\"native\":{},\"reason\":\"dispatch_process_stopped\",\"interruptedExecution\":{\"stoppedServerGeneration\":\"native-generation\"},\"text\":\"\"}"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn project_scope_keeps_context_and_excludes_credential_references() {
        let configuration = serde_json::json!({
            "integration":{"repository":{"kind":"bitbucket","tokenEnvironment":"BB_TOKEN","usernameEnvironment":"BB_USER"},"tracker":{"kind":"jira","emailEnvironment":"JIRA_EMAIL","tokenEnvironment":"JIRA_TOKEN"}},
            "execution":{"instructions":"Follow project instructions","environment":{"PROJECT_MODE":"strict"},"mcp":[{"transport":{"type":"http","headers":{"Authorization":"MCP_TOKEN"}}}]}
        });
        let scope = project_launch_scope(
            &configuration,
            &serde_json::json!({"key":"ISSUE-1"}),
            Path::new("/tmp/suplex/data/suplex.sqlite"),
            "task_one",
        );
        assert_eq!(scope.environment["PROJECT_MODE"], "strict");
        assert_eq!(
            scope.excluded_keys,
            [
                "BB_TOKEN",
                "BB_USER",
                "JIRA_EMAIL",
                "JIRA_TOKEN",
                "MCP_TOKEN"
            ]
        );
        assert!(
            scope
                .context
                .as_deref()
                .unwrap()
                .contains("Associated issue context")
        );
        assert_eq!(
            scope.context_path.unwrap(),
            Path::new("/tmp/suplex/data/runtime/task-preparation/task_one/context.md")
        );
    }

    #[tokio::test]
    async fn root_dispatch_claim_survives_reopen_without_replaying_child() {
        let base = std::env::temp_dir().join(format!("suplex-root-host-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let database_path = base.join("suplex.sqlite");
        let worktree = base.join("worktree");
        fs::create_dir(&worktree).unwrap();
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head("task-one");
        let repository = git2::Repository::init_opts(&worktree, &options).unwrap();
        fs::write(worktree.join("fixture.txt"), "task fixture\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("fixture.txt")).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Suplex fixture", "fixture@example.invalid").unwrap();
        let head = repository
            .commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap()
            .to_string();
        drop(tree);
        drop(repository);
        let marker = base.join("launches");
        let codex = base.join("codex");
        fs::write(&codex, format!("#!/bin/sh\nprintf x >> '{}'\ncat >/dev/null\nprintf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"host-thread\"}}' '{{\"type\":\"turn.completed\",\"usage\":{{\"input_tokens\":1,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":1,\"reasoning_output_tokens\":0}}}}'\n", marker.display())).unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
        let now = Utc::now();
        let task_id = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
            let user = auth::development_sign_in(&mut database, now).unwrap().user;
            let time = now.to_rfc3339();
            database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('host_company','Host','active',?1)", [&time]).unwrap();
            database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('host_project','host_company','Project',?1,?2,NULL,'main','','','root_profile','worker_profile','{}',?3,?3)", rusqlite::params![worktree.to_string_lossy(), base.to_string_lossy(), time]).unwrap();
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "host_company".into(),
                project_id: "host_project".into(),
                title: "One task".into(),
                description: "Run Codex".into(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-one","baseBranch":"main","baselineSha":"head"}),
                idempotency_key: "host-key".into(),
                request_hash: "host-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::json!({"repository":"owner/repo","headBranch":"task-one","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
                root_profile: serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                worker_profile: serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                advisor_profiles: serde_json::json!({}),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
            };
            let task = repository::create(&mut database, &prepared, now)
                .unwrap()
                .task;
            database.connection().execute("UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2", rusqlite::params![serde_json::json!({"path":worktree,"branch":"task-one","baseSha":head,"headSha":head,"dirty":false}).to_string(), task.id]).unwrap();
            task.id
        };
        root_controller::prepare_root(&database_path, &task_id).unwrap();
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let root = root_session_store::current_root(&database, &task_id)
                .unwrap()
                .unwrap();
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            let attempted = PromptDispatchAttempt {
                server_generation: "crash-before-native-launch".into(),
                claimed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            };
            database.connection().execute(
                "UPDATE suplex_task_turns SET status = 'unknown', dispatch_attempt_json = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&attempted).unwrap(), turn.id],
            ).unwrap();
        }
        let environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let young =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(!young.retry_allowed);
        assert!(!marker.exists());
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let root = root_session_store::current_root(&database, &task_id)
                .unwrap()
                .unwrap();
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            let attempted = PromptDispatchAttempt {
                server_generation: "crash-before-native-launch".into(),
                claimed_at: (Utc::now() - chrono::Duration::seconds(31))
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
            };
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_turns SET dispatch_attempt_json = ?1 WHERE id = ?2",
                    rusqlite::params![serde_json::to_string(&attempted).unwrap(), turn.id],
                )
                .unwrap();
        }
        let fenced =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(fenced.retry_allowed);
        assert!(!fenced.admission_observed);
        assert!(!marker.exists());
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            let root = root_session_store::current_root(&database, &task_id)
                .unwrap()
                .unwrap();
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            assert_eq!(turn.status, "pending_prompt");
            assert!(turn.dispatch_attempt.is_none());
        }
        let first =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(first.admission_observed);
        let second =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(!second.retry_allowed);
        assert!(second.admission_observed);
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let root = root_session_store::current_root(&database, &task_id)
            .unwrap()
            .unwrap();
        assert!(
            root.native_session_id
                .as_deref()
                .unwrap()
                .starts_with("codex-")
        );
        let rows = root_session_store::root_observation_rows(&database, &task_id).unwrap();
        let turn = rows
            .turns
            .iter()
            .find(|turn| turn["sessionId"] == root.id)
            .unwrap();
        assert!(turn["dispatchAttempt"].is_object());
        let directory = session_reader::session_directory(&database_path, &root.id).unwrap();
        let exit =
            crate::runtimes::headless::turn_file(&directory, turn["id"].as_str().unwrap(), "exit");
        for _ in 0..40 {
            if exit.exists() && fs::read(&marker).is_ok_and(|launches| launches == b"x") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(exit.exists());
        assert_eq!(fs::read(&marker).unwrap(), b"x");
        drop(database);
        recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let rows = root_session_store::root_observation_rows(&database, &task_id).unwrap();
        assert_eq!(
            rows.turns
                .iter()
                .find(|row| row["sessionId"] == root.id)
                .unwrap()["status"],
            "completed"
        );
        assert!(
            rows.turns
                .iter()
                .find(|row| row["sessionId"] == root.id)
                .unwrap()["terminalObservation"]
                .as_str()
                .is_some_and(|raw| raw.contains("\"state\":\"completed\""))
        );
        let root_terminal = rows
            .turns
            .iter()
            .find(|row| row["sessionId"] == root.id)
            .unwrap()["terminalObservation"]
            .as_str()
            .unwrap();
        assert!(!root_terminal.contains("\"reason\""));
        assert!(!root_terminal.contains("\"interruptedExecution\""));
        drop(database);
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let native_id = root.native_session_id.as_deref().unwrap();
            database.connection().execute(
                "INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?1,?2,'prior-native','{}',?3)",
                rusqlite::params![task_id, native_id, Utc::now().to_rfc3339()],
            ).unwrap();
            let missing = usage::CodexUsageObservation {
                turns: vec![],
                live_turn_id: None,
                complete: false,
                estimated_cost_usd: 0.0,
            };
            assert!(
                replace_observed_usage(
                    &database_path,
                    &task_id,
                    vec![(
                        root.id.clone(),
                        native_id.to_owned(),
                        "root".into(),
                        missing
                    )],
                    None
                )
                .is_err()
            );
            let retained: i64 = database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_task_usage WHERE task_id = ?1 AND message_id = 'prior-native'",
                [&task_id], |row| row.get(0),
            ).unwrap();
            assert_eq!(retained, 1);
        }
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        root_session_store::launch_standard_worker(
            &mut database,
            &root,
            "Implement the fixture",
            "Worker prompt",
            Some(&serde_json::json!({"kind":"worker","purpose":"implementation"})),
            Utc::now(),
        )
        .unwrap();
        let worker = root_session_store::current_worker(&database, &task_id)
            .unwrap()
            .unwrap();
        let worker_turn = root_session_store::pending_turns(&database, &worker.id)
            .unwrap()
            .remove(0);
        drop(database);
        let launched =
            recover_prepared_worker(&database_path, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(launched.admission_observed);
        let worker_directory =
            session_reader::session_directory(&database_path, &worker.id).unwrap();
        let worker_exit =
            crate::runtimes::headless::turn_file(&worker_directory, &worker_turn.id, "exit");
        for _ in 0..40 {
            if worker_exit.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(worker_exit.exists());
        recover_prepared_worker(&database_path, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let rows = root_session_store::root_observation_rows(&database, &task_id).unwrap();
        assert_eq!(
            rows.turns
                .iter()
                .find(|row| row["id"] == worker_turn.id)
                .unwrap()["status"],
            "completed"
        );
        assert_eq!(
            rows.turns
                .iter()
                .find(|row| row["id"] == worker_turn.id)
                .unwrap()["nativeTurnId"],
            worker_turn.id
        );
        assert!(
            rows.turns
                .iter()
                .find(|row| row["id"] == worker_turn.id)
                .unwrap()["resultReceiptId"]
                .as_str()
                .unwrap()
                .contains(&worker_turn.id)
        );
        assert_eq!(
            root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(fs::read(&marker).unwrap(), b"xx");
        drop(database);
        let pricing = HashMap::from([(
            "openai/gpt-6-sol".into(),
            ModelPricing {
                input: 1.0,
                output: 2.0,
                cache_read: 0.5,
                cache_write: 0.5,
            },
        )]);
        let cost = replace_observed_usage(
            &database_path,
            &task_id,
            vec![(
                root.id.clone(),
                root.native_session_id.clone().unwrap(),
                "root".into(),
                CodexUsageObservation {
                    turns: vec![CodexTurnUsage {
                        turn_id: "msg-usage".into(),
                        model: "gpt-6-sol".into(),
                        updated_at_ms: 1_234_567,
                        failed: false,
                        tokens: UsageTokens {
                            input: 1_000_000.0,
                            output: 0.0,
                            reasoning: 0.0,
                            cache_read: 0.0,
                            cache_write: 0.0,
                        },
                        cost_usd: 0.0,
                        priced: false,
                    }],
                    live_turn_id: None,
                    complete: true,
                    estimated_cost_usd: 0.0,
                },
            )],
            Some(&pricing),
        )
        .unwrap();
        assert_eq!(cost, 1.0);
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let snapshot: String = database.connection().query_row(
            "SELECT snapshot FROM suplex_task_usage WHERE task_id = ?1 AND message_id = 'msg-usage'",
            [&task_id], |row| row.get(0),
        ).unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(
            snapshot["sessionId"],
            root.native_session_id.clone().unwrap()
        );
        assert_eq!(snapshot["role"], "root");
        assert_eq!(snapshot["cost"], 1.0);
        assert_eq!(snapshot["subsidized"], true);
        drop(database);
        fs::write(
            worktree.join("uncommitted.txt"),
            "local work may be dirty\n",
        )
        .unwrap();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        let token = root_session_store::claim_tool_owner(&mut database, &task_id, Utc::now())
            .unwrap()
            .unwrap();
        drop(database);
        let identity = RootIdentity {
            task_id: task_id.clone(),
            session_id: root.id,
            generation: root.generation,
        };
        assert!(
            operations::complete_local_work(&database_path, &identity, &token, Some("wrong-head"))
                .await
                .is_err()
        );
        let delivered =
            operations::complete_local_work(&database_path, &identity, &token, Some(&head))
                .await
                .unwrap();
        assert_eq!(
            delivered,
            serde_json::json!({"kind":"local_work_completed","headSha":head})
        );
        // A lost MCP reply cannot perform a second delivery after the durable
        // status transition; recovery reads the delivered control instead.
        assert!(
            operations::complete_local_work(&database_path, &identity, &token, Some(&head))
                .await
                .is_err()
        );
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let control = root_session_store::root_observation_rows(&database, &task_id)
            .unwrap()
            .control;
        assert_eq!(control["status"], "delivered");
        assert_eq!(control["worktree"]["dirty"], true);
        drop(database);
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET launch_owner_pid = ?1, launch_owner_start_time = NULL WHERE id = ?2",
                rusqlite::params![i64::from(std::process::id()), identity.session_id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET launch_owner_pid = ?1, launch_owner_start_time = 'stale-owner' WHERE id = ?2",
                rusqlite::params![i64::from(std::process::id()), worker.id],
            ).unwrap();
        }
        assert!(due_task_ids(&database_path).unwrap().contains(&task_id));
        sweep_task(&database_path, &base, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        assert!(!due_task_ids(&database_path).unwrap().contains(&task_id));
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            let outstanding: i64 = database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_task_sessions WHERE task_id = ?1 AND stop_requested_at IS NOT NULL AND stopped_at IS NULL",
                [&task_id], |row| row.get(0),
            ).unwrap();
            assert_eq!(outstanding, 0);
        }
        let failing_task = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let user = auth::development_sign_in(&mut database, Utc::now())
                .unwrap()
                .user;
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "host_company".into(),
                project_id: "host_project".into(),
                title: "Failing Root".into(),
                description: "Verify the failure transition".into(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-two","baseBranch":"main","baselineSha":"head"}),
                idempotency_key: "failure-key".into(),
                request_hash: "failure-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::json!({"repository":"owner/repo","headBranch":"task-two","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
                root_profile: serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                worker_profile: serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                advisor_profiles: serde_json::json!({}),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
            };
            repository::create(&mut database, &prepared, Utc::now())
                .unwrap()
                .task
                .id
        };
        let failing_root = root_controller::prepare_root(&database_path, &failing_task).unwrap();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        let failing_turn = root_session_store::pending_turns(&database, &failing_root.id)
            .unwrap()
            .remove(0);
        let failure = PromptObservation {
            state: PromptState::Error,
            admission_observed: true,
            retry_allowed: false,
            reason: "native_startup_failed",
            unsettled_tool_ids: vec![],
            native_final_observed: false,
            process_running: false,
        };
        assert!(
            complete_root_if_terminal(
                &mut database,
                &database_path,
                &failing_root,
                &failing_turn,
                &failure
            )
            .unwrap()
        );
        let failed = root_session_store::root_observation_rows(&database, &failing_task)
            .unwrap()
            .control;
        assert_eq!(failed["status"], "waiting_human");
        assert_eq!(
            failed["humanQuestion"],
            "The agent stopped the Coordinator turn (error). native_startup_failed Can you resolve the failure and continue?"
        );
        drop(database);
        let mut worktree_child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .current_dir(&worktree)
            .spawn()
            .unwrap();
        {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                rusqlite::params![serde_json::json!({"path":worktree,"branch":"task-two","baseSha":head,"headSha":head,"dirty":false}).to_string(), failing_task],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET launch_owner_pid = ?1, launch_owner_start_time = NULL WHERE id = ?2",
                rusqlite::params![i64::from(std::process::id()), failing_root.id],
            ).unwrap();
            let actor = auth::development_sign_in(&mut database, Utc::now())
                .unwrap()
                .user;
            let cancelled = commands::cancel_user_task(
                &mut database,
                &actor.id,
                &failing_task,
                Utc::now(),
                |_| {},
            )
            .unwrap();
            assert_eq!(cancelled.status, "cancelled");
            let pending: i64 = database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status IN ('pending_prompt','prompted','unknown')",
                [&failing_task], |row| row.get(0),
            ).unwrap();
            assert_eq!(pending, 0);
        }
        assert!(
            due_task_ids(&database_path)
                .unwrap()
                .contains(&failing_task)
        );
        sweep_task(
            &database_path,
            &base,
            &failing_task,
            Some(&codex),
            &environment,
        )
        .await
        .unwrap();
        assert!(
            !due_task_ids(&database_path)
                .unwrap()
                .contains(&failing_task)
        );
        assert!(worktree_child.wait().unwrap().code().is_none());
        fs::remove_dir_all(base).unwrap();
    }
}
