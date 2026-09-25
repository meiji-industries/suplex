//! Task timing is projected from saved native usage and current native observations.

use std::{collections::HashMap, error::Error, path::Path};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::{
    platform::database::{DatabaseResult, SuplexDatabase},
    runtimes::{task_harness::ReaderSession, task_harness_registry},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    profile_id: String,
    model: String,
}

#[derive(Clone, Debug)]
pub struct TimelineTask {
    id: String,
    project_id: String,
    issue_key: Option<String>,
    title: String,
    status: String,
    archived_at: Option<String>,
    root_profile: Profile,
    worker_profile: Profile,
    advisor_profiles: HashMap<String, Profile>,
}

#[derive(Clone, Debug)]
pub struct TimelineSession {
    id: String,
    kind: String,
    advisor_role: Option<String>,
    generation: i64,
    current: bool,
    lifecycle: String,
    native_session_id: Option<String>,
    profile: Option<Profile>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineUsage {
    session_id: String,
    message_id: String,
    turn_id: String,
    started_at: i64,
    completed_at: Option<i64>,
    failed: bool,
}

#[derive(Clone, Debug)]
pub struct SavedTimeline {
    task: TimelineTask,
    sessions: Vec<TimelineSession>,
    usage: Vec<TimelineUsage>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineResponse {
    tasks: Vec<TimelineTaskResponse>,
    unavailable_sessions: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineTaskResponse {
    id: String,
    project_id: String,
    issue_key: Option<String>,
    title: String,
    activity: Vec<TimelineActivity>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineActivity {
    id: String,
    role: String,
    advisor_role: Option<String>,
    label: String,
    agent_id: String,
    agent_name: String,
    avatar_seed: String,
    status: &'static str,
    attempt: i64,
    started_at: String,
    finished_at: Option<String>,
}

pub fn read_saved(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<SavedTimeline>> {
    let raw = database.connection().query_row(
        "SELECT t.id,t.project_id,t.issue_number,c.issue_code,t.title,ctl.status,t.archived_at,ctl.root_profile_json,ctl.worker_profile_json,ctl.advisor_profiles_json FROM suplex_tasks t JOIN suplex_companies c ON c.id = t.company_id JOIN suplex_task_controls ctl ON ctl.task_id = t.id WHERE t.id = ?1",
        [task_id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
        )),
    ).optional()?;
    let Some((
        id,
        project_id,
        issue_number,
        issue_code,
        title,
        status,
        archived_at,
        root,
        worker,
        advisors,
    )) = raw
    else {
        return Ok(None);
    };
    let task = TimelineTask {
        id,
        project_id,
        issue_key: issue_code
            .zip(issue_number)
            .map(|(code, number)| format!("{code}-{number}")),
        title,
        status,
        archived_at,
        root_profile: serde_json::from_str(&root)?,
        worker_profile: serde_json::from_str(&worker)?,
        advisor_profiles: serde_json::from_str(&advisors)?,
    };
    let mut statement = database.connection().prepare(
        "SELECT id,kind,advisor_role,generation,is_current,lifecycle,native_session_id,profile_json FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY created_at,id",
    )?;
    let sessions = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .map(|row| -> DatabaseResult<TimelineSession> {
            let (
                id,
                kind,
                advisor_role,
                generation,
                current,
                lifecycle,
                native_session_id,
                profile,
            ) = row?;
            Ok(TimelineSession {
                id,
                kind,
                advisor_role,
                generation,
                current,
                lifecycle,
                native_session_id,
                profile: profile
                    .map(|profile| serde_json::from_str(&profile))
                    .transpose()?,
            })
        })
        .collect::<DatabaseResult<Vec<_>>>()?;
    let mut statement = database
        .connection()
        .prepare("SELECT snapshot FROM suplex_task_usage WHERE task_id = ?1")?;
    let usage = statement
        .query_map([task_id], |row| row.get::<_, String>(0))?
        .map(|row| -> DatabaseResult<TimelineUsage> { Ok(serde_json::from_str(&row?)?) })
        .collect::<DatabaseResult<Vec<_>>>()?;
    Ok(Some(SavedTimeline {
        task,
        sessions,
        usage,
    }))
}

fn timestamp(millis: i64) -> Result<String, Box<dyn Error>> {
    Ok(DateTime::<Utc>::from_timestamp_millis(millis)
        .ok_or("Native usage timestamp is out of range")?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn role_label(kind: &str, advisor_role: Option<&str>) -> &'static str {
    if kind == "root" {
        "Coordinator"
    } else {
        match advisor_role {
            Some("reviewer") => "Reviewer",
            Some("planner_a") => "Plan A",
            Some("planner_b") => "Plan B",
            Some("rater") => "Rater",
            _ => "Worker",
        }
    }
}

fn activity(
    task: &TimelineTask,
    session: &TimelineSession,
    mut usage: Vec<TimelineUsage>,
    live_id: Option<&str>,
) -> Result<Vec<TimelineActivity>, Box<dyn Error>> {
    let profile = session.profile.as_ref().unwrap_or_else(|| {
        if session.kind == "root" {
            &task.root_profile
        } else if let Some(role) = session.advisor_role.as_deref() {
            task.advisor_profiles
                .get(role)
                .unwrap_or(&task.root_profile)
        } else {
            &task.worker_profile
        }
    });
    let role_key = session.advisor_role.as_deref().unwrap_or(&session.kind);
    usage.sort_by(|left, right| left.started_at.cmp(&right.started_at));
    let mut turns = Vec::<(String, TimelineActivity)>::new();
    let last = usage.len().saturating_sub(1);
    for (index, entry) in usage.iter().enumerate() {
        let live = !entry.failed
            && entry.completed_at.is_none()
            && live_id == Some(entry.message_id.as_str())
            && index == last;
        let prior = turns
            .iter()
            .position(|(turn_id, _)| turn_id == &entry.turn_id);
        if entry.completed_at.is_none() && !live {
            if let Some((_, previous)) = prior.and_then(|position| turns.get_mut(position))
                && previous.status != "failed"
            {
                previous.status = if entry.failed {
                    "failed"
                } else {
                    "interrupted"
                };
            }
            continue;
        }
        let start = timestamp(entry.started_at)?;
        let end = if live {
            None
        } else {
            Some(timestamp(
                entry
                    .started_at
                    .max(entry.completed_at.unwrap_or(entry.started_at)),
            )?)
        };
        let previous = prior.and_then(|position| turns.get(position).map(|(_, value)| value));
        let combined = TimelineActivity {
            id: format!("{}:{}", session.id, entry.turn_id),
            role: session.kind.clone(),
            advisor_role: session.advisor_role.clone(),
            label: role_label(&session.kind, session.advisor_role.as_deref()).into(),
            agent_id: format!("{role_key}:{}", profile.profile_id),
            agent_name: profile.model.clone(),
            avatar_seed: profile.profile_id.clone(),
            status: if entry.failed || previous.is_some_and(|previous| previous.status == "failed")
            {
                "failed"
            } else if live {
                "running"
            } else {
                "completed"
            },
            attempt: session.generation,
            started_at: previous.map_or(start.clone(), |previous| {
                previous.started_at.clone().min(start)
            }),
            finished_at: if previous.is_some_and(|previous| previous.finished_at.is_none())
                || end.is_none()
            {
                None
            } else {
                previous
                    .and_then(|previous| previous.finished_at.clone())
                    .map_or(end.clone(), |prior_end| Some(prior_end.max(end.unwrap())))
            },
        };
        if let Some(position) = prior {
            turns[position].1 = combined;
        } else {
            turns.push((entry.turn_id.clone(), combined));
        }
    }
    Ok(turns.into_iter().map(|(_, entry)| entry).collect())
}

fn native_usage(
    database_path: &Path,
    session: &TimelineSession,
) -> Result<(Vec<TimelineUsage>, Option<String>), Box<dyn Error>> {
    let native_id = session
        .native_session_id
        .as_deref()
        .ok_or("Native session is missing")?;
    let observed = task_harness_registry::native_session_reader(native_id)
        .ok_or("Native timeline reader is not available")?
        .timeline(
            &ReaderSession {
                database_path,
                session_id: &session.id,
                native_session_id: native_id,
                instance_home_directory: None,
            },
            None,
        )?;
    let usage = observed
        .usage
        .into_iter()
        .map(|entry| TimelineUsage {
            session_id: native_id.into(),
            message_id: entry.message_id,
            turn_id: entry.turn_id,
            started_at: entry.started_at_ms,
            completed_at: entry.completed_at_ms,
            failed: entry.failed,
        })
        .collect();
    Ok((usage, observed.live_message_id))
}

pub fn observe(
    database_path: &Path,
    saved: SavedTimeline,
) -> Result<TimelineResponse, Box<dyn Error>> {
    let SavedTimeline {
        task,
        sessions,
        usage,
    } = saved;
    let mut target = TimelineTaskResponse {
        id: task.id.clone(),
        project_id: task.project_id.clone(),
        issue_key: task.issue_key.clone(),
        title: task.title.clone(),
        activity: Vec::new(),
    };
    let mut unavailable_sessions = 0;
    for session in sessions
        .iter()
        .filter(|session| session.native_session_id.is_some())
    {
        let mut merged = Vec::<TimelineUsage>::new();
        for entry in usage
            .iter()
            .filter(|entry| Some(entry.session_id.as_str()) == session.native_session_id.as_deref())
        {
            if let Some(previous) = merged
                .iter()
                .position(|previous| previous.message_id == entry.message_id)
            {
                merged[previous] = entry.clone();
            } else {
                merged.push(entry.clone());
            }
        }
        let mut live_id = None;
        if task.archived_at.is_none()
            && matches!(task.status.as_str(), "active" | "waiting_human")
            && session.current
            && matches!(session.lifecycle.as_str(), "live" | "unknown")
        {
            match native_usage(database_path, session) {
                Ok((native, current_live)) => {
                    for entry in native {
                        if let Some(previous) = merged
                            .iter()
                            .position(|previous| previous.message_id == entry.message_id)
                        {
                            merged[previous] = entry;
                        } else {
                            merged.push(entry);
                        }
                    }
                    live_id = current_live;
                }
                Err(_) => unavailable_sessions += 1,
            }
        }
        target
            .activity
            .extend(activity(&task, session, merged, live_id.as_deref())?);
    }
    Ok(TimelineResponse {
        tasks: vec![target],
        unavailable_sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (TimelineTask, TimelineSession) {
        let profile = Profile {
            profile_id: "profile".into(),
            model: "model".into(),
        };
        (
            TimelineTask {
                id: "task".into(),
                project_id: "project".into(),
                issue_key: None,
                title: "Task".into(),
                status: "active".into(),
                archived_at: None,
                root_profile: profile.clone(),
                worker_profile: profile,
                advisor_profiles: HashMap::new(),
            },
            TimelineSession {
                id: "root".into(),
                kind: "root".into(),
                advisor_role: None,
                generation: 1,
                current: true,
                lifecycle: "live".into(),
                native_session_id: Some("codex-1".into()),
                profile: None,
            },
        )
    }

    #[test]
    fn groups_turn_steps_and_preserves_interrupted_native_history() {
        let (task, session) = fixture();
        let entry = |message: &str, turn: &str, start: i64, end: Option<i64>| TimelineUsage {
            session_id: "codex-1".into(),
            message_id: message.into(),
            turn_id: turn.into(),
            started_at: start,
            completed_at: end,
            failed: false,
        };
        let recorded = vec![
            entry("two", "turn", 200, Some(300)),
            entry("one", "turn", 100, Some(200)),
            entry("abandoned", "later", 1000, None),
        ];
        let grouped = activity(&task, &session, recorded, None).unwrap();
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].started_at, "1970-01-01T00:00:00.100Z");
        assert_eq!(
            grouped[0].finished_at.as_deref(),
            Some("1970-01-01T00:00:00.300Z")
        );
        let running = activity(
            &task,
            &session,
            vec![
                entry("done", "turn", 1000, Some(1100)),
                entry("live", "turn", 1100, None),
            ],
            Some("live"),
        )
        .unwrap();
        assert_eq!(running[0].status, "running");
        assert_eq!(running[0].finished_at, None);
    }

    #[test]
    fn native_overlay_and_missing_record_preserve_saved_timing() {
        let (task, session) = fixture();
        let saved = SavedTimeline {
            task,
            sessions: vec![session],
            usage: vec![TimelineUsage {
                session_id: "codex-1".into(),
                message_id: "msg_old".into(),
                turn_id: "msg_old".into(),
                started_at: 1000,
                completed_at: Some(2000),
                failed: false,
            }],
        };
        let root =
            std::env::temp_dir().join(format!("suplex-task-timeline-{}", uuid::Uuid::new_v4()));
        let database_path = root.join("suplex.sqlite");
        let directory =
            crate::runtimes::task_harness::task_session_runtime_directory(&database_path, "root")
                .unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        let log = directory.join("turn-msg_native.jsonl");
        std::fs::write(&log, concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-timeline\"}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n"
        )).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&log)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(4000)),
            )
            .unwrap();
        let observed = observe(&database_path, saved.clone()).unwrap();
        assert_eq!(observed.unavailable_sessions, 0);
        assert_eq!(observed.tasks[0].activity.len(), 2);
        assert_eq!(
            observed.tasks[0].activity[1].started_at,
            "1970-01-01T00:00:04.000Z"
        );
        std::fs::remove_dir_all(&directory).unwrap();
        let missing = observe(&database_path, saved.clone()).unwrap();
        assert_eq!(missing.unavailable_sessions, 1);
        assert_eq!(missing.tasks[0].activity.len(), 1);
        assert_eq!(
            missing.tasks[0].activity[0].finished_at.as_deref(),
            Some("1970-01-01T00:00:02.000Z")
        );
        let mut archived = saved;
        archived.task.archived_at = Some("2026-01-01T00:00:00.000Z".into());
        let archived = observe(&database_path, archived).unwrap();
        assert_eq!(archived.unavailable_sessions, 0);
        assert_eq!(archived.tasks[0].activity.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
