use crate::runtimes::native::{DispatchState, PromptObservation, PromptState};
use crate::shared::fs::read_optional;
use nix::errno::Errno;
use nix::sys::signal::kill;
use nix::unistd::Pid;
use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::Path;

use super::cli::{PiCli, SessionIdentity};
use super::invocation::{self, Role, SessionArgument};
use super::session_reader;
use super::transcript;
use crate::runtimes::headless::{self, DispatchInput};

fn read_events(directory: &Path, turn_id: &str) -> io::Result<Vec<transcript::PiEvent>> {
    Ok(transcript::parse_events(
        &read_optional(&headless::turn_file(directory, turn_id, "jsonl"))?.unwrap_or_default(),
    ))
}

fn unsettled(events: &[transcript::PiEvent]) -> Vec<String> {
    transcript::unsettled_tool_ids(events)
        .into_iter()
        .take(32)
        .map(str::to_owned)
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
    // The process can finish between the first log read and the liveness check;
    // its final events are complete only once it is observed stopped.
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
        // A tool's command can outlive the native process; stop it either way.
        headless::stop_execution(directory, &record.generation)?;
    }
    // Pi settles a failed response normally and exits 0, and omp exits 1,
    // so the final response decides before completion and exit status do.
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

pub struct PiDispatch<'a> {
    pub cli: &'a PiCli,
    pub directory: &'a Path,
    pub worktree: &'a Path,
    pub executable: &'a Path,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub prompt: &'a str,
    pub model: &'a str,
    pub reasoning_effort: &'a str,
    pub role: Role,
    pub bridge_extension: Option<&'a Path>,
    pub endpoint_extension: Option<&'a Path>,
    pub environment: &'a HashMap<String, String>,
    pub excluded_environment_keys: &'a [String],
}

/// One detached `--mode json` process per turn. A Pi turn names the session
/// id, so Pi resumes the conversation itself. An omp turn resumes the
/// session file that its private directory already holds, if any.
pub fn dispatch<F>(
    input: PiDispatch<'_>,
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
        return Err(io::Error::other(format!(
            "{} prompt was not proven absent; replay is blocked",
            input.cli.executable.label
        ))
        .into());
    }
    let existing = match input.cli.session_identity {
        SessionIdentity::Named => None,
        SessionIdentity::Resumed => {
            session_reader::session_file(input.cli, input.directory, input.session_id)?
        }
    };
    let session = match (input.cli.session_identity, existing.as_deref()) {
        (SessionIdentity::Named, _) => SessionArgument::Id(input.session_id),
        (SessionIdentity::Resumed, Some(file)) => SessionArgument::Resume(file),
        (SessionIdentity::Resumed, None) => SessionArgument::New,
    };
    let args = invocation::pi_arguments(
        input.cli,
        &invocation::TurnArguments {
            model: input.model,
            reasoning_effort: input.reasoning_effort,
            role: input.role,
            session_directory: &session_reader::session_directory(input.cli, input.directory),
            session,
            bridge: input.bridge_extension,
            endpoint: input.endpoint_extension,
        },
    );
    let record = headless::dispatch_with_exclusions(
        DispatchInput {
            directory: input.directory,
            worktree: input.worktree,
            session_id: input.session_id,
            turn_id: input.turn_id,
            executable: input.executable,
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
        return Ok(failure.to_owned());
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
            session_id: "pi-session-1".into(),
            pid: 999_999,
            process_identity: RecordedProcessIdentity {
                command: "/bin/sh".into(),
                executable: "/bin/sh".into(),
                argv: vec!["/bin/sh".into()],
                process_group: 999_999,
                start_time: "gone".into(),
                owner_uid: 501,
            },
            dispatch_arguments: vec!["pi".into(), "--mode".into(), "json".into()],
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
            "pi-session-1",
            "msg_1",
            DispatchState::Ambiguous,
            None,
        )
        .unwrap()
    }

    #[test]
    fn native_log_and_record_determine_the_turn_state_without_a_replay_receipt() {
        let directory =
            std::env::temp_dir().join(format!("suplex-pi-observe-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let before = observe(
            &directory,
            "pi-session-1",
            "msg_1",
            DispatchState::NotSubmitted,
            None,
        )
        .unwrap();
        assert!(before.retry_allowed);
        fs::write(headless::turn_file(&directory, "msg_1", "jsonl"), TURN).unwrap();
        let missing_record = observe(
            &directory,
            "pi-session-1",
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
        assert_eq!(result_text(&directory, "msg_1").unwrap(), "Done.");

        let header = TURN.lines().next().unwrap();
        let started = "{\"type\":\"tool_execution_start\",\"toolCallId\":\"call_7\",\"toolName\":\"bash\",\"args\":{\"command\":\"sleep 60\"}}";
        let failed = "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"errorMessage\":\"Connection error.\"}}\n{\"type\":\"agent_end\",\"willRetry\":false}\n{\"type\":\"agent_settled\",\"aborted\":false}";
        for (events, exit, state, reason) in [
            (
                format!("{header}\n{started}\n"),
                Some("0"),
                PromptState::Interrupted,
                "tool_execution_after_process_stopped",
            ),
            (
                format!("{header}\n{failed}\n"),
                Some("0"),
                PromptState::Error,
                "native_error",
            ),
            (
                format!("{header}\n{{\"type\":\"agent_settled\",\"aborted\":true}}\n"),
                Some("0"),
                PromptState::Interrupted,
                "native_turn_aborted",
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
        assert_eq!(
            result_text(&directory, "msg_1").unwrap(),
            "",
            "a header alone has no result"
        );
        fs::write(
            headless::turn_file(&directory, "msg_1", "jsonl"),
            format!("{header}\n{failed}\n"),
        )
        .unwrap();
        assert_eq!(
            result_text(&directory, "msg_1").unwrap(),
            "Connection error."
        );
        // A real omp turn ends at `agent_end` without `agent_settled`.
        fs::write(
            headless::turn_file(&directory, "msg_1", "jsonl"),
            include_str!("fixtures/omp-turn.jsonl"),
        )
        .unwrap();
        fs::write(headless::turn_file(&directory, "msg_1", "exit"), "0").unwrap();
        let omp = observed(&directory);
        assert_eq!(
            (omp.state, omp.reason),
            (PromptState::Completed, "native_turn_completed")
        );
        assert_eq!(result_text(&directory, "msg_1").unwrap(), "Done.");
        fs::remove_dir_all(directory).unwrap();
    }
}
