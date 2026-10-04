//! Saved network intent versus the running host's actual mode. Saving never restarts; Restart
//! applies the latest saved preference to a host this shell owns, and every start, restart, and
//! shutdown runs one at a time.

use std::{
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

use serde_json::Value;

use crate::{contracts::NetworkMode, paths::write_atomic};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolvedNetworkAccess {
    Local,
    All,
    Tailscale { hostname: String, command: String },
}

impl ResolvedNetworkAccess {
    pub fn mode(&self) -> NetworkMode {
        match self {
            Self::Local => NetworkMode::Local,
            Self::All => NetworkMode::All,
            Self::Tailscale { .. } => NetworkMode::Tailscale,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActiveNetworkAccess {
    Owned {
        access: ResolvedNetworkAccess,
        port: u16,
    },
    /// A matching host this shell did not start. It is never restarted, reconfigured, or signalled.
    Adopted { port: u16 },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkState {
    pub preference: NetworkMode,
    pub active: Option<ActiveNetworkAccess>,
    pub busy: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Started {
    pub port: u16,
    pub adopted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartError {
    Failed(String),
    /// The start failed and a Tailscale route for `port` may still point at it.
    CleanupRequired {
        message: String,
        port: u16,
    },
}

impl StartError {
    #[cfg(test)]
    pub fn message(&self) -> &str {
        match self {
            Self::Failed(message) | Self::CleanupRequired { message, .. } => message,
        }
    }
}

pub trait Ports: Send + Sync {
    fn resolve(
        &self,
        preference: NetworkMode,
    ) -> impl Future<Output = Result<ResolvedNetworkAccess, String>> + Send;
    fn start(
        &self,
        access: &ResolvedNetworkAccess,
    ) -> impl Future<Output = Result<Started, StartError>> + Send;
    fn stop(&self) -> impl Future<Output = Result<(), String>> + Send;
    /// Removes the Serve route for `port` after observing live state; `hostname` and `command` are from a fresh resolution.
    fn remove_serve_route(
        &self,
        hostname: &str,
        command: &str,
        port: u16,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// Removes this host's Serve route from live Tailscale state. Works when Tailscale is not connected.
    /// `port` is the recorded port; `None` means the record was unreadable, so use the port the host starts on.
    fn recover_serve_route(
        &self,
        port: Option<u16>,
    ) -> impl Future<Output = Result<(), String>> + Send;
}

pub fn read_preference(file: &std::path::Path) -> NetworkMode {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str::<NetworkMode>(&raw).ok())
        .unwrap_or_default()
}

pub fn write_preference(file: &std::path::Path, mode: NetworkMode) -> std::io::Result<()> {
    write_atomic(file, serde_json::to_string(&mode)?.as_bytes())
}

/// The recorded recovery intent: a port whose route may still exist.
#[derive(Debug, PartialEq)]
enum Recorded {
    None,
    Port(u16),
    /// Malformed intent is resolved from live Serve state for the port the host starts on.
    Unreadable,
}

fn read_cleanup(file: &std::path::Path) -> Result<Recorded, String> {
    let raw = match std::fs::read_to_string(file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Recorded::None),
        Err(error) => return Err(error.to_string()),
        Ok(raw) => raw,
    };
    Ok(serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("port")?.as_u64())
        .filter(|port| (1..=65_535).contains(port))
        .map_or(Recorded::Unreadable, |port| Recorded::Port(port as u16)))
}

fn write_cleanup(file: &std::path::Path, port: u16) -> std::io::Result<()> {
    write_atomic(
        file,
        serde_json::json!({ "port": port }).to_string().as_bytes(),
    )
}

struct Inner {
    preference: NetworkMode,
    active: Option<ActiveNetworkAccess>,
    cleanup_required: Option<u16>,
}

pub struct Controller<P: Ports> {
    ports: P,
    file: PathBuf,
    cleanup_file: PathBuf,
    inner: tokio::sync::Mutex<Inner>,
    snapshot: StdMutex<NetworkState>,
    on_change: Box<dyn Fn(NetworkState) + Send + Sync>,
}

impl<P: Ports> Controller<P> {
    pub fn new(
        ports: P,
        file: PathBuf,
        cleanup_file: PathBuf,
        on_change: impl Fn(NetworkState) + Send + Sync + 'static,
    ) -> Arc<Self> {
        let preference = read_preference(&file);
        Arc::new(Self {
            ports,
            file,
            cleanup_file,
            inner: tokio::sync::Mutex::new(Inner {
                preference,
                active: None,
                cleanup_required: None,
            }),
            snapshot: StdMutex::new(NetworkState {
                preference,
                active: None,
                busy: false,
            }),
            on_change: Box::new(on_change),
        })
    }

    /// The last published state. Readable while an operation runs.
    pub fn state(&self) -> NetworkState {
        self.snapshot.lock().unwrap().clone()
    }

    fn publish(&self, inner: &Inner, busy: bool) {
        let state = NetworkState {
            preference: inner.preference,
            active: inner.active.clone(),
            busy,
        };
        *self.snapshot.lock().unwrap() = state.clone();
        (self.on_change)(state);
    }

    /// Takes the operation lock and publishes `busy`; `finish` publishes the outcome.
    async fn begin(&self) -> tokio::sync::MutexGuard<'_, Inner> {
        let inner = self.inner.lock().await;
        self.publish(&inner, true);
        inner
    }

    fn finish<T>(
        &self,
        inner: tokio::sync::MutexGuard<'_, Inner>,
        result: Result<T, String>,
    ) -> Result<T, String> {
        self.publish(&inner, false);
        result
    }

    async fn start(
        &self,
        inner: &mut Inner,
        access: ResolvedNetworkAccess,
    ) -> Result<ActiveNetworkAccess, String> {
        let started = match self.ports.start(&access).await {
            Ok(started) => started,
            Err(StartError::CleanupRequired { message, port }) => {
                inner.cleanup_required = Some(port);
                write_cleanup(&self.cleanup_file, port).map_err(|error| {
                    format!(
                        "Suplex could not save its Tailscale cleanup intent: {message}; {error}"
                    )
                })?;
                return Err(message);
            }
            Err(StartError::Failed(message)) => return Err(message),
        };
        let active = if started.adopted {
            ActiveNetworkAccess::Adopted { port: started.port }
        } else {
            ActiveNetworkAccess::Owned {
                access,
                port: started.port,
            }
        };
        inner.active = Some(active.clone());
        self.publish(inner, true);
        Ok(active)
    }

    async fn stop(&self, inner: &mut Inner, running: ActiveNetworkAccess) -> Result<(), String> {
        let ActiveNetworkAccess::Owned { access, port } = running else {
            return Ok(());
        };
        self.ports.stop().await?;
        inner.active = None;
        self.publish(inner, true);
        if let ResolvedNetworkAccess::Tailscale { hostname, command } = &access {
            if let Err(error) = self.ports.remove_serve_route(hostname, command, port).await {
                inner.cleanup_required = Some(port);
                write_cleanup(&self.cleanup_file, port).map_err(|write| {
                    format!("Suplex could not save its Tailscale cleanup intent: {error}; {write}")
                })?;
                return Err(error);
            }
        }
        Ok(())
    }

    /// A recorded cleanup is retried against live Tailscale state before any host starts.
    /// It needs a Tailscale CLI only, not a connected tailnet or a readable record.
    async fn recover_cleanup(&self, inner: &mut Inner) -> Result<(), String> {
        let port = match inner.cleanup_required {
            Some(port) => Some(port),
            None => match read_cleanup(&self.cleanup_file)? {
                Recorded::None => return Ok(()),
                Recorded::Port(port) => Some(port),
                Recorded::Unreadable => None,
            },
        };
        self.ports.recover_serve_route(port).await?;
        let _ = std::fs::remove_file(&self.cleanup_file);
        inner.cleanup_required = None;
        Ok(())
    }

    pub async fn load_preference(&self) {
        let mut inner = self.begin().await;
        inner.preference = read_preference(&self.file);
        let _ = self.finish(inner, Ok(()));
    }

    pub async fn start_preferred(&self) -> Result<ActiveNetworkAccess, String> {
        let mut inner = self.begin().await;
        let result = self.start_preferred_locked(&mut inner).await;
        self.finish(inner, result)
    }

    async fn start_preferred_locked(
        &self,
        inner: &mut Inner,
    ) -> Result<ActiveNetworkAccess, String> {
        inner.preference = read_preference(&self.file);
        self.recover_cleanup(inner).await?;
        let resolved = self.ports.resolve(inner.preference).await?;
        self.start(inner, resolved).await
    }

    pub async fn save_preference(&self, requested: NetworkMode) -> Result<(), String> {
        let mut inner = self.begin().await;
        let result = write_preference(&self.file, requested).map_err(|error| error.to_string());
        if result.is_ok() {
            inner.preference = requested;
        }
        self.finish(inner, result)
    }

    /// Resolves the new mode before stopping a healthy host; on a failed start restores the previous mode unless a route may remain.
    pub async fn apply_preference(&self) -> Result<ActiveNetworkAccess, String> {
        let mut inner = self.begin().await;
        let result = self.apply_locked(&mut inner).await;
        self.finish(inner, result)
    }

    async fn apply_locked(&self, inner: &mut Inner) -> Result<ActiveNetworkAccess, String> {
        let Some(ActiveNetworkAccess::Owned {
            access: previous_access,
            port,
        }) = inner.active.clone()
        else {
            return Err("Suplex does not own a running host to restart.".into());
        };
        let previous_mode = previous_access.mode();
        if previous_mode == inner.preference {
            return Ok(ActiveNetworkAccess::Owned {
                access: previous_access,
                port,
            });
        }
        let requested = self.ports.resolve(inner.preference).await?;
        self.stop(
            inner,
            ActiveNetworkAccess::Owned {
                access: previous_access,
                port,
            },
        )
        .await?;
        let error = match self.start(inner, requested).await {
            Ok(active) => return Ok(active),
            Err(error) => error,
        };
        if inner.cleanup_required.is_some() {
            return Err(error);
        }
        let restored = match self.ports.resolve(previous_mode).await {
            Ok(access) => self.start(inner, access).await.map(|_| ()),
            Err(restore) => Err(restore),
        };
        match restored {
            Ok(()) => Err(error),
            Err(restore) => Err(format!("Suplex could not apply network access or restore the previous mode: {error}; {restore}")),
        }
    }

    /// Stops an owned host, or retries recorded cleanup when nothing owned runs. An adopted host is left alone.
    pub async fn shutdown(&self) -> Result<(), String> {
        let mut inner = self.begin().await;
        let result = match inner.active.clone() {
            Some(running @ ActiveNetworkAccess::Owned { .. }) => {
                self.stop(&mut inner, running).await
            }
            _ => self.recover_cleanup(&mut inner).await,
        };
        self.finish(inner, result)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn tailscale(hostname: &str) -> ResolvedNetworkAccess {
        ResolvedNetworkAccess::Tailscale {
            hostname: hostname.into(),
            command: "/tailscale".into(),
        }
    }

    type Resolve = Box<dyn Fn(NetworkMode) -> Result<ResolvedNetworkAccess, String> + Send + Sync>;
    type Start = Box<dyn Fn(&ResolvedNetworkAccess) -> Result<Started, StartError> + Send + Sync>;

    struct Fake {
        log: Arc<Mutex<Vec<String>>>,
        resolve: Resolve,
        start: Start,
        cleanup: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
        gate: Option<Arc<tokio::sync::Notify>>,
    }

    impl Fake {
        fn new(log: &Arc<Mutex<Vec<String>>>) -> Self {
            let started = log.clone();
            Self {
                log: log.clone(),
                resolve: Box::new(|mode| {
                    Ok(match mode {
                        NetworkMode::Local => ResolvedNetworkAccess::Local,
                        NetworkMode::All => ResolvedNetworkAccess::All,
                        NetworkMode::Tailscale => tailscale("mac.one.ts.net"),
                    })
                }),
                start: Box::new(move |access| {
                    started
                        .lock()
                        .unwrap()
                        .push(format!("start:{:?}", access.mode()).to_lowercase());
                    Ok(Started {
                        port: 4111,
                        adopted: false,
                    })
                }),
                cleanup: Box::new(|| Ok(())),
                gate: None,
            }
        }
    }

    impl Ports for Fake {
        async fn resolve(&self, preference: NetworkMode) -> Result<ResolvedNetworkAccess, String> {
            self.log
                .lock()
                .unwrap()
                .push(format!("resolve:{preference:?}").to_lowercase());
            (self.resolve)(preference)
        }
        async fn start(&self, access: &ResolvedNetworkAccess) -> Result<Started, StartError> {
            if let (Some(gate), ResolvedNetworkAccess::Tailscale { .. }) = (&self.gate, access) {
                gate.notified().await;
            }
            (self.start)(access)
        }
        async fn stop(&self) -> Result<(), String> {
            self.log.lock().unwrap().push("stop".into());
            Ok(())
        }
        async fn remove_serve_route(
            &self,
            hostname: &str,
            _command: &str,
            port: u16,
        ) -> Result<(), String> {
            self.log
                .lock()
                .unwrap()
                .push(format!("cleanup:{hostname}:{port}"));
            (self.cleanup)()
        }
        async fn recover_serve_route(&self, port: Option<u16>) -> Result<(), String> {
            self.log.lock().unwrap().push(format!(
                "recover:{}",
                port.map_or("unreadable".to_owned(), |port| port.to_string())
            ));
            (self.cleanup)()
        }
    }

    struct Setup {
        _directory: tempfile::TempDir,
        file: PathBuf,
        cleanup_file: PathBuf,
        log: Arc<Mutex<Vec<String>>>,
    }

    fn setup() -> Setup {
        let directory = tempfile::tempdir().unwrap();
        Setup {
            file: directory.path().join("network-access.json"),
            cleanup_file: directory.path().join("network-access-cleanup.json"),
            _directory: directory,
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }

    impl Setup {
        fn controller(&self, fake: Fake) -> Arc<Controller<Fake>> {
            Controller::new(fake, self.file.clone(), self.cleanup_file.clone(), |_| {})
        }
        fn operations(&self) -> Vec<String> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .filter(|entry| !entry.starts_with("resolve"))
                .cloned()
                .collect()
        }
    }

    fn owned(access: ResolvedNetworkAccess) -> Option<ActiveNetworkAccess> {
        Some(ActiveNetworkAccess::Owned { access, port: 4111 })
    }

    #[test]
    fn missing_corrupt_and_unknown_preferences_default_to_local_and_valid_ones_round_trip() {
        let setup = setup();
        assert_eq!(read_preference(&setup.file), NetworkMode::Local);
        for content in ["null", "{broken", "\"wifi\""] {
            std::fs::write(&setup.file, content).unwrap();
            assert_eq!(
                read_preference(&setup.file),
                NetworkMode::Local,
                "{content}"
            );
        }
        write_preference(&setup.file, NetworkMode::Tailscale).unwrap();
        assert_eq!(read_preference(&setup.file), NetworkMode::Tailscale);
        assert_eq!(
            std::fs::read_to_string(&setup.file).unwrap(),
            "\"tailscale\""
        );
    }

    #[tokio::test]
    async fn saving_persists_pending_intent_without_touching_the_runtime() {
        let setup = setup();
        let controller = setup.controller(Fake::new(&setup.log));
        controller.start_preferred().await.unwrap();
        setup.log.lock().unwrap().clear();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        assert_eq!(read_preference(&setup.file), NetworkMode::Tailscale);
        assert_eq!(
            controller.state(),
            NetworkState {
                preference: NetworkMode::Tailscale,
                active: owned(ResolvedNetworkAccess::Local),
                busy: false
            }
        );
        assert!(setup.log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn saving_the_active_mode_cancels_a_pending_restart() {
        let setup = setup();
        let controller = setup.controller(Fake::new(&setup.log));
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        controller
            .save_preference(NetworkMode::Local)
            .await
            .unwrap();
        assert_eq!(controller.state().preference, NetworkMode::Local);
        assert_eq!(read_preference(&setup.file), NetworkMode::Local);
        assert_eq!(setup.operations(), ["start:local"]);
    }

    #[tokio::test]
    async fn apply_uses_only_the_latest_saved_preference() {
        let setup = setup();
        let controller = setup.controller(Fake::new(&setup.log));
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        controller.save_preference(NetworkMode::All).await.unwrap();
        assert_eq!(
            controller.apply_preference().await.unwrap(),
            owned(ResolvedNetworkAccess::All).unwrap()
        );
        let resolutions: Vec<String> = setup
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.starts_with("resolve"))
            .cloned()
            .collect();
        assert_eq!(resolutions, ["resolve:local", "resolve:all"]);
        assert_eq!(setup.operations(), ["start:local", "stop", "start:all"]);
    }

    #[tokio::test]
    async fn a_failed_resolution_keeps_the_running_host_and_the_pending_preference() {
        let setup = setup();
        let mut fake = Fake::new(&setup.log);
        fake.resolve = Box::new(|mode| {
            if mode == NetworkMode::Tailscale {
                Err("not connected".into())
            } else {
                Ok(ResolvedNetworkAccess::Local)
            }
        });
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        assert_eq!(
            controller.apply_preference().await.unwrap_err(),
            "not connected"
        );
        assert_eq!(setup.operations(), ["start:local"]);
        assert_eq!(
            controller.state().active,
            owned(ResolvedNetworkAccess::Local)
        );
        assert_eq!(read_preference(&setup.file), NetworkMode::Tailscale);
    }

    #[tokio::test]
    async fn a_failed_start_restores_the_previous_mode_and_keeps_the_pending_preference() {
        let setup = setup();
        let mut fake = Fake::new(&setup.log);
        let log = setup.log.clone();
        fake.start = Box::new(move |access| {
            log.lock()
                .unwrap()
                .push(format!("start:{:?}", access.mode()).to_lowercase());
            if access.mode() == NetworkMode::All {
                Err(StartError::Failed("all failed".into()))
            } else {
                Ok(Started {
                    port: 4111,
                    adopted: false,
                })
            }
        });
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        controller.save_preference(NetworkMode::All).await.unwrap();
        assert_eq!(
            controller.apply_preference().await.unwrap_err(),
            "all failed"
        );
        assert_eq!(
            setup.operations(),
            ["start:local", "stop", "start:all", "start:local"]
        );
        assert_eq!(
            controller.state(),
            NetworkState {
                preference: NetworkMode::All,
                active: owned(ResolvedNetworkAccess::Local),
                busy: false
            }
        );
    }

    #[tokio::test]
    async fn a_cleanup_failure_leaves_the_host_stopped_with_recovery_intent_instead_of_starting_behind_a_stale_route(
    ) {
        let setup = setup();
        write_preference(&setup.file, NetworkMode::Tailscale).unwrap();
        let mut fake = Fake::new(&setup.log);
        fake.cleanup = Box::new(|| Err("route remains".into()));
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Local)
            .await
            .unwrap();
        assert_eq!(
            controller.apply_preference().await.unwrap_err(),
            "route remains"
        );
        assert_eq!(
            setup.operations(),
            ["start:tailscale", "stop", "cleanup:mac.one.ts.net:4111"]
        );
        assert_eq!(controller.state().active, None);
        assert_eq!(
            std::fs::read_to_string(&setup.cleanup_file).unwrap(),
            r#"{"port":4111}"#
        );
        assert_eq!(read_preference(&setup.file), NetworkMode::Local);
    }

    #[tokio::test]
    async fn a_preference_write_failure_leaves_the_old_host_running() {
        let setup = setup();
        std::fs::create_dir(&setup.file).unwrap();
        let controller = setup.controller(Fake::new(&setup.log));
        controller.start_preferred().await.unwrap();
        assert!(controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .is_err());
        assert_eq!(setup.operations(), ["start:local"]);
        assert_eq!(
            controller.state().active,
            owned(ResolvedNetworkAccess::Local)
        );
    }

    fn first_tailscale_start_needs_cleanup(
        fake: &mut Fake,
        log: &Arc<Mutex<Vec<String>>>,
        cleanup_port: u16,
    ) {
        let log = log.clone();
        let attempts = Mutex::new(0);
        fake.start = Box::new(move |access| {
            log.lock()
                .unwrap()
                .push(format!("start:{:?}", access.mode()).to_lowercase());
            if access.mode() == NetworkMode::Tailscale {
                let mut attempts = attempts.lock().unwrap();
                *attempts += 1;
                if *attempts == 1 {
                    return Err(StartError::CleanupRequired {
                        message: "cleanup unresolved".into(),
                        port: cleanup_port,
                    });
                }
                return Ok(Started {
                    port: cleanup_port,
                    adopted: false,
                });
            }
            Ok(Started {
                port: 4111,
                adopted: false,
            })
        });
    }

    #[tokio::test]
    async fn an_unresolved_tailscale_start_never_restores_local_and_a_retry_cleans_up_before_starting(
    ) {
        let setup = setup();
        let mut fake = Fake::new(&setup.log);
        first_tailscale_start_needs_cleanup(&mut fake, &setup.log, 4222);
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        assert_eq!(
            controller.apply_preference().await.unwrap_err(),
            "cleanup unresolved"
        );
        assert_eq!(controller.state().active, None);
        assert_eq!(
            setup.operations(),
            ["start:local", "stop", "start:tailscale"]
        );
        assert_eq!(read_preference(&setup.file), NetworkMode::Tailscale);
        controller.start_preferred().await.unwrap();
        assert_eq!(
            controller.state().active,
            Some(ActiveNetworkAccess::Owned {
                access: tailscale("mac.one.ts.net"),
                port: 4222
            })
        );
        assert_eq!(
            setup.operations(),
            [
                "start:local",
                "stop",
                "start:tailscale",
                "recover:4222",
                "start:tailscale"
            ]
        );
        assert!(!setup.cleanup_file.exists());
    }

    #[tokio::test]
    async fn a_later_local_selection_saves_intent_without_touching_unresolved_cleanup() {
        let setup = setup();
        let mut fake = Fake::new(&setup.log);
        first_tailscale_start_needs_cleanup(&mut fake, &setup.log, 4222);
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        assert!(controller.apply_preference().await.is_err());
        controller
            .save_preference(NetworkMode::Local)
            .await
            .unwrap();
        assert!(!setup
            .operations()
            .iter()
            .any(|entry| entry.starts_with("cleanup")));
        assert_eq!(read_preference(&setup.file), NetworkMode::Local);
        controller.start_preferred().await.unwrap();
        assert!(setup.operations().contains(&"recover:4222".to_owned()));
    }

    #[tokio::test]
    async fn a_recreated_controller_recovers_the_live_route_from_the_saved_intent_before_starting()
    {
        let setup = setup();
        let mut first = Fake::new(&setup.log);
        first.resolve = Box::new(|mode| {
            Ok(if mode == NetworkMode::Local {
                ResolvedNetworkAccess::Local
            } else {
                tailscale("old-name.ts.net")
            })
        });
        first.start = Box::new(|access| {
            if access.mode() == NetworkMode::Tailscale {
                Err(StartError::CleanupRequired {
                    message: "cleanup unresolved".into(),
                    port: 4333,
                })
            } else {
                Ok(Started {
                    port: 4111,
                    adopted: false,
                })
            }
        });
        let controller = setup.controller(first);
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        assert!(controller.apply_preference().await.is_err());
        assert_eq!(
            std::fs::read_to_string(&setup.cleanup_file).unwrap(),
            r#"{"port":4333}"#
        );
        drop(controller);

        setup.log.lock().unwrap().clear();
        let mut second = Fake::new(&setup.log);
        second.resolve = Box::new(|mode| {
            Ok(if mode == NetworkMode::Local {
                ResolvedNetworkAccess::Local
            } else {
                tailscale("new-name.ts.net")
            })
        });
        let controller = setup.controller(second);
        controller
            .save_preference(NetworkMode::Local)
            .await
            .unwrap();
        assert!(setup.operations().is_empty());
        assert_eq!(
            controller.start_preferred().await.unwrap(),
            owned(ResolvedNetworkAccess::Local).unwrap()
        );
        assert_eq!(setup.operations(), ["recover:4333", "start:local"]);
    }

    #[tokio::test]
    async fn missing_and_recreated_observation_files_do_not_block_a_safe_local_start() {
        let setup = setup();
        let controller = setup.controller(Fake::new(&setup.log));
        assert_eq!(
            controller.start_preferred().await.unwrap(),
            owned(ResolvedNetworkAccess::Local).unwrap()
        );
        controller.shutdown().await.unwrap();
        std::fs::write(&setup.file, "{garbage").unwrap();
        let recreated = setup.controller(Fake::new(&setup.log));
        assert_eq!(
            recreated.start_preferred().await.unwrap(),
            owned(ResolvedNetworkAccess::Local).unwrap()
        );
        assert!(!setup
            .operations()
            .iter()
            .any(|entry| entry.starts_with("cleanup")));
    }

    #[tokio::test]
    async fn malformed_cleanup_intent_is_resolved_from_live_serve_state() {
        let setup = setup();
        std::fs::write(&setup.cleanup_file, "{\"port\":\"x\"}").unwrap();
        let controller = setup.controller(Fake::new(&setup.log));
        controller.start_preferred().await.unwrap();
        assert_eq!(setup.operations(), ["recover:unreadable", "start:local"]);
        assert!(!setup.cleanup_file.exists());
    }

    #[tokio::test]
    async fn recorded_cleanup_does_not_need_tailscale_to_be_connected() {
        let setup = setup();
        std::fs::write(&setup.cleanup_file, r#"{"port":4222}"#).unwrap();
        let mut fake = Fake::new(&setup.log);
        fake.resolve = Box::new(|mode| match mode {
            NetworkMode::Tailscale => Err("Tailscale is not connected.".into()),
            _ => Ok(ResolvedNetworkAccess::Local),
        });
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        assert_eq!(setup.operations(), ["recover:4222", "start:local"]);
        assert!(!setup.cleanup_file.exists());
    }

    #[tokio::test]
    async fn a_route_that_cannot_be_observed_keeps_the_host_stopped_and_the_intent() {
        let setup = setup();
        std::fs::write(&setup.cleanup_file, r#"{"port":4222}"#).unwrap();
        let mut fake = Fake::new(&setup.log);
        fake.cleanup = Box::new(|| Err("status unavailable".into()));
        let controller = setup.controller(fake);
        assert_eq!(
            controller.start_preferred().await.unwrap_err(),
            "status unavailable"
        );
        assert_eq!(setup.operations(), ["recover:4222"]);
        assert!(setup.cleanup_file.exists());
    }

    #[tokio::test]
    async fn shutdown_cleanup_can_fail_and_retry_from_live_state_while_the_host_stays_stopped() {
        let setup = setup();
        write_preference(&setup.file, NetworkMode::Tailscale).unwrap();
        let mut fake = Fake::new(&setup.log);
        let failures = Mutex::new(1);
        fake.cleanup = Box::new(move || {
            let mut failures = failures.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                Err("status unavailable".into())
            } else {
                Ok(())
            }
        });
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        assert_eq!(
            controller.shutdown().await.unwrap_err(),
            "status unavailable"
        );
        assert_eq!(controller.state().active, None);
        controller.shutdown().await.unwrap();
        assert_eq!(
            setup.operations(),
            [
                "start:tailscale",
                "stop",
                "cleanup:mac.one.ts.net:4111",
                "recover:4111"
            ]
        );
        assert!(!setup.cleanup_file.exists());
    }

    #[tokio::test]
    async fn an_adopted_host_stays_untouched_and_claims_no_access_mode() {
        let setup = setup();
        let mut fake = Fake::new(&setup.log);
        let log = setup.log.clone();
        fake.start = Box::new(move |access| {
            log.lock()
                .unwrap()
                .push(format!("start:{:?}", access.mode()).to_lowercase());
            Ok(Started {
                port: 4111,
                adopted: true,
            })
        });
        let controller = setup.controller(fake);
        assert_eq!(
            controller.start_preferred().await.unwrap(),
            ActiveNetworkAccess::Adopted { port: 4111 }
        );
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        assert!(controller
            .apply_preference()
            .await
            .unwrap_err()
            .contains("does not own"));
        controller.shutdown().await.unwrap();
        assert_eq!(setup.operations(), ["start:local"]);
        assert_eq!(
            controller.state().active,
            Some(ActiveNetworkAccess::Adopted { port: 4111 })
        );
    }

    #[tokio::test]
    async fn shutdown_waits_behind_an_apply_and_then_stops_the_resulting_owned_host() {
        let setup = setup();
        let gate = Arc::new(tokio::sync::Notify::new());
        let mut fake = Fake::new(&setup.log);
        fake.gate = Some(gate.clone());
        let controller = setup.controller(fake);
        controller.start_preferred().await.unwrap();
        controller
            .save_preference(NetworkMode::Tailscale)
            .await
            .unwrap();
        let changing = tokio::spawn({
            let controller = controller.clone();
            async move { controller.apply_preference().await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let shutdown = tokio::spawn({
            let controller = controller.clone();
            async move { controller.shutdown().await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(controller.state().busy);
        gate.notify_one();
        changing.await.unwrap().unwrap();
        shutdown.await.unwrap().unwrap();
        assert_eq!(
            setup
                .operations()
                .iter()
                .filter(|entry| *entry == "stop")
                .count(),
            2
        );
        assert_eq!(controller.state().active, None);
    }
}
