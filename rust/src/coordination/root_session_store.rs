//! Durable Root session and prompt intent. Native runtime evidence stays with the harness.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::platform::database::{DatabaseResult, SuplexDatabase};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootSession {
    pub id: String,
    pub task_id: String,
    pub generation: i64,
    pub lifecycle: String,
    pub native_session_id: Option<String>,
    pub launch_owner: Option<String>,
    pub launch_owner_pid: Option<i64>,
    pub launch_owner_start_time: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchAttempt {
    pub server_generation: String,
    pub claimed_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootTurn {
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    pub generation: i64,
    pub prompt_text: String,
    pub status: String,
    pub dispatch_attempt: Option<PromptDispatchAttempt>,
    pub native_turn_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TaskLimitUsage {
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskLimits {
    budget_usd: f64,
    max_turns: i64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedLimitUsage {
    estimated_cost_usd: Option<f64>,
    admitted_turns: i64,
}

fn suggested_budget(proposed: f64, spent: f64) -> f64 {
    (proposed / 5.0)
        .round()
        .mul_add(5.0, 0.0)
        .max(((spent / 5.0).floor() + 1.0) * 5.0)
}

fn task_limit_question(
    reason: &str,
    limits: TaskLimits,
    proposed: TaskLimits,
    usage: PersistedLimitUsage,
) -> String {
    let reached = match reason {
        "budget" => "estimated spend budget",
        "turns" => "turn limit",
        _ => "estimated spend budget and turn limit",
    };
    let spend = match usage.estimated_cost_usd {
        None => "Estimated spend is not available.".to_owned(),
        Some(cost) if limits.budget_usd == 0.0 => {
            format!("Estimated spend is ${cost:.2}. The budget is disabled.")
        }
        Some(cost) => format!(
            "Estimated spend is ${cost:.2} of ${:.2}.",
            limits.budget_usd
        ),
    };
    let turns = if limits.max_turns == 0 {
        format!(
            "{} turns were admitted. The turn limit is disabled.",
            usage.admitted_turns
        )
    } else {
        format!(
            "Admitted turns are {} of {}.",
            usage.admitted_turns, limits.max_turns
        )
    };
    let budget = if reason == "turns" {
        proposed.budget_usd
    } else {
        suggested_budget(proposed.budget_usd, usage.estimated_cost_usd.unwrap_or(0.0))
    };
    let proposed_budget = if budget == 0.0 {
        "no budget limit".to_owned()
    } else {
        format!("a ${budget:.2} budget")
    };
    let proposed_turns = if proposed.max_turns == 0 {
        "no turn limit".to_owned()
    } else {
        format!("{} turns", proposed.max_turns)
    };
    format!(
        "This task reached its {reached}. {spend} {turns} Suplex proposes {proposed_budget} and {proposed_turns}. A native turn already in progress can finish before Suplex pauses. Select how to continue."
    )
}

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn session(row: &Row<'_>) -> rusqlite::Result<RootSession> {
    Ok(RootSession {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        generation: row.get("generation")?,
        lifecycle: row.get("lifecycle")?,
        native_session_id: row.get("native_session_id")?,
        launch_owner: row.get("launch_owner")?,
        launch_owner_pid: row.get("launch_owner_pid")?,
        launch_owner_start_time: row.get("launch_owner_start_time")?,
    })
}

fn turn(row: &Row<'_>) -> rusqlite::Result<RootTurn> {
    let raw: Option<String> = row.get("dispatch_attempt_json")?;
    let dispatch_attempt = raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    Ok(RootTurn {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        session_id: row.get("session_id")?,
        generation: row.get("generation")?,
        prompt_text: row.get("prompt_text")?,
        status: row.get("status")?,
        dispatch_attempt,
        native_turn_id: row.get("native_turn_id")?,
    })
}

pub fn current_root(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<RootSession>> {
    Ok(database.connection().query_row(
        "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
        [task_id], session,
    ).optional()?)
}

/// Reserve one Root generation for an active task; a repeated admission returns it.
pub fn reserve_root(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<RootSession> {
    database.transaction(true, |database| {
        let active: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_controls WHERE task_id = ?1 AND status = 'active')",
            [task_id], |row| row.get(0),
        )?;
        if !active {
            return Err(std::io::Error::other("task_not_active").into());
        }
        if let Some(existing) = current_root(database, task_id)? {
            return Ok(existing);
        }
        let generation: i64 = database.connection().query_row(
            "SELECT COALESCE(MAX(generation), 0) + 1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root'",
            [task_id], |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let time = timestamp(now);
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, created_at, updated_at) VALUES (?1, ?2, 'root', ?3, 1, 'reserved', ?4, ?4)",
            params![id, task_id, generation, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET root_session_id = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![id, time, task_id],
        )?;
        current_root(database, task_id)?.ok_or_else(|| std::io::Error::other("root_session_missing").into())
    })
}

pub fn ensure_initial_prompt(
    database: &mut SuplexDatabase,
    root: &RootSession,
    prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<RootTurn>> {
    database.transaction(true, |database| {
        let existing: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_turns WHERE session_id = ?1)",
            [&root.id], |row| row.get(0),
        )?;
        if existing { return Ok(None); }
        let id = Uuid::new_v4().to_string();
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        let time = timestamp(now);
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending_prompt', ?7, ?7)",
            params![id, root.task_id, root.id, root.generation, hash, prompt, time],
        )?;
        Ok(Some(database.connection().query_row(
            "SELECT * FROM suplex_task_turns WHERE id = ?1", [&id], turn,
        )?))
    })
}

pub fn pending_turns(database: &SuplexDatabase, session_id: &str) -> DatabaseResult<Vec<RootTurn>> {
    let mut statement = database.connection().prepare(
        "SELECT * FROM suplex_task_turns WHERE session_id = ?1 AND status IN ('pending_prompt', 'unknown', 'prompted') ORDER BY created_at, id",
    )?;
    Ok(statement
        .query_map([session_id], turn)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The caller observes the prior owner from the native process system before replacing it.
pub fn claim_session_operation(
    database: &mut SuplexDatabase,
    root: &RootSession,
    owner: &str,
    owner_pid: i64,
    owner_start_time: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_sessions SET launch_owner = ?1, launch_owner_pid = ?2, launch_owner_start_time = ?3, launch_claimed_at = ?4, updated_at = ?4 WHERE id = ?5 AND generation = ?6 AND is_current = 1 AND lifecycle <> 'cancelled' AND launch_owner IS ?7",
            params![owner, owner_pid, owner_start_time, timestamp(now), root.id, root.generation, root.launch_owner],
        )? == 1)
    })
}

