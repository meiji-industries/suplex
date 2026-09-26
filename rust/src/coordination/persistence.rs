//! Row decoding and shared task persistence writes.
use crate::{
    coordination::CoordinationError,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::hash::sha256_hex,
    tasks::control::*,
};
use chrono::{DateTime, Utc};
use rusqlite::Row;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::Mutex;
/// Persisted Root inputs. The controller adds live Git and native observations.
pub struct RootObservationRows {
    pub control: TaskControlRow,
    pub context: Value,
    pub dependencies: Vec<DependencyRow>,
    pub root: Option<SessionRow>,
    pub worker: Option<SessionRow>,
    pub workers: Vec<SessionRow>,
    pub sessions: Vec<SessionRow>,
    pub turns: Vec<TurnRow>,
}

impl RootObservationRows {
    /// TypeScript `session.profile ?? control.<role>Profile`: an Advisor
    /// without its own snapshot uses the Coordinator profile.
    pub fn profile_of<'a>(&'a self, session: &'a SessionRow) -> &'a TaskProfile {
        session.profile.as_ref().unwrap_or_else(|| {
            if session.kind == SessionKind::Root {
                &self.control.root_profile
            } else if let Some(role) = session.advisor_role {
                self.control
                    .advisor_profiles
                    .get(&role)
                    .unwrap_or(&self.control.root_profile)
            } else {
                &self.control.worker_profile
            }
        })
    }

    pub fn session(&self, id: &str) -> Option<&SessionRow> {
        self.sessions.iter().find(|session| session.id == id)
    }
}

pub struct TaskArtifact {
    pub kind: String,
    pub filename: String,
    pub mime_type: String,
    pub company_id: String,
    pub storage_path: String,
    pub sha256: String,
}

pub fn task_artifact(
    database: &SuplexDatabase,
    task_id: &str,
    artifact_id: &str,
) -> DatabaseResult<Option<TaskArtifact>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT a.kind, a.filename, a.mime_type, a.company_id, a.storage_path, a.sha256 FROM suplex_artifacts a JOIN suplex_tasks t ON t.id = a.task_id AND t.company_id = a.company_id WHERE t.id = ?1 AND a.id = ?2",
            params![task_id, artifact_id],
            |row| Ok(TaskArtifact {
                kind: row.get(0)?,
                filename: row.get(1)?,
                mime_type: row.get(2)?,
                company_id: row.get(3)?,
                storage_path: row.get(4)?,
                sha256: row.get(5)?,
            }),
        )
        .optional()?)
}

/// A JSON text column parsed into its type; SQL NULL parses as JSON `null`.
fn json_column<T: serde::de::DeserializeOwned>(row: &Row<'_>, column: &str) -> rusqlite::Result<T> {
    let raw: Option<String> = row.get(column)?;
    serde_json::from_str(raw.as_deref().unwrap_or("null")).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            row.as_ref().column_index(column).unwrap_or_default(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

/// TypeScript `control(row)`: one `suplex_task_controls` row by column name.
fn control_row(row: &Row<'_>) -> rusqlite::Result<TaskControlRow> {
    Ok(TaskControlRow {
        task_id: row.get("task_id")?,
        objective: row.get("objective")?,
        delivery_target: row.get("delivery_target")?,
        delivery_intent: json_column(row, "delivery_intent_json")?,
        status: row.get("status")?,
        wake_at: row.get("wake_at")?,
        human_question: row.get("human_question")?,
        human_question_options: json_column::<Option<Value>>(row, "human_question_options_json")?
            .unwrap_or_else(|| json!([])),
        human_question_id: row.get("human_question_id")?,
        recovery_turn_id: row.get("recovery_turn_id")?,
        limit_pause: json_column(row, "limit_pause_json")?,
        worktree: json_column(row, "worktree_json")?,
        pull_request: json_column(row, "pull_request_json")?,
        root_session_id: row.get("root_session_id")?,
        worker_session_id: row.get("worker_session_id")?,
        shell_pane_id: row.get("shell_pane_id")?,
        root_profile: json_column(row, "root_profile_json")?,
        worker_profile: json_column(row, "worker_profile_json")?,
        workflow: row.get("workflow")?,
        advisor_profiles: json_column(row, "advisor_profiles_json")?,
        workflow_state: json_column(row, "workflow_state_json")?,
    })
}

/// The durable control of one task, when the task exists.
pub fn task_control(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<TaskControlRow>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT * FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            control_row,
        )
        .optional()?)
}

