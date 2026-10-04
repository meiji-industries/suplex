//! Starts, adopts, and stops the bundled host. The shell signals only the process group it created;
//! a matching host it did not start is adopted and never signalled, and any other listener is left alone.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::sync::watch;

use crate::{
    boot::runtime_environment,
    network_access::{ResolvedNetworkAccess, StartError, Started},
    paths::RuntimePaths,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub poll: Duration,
    pub ready_timeout: Duration,
    pub stop_timeout: Duration,
    pub probe_timeout: Duration,
}

impl Timing {
    pub const PRODUCTION: Timing = Timing {
        poll: Duration::from_millis(500),
        ready_timeout: Duration::from_secs(60),
        stop_timeout: Duration::from_secs(5),
        probe_timeout: Duration::from_secs(2),
    };
}

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .no_proxy()
        .build()
        .expect("a TLS backend is compiled in")
}

/// `GET <origin>/health` answering 200, without following redirects. Also the setup page's connection test.
pub async fn healthy(origin: &str, timeout: Duration) -> bool {
    matches!(client(timeout).get(format!("{origin}/health")).send().await, Ok(response) if response.status() == 200)
}

/// Any HTTP answer from `origin`. A remote host that answers at all is shown; only a network failure shows the
/// bundled failure page, as a failed page load did in the Electron shell.
pub async fn reachable(origin: &str, timeout: Duration) -> bool {
    client(timeout)
        .get(format!("{origin}/health"))
        .send()
        .await
        .is_ok()
}

/// The installation id a healthy host at `origin` reports, or `None`.
pub async fn served_installation(origin: &str, timeout: Duration) -> Option<String> {
    let response = client(timeout)
        .get(format!("{origin}/health"))
        .send()
        .await
        .ok()?;
    if response.status() != 200 {
        return None;
    }
    response
        .headers()
        .get("x-suplex-installation-id")?
        .to_str()
        .ok()
        .map(str::to_owned)
}

/// The preferred port when it can still be bound, otherwise whatever the kernel hands out.
pub fn free_port(preferred: u16) -> Result<u16, String> {
    let bind = |port: u16| {
        std::net::TcpListener::bind(("127.0.0.1", port))
            .ok()
            .and_then(|listener| listener.local_addr().ok())
            .map(|address| address.port())
    };
    bind(preferred)
        .or_else(|| bind(0))
        .ok_or_else(|| "No local port is available for Suplex.".to_owned())
}

pub fn read_installation_id(user_data: &Path) -> String {
    std::fs::read_to_string(user_data.join("installation-id"))
        .map(|id| id.trim().to_owned())
        .unwrap_or_default()
}

fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn signal_group(pid: i32, signal: libc::c_int) {
    // SAFETY: a negative pid addresses the process group our own child leads; it never names another process.
    unsafe { libc::kill(-pid, signal) };
}

/// The host child this shell spawned. Its pid is a live process-group leader until `exited` reports.
struct OwnedChild {
    pid: i32,
    exited: watch::Receiver<Option<i32>>,
    reaper: tokio::task::JoinHandle<()>,
    drains: Vec<tokio::task::JoinHandle<()>>,
}

impl OwnedChild {
    fn exit_code(&self) -> Option<i32> {
        *self.exited.borrow()
    }

    /// TERM to the group, a bounded wait, KILL only if the leader is still alive, then reap and close the log.
    async fn stop(mut self, timeout: Duration) {
        if self.exit_code().is_none() {
            signal_group(self.pid, libc::SIGTERM);
            let mut exited = self.exited.clone();
            let ended = tokio::time::timeout(timeout, exited.wait_for(Option::is_some))
                .await
                .is_ok();
            if !ended {
                signal_group(self.pid, libc::SIGKILL);
            }
        }
        self.finish().await;
    }

    async fn kill(mut self) {
        if self.exit_code().is_none() {
            signal_group(self.pid, libc::SIGKILL);
        }
        self.finish().await;
    }