pub fn release_session_operation(
    database: &mut SuplexDatabase,
    session_id: &str,
    owner: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        database.connection().execute(
            "UPDATE suplex_task_sessions SET launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, updated_at = ?1 WHERE id = ?2 AND launch_owner = ?3",
            params![timestamp(now), session_id, owner],
        )?;
        Ok(())
    })
}

pub fn bind_native_session(
    database: &mut SuplexDatabase,
    root: &RootSession,
    native_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_sessions SET native_session_id = ?1, lifecycle = 'live', updated_at = ?2 WHERE id = ?3 AND generation = ?4 AND is_current = 1 AND lifecycle <> 'cancelled' AND (native_session_id IS NULL OR native_session_id = ?1)",
            params![native_id, timestamp(now), root.id, root.generation],
        )? == 1)
    })
}

/// This CAS is the durable admission boundary used inside the harness dispatch callback.
pub fn claim_prompt(
    database: &mut SuplexDatabase,
    turn: &RootTurn,
    owner: &str,
    server_generation: &str,
    usage: TaskLimitUsage,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let control = database.connection().query_row(
            "SELECT status, budget_usd, max_turns FROM suplex_task_controls WHERE task_id = ?1",
            [&turn.task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<f64>>(1)?, row.get::<_, Option<i64>>(2)?)),
        ).optional()?;
        let Some((status, budget_usd, max_turns)) = control else { return Ok(false); };
        if status != "active" { return Ok(false); }
        let dependency_blocked: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id LEFT JOIN suplex_task_controls c ON c.task_id = t.id WHERE d.task_id = ?1 AND COALESCE(c.status, 'backlog') <> 'delivered')",
            [&turn.task_id], |row| row.get(0),
        )?;
        if dependency_blocked { return Ok(false); }
        let defaults = database.connection().query_row(
            "SELECT default_budget_usd, default_max_turns FROM suplex_environment_settings WHERE id = 'host'",
            [], |row| Ok(TaskLimits { budget_usd: row.get(0)?, max_turns: row.get(1)? }),
        ).optional()?.unwrap_or(TaskLimits { budget_usd: 15.0, max_turns: 40 });
        let limits = TaskLimits { budget_usd: budget_usd.unwrap_or(defaults.budget_usd), max_turns: max_turns.unwrap_or(defaults.max_turns) };
        let admitted_turns: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompted_at IS NOT NULL",
            [&turn.task_id], |row| row.get(0),
        )?;
        let reservations: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status = 'unknown' AND prompted_at IS NULL",
            [&turn.task_id], |row| row.get(0),
        )?;
        let hit_budget = limits.budget_usd > 0.0 && usage.estimated_cost_usd.is_some_and(|cost| cost >= limits.budget_usd);
        let hit_turns = limits.max_turns > 0 && admitted_turns >= limits.max_turns;
        if hit_budget || hit_turns {
            let reason = match (hit_budget, hit_turns) { (true, true) => "budget_and_turns", (true, false) => "budget", _ => "turns" };
            let budget_allowance = if defaults.budget_usd > 0.0 { defaults.budget_usd } else { limits.budget_usd };
            let turn_allowance = if defaults.max_turns > 0 { defaults.max_turns } else { limits.max_turns };
            let proposed = TaskLimits {
                budget_usd: if hit_budget { suggested_budget(usage.estimated_cost_usd.unwrap_or(0.0) + budget_allowance, usage.estimated_cost_usd.unwrap_or(0.0)) } else { limits.budget_usd },
                max_turns: if hit_turns { admitted_turns + turn_allowance } else { limits.max_turns },
            };
            let observed = PersistedLimitUsage { estimated_cost_usd: usage.estimated_cost_usd, admitted_turns };
            let pause = serde_json::json!({ "kind": "task_limit", "reason": reason, "limits": limits, "usage": observed, "proposedLimits": proposed });
            let time = timestamp(now);
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', limit_pause_json = ?1, human_question = ?2, human_question_options_json = '[]', human_question_id = ?3, wake_at = NULL, updated_at = ?4 WHERE task_id = ?5 AND status = 'active'",
                params![pause.to_string(), task_limit_question(reason, limits, proposed, observed), Uuid::new_v4().to_string(), time, turn.task_id],
            )?;
            return Ok(false);
        }
        if limits.max_turns > 0 && admitted_turns + reservations >= limits.max_turns { return Ok(false); }
        let attempt = PromptDispatchAttempt { server_generation: server_generation.to_owned(), claimed_at: timestamp(now) };
        let raw = serde_json::to_string(&attempt)?;
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'unknown', dispatch_attempt_json = ?1, updated_at = ?2 WHERE id = ?3 AND task_id = ?4 AND status = 'pending_prompt' AND EXISTS (SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_controls c ON c.task_id = s.task_id WHERE s.id = suplex_task_turns.session_id AND s.generation = suplex_task_turns.generation AND s.launch_owner = ?5 AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')",
            params![raw, attempt.claimed_at, turn.id, turn.task_id, owner],
        )? == 1)
    })
}

