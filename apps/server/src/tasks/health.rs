//! Display observations that tell a task that does not advance from a task
//! that works: provider sign-in, retries of the current work, and the last
//! progress with the task's usual turn time. They never gate a command, never
//! disable a control, and never move a task to `waiting_human`. The browser
//! decides when the last progress is old, so the value does not change each
//! second.

use std::collections::HashMap;

use chrono::{DateTime, DurationRound, TimeDelta, Utc};

use crate::{
    coordination::{
        root_prompts::INTERRUPTED_CONTINUATION, root_session_store::RootObservationRows,
    },
    http::contracts::task_reads::{TaskHealth, TaskProviderConnection},
    platform::database::{DatabaseResult, SuplexDatabase},
    profiles::connection_cache::{self, ConnectionKey},
    shared::time::rfc3339_millis,
    tasks::control::{SessionRow, TaskProfile, TaskStatus, TurnRow, TurnStatus},
};

/// The stored part of a task's health, read with the task's saved sessions.
pub(crate) struct StoredHealth {
    logins: Vec<ConnectionKey>,
    retries: u32,
    active: bool,
    last_completed_at: Option<DateTime<Utc>>,
    usual_turn_seconds: Option<u32>,
}

#[cfg(test)]
impl StoredHealth {
    /// An active task without retries, turns, or provider logins.
    pub(crate) fn fixture() -> Self {
        Self {
            logins: Vec::new(),
            retries: 0,
            active: true,
            last_completed_at: None,
            usual_turn_seconds: None,
        }
    }
}