    async fn finish(&mut self) {
        let _ = (&mut self.reaper).await;
        for drain in self.drains.drain(..) {
            // A grandchild holding the pipes open would keep a drain alive; the leader is reaped, so stop waiting.
            let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
        }
    }
}

/// The shell's local host: stopped, or running an owned child. Adoption leaves `child` empty.
pub struct LocalHost {
    pub runtime: RuntimePaths,
    pub user_data: PathBuf,
    pub base: HashMap<String, String>,
    pub timing: Timing,
    child: tokio::sync::Mutex<Option<OwnedChild>>,
}

impl LocalHost {
    pub fn new(
        runtime: RuntimePaths,
        user_data: PathBuf,
        base: HashMap<String, String>,
        timing: Timing,
    ) -> Self {
        Self {
            runtime,
            user_data,
            base,
            timing,
            child: tokio::sync::Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub async fn owns_child(&self) -> bool {
        self.child.lock().await.is_some()
    }

    /// Adopts this installation's host on `preferred`, or spawns one on a free port and waits for it to answer as this installation.
    pub async fn start(
        &self,
        preferred: u16,
        access: &ResolvedNetworkAccess,
    ) -> Result<Started, StartError> {
        let own = read_installation_id(&self.user_data);
        if !own.is_empty()
            && served_installation(&origin(preferred), self.timing.probe_timeout)
                .await
                .as_deref()
                == Some(own.as_str())
        {
            return Ok(Started {
                port: preferred,
                adopted: true,
            });
        }
        let mut last = StartError::Failed("Suplex could not start.".into());
        // A listener that wins a race for the chosen port is never adopted; choose another free port.
        for _ in 0..3 {
            let port = free_port(preferred).map_err(StartError::Failed)?;
            match self.spawn_and_wait(port, access).await {
                Ok(started) => return Ok(started),
                Err((error, true)) => last = error,
                Err((error, false)) => return Err(error),
            }
        }
        Err(last)
    }

    /// Returns the error and whether another listener took the port.
    async fn spawn_and_wait(
        &self,
        port: u16,
        access: &ResolvedNetworkAccess,
    ) -> Result<Started, (StartError, bool)> {
        let failed = |message: String, raced: bool| {
            let error = match access {
                ResolvedNetworkAccess::Tailscale { .. } => {
                    StartError::CleanupRequired { message, port }
                }
                _ => StartError::Failed(message),
            };
            (error, raced)
        };
        let child = self
            .spawn(port, access)
            .map_err(|message| failed(message, false))?;
        let target = origin(port);
        let mut waited = Duration::ZERO;
        let outcome = loop {
            if waited >= self.timing.ready_timeout {
                break Err((format!("The Suplex server did not answer {target}/health within {} seconds. The log is in logs/server.log.", self.timing.ready_timeout.as_secs()), false));
            }
            tokio::time::sleep(self.timing.poll).await;
            waited += self.timing.poll;
            if healthy(&target, self.timing.probe_timeout).await {
                let own = read_installation_id(&self.user_data);
                let served = served_installation(&target, self.timing.probe_timeout).await;
                // Without an installation id only a live child can vouch for the listener.
                if (own.is_empty() && child.exit_code().is_none())
                    || served.as_deref() == Some(own.as_str())
                {
                    break Ok(());
                }
                if child.exit_code().is_some() {
                    break Err((
                        format!("Another server took {target} while Suplex started."),
                        true,
                    ));
                }
            }
            if let Some(code) = child.exit_code() {
                // Something that is not Suplex holds the port: the child lost a race for it.
                let taken = tokio::time::timeout(
                    self.timing.probe_timeout,
                    tokio::net::TcpStream::connect(("127.0.0.1", port)),
                )
                .await
                .is_ok_and(|connection| connection.is_ok());
                if taken {
                    break Err((
                        format!("Another server took {target} while Suplex started."),
                        true,
                    ));
                }
                break Err((format!("The Suplex server stopped while starting (exit {code}). The log is in logs/server.log."), false));
            }
        };
        match outcome {
            Ok(()) => {
                *self.child.lock().await = Some(child);
                Ok(Started {
                    port,
                    adopted: false,
                })
            }
            Err((message, raced)) => {
                child.kill().await;
                Err(failed(message, raced))
            }
        }
    }

    fn spawn(&self, port: u16, access: &ResolvedNetworkAccess) -> Result<OwnedChild, String> {
        let logs = self.user_data.join("logs");
        std::fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("server.log"))
            .map_err(|error| error.to_string())?;
        let second = log.try_clone().map_err(|error| error.to_string())?;
        let mut child = tokio::process::Command::new(&self.runtime.binary)
            .args(["start", "--foreground"])
            .current_dir(&self.runtime.directory)
            .env_clear()
            .envs(runtime_environment(
                &self.user_data,
                port,
                &self.base,
                access,
            ))
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .spawn()
            .map_err(|error| {
                format!(
                    "Suplex could not start {}: {error}",
                    self.runtime.binary.display()
                )
            })?;
        let pid = child
            .id()
            .ok_or("The Suplex server exited before it started.")? as i32;
        let drain = |mut reader: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
                     file: std::fs::File| {
            tokio::spawn(async move {
                let mut file = tokio::fs::File::from_std(file);
                let _ = tokio::io::copy(&mut reader, &mut file).await;
            })
        };
        let drains = vec![
            drain(Box::new(child.stdout.take().expect("piped stdout")), log),
            drain(Box::new(child.stderr.take().expect("piped stderr")), second),
        ];
        let (sender, exited) = watch::channel(None);
        let reaper = tokio::spawn(async move {
            let code = child
                .wait()
                .await
                .ok()
                .map(|status| status.code().unwrap_or(-1))
                .unwrap_or(-1);
            let _ = sender.send(Some(code));
        });
        Ok(OwnedChild {
            pid,
            exited,
            reaper,
            drains,
        })
    }

    /// Stops the owned child, if any. An adopted or remote host is never signalled.
    pub async fn stop(&self) {
        let child = self.child.lock().await.take();
        if let Some(child) = child {
            child.stop(self.timing.stop_timeout).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Instant};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::installer::fixture_runtime;

    fn quick() -> Timing {
        Timing {
            poll: Duration::from_millis(50),
            ready_timeout: Duration::from_secs(20),
            stop_timeout: Duration::from_secs(5),
            probe_timeout: Duration::from_secs(2),
        }
    }

    fn user_data(
        installation: Option<&str>,
        settings: Option<serde_json::Value>,
    ) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("data")).unwrap();
        if let Some(id) = installation {
            std::fs::write(directory.path().join("installation-id"), format!("{id}\n")).unwrap();
        }
        if let Some(settings) = settings {
            std::fs::write(
                directory.path().join("data/fixture.json"),
                settings.to_string(),
            )
            .unwrap();
        }
        directory
    }

