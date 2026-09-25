use std::{
    collections::{BTreeSet, HashMap},
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use super::{
    advisor_evidence,
    task_runtime::{session_busy, turn_running},
    transcript::{self, DevinTurn},
};
use crate::runtimes::{
    headless::{self, HeadlessTurnRecord},
    task_harness::NativeTimeline,
};

fn file_stat(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn milliseconds(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}

fn modified_at(file: &fs::Metadata) -> i64 {
    file.modified().map_or(0, milliseconds)
}

fn created_at(file: &fs::Metadata) -> i64 {
    file.created()
        .map(milliseconds)
        .ok()
        .filter(|created| *created > 0)
        .unwrap_or_else(|| modified_at(file))
}

fn read_optional(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn dispatch_record_name(name: &str) -> bool {
    name.strip_prefix("dispatch-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-'))
        })
}

/// Turns come from native output files and durable dispatch records, never from a Suplex receipt.
pub fn turns(
    runtime_directory: &Path,
    native_session_id: Option<&str>,
) -> io::Result<Vec<DevinTurn>> {
    let entries = match fs::read_dir(runtime_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let names = entries
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<io::Result<Vec<_>>>()?;
    let mut ids = names
        .iter()
        .filter_map(|name| {
            let (id, extension) = name.strip_prefix("turn-")?.rsplit_once('.')?;
            (["jsonl", "prompt", "exit"].contains(&extension) && valid_id(id))
                .then(|| id.to_owned())
        })
        .collect::<BTreeSet<_>>();
    let mut records = HashMap::<String, Vec<(HeadlessTurnRecord, i64)>>::new();
    for name in names.iter().filter(|name| dispatch_record_name(name)) {
        let path = runtime_directory.join(name);
        let (Some(record), Some(metadata)) = (headless::read_record(&path)?, file_stat(&path)?)
        else {
            continue;
        };
        if Some(record.session_id.as_str()) != native_session_id {
            continue;
        }
        ids.insert(record.turn_id.clone());
        records
            .entry(record.turn_id.clone())
            .or_default()
            .push((record, created_at(&metadata)));
    }
    let mut turns = Vec::new();
    for id in ids {
        let prompt = file_stat(&headless::turn_file(runtime_directory, &id, "prompt"))?;
        let log_path = headless::turn_file(runtime_directory, &id, "jsonl");
        let exit_path = headless::turn_file(runtime_directory, &id, "exit");
        let (log, exit) = (file_stat(&log_path)?, file_stat(&exit_path)?);
        let (output, exit_text) = (read_optional(&log_path)?, read_optional(&exit_path)?);
        let dispatches = records.get(&id).map(Vec::as_slice).unwrap_or_default();
        let running = dispatches.iter().any(|(record, _)| turn_running(record));
        let started_at = prompt
            .as_ref()
            .map(created_at)
            .or_else(|| dispatches.iter().map(|(_, created)| *created).min())
            .or_else(|| log.as_ref().map(created_at))
            .or_else(|| exit.as_ref().map(created_at));
        let Some(started_at) = started_at else {
            continue;
        };
        let completed_at = exit
            .as_ref()
            .filter(|_| !running && exit_text.is_some())
            .map(modified_at);
        turns.push(DevinTurn {
            text: transcript::result_text(output.as_deref().unwrap_or_default()).to_owned(),
            text_at: log.as_ref().map_or(started_at, modified_at),
            started_at,
            completed_at,
            failed: completed_at.is_some() && exit_text.as_deref().map(str::trim) != Some("0"),
            running,
            id,
        });
    }
    turns.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(turns)
}

pub fn history(
    runtime_directory: &Path,
    native_session_id: Option<&str>,
) -> io::Result<Vec<Value>> {
    Ok(transcript::history(&turns(
        runtime_directory,
        native_session_id,
    )?))
}

pub fn execution() -> Value {
    json!({ "tools": [], "plan": null, "limited": true })
}

pub fn turn_evidence(
    runtime_directory: &Path,
    turn_id: &str,
) -> io::Result<advisor_evidence::AdvisorEvidence> {
    advisor_evidence::read(runtime_directory, turn_id)
}

/// Returns `("busy" | "idle", updatedAt)`; a session without `turn.json` has no status.
pub fn status(runtime_directory: &Path) -> io::Result<(&'static str, i64)> {
    let updated_at = modified_at(&fs::metadata(runtime_directory.join("turn.json"))?);
    let status = if session_busy(runtime_directory)? {
        "busy"
    } else {
        "idle"
    };
    Ok((status, updated_at))
}

pub fn timeline(
    runtime_directory: &Path,
    native_session_id: Option<&str>,
) -> io::Result<NativeTimeline> {
    let Some(native_session_id) = native_session_id else {
        return Err(io::Error::other("Session is not available"));
    };
    let turns = turns(runtime_directory, Some(native_session_id))?;
    Ok(NativeTimeline {
        usage: transcript::usage(&turns),
        live_message_id: turns
            .iter()
            .find(|turn| turn.running)
            .map(|turn| turn.id.clone()),
    })
}

/// Archive refuses while the native process is active; stopping is a no-op afterwards.
pub fn archive(runtime_directory: &Path) -> io::Result<()> {
    if session_busy(runtime_directory)? {
        return Err(io::Error::other(
            "An agent is still active. Retry after it stops.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::task_runtime::{
        self,
        tests::{Fixture, SESSION, dispatch_turn, eventually},
    };
    use super::*;
    use crate::runtimes::{codex::runtime::PromptState, task_harness::UsageEntry};
    use std::{fs::File, time::Duration};

    fn dispatch_record(directory: &Path) -> std::path::PathBuf {
        fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| dispatch_record_name(&entry.file_name().to_string_lossy()))
            .unwrap()
            .path()
    }

    fn usage_for<'a>(timeline: &'a NativeTimeline, turn: &str) -> &'a UsageEntry {
        timeline
            .usage
            .iter()
            .find(|usage| usage.message_id == turn)
            .unwrap()
    }

    #[test]
    fn timeline_keeps_completed_execution_time_when_the_output_log_changes() {
        let f = Fixture::new("complete");
        let directory = f.directory("session-devin");
        dispatch_turn(&f.worker(), SESSION, "msg_1", "Implement the change");
        assert_eq!(
            eventually(&directory, SESSION, "msg_1").state,
            PromptState::Completed
        );
        let file = |suffix| headless::turn_file(&directory, "msg_1", suffix);
        let first = timeline(&directory, Some(SESSION)).unwrap().usage[0].clone();
        assert!(first.started_at_ms <= modified_at(&fs::metadata(file("prompt")).unwrap()));
        assert_eq!(
            first.completed_at_ms.unwrap(),
            modified_at(&fs::metadata(file("exit")).unwrap())
        );
        File::options()
            .write(true)
            .open(file("jsonl"))
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(60))
            .unwrap();
        let after = timeline(&directory, Some(SESSION)).unwrap().usage[0].clone();
        assert_eq!(after.started_at_ms, first.started_at_ms);
        assert_eq!(after.completed_at_ms, first.completed_at_ms);
        assert!(!after.failed);
        fs::remove_file(file("prompt")).unwrap();
        let record = fs::metadata(dispatch_record(&directory)).unwrap();
        assert_eq!(
            timeline(&directory, Some(SESSION)).unwrap().usage[0].started_at_ms,
            created_at(&record)
        );
        assert_eq!(
            history(&directory, Some(SESSION)).unwrap()[0]["content"][0]["text"],
            "Reviewed the change."
        );
    }

    #[test]
    fn timeline_identifies_the_running_silent_dispatch_without_turn_json_or_output_ordering() {
        let f = Fixture::new("silent_hang");
        let directory = f.directory("session-devin");
        fs::create_dir_all(&directory).unwrap();
        let completed = "zzzz-completed";
        fs::write(
            headless::turn_file(&directory, completed, "prompt"),
            "Earlier request",
        )
        .unwrap();
        fs::write(
            headless::turn_file(&directory, completed, "jsonl"),
            "Earlier answer",
        )
        .unwrap();
        fs::write(headless::turn_file(&directory, completed, "exit"), "0\n").unwrap();
        dispatch_turn(&f.worker(), SESSION, "msg_live", "Implement the change");
        fs::write(headless::turn_file(&directory, "msg_live", "exit"), "0\n").unwrap();
        let first = timeline(&directory, Some(SESSION)).unwrap();
        assert_eq!(first.live_message_id.as_deref(), Some("msg_live"));
        assert!(usage_for(&first, completed).completed_at_ms.is_some());
        assert!(!usage_for(&first, completed).failed);
        assert!(usage_for(&first, "msg_live").completed_at_ms.is_none());
        assert!(!usage_for(&first, "msg_live").failed);
        let started_at = usage_for(&first, "msg_live").started_at_ms;
        fs::write(
            headless::turn_file(&directory, "msg_live", "jsonl"),
            "New output",
        )
        .unwrap();
        fs::remove_file(directory.join("turn.json")).unwrap();
        let after_missing = timeline(&directory, Some(SESSION)).unwrap();
        assert_eq!(after_missing.live_message_id.as_deref(), Some("msg_live"));
        assert_eq!(
            usage_for(&after_missing, "msg_live").started_at_ms,
            started_at
        );
        fs::copy(dispatch_record(&directory), directory.join("turn.json")).unwrap();
        assert_eq!(
            timeline(&directory, Some(SESSION))
                .unwrap()
                .live_message_id
                .as_deref(),
            Some("msg_live")
        );
        task_runtime::stop(&directory, Some(SESSION)).unwrap();
    }

    #[test]
    fn timeline_records_failures_and_leaves_a_turn_without_exit_evidence_incomplete() {
        let f = Fixture::new("crash");
        let directory = f.directory("session-devin");
        dispatch_turn(&f.worker(), SESSION, "msg_crash", "Implement the change");
        assert_eq!(
            eventually(&directory, SESSION, "msg_crash").state,
            PromptState::Error
        );
        let failed = timeline(&directory, Some(SESSION)).unwrap().usage;
        assert_eq!(failed.len(), 1);
        assert!(failed[0].failed);
        assert!(failed[0].completed_at_ms.is_some());
        fs::remove_file(headless::turn_file(&directory, "msg_crash", "exit")).unwrap();
        let incomplete = timeline(&directory, Some(SESSION)).unwrap().usage;
        assert!(!incomplete[0].failed);
        assert!(incomplete[0].completed_at_ms.is_none());
        assert_eq!(status(&directory).unwrap().0, "idle");
    }

    #[test]
    fn analytics_reads_devin_usage_from_the_suplex_session_runtime_directory() {
        let f = Fixture::new("complete");
        let directory = f.directory("suplex-session");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("turn-turn-1.jsonl"),
            "Reviewed the change.\n",
        )
        .unwrap();
        let usage = timeline(&directory, Some("devin-reserved")).unwrap().usage;
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].message_id, "turn-1");
        assert_eq!(usage[0].provider, "devin");
        assert!(timeline(&directory, None).is_err());
    }
}
