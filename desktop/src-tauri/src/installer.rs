//! Runs the host's own install stages: `suplex install --manifest`, then one
//! `suplex install --stage <name> --json` child per stage, stopping at the first failure.
//! The shell never reimplements a stage.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

use serde_json::Value;
use std::io::Write;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use crate::{
    boot::runtime_environment,
    contracts::{InstallEvent, InstallStage},
    network_access::ResolvedNetworkAccess,
    paths::RuntimePaths,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Complete,
    Failed,
    Cancelled,
}

/// Cancels the running stage by signalling only the process group this installer created.
#[derive(Clone, Default)]
pub struct InstallCancel {
    cancelled: Arc<AtomicBool>,
    active: Arc<Mutex<Option<i32>>>,
}

impl InstallCancel {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(pid) = *self.active.lock().unwrap() {
            // SAFETY: kill(2) with a negative pid signals the group led by our own child.
            unsafe { libc::kill(-pid, libc::SIGTERM) };
        }
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

pub struct Installer {
    pub runtime: RuntimePaths,
    pub user_data: PathBuf,
    pub base: HashMap<String, String>,
    pub port: u16,
    pub cancel: InstallCancel,
}

struct ChildResult {
    code: i32,
    stdout: String,
    stderr: String,
}

fn last_json_line(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with('{'))
        .and_then(|line| serde_json::from_str(line).ok())
}

fn log_name() -> String {
    let now = time::OffsetDateTime::now_utc();
    let stamp = now
        .format(&time::macros::format_description!(
            "[year]-[month]-[day]T[hour]-[minute]-[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_else(|_| now.unix_timestamp().to_string());
    format!("install-{stamp}.log")
}

impl Installer {
    async fn child(&self, args: &[&str], record: &mut (impl FnMut(&str) + Send)) -> ChildResult {
        let environment = runtime_environment(
            &self.user_data,
            self.port,
            &self.base,
            &ResolvedNetworkAccess::Local,
        );
        let spawned = tokio::process::Command::new(&self.runtime.binary)
            .args(args)
            .current_dir(&self.runtime.directory)
            .env_clear()
            .envs(environment)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                return ChildResult {
                    code: -1,
                    stdout: String::new(),
                    stderr: format!("{error}\n"),
                }
            }
        };
        let pid = child.id().map(|pid| pid as i32);
        *self.cancel.active.lock().unwrap() = pid;
        // A cancel that arrived while this child was spawning saw no pid to signal.
        if let (true, Some(pid)) = (self.cancel.is_cancelled(), pid) {
            // SAFETY: kill(2) with a negative pid signals the group led by our own child.
            unsafe { libc::kill(-pid, libc::SIGTERM) };
        }
        let mut stdout = child.stdout.take().expect("piped stdout");
        let stdout_task = tokio::spawn(async move {
            let mut text = String::new();
            let _ = stdout.read_to_string(&mut text).await;
            text
        });
        let mut stderr_text = String::new();
        let mut lines = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            stderr_text.push_str(&line);
            stderr_text.push('\n');
            if !line.trim().is_empty() {
                record(&line);
            }
        }
        let code = child
            .wait()
            .await
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        *self.cancel.active.lock().unwrap() = None;
        ChildResult {
            code,
            stdout: stdout_task.await.unwrap_or_default(),
            stderr: stderr_text,
        }
    }

    /// Runs from the named stage (or the first), streaming events and appending each line to a dated log under `logs/`.
    pub async fn run(
        &self,
        from: Option<&str>,
        emit: impl Fn(InstallEvent) + Send + Sync,
    ) -> InstallOutcome {
        let logs = self.user_data.join("logs");
        let _ = std::fs::create_dir_all(&logs);
        let file = Mutex::new(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(logs.join(log_name()))
                .ok(),
        );
        let record = |line: &str| {
            if let Some(file) = file.lock().unwrap().as_mut() {
                let _ = writeln!(file, "{line}");
            }
            emit(InstallEvent::Log {
                line: line.to_owned(),
            });
        };
        self.stages(from, &emit, record).await
    }

    async fn stages(
        &self,
        from: Option<&str>,
        emit: &(impl Fn(InstallEvent) + Send + Sync),
        mut record: impl FnMut(&str) + Send,
    ) -> InstallOutcome {
        let fail = |record: &mut dyn FnMut(&str),
                    stage: &str,
                    title: &str,
                    reason: String,
                    remedy: Option<String>| {
            record(&reason);
            emit(InstallEvent::Failed {
                stage: stage.into(),
                title: title.into(),
                reason,
                remedy,
            });
            InstallOutcome::Failed
        };
        let manifest = self.child(&["install", "--manifest"], &mut record).await;
        if self.cancel.is_cancelled() {
            return InstallOutcome::Cancelled;
        }
        let parsed = last_json_line(&manifest.stdout).filter(|frame| {
            manifest.code == 0 && frame.get("protocolVersion") == Some(&Value::from(1))
        });
        let stages: Vec<InstallStage> = parsed
            .as_ref()
            .and_then(|frame| frame.get("stages")?.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|stage| serde_json::from_value(stage.clone()).ok())
            .collect();
        if stages.is_empty() {
            let remedy = Some(manifest.stderr.trim().to_owned()).filter(|text| !text.is_empty());
            return fail(
                &mut record,
                "",
                "Read the install steps",
                format!(
                    "Suplex could not read the install steps (exit {}).",
                    manifest.code
                ),
                remedy,
            );
        }
        let start = from
            .and_then(|from| stages.iter().position(|stage| stage.name == from))
            .unwrap_or(0);
        emit(InstallEvent::Stages {
            stages: stages.clone(),
            from: start,
        });
        for stage in &stages[start..] {
            if self.cancel.is_cancelled() {
                return InstallOutcome::Cancelled;
            }
            emit(InstallEvent::StageStarted {
                stage: stage.name.clone(),
            });
            let began = Instant::now();
            let result = self
                .child(&["install", "--stage", &stage.name, "--json"], &mut record)
                .await;
            if self.cancel.is_cancelled() {
                return InstallOutcome::Cancelled;
            }
            let frame = last_json_line(&result.stdout);
            let field = |name: &str| {
                frame
                    .as_ref()
                    .and_then(|frame| frame.get(name))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            let ok = frame.as_ref().and_then(|frame| frame.get("ok")) == Some(&Value::Bool(true));
            if result.code != 0 || !ok || field("stage").as_deref() != Some(stage.name.as_str()) {
                let reason = field("reason").unwrap_or_else(|| {
                    format!("The step ended unexpectedly (exit {}).", result.code)
                });
                return fail(
                    &mut record,
                    &stage.name,
                    &stage.title,
                    reason,
                    field("remedy"),
                );
            }
            let skipped =
                frame.as_ref().and_then(|frame| frame.get("skipped")) == Some(&Value::Bool(true));
            emit(InstallEvent::StageFinished {
                stage: stage.name.clone(),
                skipped,
                elapsed_ms: began.elapsed().as_millis() as u64,
            });
        }
        emit(InstallEvent::Done);
        InstallOutcome::Complete
    }
}