    fn host(directory: &tempfile::TempDir, timing: Timing) -> LocalHost {
        let base = [
            ("HOME", std::env::var("HOME").unwrap()),
            ("USER", std::env::var("USER").unwrap_or_default()),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
        LocalHost::new(fixture_runtime(), directory.path().to_owned(), base, timing)
    }

    /// A listener that answers `/health` for another program, optionally as some installation.
    async fn foreign_listener(
        installation: Option<&'static str>,
    ) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let header = installation
                    .map(|id| format!("x-suplex-installation-id: {id}\r\n"))
                    .unwrap_or_default();
                let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\n{header}content-length: 2\r\nconnection: close\r\n\r\nok").as_bytes()).await;
            }
        });
        (port, hits)
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks for existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn production_timing_is_unchanged() {
        assert_eq!(
            Timing::PRODUCTION,
            Timing {
                poll: Duration::from_millis(500),
                ready_timeout: Duration::from_secs(60),
                stop_timeout: Duration::from_secs(5),
                probe_timeout: Duration::from_secs(2)
            }
        );
    }

    #[tokio::test]
    async fn a_host_of_this_installation_is_adopted_never_spawned_and_never_signalled() {
        let (port, _) = foreign_listener(Some("ours")).await;
        let directory = user_data(Some("ours"), None);
        let local = host(&directory, quick());
        assert_eq!(
            local.start(port, &ResolvedNetworkAccess::Local).await,
            Ok(Started {
                port,
                adopted: true
            })
        );
        assert!(!local.owns_child().await);
        local.stop().await;
        assert!(
            !directory.path().join("logs/server.log").exists(),
            "nothing was spawned"
        );
        assert!(
            healthy(&origin(port), Duration::from_secs(2)).await,
            "the adopted host still answers"
        );
    }

    #[tokio::test]
    async fn another_installation_or_program_on_the_port_is_left_alone_and_ours_starts_elsewhere() {
        for installation in [Some("deleted-folder"), None] {
            let (port, _) = foreign_listener(installation).await;
            let directory = user_data(
                Some("ours"),
                Some(serde_json::json!({ "installationId": "ours" })),
            );
            let local = host(&directory, quick());
            let started = local
                .start(port, &ResolvedNetworkAccess::Local)
                .await
                .unwrap();
            assert!(!started.adopted);
            assert_ne!(started.port, port);
            assert!(
                healthy(&origin(port), Duration::from_secs(2)).await,
                "the other listener still answers"
            );
            local.stop().await;
        }
    }

    #[tokio::test]
    async fn the_owned_host_runs_its_foreground_command_with_cwd_environment_and_drained_log() {
        let directory = user_data(None, None);
        let local = host(&directory, quick());
        let preferred = free_port(0).unwrap();
        let started = local
            .start(preferred, &ResolvedNetworkAccess::Local)
            .await
            .unwrap();
        assert_eq!(
            started,
            Started {
                port: preferred,
                adopted: false
            }
        );
        let log = std::fs::read_to_string(directory.path().join("logs/server.log")).unwrap();
        assert!(
            log.contains(&format!("fixture native runtime listening on {preferred}")),
            "{log}"
        );
        let report: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(directory.path().join("data/fixture-start.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(report["args"], serde_json::json!(["start", "--foreground"]));
        assert_eq!(
            report["cwd"],
            std::fs::canonicalize(fixture_runtime().directory)
                .unwrap()
                .display()
                .to_string()
        );
        assert_eq!(report["env"]["SUPLEX_PACKAGED"], "1");
        assert_eq!(report["env"]["SUPLEX_ACCESS_MODE"], "local");
        assert_eq!(report["env"]["SUPLEX_BIND_ADDRESS"], "127.0.0.1");
        assert_eq!(report["env"]["SUPLEX_PORT"], preferred.to_string());
        assert_eq!(
            report["env"]["SUPLEX_DATA_ROOT"],
            directory.path().join("data").display().to_string()
        );
        assert_eq!(
            report["pgid"], report["pid"],
            "the host leads its own process group"
        );
        local.stop().await;
        assert!(!healthy(&origin(preferred), Duration::from_millis(500)).await);
    }

    #[test]
    fn the_preferred_port_is_kept_when_free_and_given_up_when_taken() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_ne!(free_port(port).unwrap(), port);
        drop(taken);
        assert_eq!(free_port(port).unwrap(), port);
    }

    #[tokio::test]
    async fn a_host_that_never_answers_times_out_and_its_whole_group_is_killed() {
        let directory = user_data(
            None,
            Some(serde_json::json!({ "startDelayMs": 60000, "spawnChild": true })),
        );
        let local = host(
            &directory,
            Timing {
                ready_timeout: Duration::from_secs(2),
                ..quick()
            },
        );
        let error = local
            .start(free_port(0).unwrap(), &ResolvedNetworkAccess::Local)
            .await
            .unwrap_err();
        assert!(
            error.message().contains("/health within 2 seconds"),
            "{error:?}"
        );
        let grandchild: i32 =
            std::fs::read_to_string(directory.path().join("data/fixture-child.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
        for _ in 0..40 {
            if !alive(grandchild) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!alive(grandchild), "the group member was killed");
        assert!(!local.owns_child().await);
    }

    #[tokio::test]
    async fn a_child_that_loses_the_port_to_another_program_is_retried_on_a_free_port() {
        let directory = user_data(None, Some(serde_json::json!({ "takePortOnce": true })));
        let preferred = free_port(0).unwrap();
        let local = host(&directory, quick());
        let started = local
            .start(preferred, &ResolvedNetworkAccess::Local)
            .await
            .unwrap();
        let taker: i32 = std::fs::read_to_string(directory.path().join("data/fixture-taker.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: the pid is the fixture's own listener process.
        unsafe { libc::kill(taker, libc::SIGKILL) };
        assert_ne!(started.port, preferred, "the taken port is not reused");
        assert!(!started.adopted && local.owns_child().await);
        local.stop().await;
    }

    #[tokio::test]
    async fn a_host_that_exits_while_starting_reports_its_exit_code() {
        let directory = user_data(None, Some(serde_json::json!({ "exitCode": 3 })));
        let error = host(&directory, quick())
            .start(free_port(0).unwrap(), &ResolvedNetworkAccess::Local)
            .await
            .unwrap_err();
        assert!(
            error.message().contains("stopped while starting (exit 3)"),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn a_tailscale_start_failure_records_the_port_for_route_cleanup() {
        let directory = user_data(None, Some(serde_json::json!({ "exitCode": 4 })));
        let port = free_port(0).unwrap();
        let error = host(&directory, quick())
            .start(
                port,
                &ResolvedNetworkAccess::Tailscale {
                    hostname: "mac.ts.net".into(),
                    command: "/tailscale".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(error, StartError::CleanupRequired { port: recorded, .. } if recorded == port)
        );
    }

    #[tokio::test]
    async fn quitting_terms_the_group_and_stops_waiting_once_it_exits() {
        let directory = user_data(None, Some(serde_json::json!({ "spawnChild": true })));
        let local = host(&directory, quick());
        let port = local
            .start(free_port(0).unwrap(), &ResolvedNetworkAccess::Local)
            .await
            .unwrap()
            .port;
        let grandchild: i32 =
            std::fs::read_to_string(directory.path().join("data/fixture-child.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
        let began = Instant::now();
        local.stop().await;
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "TERM ended it without the KILL deadline"
        );
        assert!(!healthy(&origin(port), Duration::from_millis(500)).await);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!alive(grandchild), "TERM reached the whole group");
        assert!(
            std::fs::read_to_string(directory.path().join("logs/server.log"))
                .unwrap()
                .contains("fixture received SIGTERM")
        );
    }

    #[tokio::test]
    async fn a_host_that_ignores_term_is_killed_after_the_deadline() {
        let directory = user_data(None, Some(serde_json::json!({ "ignoreTerm": true })));
        let local = host(
            &directory,
            Timing {
                stop_timeout: Duration::from_secs(1),
                ..quick()
            },
        );
        let port = local
            .start(free_port(0).unwrap(), &ResolvedNetworkAccess::Local)
            .await
            .unwrap()
            .port;
        let began = Instant::now();
        local.stop().await;
        let elapsed = began.elapsed();
        assert!(
            elapsed >= Duration::from_secs(1) && elapsed < Duration::from_secs(4),
            "{elapsed:?}"
        );
        assert!(!healthy(&origin(port), Duration::from_millis(500)).await);
    }

    #[tokio::test]
    async fn stopping_without_an_owned_child_signals_nothing() {
        let (port, hits) = foreign_listener(Some("ours")).await;
        let directory = user_data(Some("ours"), None);
        let local = host(&directory, quick());
        local.stop().await;
        local
            .start(port, &ResolvedNetworkAccess::Local)
            .await
            .unwrap();
        local.stop().await;
        assert!(healthy(&origin(port), Duration::from_secs(2)).await);
        assert!(hits.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    }
}
