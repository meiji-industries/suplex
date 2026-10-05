use crate::runtimes::native::{DispatchState, PromptObservation, PromptState};
use crate::shared::fs::read_optional;
use nix::errno::Errno;
use nix::sys::signal::kill;
use nix::unistd::Pid;
use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::Path;

use super::invocation::{self, BridgeServer, Role};
use super::thread;
use super::transcript;
use crate::runtimes::headless::{self, DispatchInput};

fn observation(
    state: PromptState,
    admission_observed: bool,
    retry_allowed: bool,
    reason: &'static str,
) -> PromptObservation {
    PromptObservation {
        state,
        admission_observed,
        retry_allowed,
        reason,
        unsettled_tool_ids: Vec::new(),
        native_final_observed: false,
        process_running: false,
        execution_uncertain: false,
    }
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
    if let Some(thread_id) = transcript::thread_id(&events) {
        thread::persist_observed_thread(directory, thread_id)?;
    }
    let unsettled = transcript::unsettled_tool_ids(&events);
    let completed = transcript::completed(&events);
    let mut result = observation(
        PromptState::Running,
        true,
        false,
        "dispatch_process_running",
    );
    result.unsettled_tool_ids = unsettled.into_iter().take(32).map(str::to_owned).collect();
    result.native_final_observed = completed;
    if headless::running(&record)? {
        result.process_running = true;
        return Ok(result);
    }
    // The process can finish between the first log read and the liveness check;
    // its final events are complete only once it is observed stopped.
    let events = transcript::parse_events(
        &read_optional(&headless::turn_file(directory, turn_id, "jsonl"))?.unwrap_or_default(),
    );
    let completed = transcript::completed(&events);
    result.unsettled_tool_ids = transcript::unsettled_tool_ids(&events)
        .into_iter()
        .take(32)
        .map(str::to_owned)
        .collect();
    result.native_final_observed = completed;
    let exit = read_optional(&headless::turn_file(directory, turn_id, "exit"))?;
    if !result.unsettled_tool_ids.is_empty() {
        if exit.is_none() {
            let pid = i32::try_from(record.pid).map_err(io::Error::other)?;
            match kill(Pid::from_raw(pid), None) {
                Ok(()) | Err(Errno::EPERM) => {
                    return Err(io::Error::other("Codex process liveness is uncertain"));
                }
                Err(Errno::ESRCH) => {}
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        // A yielded command can outlive a turn that Codex finished; stop it either way.
        headless::stop_execution(directory, &record.generation)?;
    }
    if completed {
        result.state = PromptState::Completed;
        result.reason = "native_turn_completed";
    } else if !result.unsettled_tool_ids.is_empty() {
        result.state = PromptState::Interrupted;
        result.reason = "tool_execution_after_process_stopped";
    } else if transcript::failure(&events).is_some() {
        result.state = PromptState::Error;
        result.reason = "native_error";
    } else if exit.is_none() {
        result.state = PromptState::Interrupted;
        result.reason = "dispatch_process_stopped";
    } else if transcript::thread_id(&events).is_none() {
        let arguments = if record.dispatch_arguments.is_empty() {
            &record.process_identity.argv
        } else {
            &record.dispatch_arguments
        };
        if arguments.iter().any(|argument| argument == "resume") {
            let stderr = read_optional(&headless::turn_file(directory, turn_id, "stderr.log"))?
                .unwrap_or_default();
            let unresumable = regex::Regex::new(
                r"(?i)no rollout found|rollout .* is empty|thread .*not found|missing thread|no archived rollout",
            )
            .expect("Codex unresumable error pattern");
            if unresumable.is_match(&stderr) {
                thread::forget_unresumable_thread(directory)?;
            }
        }
        result.state = PromptState::Error;
        result.reason = "native_startup_failed";
    } else {
        result.state = PromptState::Interrupted;
        result.reason = "dispatch_process_stopped";
    }
    Ok(result)
}

pub struct CodexDispatch<'a> {
    pub directory: &'a Path,
    pub worktree: &'a Path,
    pub executable: &'a Path,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub prompt: &'a str,
    pub model: &'a str,
    pub reasoning_effort: &'a str,
    pub role: Role,
    pub bridge: Option<&'a BridgeServer<'a>>,
    pub environment: &'a HashMap<String, String>,
    pub excluded_environment_keys: &'a [String],
}

pub fn dispatch<F>(input: CodexDispatch<'_>, claim: F) -> Result<PromptObservation, Box<dyn Error>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error>>,
{
    let before = observe(
        input.directory,
        input.session_id,
        input.turn_id,
        DispatchState::NotSubmitted,
        None,
    )?;
    if !before.retry_allowed {
        return Err(
            io::Error::other("Codex prompt was not proven absent; replay is blocked").into(),
        );
    }
    let resume = thread::recover_thread_id(input.directory)?;
    let args = invocation::codex_arguments(
        input.model,
        input.reasoning_effort,
        input.role,
        resume.as_deref(),
        input.bridge,
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
    let events = transcript::parse_events(
        &read_optional(&headless::turn_file(directory, turn_id, "jsonl"))?.unwrap_or_default(),
    );
    let result = transcript::result_text(&events);
    if !result.is_empty() {
        return Ok(result.to_owned());
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

    #[test]
    fn native_log_and_record_determine_completion_without_replay_receipt() {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "suplex-codex-observe-{}",
            u64::from_ne_bytes(suffix)
        ));
        fs::create_dir(&directory).unwrap();
        let before = observe(
            &directory,
            "session-1",
            "msg_1",
            DispatchState::NotSubmitted,
            None,
        )
        .unwrap();
        assert!(before.retry_allowed);
        fs::write(headless::turn_file(&directory, "msg_1", "jsonl"), "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"Done\"}}\n{\"type\":\"turn.completed\"}\n").unwrap();
        let missing_record = observe(
            &directory,
            "session-1",
            "msg_1",
            DispatchState::NotSubmitted,
            None,
        )
        .unwrap();
        assert_eq!(missing_record.state, PromptState::Unknown);
        assert!(!missing_record.retry_allowed);
        let record = HeadlessTurnRecord {
            generation: "generation-1".into(),
            turn_id: "msg_1".into(),
            session_id: "session-1".into(),
            pid: 999_999,
            process_identity: RecordedProcessIdentity {
                command: "/bin/sh".into(),
                executable: "/bin/sh".into(),
                argv: vec!["/bin/sh".into()],
                process_group: 999_999,
                start_time: "gone".into(),
                owner_uid: 501,
            },
            dispatch_arguments: vec!["codex".into(), "exec".into()],
        };
        fs::write(
            directory.join("turn.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        let finished = observe(
            &directory,
            "session-1",
            "msg_1",
            DispatchState::Ambiguous,
            None,
        )
        .unwrap();
        assert_eq!(finished.state, PromptState::Completed);
        assert!(finished.native_final_observed);
        assert_eq!(
            thread::read_thread_id(&directory).unwrap().as_deref(),
            Some("thread-1")
        );
        assert_eq!(result_text(&directory, "msg_1").unwrap(), "Done");
        let started = "{\"type\":\"item.started\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\"}}\n";
        for (events, state) in [
            (
                format!("{started}{{\"type\":\"turn.completed\"}}\n"),
                PromptState::Completed,
            ),
            (started.to_owned(), PromptState::Interrupted),
        ] {
            fs::write(headless::turn_file(&directory, "msg_1", "jsonl"), events).unwrap();
            fs::write(headless::turn_file(&directory, "msg_1", "exit"), "0").unwrap();
            let yielded = observe(
                &directory,
                "session-1",
                "msg_1",
                DispatchState::Ambiguous,
                None,
            )
            .unwrap();
            assert_eq!(yielded.state, state);
            assert_eq!(yielded.unsettled_tool_ids, ["item_1"]);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn only_an_unresumable_resume_forgets_the_persisted_codex_thread() {
        for (stderr, forgotten) in [
            ("error: no rollout found for thread id thread-1", true),
            ("Error: Not logged in", false),
        ] {
            let directory =
                std::env::temp_dir().join(format!("suplex-codex-resume-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            thread::persist_thread_id(&directory, "thread-1").unwrap();
            fs::write(headless::turn_file(&directory, "msg_1", "jsonl"), "").unwrap();
            fs::write(
                headless::turn_file(&directory, "msg_1", "stderr.log"),
                stderr,
            )
            .unwrap();
            fs::write(headless::turn_file(&directory, "msg_1", "exit"), "1\n").unwrap();
            let record = HeadlessTurnRecord {
                generation: "generation-1".into(),
                turn_id: "msg_1".into(),
                session_id: "session-1".into(),
                pid: 999_999,
                process_identity: RecordedProcessIdentity {
                    command: "/bin/sh".into(),
                    executable: "/bin/sh".into(),
                    argv: vec![
                        "codex".into(),
                        "exec".into(),
                        "resume".into(),
                        "thread-1".into(),
                    ],
                    process_group: 999_999,
                    start_time: "gone".into(),
                    owner_uid: 501,
                },
                dispatch_arguments: vec![
                    "codex".into(),
                    "exec".into(),
                    "resume".into(),
                    "thread-1".into(),
                ],
            };
            fs::write(
                directory.join("turn.json"),
                serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
            let observed = observe(
                &directory,
                "session-1",
                "msg_1",
                DispatchState::Ambiguous,
                None,
            )
            .unwrap();
            assert_eq!(observed.state, PromptState::Error);
            assert_eq!(observed.reason, "native_startup_failed");
            assert_eq!(
                thread::read_thread_id(&directory).unwrap().is_none(),
                forgotten
            );
            if forgotten {
                fs::write(
                    headless::turn_file(&directory, "msg_0", "jsonl"),
                    "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
                )
                .unwrap();
                assert_eq!(thread::recover_thread_id(&directory).unwrap(), None);
            } else {
                assert_eq!(
                    thread::recover_thread_id(&directory).unwrap().as_deref(),
                    Some("thread-1")
                );
            }
            fs::remove_dir_all(directory).unwrap();
        }
    }
}