#[cfg(test)]
pub(crate) fn fixture_runtime() -> RuntimePaths {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime");
    RuntimePaths {
        binary: directory.join("bin/suplex"),
        directory,
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, time::Duration};

    use super::*;

    fn workspace(settings: Option<Value>) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("data")).unwrap();
        if let Some(settings) = settings {
            std::fs::write(
                directory.path().join("data/fixture.json"),
                settings.to_string(),
            )
            .unwrap();
        }
        directory
    }

    fn installer(user_data: &Path, runtime: RuntimePaths) -> Installer {
        let base = ["HOME", "USER", "TMPDIR"]
            .iter()
            .filter_map(|key| {
                std::env::var(key)
                    .ok()
                    .map(|value| (key.to_string(), value))
            })
            .collect();
        Installer {
            runtime,
            user_data: user_data.to_owned(),
            base,
            port: 4111,
            cancel: InstallCancel::default(),
        }
    }

    fn collect() -> (
        Arc<Mutex<Vec<InstallEvent>>>,
        impl Fn(InstallEvent) + Send + Sync,
    ) {
        let events: Arc<Mutex<Vec<InstallEvent>>> = Arc::default();
        let sink = events.clone();
        (events, move |event| sink.lock().unwrap().push(event))
    }

    fn stage_names(events: &[InstallEvent], started: bool) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                InstallEvent::StageStarted { stage } if started => Some(stage.clone()),
                InstallEvent::StageFinished { stage, .. } if !started => Some(stage.clone()),
                _ => None,
            })
            .collect()
    }

    const ALL: [&str; 5] = [
        "prerequisites",
        "developer-tools",
        "herdr",
        "data",
        "complete",
    ];

    #[tokio::test]
    async fn every_stage_runs_in_order_streams_its_log_and_writes_a_dated_file() {
        let user_data = workspace(None);
        let (events, emit) = collect();
        assert_eq!(
            installer(user_data.path(), fixture_runtime())
                .run(None, emit)
                .await,
            InstallOutcome::Complete
        );
        let events = events.lock().unwrap().clone();
        assert!(matches!(
            &events[0],
            InstallEvent::Log { .. } | InstallEvent::Stages { .. }
        ));
        let stages = events
            .iter()
            .find_map(|event| match event {
                InstallEvent::Stages { stages, from } => Some((stages.clone(), *from)),
                _ => None,
            })
            .unwrap();
        assert_eq!(stages.1, 0);
        assert_eq!(
            stages
                .0
                .iter()
                .map(|stage| stage.name.as_str())
                .collect::<Vec<_>>(),
            ALL
        );
        assert_eq!(stage_names(&events, true), ALL);
        assert_eq!(stage_names(&events, false), ALL);
        assert_eq!(events.last(), Some(&InstallEvent::Done));
        assert!(events.contains(&InstallEvent::Log {
            line: "herdr: working".into()
        }));
        let logs: Vec<PathBuf> = std::fs::read_dir(user_data.path().join("logs"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(logs.len(), 1);
        let name = logs[0].file_name().unwrap().to_str().unwrap().to_owned();
        assert!(
            name.starts_with("install-") && name.ends_with("Z.log") && !name.contains(':'),
            "{name}"
        );
        assert!(std::fs::read_to_string(&logs[0])
            .unwrap()
            .contains("Install Herdr terminals"));
    }

    #[tokio::test]
    async fn the_first_failure_stops_the_run_with_the_stage_title_reason_and_remedy() {
        let user_data = workspace(Some(
            serde_json::json!({ "failStage": "herdr", "reason": "curl exited 22", "remedy": "Check the network connection and retry." }),
        ));
        let (events, emit) = collect();
        assert_eq!(
            installer(user_data.path(), fixture_runtime())
                .run(None, emit)
                .await,
            InstallOutcome::Failed
        );
        let events = events.lock().unwrap().clone();
        assert_eq!(
            events.last(),
            Some(&InstallEvent::Failed {
                stage: "herdr".into(),
                title: "Install Herdr terminals".into(),
                reason: "curl exited 22".into(),
                remedy: Some("Check the network connection and retry.".into())
            })
        );
        assert_eq!(
            stage_names(&events, true),
            ["prerequisites", "developer-tools", "herdr"]
        );
    }

    #[tokio::test]
    async fn a_retry_reruns_from_the_failed_stage_and_earlier_stages_stay_done() {
        let user_data = workspace(Some(
            serde_json::json!({ "failStage": "herdr", "reason": "curl exited 22" }),
        ));
        installer(user_data.path(), fixture_runtime())
            .run(None, |_| {})
            .await;
        std::fs::write(user_data.path().join("data/fixture.json"), "{}").unwrap();
        let (events, emit) = collect();
        assert_eq!(
            installer(user_data.path(), fixture_runtime())
                .run(Some("herdr"), emit)
                .await,
            InstallOutcome::Complete
        );
        let events = events.lock().unwrap().clone();
        assert!(events
            .iter()
            .any(|event| matches!(event, InstallEvent::Stages { from: 2, .. })));
        assert_eq!(stage_names(&events, true), ["herdr", "data", "complete"]);
        let done: Vec<String> = serde_json::from_str(
            &std::fs::read_to_string(user_data.path().join("data/fixture-stages.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(done, ALL);
    }

    #[tokio::test]
    async fn a_completed_stage_reports_itself_as_skipped_on_a_rerun() {
        let user_data = workspace(None);
        installer(user_data.path(), fixture_runtime())
            .run(None, |_| {})
            .await;
        let (events, emit) = collect();
        assert_eq!(
            installer(user_data.path(), fixture_runtime())
                .run(None, emit)
                .await,
            InstallOutcome::Complete
        );
        let skipped: Vec<bool> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                InstallEvent::StageFinished { skipped, .. } => Some(*skipped),
                _ => None,
            })
            .collect();
        assert_eq!(skipped, [true; 5]);
    }

    #[tokio::test]
    async fn a_cancel_before_a_stage_starts_runs_no_further_stage() {
        let user_data = workspace(None);
        let (events, emit) = collect();
        let driver = installer(user_data.path(), fixture_runtime());
        driver.cancel.cancel();
        assert_eq!(driver.run(None, emit).await, InstallOutcome::Cancelled);
        assert!(stage_names(&events.lock().unwrap(), true).is_empty());
    }

    #[tokio::test]
    async fn cancel_terminates_only_the_running_stage_process_group() {
        let user_data = workspace(Some(serde_json::json!({ "delayMs": 5000 })));
        let (events, emit) = collect();
        let driver = Arc::new(installer(user_data.path(), fixture_runtime()));
        let running = tokio::spawn({
            let driver = driver.clone();
            async move { driver.run(None, emit).await }
        });
        let finished = InstallEvent::Log {
            line: "prerequisites: finished".into(),
        };
        for _ in 0..200 {
            if events.lock().unwrap().contains(&finished) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let began = Instant::now();
        driver.cancel.cancel();
        assert_eq!(running.await.unwrap(), InstallOutcome::Cancelled);
        assert!(
            began.elapsed() < Duration::from_secs(4),
            "the sleeping stage was terminated"
        );
        assert_eq!(
            stage_names(&events.lock().unwrap(), true),
            ["prerequisites"]
        );
    }

    #[tokio::test]
    async fn a_missing_runtime_fails_before_any_stage() {
        let user_data = workspace(None);
        let missing = RuntimePaths {
            binary: user_data.path().join("missing/bin/suplex"),
            directory: user_data.path().join("missing"),
        };
        let (events, emit) = collect();
        assert_eq!(
            installer(user_data.path(), missing).run(None, emit).await,
            InstallOutcome::Failed
        );
        assert!(
            matches!(events.lock().unwrap().last(), Some(InstallEvent::Failed { title, .. }) if title == "Read the install steps")
        );
    }
}
