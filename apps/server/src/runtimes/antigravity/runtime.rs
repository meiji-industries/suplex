//! Antigravity turn observation and dispatch over the shared headless
//! runtime. The turn log and the recorded process are the evidence; no
//! separate receipt decides a prompt's state.

use std::{collections::HashMap, error::Error, io, path::Path};

use nix::{errno::Errno, sys::signal::kill, unistd::Pid};

use super::{session_reader, transcript, turn::TurnArgs};
use crate::{
    runtimes::{
        headless::{self, DispatchInput},
        native::{DispatchState, PromptObservation, PromptState},
    },
    shared::fs::read_optional,
};

fn read_events(directory: &Path, turn_id: &str) -> io::Result<Vec<serde_json::Value>> {
    Ok(transcript::parse_events(
        &read_optional(&headless::turn_file(directory, turn_id, "jsonl"))?.unwrap_or_default(),
    ))
}

fn unsettled(events: &[serde_json::Value]) -> Vec<String> {
    transcript::unsettled_tool_ids(events)
        .into_iter()
        .take(32)
        .collect()
}

pub fn observe(
    directory: &Path,
    session_id: &str,
    turn_id: &str,
    dispatch: DispatchState,
    generation: Option<&str>,
) -> io::Result<PromptObservation> {
    let record = headless::admitted_record(directory, turn_id, generation)?;
    let log = read_optional(&headless::turn_file(directory, turn_id, "jsonl"))?;
    if let Some(observed) =
        headless::observe_admission(record.as_ref(), session_id, dispatch, log.is_some())
    {
        return Ok(observed);
    }
    let record = record.expect("admission checked");
    let events = transcript::parse_events(log.as_deref().unwrap_or_default());
    let mut result = PromptObservation {
        state: PromptState::Running,
        admission_observed: true,
        retry_allowed: false,
        reason: "dispatch_process_running",
        unsettled_tool_ids: unsettled(&events),
        native_final_observed: transcript::completed(&events),
        process_running: false,
        execution_uncertain: false,
    };
    if headless::running(&record)? {
        result.process_running = true;
        return Ok(result);
    }
    // The process can finish between the first log read and the liveness
    // check; its final events are complete only once it is observed stopped.
    let events = read_events(directory, turn_id)?;
    let completed = transcript::completed(&events);
    result.unsettled_tool_ids = unsettled(&events);
    result.native_final_observed = completed;
    let exit = read_optional(&headless::turn_file(directory, turn_id, "exit"))?;
    if !result.unsettled_tool_ids.is_empty() {
        if exit.is_none() {
            let pid = i32::try_from(record.pid).map_err(io::Error::other)?;
            match kill(Pid::from_raw(pid), None) {
                Ok(()) | Err(Errno::EPERM) => {
                    return Err(io::Error::other("Native process liveness is uncertain"));
                }
                Err(Errno::ESRCH) => {}
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        // A tool's command can outlive the agent; stop it either way.
        headless::stop_execution(directory, &record.generation)?;
    }
    (result.state, result.reason) = if transcript::failure(&events).is_some() {
        (PromptState::Error, "native_error")
    } else if transcript::aborted(&events) {
        (PromptState::Interrupted, "native_turn_aborted")
    } else if completed {
        (PromptState::Completed, "native_turn_completed")
    } else if !result.unsettled_tool_ids.is_empty() {
        (
            PromptState::Interrupted,
            "tool_execution_after_process_stopped",
        )
    } else if exit.is_some() && transcript::session_id(&events).is_none() {
        (PromptState::Error, "native_startup_failed")
    } else {
        (PromptState::Interrupted, "dispatch_process_stopped")
    };
    Ok(result)
}

pub struct AntigravityDispatch<'a> {
    pub directory: &'a Path,
    pub worktree: &'a Path,
    /// The Suplex program that runs `antigravity-turn`.
    pub driver: &'a Path,
    pub turn: TurnArgs,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub prompt: &'a str,
    pub environment: &'a HashMap<String, String>,
    pub excluded_environment_keys: &'a [String],
}

/// One detached ACP client process per turn. A later turn resumes the native
/// session that the latest turn log names; the first creates it.
pub fn dispatch<F>(
    mut input: AntigravityDispatch<'_>,
    claim: F,
) -> Result<PromptObservation, Box<dyn Error + Send + Sync>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error + Send + Sync>>,
{
    let before = observe(
        input.directory,
        input.session_id,
        input.turn_id,
        DispatchState::NotSubmitted,
        None,
    )?;
    if !before.retry_allowed {
        return Err(io::Error::other(
            "Antigravity prompt was not proven absent; replay is blocked",
        )
        .into());
    }
    input.turn.resume = session_reader::native_session(input.directory)?;
    let args = input.turn.to_args();
    let record = headless::dispatch_with_exclusions(
        DispatchInput {
            directory: input.directory,
            worktree: input.worktree,
            session_id: input.session_id,
            turn_id: input.turn_id,
            executable: input.driver,
            args: &args,
            prompt: input.prompt,
            environment: input.environment,
        },
        input.excluded_environment_keys,
        claim,
    )?;
    Ok(observe(
        input.directory,
        input.session_id,
        input.turn_id,
        DispatchState::Ambiguous,
        Some(&record.generation),
    )?)
}

pub fn result_text(directory: &Path, turn_id: &str) -> io::Result<String> {
    let events = read_events(directory, turn_id)?;
    let result = transcript::result_text(&events);
    if !result.is_empty() {
        return Ok(result);
    }
    if let Some(failure) = transcript::failure(&events) {
        return Ok(failure);
    }
    let stderr =
        read_optional(&headless::turn_file(directory, turn_id, "stderr.log"))?.unwrap_or_default();
    Ok(stderr
        .trim()
        .chars()
        .rev()
        .take(2_000)
        .collect::<String>()
        .chars()
        .rev()
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::headless::{HeadlessTurnRecord, RecordedProcessIdentity};
    use std::fs;

    const TURN: &str = include_str!("fixtures/turn.jsonl");

    fn stopped_record(directory: &Path) {
        let record = HeadlessTurnRecord {
            generation: "generation-1".into(),
            turn_id: "msg_1".into(),
            session_id: "antigravity-session-1".into(),
            pid: 999_999,
            process_identity: RecordedProcessIdentity {
                command: "/bin/sh".into(),
                executable: "/bin/sh".into(),
                argv: vec!["/bin/sh".into()],
                process_group: 999_999,
                start_time: "gone".into(),
                owner_uid: 501,
            },
            dispatch_arguments: vec!["suplex".into(), "antigravity-turn".into()],
        };
        fs::write(
            directory.join("turn.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }

    fn observed(directory: &Path) -> PromptObservation {
        observe(
            directory,
            "antigravity-session-1",
            "msg_1",
            DispatchState::Ambiguous,
            None,
        )
        .unwrap()
    }

    #[test]
    fn the_turn_log_and_process_record_decide_the_state_without_a_receipt() {
        let directory = std::env::temp_dir().join(format!(
            "suplex-antigravity-observe-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&directory).unwrap();
        let before = observe(
            &directory,
            "antigravity-session-1",
            "msg_1",
            DispatchState::NotSubmitted,
            None,
        )
        .unwrap();
        assert!(before.retry_allowed);
        // A log without its process record is not proof of absence: the
        // record was lost, not the turn.
        fs::write(headless::turn_file(&directory, "msg_1", "jsonl"), TURN).unwrap();
        let missing_record = observe(
            &directory,
            "antigravity-session-1",
            "msg_1",
            DispatchState::NotSubmitted,
            None,
        )
        .unwrap();
        assert_eq!(missing_record.state, PromptState::Unknown);
        assert!(!missing_record.retry_allowed);
        stopped_record(&directory);
        let finished = observed(&directory);
        assert_eq!(finished.state, PromptState::Completed);
        assert!(finished.native_final_observed);
        assert_eq!(result_text(&directory, "msg_1").unwrap(), "All tests pass.");

        let header = TURN.lines().take(2).collect::<Vec<_>>().join("\n");
        let running = "{\"type\":\"update\",\"update\":{\"sessionUpdate\":\"tool_call\",\"toolCallId\":\"call_7\",\"kind\":\"execute\",\"status\":\"in_progress\",\"rawInput\":{\"CommandLine\":\"sleep 60\"}}}";
        let signed_out = "{\"type\":\"error\",\"message\":\"Antigravity is not signed in.\",\"signInRequired\":true}";
        for (events, exit, state, reason) in [
            (
                format!("{header}\n{running}\n"),
                Some("0"),
                PromptState::Interrupted,
                "tool_execution_after_process_stopped",
            ),
            (
                format!("{header}\n{{\"type\":\"prompt_result\",\"stopReason\":\"cancelled\"}}\n"),
                Some("1"),
                PromptState::Interrupted,
                "native_turn_aborted",
            ),
            (
                format!("{signed_out}\n"),
                Some("1"),
                PromptState::Error,
                "native_error",
            ),
            (
                String::new(),
                Some("1"),
                PromptState::Error,
                "native_startup_failed",
            ),
            (
                format!("{header}\n"),
                None,
                PromptState::Interrupted,
                "dispatch_process_stopped",
            ),
        ] {
            fs::write(headless::turn_file(&directory, "msg_1", "jsonl"), events).unwrap();
            let exit_path = headless::turn_file(&directory, "msg_1", "exit");
            match exit {
                Some(code) => fs::write(&exit_path, code).unwrap(),
                None => {
                    let _ = fs::remove_file(&exit_path);
                }
            }
            let observation = observed(&directory);
            assert_eq!((observation.state, observation.reason), (state, reason));
        }
        fs::write(
            headless::turn_file(&directory, "msg_1", "jsonl"),
            format!("{signed_out}\n"),
        )
        .unwrap();
        assert_eq!(
            result_text(&directory, "msg_1").unwrap(),
            "Antigravity is not signed in."
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