fn typed_rows<T>(
    database: &SuplexDatabase,
    sql: &str,
    task_id: &str,
    decode: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> DatabaseResult<Vec<T>> {
    let mut statement = database.connection().prepare(sql)?;
    let rows = statement
        .query_map([task_id], decode)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn json_rows(database: &SuplexDatabase, sql: &str, task_id: &str) -> DatabaseResult<Vec<Value>> {
    let mut statement = database.connection().prepare(sql)?;
    let rows = statement
        .query_map([task_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| serde_json::from_str(&row).map_err(Into::into))
        .collect()
}

pub fn root_observation_rows(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<RootObservationRows> {
    let control = task_control(database, task_id)?.ok_or("task_control_missing")?;
    let context = json_rows(
        database,
        r#"SELECT json_object(
            'configuration',json(configuration_json),
            'images',json(COALESCE((
                SELECT json_group_array(json_object('artifactId',id,'filename',filename))
                FROM (SELECT id,filename FROM suplex_artifacts
                      WHERE task_id = t.id AND kind IN ('task-image','delivery-image')
                      ORDER BY created_at,id)
            ),'[]')),
            'issueContext',json(issue_context_json))
            FROM suplex_tasks t WHERE id = ?1"#,
        task_id,
    )?
    .into_iter()
    .next()
    .ok_or("task_context_missing")?;
    let dependencies = typed_rows(
        database,
        "SELECT t.id, t.title, COALESCE(c.status,'backlog') AS status
            FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id
            LEFT JOIN suplex_task_controls c ON c.task_id = t.id
            WHERE d.task_id = ?1 ORDER BY t.id",
        task_id,
        |row| {
            Ok(DependencyRow {
                id: row.get("id")?,
                title: row.get("title")?,
                status: row.get("status")?,
            })
        },
    )?;
    let sessions = typed_rows(
        database,
        "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY created_at,id",
        task_id,
        session,
    )?;
    let turns = typed_rows(
        database,
        "SELECT * FROM suplex_task_turns WHERE task_id = ?1 ORDER BY created_at,id",
        task_id,
        turn,
    )?;
    let root = sessions
        .iter()
        .find(|session| session.kind == SessionKind::Root && session.current)
        .cloned();
    let mut workers = sessions
        .iter()
        .filter(|session| session.kind == SessionKind::Worker && session.current)
        .cloned()
        .collect::<Vec<_>>();
    workers.sort_by_key(|session| match session.delegate_slot.as_deref() {
        Some("planner_a") => 0,
        Some("planner_b") => 1,
        _ => 2,
    });
    let pointed = control.worker_session_id.as_deref();
    let worker = workers
        .iter()
        .find(|session| Some(session.id.as_str()) == pointed)
        .or_else(|| workers.first())
        .cloned();
    Ok(RootObservationRows {
        control,
        context,
        dependencies,
        root,
        worker,
        workers,
        sessions,
        turns,
    })
}

pub(crate) fn new_turn_id(now: DateTime<Utc>) -> DatabaseResult<String> {
    const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    static COUNTER: Mutex<(i64, u64)> = Mutex::new((0, 0));
    let millis = now.timestamp_millis();
    let counter = {
        let mut state = COUNTER
            .lock()
            .map_err(|_| CoordinationError::refused("turn ID counter poisoned"))?;
        if state.0 != millis {
            *state = (millis, 0);
        }
        state.1 += 1;
        state.1
    };
    let value = (millis as u128) * 0x1000 + u128::from(counter);
    let mut id = String::from("msg_");
    for index in 0..6 {
        let byte = ((value >> (40 - 8 * index)) & 0xff) as u8;
        id.push_str(&format!("{byte:02x}"));
    }
    let mut random = [0u8; 14];
    getrandom::fill(&mut random)?;
    for byte in random {
        id.push(BASE62[usize::from(byte % 62)] as char);
    }
    Ok(id)
}

/// TypeScript `session(row)`: one `suplex_task_sessions` row by column name.
pub(crate) fn session(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    let replaces: Option<String> = row.get("replaces_session_id")?;
    Ok(SessionRow {
        profile: json_column(row, "profile_json")?,
        replacement: replaces
            .map(|session_id| -> rusqlite::Result<_> {
                Ok(SessionReplacement {
                    session_id,
                    reason: row.get("replacement_reason")?,
                    handoff: row.get("replacement_handoff")?,
                })
            })
            .transpose()?,
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        kind: row.get("kind")?,
        generation: row.get("generation")?,
        current: row.get("is_current")?,
        pane_id: row.get("pane_id")?,
        native_session_id: row.get("native_session_id")?,
        lifecycle: row.get("lifecycle")?,
        assignment_hash: row.get("assignment_hash")?,
        launch_owner: row.get("launch_owner")?,
        launch_owner_pid: row.get("launch_owner_pid")?,
        launch_owner_start_time: row.get("launch_owner_start_time")?,
        stop_requested_at: row.get("stop_requested_at")?,
        stopped_at: row.get("stopped_at")?,
        advisor_role: row.get("advisor_role")?,
        delegate_slot: row.get("delegate_slot")?,
        workflow_input: json_column(row, "workflow_input_json")?,
    })
}

/// TypeScript `turn(row)`: one `suplex_task_turns` row by column name.
pub(crate) fn turn(row: &Row<'_>) -> rusqlite::Result<TurnRow> {
    Ok(TurnRow {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        session_id: row.get("session_id")?,
        generation: row.get("generation")?,
        assignment_hash: row.get("assignment_hash")?,
        prompt_hash: row.get("prompt_hash")?,
        prompt_text: row.get("prompt_text")?,
        status: row.get("status")?,
        prompted_at: row.get("prompted_at")?,
        completed_at: row.get("completed_at")?,
        result_receipt_id: row.get("result_receipt_id")?,
        terminal_observation: row.get("terminal_observation")?,
        native_turn_id: row.get("native_turn_id")?,
        dispatch_attempt: json_column(row, "dispatch_attempt_json")?,
        workflow_input: json_column(row, "workflow_input_json")?,
    })
}

pub fn insert_pending_turn(
    database: &SuplexDatabase,
    id: &str,
    task_id: &str,
    session_id: &str,
    generation: i64,
    assignment_hash: Option<&str>,
    prompt: &str,
    workflow_input: Option<&str>,
    time: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,assignment_hash,prompt_hash,prompt_text,status,workflow_input_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending_prompt',?8,?9,?9)",
        params![id, task_id, session_id, generation, assignment_hash, sha256_hex(prompt.as_bytes()), prompt, workflow_input, time],
    )?;
    Ok(())
}

pub fn cancel_open_turns(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: Option<&str>,
    time: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_task_turns SET status = 'cancelled', updated_at = ?1 WHERE task_id = ?2 AND (?3 IS NULL OR session_id = ?3) AND status IN ('pending_prompt','prompted','unknown')",
        params![time, task_id, session_id],
    )?;
    Ok(())
}