/// The stored health inputs of one task, for the sync feed and the agents
/// route. The caller authorizes.
pub(crate) fn stored(
    database: &SuplexDatabase,
    rows: &RootObservationRows,
    status: TaskStatus,
) -> DatabaseResult<StoredHealth> {
    let mut statement = database.connection().prepare(
        "SELECT id, dispatch_requeues FROM suplex_task_turns WHERE task_id = ?1 AND dispatch_requeues > 0",
    )?;
    let requeues = statement
        .query_map([&rows.control.task_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<HashMap<String, u32>, _>>()?;
    Ok(StoredHealth {
        logins: logins(rows),
        retries: suplex_retries(rows, &requeues),
        active: status == TaskStatus::Active,
        last_completed_at: rows.turns.iter().filter_map(completed_at).max(),
        usual_turn_seconds: usual_turn_seconds(&rows.turns),
    })
}

/// The task health from its stored inputs and the native observations of its
/// current sessions: each native retry attempt, and each native update time
/// (Unix ms). Provider sign-in comes from the host-wide cache, so tasks on
/// one login share one probe.
pub(crate) fn observe(
    stored: &StoredHealth,
    native_retries: u64,
    native_updates: impl IntoIterator<Item = f64>,
) -> TaskHealth {
    let mut providers = Vec::new();
    for key in &stored.logins {
        let connection = connection_cache::HOST.read(key);
        providers.push(TaskProviderConnection {
            provider: key.provider,
            status: connection.status,
            summary: connection.summary,
            observed_at: connection.observed_at,
        });
    }
    let native = u32::try_from(native_retries).unwrap_or(u32::MAX);
    TaskHealth {
        providers,
        retries: stored.retries.saturating_add(native),
        last_progress_at: stored
            .active
            .then(|| last_progress(stored.last_completed_at, native_updates))
            .flatten(),
        usual_turn_seconds: stored.usual_turn_seconds,
    }
}

/// Each provider login of the Coordinator, Worker, and Advisor profiles and
/// of each current session, in that order, once. A Claude Code profile on a
/// provider instance has its own login; other providers have one per host.
pub fn logins(rows: &RootObservationRows) -> Vec<ConnectionKey> {
    let control = &rows.control;
    let profiles = [&control.root_profile, &control.worker_profile]
        .into_iter()
        .chain(control.advisor_profiles.values())
        .chain(
            rows.sessions
                .iter()
                .filter(|session| session.current)
                .map(|session| rows.profile_of(session)),
        );
    let mut keys: Vec<ConnectionKey> = Vec::new();
    for profile in profiles {
        let key = login(profile);
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

fn login(profile: &TaskProfile) -> ConnectionKey {
    ConnectionKey {
        provider: profile.provider,
        home_directory: profile.instance_home_directory().map(str::to_owned),
    }
}

/// The Suplex retries of the task's current work: the sum, over each current
/// session, of
///
/// - the requeues of the session's newest turn: each time Suplex returned it
///   to `pending_prompt` after the native runtime proved a claimed dispatch
///   absent (`dispatch_requeues`);
/// - the continuations: the run of newest turns of the session that continue
///   an interrupted execution (`INTERRUPTED_CONTINUATION`);
/// - the replacements: the earlier sessions with the same kind, Advisor role,
///   and assignment, which a Worker or Advisor replacement left behind.
///
/// The agents route adds each native retry attempt that the runtime reports
/// now (OpenCode `Retry { attempt }`). The count is 0 when nothing was retried.
pub fn suplex_retries(rows: &RootObservationRows, requeues: &HashMap<String, u32>) -> u32 {
    rows.sessions
        .iter()
        .filter(|session| session.current)
        .map(|session| {
            let turns = rows
                .turns
                .iter()
                .filter(|turn| turn.session_id == session.id)
                .collect::<Vec<_>>();
            let requeued = turns
                .last()
                .and_then(|turn| requeues.get(&turn.id))
                .copied()
                .unwrap_or(0);
            let continued = turns
                .iter()
                .rev()
                .take_while(|turn| turn.prompt_text == INTERRUPTED_CONTINUATION)
                .count();
            requeued
                .saturating_add(u32::try_from(continued).unwrap_or(u32::MAX))
                .saturating_add(replacements(rows, session))
        })
        .fold(0, u32::saturating_add)
}

fn replacements(rows: &RootObservationRows, session: &SessionRow) -> u32 {
    let Some(assignment) = session.assignment_hash.as_deref() else {
        return 0;
    };
    let count = rows
        .sessions
        .iter()
        .filter(|earlier| {
            !earlier.current
                && earlier.id != session.id
                && earlier.kind == session.kind
                && earlier.advisor_role == session.advisor_role
                && earlier.assignment_hash.as_deref() == Some(assignment)
        })
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn time(value: Option<&String>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn completed_at(turn: &TurnRow) -> Option<DateTime<Utc>> {
    time(turn.completed_at.as_ref())
}

/// The median time from prompt to completion of the task's completed turns,
/// rounded to whole minutes and at least one minute, in seconds. `None` with
/// fewer than 2 completed turns.
pub fn usual_turn_seconds(turns: &[TurnRow]) -> Option<u32> {
    let mut durations = turns
        .iter()
        .filter(|turn| turn.status == TurnStatus::Completed)
        .filter_map(|turn| {
            Some((completed_at(turn)? - time(turn.prompted_at.as_ref())?).num_seconds())
        })
        .filter(|seconds| *seconds >= 0)
        .collect::<Vec<_>>();
    if durations.len() < 2 {
        return None;
    }
    durations.sort_unstable();
    let middle = durations.len() / 2;
    let median = if durations.len() % 2 == 0 {
        (durations[middle - 1] + durations[middle]) / 2
    } else {
        durations[middle]
    };
    let minutes = ((median + 30) / 60).max(1);
    u32::try_from(minutes * 60).ok()
}

/// The newest of the last turn completion and each native update (Unix ms),
/// to the minute, so a busy native session does not change it each second.
pub fn last_progress(
    last_completed_at: Option<DateTime<Utc>>,
    native_updates: impl IntoIterator<Item = f64>,
) -> Option<String> {
    native_updates
        .into_iter()
        .filter(|value| value.is_finite())
        .filter_map(|value| DateTime::<Utc>::from_timestamp_millis(value as i64))
        .chain(last_completed_at)
        .max()
        .and_then(|time| time.duration_trunc(TimeDelta::minutes(1)).ok())
        .map(rfc3339_millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        coordination::advisor_bridge::AdvisorRole,
        tasks::control::{HarnessKind, SessionKind, TaskControlRow},
    };

    fn rows(sessions: Vec<SessionRow>, turns: Vec<TurnRow>) -> RootObservationRows {
        RootObservationRows {
            control: TaskControlRow::fixture(),
            context: serde_json::Value::Null,
            dependencies: Vec::new(),
            root: None,
            worker: None,
            workers: Vec::new(),
            sessions,
            turns,
        }
    }

    fn turn(id: &str, session: &str, prompt: &str) -> TurnRow {
        TurnRow {
            prompt_text: prompt.into(),
            ..TurnRow::fixture(id, session, TurnStatus::Completed)
        }
    }

    fn worker(id: &str, current: bool, assignment: &str) -> SessionRow {
        SessionRow {
            current,
            assignment_hash: Some(assignment.into()),
            ..SessionRow::fixture(id, SessionKind::Worker)
        }
    }

    #[test]
    fn work_that_was_not_retried_counts_zero() {
        let rows = rows(
            vec![
                SessionRow::fixture("root", SessionKind::Root),
                worker("worker", true, "a"),
            ],
            vec![turn("t1", "root", "Start"), turn("t2", "worker", "Build")],
        );
        assert_eq!(suplex_retries(&rows, &HashMap::new()), 0);
    }

    #[test]
    fn requeues_continuations_and_replacements_of_the_current_work_count() {
        let mut advisor = worker("advisor-old", false, "a");
        advisor.advisor_role = Some(AdvisorRole::Reviewer);
        let rows = rows(
            vec![
                SessionRow::fixture("root", SessionKind::Root),
                worker("worker-1", false, "a"),
                worker("worker-2", false, "a"),
                // An earlier assignment and another role are not replacements.
                worker("worker-other", false, "b"),
                advisor,
                worker("worker-3", true, "a"),
            ],
            vec![
                turn("t1", "root", "Start"),
                turn("t2", "root", INTERRUPTED_CONTINUATION),
                turn("t3", "root", INTERRUPTED_CONTINUATION),
                turn("t4", "worker-3", "Build"),
            ],
        );
        // Requeues of an older turn are not the current work.
        let requeues = HashMap::from([("t4".to_owned(), 3), ("t1".to_owned(), 5)]);
        // 2 continuations + 2 replacements + 3 requeues.
        assert_eq!(suplex_retries(&rows, &requeues), 7);
    }

    #[test]
    fn a_new_turn_after_a_continuation_ends_the_count() {
        let rows = rows(
            vec![SessionRow::fixture("root", SessionKind::Root)],
            vec![
                turn("t1", "root", INTERRUPTED_CONTINUATION),
                turn("t2", "root", "The Worker finished"),
            ],
        );
        assert_eq!(suplex_retries(&rows, &HashMap::new()), 0);
    }

    #[test]
    fn a_requeued_dispatch_of_the_current_turn_counts() {
        use crate::{
            coordination::root_session_store, platform::database::OpenMode,
            tasks::control::PromptDispatchAttempt,
        };
        let root = std::env::temp_dir().join(format!("suplex-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("suplex.sqlite");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/parity/task-agents-native/database.sqlite"
            ),
            &path,
        )
        .unwrap();
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let task_id = "task_1bfa5d693de94807ba20b6dd0f5218e5";
        let (session_id, generation): (String, i64) = database
            .connection()
            .query_row(
                "SELECT id, generation FROM suplex_task_sessions WHERE task_id = ?1 AND is_current = 1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let attempt = PromptDispatchAttempt {
            server_generation: "server".into(),
            claimed_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let connection = database.connection();
        connection
            .execute(
                "UPDATE suplex_task_sessions SET launch_owner = 'owner' WHERE id = ?1",
                [&session_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,dispatch_attempt_json,created_at,updated_at) VALUES ('turn',?1,?2,?3,'hash','Start','unknown',?4,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
                rusqlite::params![task_id, session_id, generation, serde_json::to_string(&attempt).unwrap()],
            )
            .unwrap();
        let rows = root_session_store::root_observation_rows(&database, task_id).unwrap();
        assert_eq!(
            stored(&database, &rows, TaskStatus::Active)
                .unwrap()
                .retries,
            0
        );
        assert!(
            root_session_store::requeue_fenced_prompt(
                &mut database,
                &rows.turns[0],
                &attempt,
                "owner",
                Utc::now()
            )
            .unwrap()
        );
        let rows = root_session_store::root_observation_rows(&database, task_id).unwrap();
        let health = stored(&database, &rows, TaskStatus::Active).unwrap();
        assert_eq!(health.retries, 1);
        // A task that is not active shows no last progress.
        assert!(
            !stored(&database, &rows, TaskStatus::WaitingHuman)
                .unwrap()
                .active
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn timed(id: &str, prompted: &str, completed: &str) -> TurnRow {
        TurnRow {
            prompted_at: Some(prompted.into()),
            completed_at: Some(completed.into()),
            ..TurnRow::fixture(id, "root", TurnStatus::Completed)
        }
    }

    #[test]
    fn the_usual_turn_time_is_the_median_of_completed_turns() {
        assert_eq!(
            usual_turn_seconds(&[timed("t1", "2026-01-01T00:00:00Z", "2026-01-01T00:04:00Z")]),
            None
        );
        let mut open = timed("t4", "2026-01-01T00:00:00Z", "2026-01-01T09:00:00Z");
        open.status = TurnStatus::Prompted;
        let turns = [
            timed("t1", "2026-01-01T00:00:00Z", "2026-01-01T00:04:00Z"),
            timed("t2", "2026-01-01T01:00:00Z", "2026-01-01T01:20:10Z"),
            timed("t3", "2026-01-01T02:00:00Z", "2026-01-01T02:06:00Z"),
            open,
        ];
        assert_eq!(usual_turn_seconds(&turns), Some(6 * 60));
        assert_eq!(usual_turn_seconds(&turns[..2]), Some(12 * 60));
        assert_eq!(
            usual_turn_seconds(&[
                timed("t1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z"),
                timed("t2", "2026-01-01T00:00:00Z", "2026-01-01T00:00:09Z"),
            ]),
            Some(60)
        );
    }

    #[test]
    fn last_progress_is_the_newest_completion_or_native_update_to_the_minute() {
        let completed = time(Some(&"2026-01-01T10:00:30.500Z".to_owned()));
        assert_eq!(
            last_progress(completed, []).as_deref(),
            Some("2026-01-01T10:00:00.000Z")
        );
        let native = DateTime::parse_from_rfc3339("2026-01-01T10:07:59Z")
            .unwrap()
            .timestamp_millis() as f64;
        assert_eq!(
            last_progress(completed, [native, f64::NAN]).as_deref(),
            Some("2026-01-01T10:07:00.000Z")
        );
        assert_eq!(last_progress(None, []), None);
    }

    #[test]
    fn each_login_of_the_task_profiles_is_listed_once() {
        let mut rows = rows(Vec::new(), Vec::new());
        rows.control.root_profile.provider = HarnessKind::ClaudeCode;
        rows.control.root_profile.instance_home_directory = Some(Some("/homes/work".into()));
        rows.control
            .advisor_profiles
            .insert(AdvisorRole::Reviewer, rows.control.worker_profile.clone());
        let keys = logins(&rows);
        assert_eq!(
            keys,
            vec![
                ConnectionKey {
                    provider: HarnessKind::ClaudeCode,
                    home_directory: Some("/homes/work".into())
                },
                ConnectionKey {
                    provider: HarnessKind::Codex,
                    home_directory: None
                },
            ]
        );
    }
}