pub fn mark_prompted(
    database: &mut SuplexDatabase,
    turn: &RootTurn,
    native_turn_id: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'prompted', native_turn_id = COALESCE(?1, native_turn_id), prompted_at = ?2, updated_at = ?2 WHERE id = ?3 AND generation = ?4 AND status IN ('pending_prompt', 'unknown') AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.id = suplex_task_turns.session_id AND s.is_current = 1 AND s.generation = suplex_task_turns.generation)",
            params![native_turn_id, timestamp(now), turn.id, turn.generation],
        )? == 1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth,
        platform::database::OpenMode,
        runtimes::headless::{self, DispatchInput},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use std::{collections::HashMap, path::Path};

    #[test]
    fn committed_claim_survives_reopen_and_budget_pause_never_dispatches() {
        let filename =
            std::env::temp_dir().join(format!("suplex_task_store_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_task_test', 'Task test', 'active', ?1)",
            [timestamp(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('project_task_test', 'company_task_test', 'Task project', '/tmp/suplex-task-project', '/tmp/suplex-task-worktrees', NULL, 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?1, ?1)",
            [timestamp(now)],
        ).unwrap();
        let prepared = PreparedTask {
            company_id: "company_task_test".into(),
            project_id: "project_task_test".into(),
            title: "One task".into(),
            description: "Run Codex".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-one","baseBranch":"main","baselineSha":"head"}),
            idempotency_key: "task-key".into(),
            request_hash: "same-request".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::json!({"repository":"owner/repo","headBranch":"task-one","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
            root_profile: serde_json::json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            worker_profile: serde_json::json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            advisor_profiles: serde_json::json!({}),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
        };
        let created = repository::create(&mut database, &prepared, now).unwrap();
        assert!(created.created);
        assert_eq!(created.task.status, "active");
        let repeated = repository::create(&mut database, &prepared, now).unwrap();
        assert!(!repeated.created);
        assert_eq!(created.task.id, repeated.task.id);
        let blocked_input = PreparedTask {
            title: "Dependent task".into(),
            idempotency_key: "dependent-key".into(),
            request_hash: "dependent-request".into(),
            depends_on: vec![created.task.id.clone()],
            ..prepared.clone()
        };
        let blocked = repository::create(&mut database, &blocked_input, now).unwrap();
        assert_eq!(blocked.task.status, "queued");
        let backlog_input = PreparedTask {
            title: "Manual task".into(),
            idempotency_key: "manual-key".into(),
            request_hash: "manual-request".into(),
            start_queued: false,
            ..prepared.clone()
        };
        let backlog = repository::create(&mut database, &backlog_input, now).unwrap();
        assert_eq!(backlog.task.status, "backlog");
        assert_eq!(
            repository::start(&mut database, &backlog.task.id, now)
                .unwrap()
                .unwrap()
                .status,
            "active"
        );
        let pull_request_input = PreparedTask {
            title: "Pull request task".into(),
            idempotency_key: "pull-request-key".into(),
            request_hash: "pull-request-request".into(),
            configuration: serde_json::json!({"repository":"owner/repo","source":{"kind":"pull_request","number":42}}),
            delivery_intent: serde_json::json!({"repository":"owner/repo","pullRequestNumber":42}),
            start_queued: false,
            ..prepared.clone()
        };
        let pull_request = repository::create(&mut database, &pull_request_input, now).unwrap();
        assert!(pull_request.created);
        let conflicting_pull_request = PreparedTask {
            idempotency_key: "another-pull-request-key".into(),
            request_hash: "another-pull-request-request".into(),
            ..pull_request_input
        };
        assert!(repository::create(&mut database, &conflicting_pull_request, now).is_err());
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'delivered' WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        assert_eq!(
            repository::start(&mut database, &blocked.task.id, now)
                .unwrap()
                .unwrap()
                .status,
            "active"
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        let root = reserve_root(&mut database, &created.task.id, now).unwrap();
        let turn = ensure_initial_prompt(&mut database, &root, "Begin", now)
            .unwrap()
            .unwrap();
        assert!(
            claim_session_operation(&mut database, &root, "owner-one", 123, "process-start", now)
                .unwrap()
        );
        let session_directory = filename.with_extension("session");
        std::fs::create_dir_all(&session_directory).unwrap();
        let args = vec!["-c".to_owned(), "sleep 1; cat >/dev/null".to_owned()];
        let environment = HashMap::new();
        let dispatch_input = || DispatchInput {
            directory: &session_directory,
            worktree: session_directory.parent().unwrap(),
            session_id: &root.id,
            turn_id: &turn.id,
            executable: Path::new("/bin/sh"),
            args: &args,
            prompt: "Begin",
            environment: &environment,
        };
        let native = headless::dispatch(dispatch_input(), |generation| {
            claim_prompt(
                &mut database,
                &turn,
                "owner-one",
                generation,
                TaskLimitUsage {
                    estimated_cost_usd: None,
                },
                now,
            )
        })
        .unwrap();
        assert!(
            headless::dispatch(dispatch_input(), |generation| {
                claim_prompt(
                    &mut database,
                    &turn,
                    "owner-one",
                    generation,
                    TaskLimitUsage {
                        estimated_cost_usd: None,
                    },
                    now,
                )
            })
            .is_err()
        );
        drop(database);

        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        let recovered = headless::read_record(&session_directory.join("turn.json"))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.generation, native.generation);
        assert_eq!(recovered.turn_id, turn.id);
        let exit_file = headless::turn_file(&session_directory, &turn.id, "exit");
        for _ in 0..30 {
            if exit_file.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(std::fs::read_to_string(&exit_file).unwrap().trim(), "0");
        let pending = pending_turns(&database, &root.id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].status, "unknown");
        assert_eq!(
            pending[0]
                .dispatch_attempt
                .as_ref()
                .unwrap()
                .server_generation,
            native.generation
        );
        assert!(mark_prompted(&mut database, &pending[0], Some("native-turn"), now).unwrap());
        let second_id = Uuid::new_v4().to_string();
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'hash', 'Continue', 'pending_prompt', ?5, ?5)",
            params![second_id, created.task.id, root.id, root.generation, timestamp(now)],
        ).unwrap();
        let second = pending_turns(&database, &root.id)
            .unwrap()
            .into_iter()
            .find(|turn| turn.id == second_id)
            .unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'backlog' WHERE task_id = ?1",
                [&backlog.task.id],
            )
            .unwrap();
        database.connection().execute(
            "INSERT INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?1, ?2, ?3)",
            params![created.task.id, backlog.task.id, timestamp(now)],
        ).unwrap();
        assert!(
            !claim_prompt(
                &mut database,
                &second,
                "owner-one",
                "dependency-regressed",
                TaskLimitUsage {
                    estimated_cost_usd: None
                },
                now,
            )
            .unwrap()
        );
        let still_active: String = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_active, "active");
        database.connection().execute(
            "DELETE FROM suplex_task_dependencies WHERE task_id = ?1 AND depends_on_task_id = ?2",
            params![created.task.id, backlog.task.id],
        ).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET budget_usd = 1 WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        assert!(
            !claim_prompt(
                &mut database,
                &second,
                "owner-one",
                "runtime-generation-three",
                TaskLimitUsage {
                    estimated_cost_usd: Some(1.0)
                },
                now
            )
            .unwrap()
        );
        let status: String = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "waiting_human");
        let attempt: Option<String> = database
            .connection()
            .query_row(
                "SELECT dispatch_attempt_json FROM suplex_task_turns WHERE id = ?1",
                [&second_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(attempt.is_none());
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
        let _ = std::fs::remove_dir_all(&session_directory);
    }
}
