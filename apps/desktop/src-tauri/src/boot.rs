//! The boot state machine, the persisted install record, and the environment every host
//! subprocess receives.

use std::{collections::HashMap, path::Path};

use serde::{Deserialize, Serialize};

use crate::{
    contracts::{BootFailure, BootStateName, FailureSource},
    network_access::ResolvedNetworkAccess,
    paths::{home, write_atomic},
};

pub const DEFAULT_PORT: u16 = 4111;

/// Where the boot sequence is. `Failed` is latched: only a retry leaves it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootState {
    Resolve,
    BootstrapNeeded,
    Choosing,
    Installing { from: Option<String> },
    Ready,
    Starting,
    ConnectingRemote { url: Option<String> },
    Connected { url: String },
    Failed(BootFailure),
}

impl BootState {
    pub fn name(&self) -> BootStateName {
        match self {
            Self::Resolve => BootStateName::Resolve,
            Self::BootstrapNeeded => BootStateName::BootstrapNeeded,
            Self::Choosing => BootStateName::Choosing,
            Self::Installing { .. } => BootStateName::Installing,
            Self::Ready => BootStateName::Ready,
            Self::Starting => BootStateName::Starting,
            Self::ConnectingRemote { .. } => BootStateName::ConnectingRemote,
            Self::Connected { .. } => BootStateName::Connected,
            Self::Failed(_) => BootStateName::Failed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BootEvent {
    Shown,
    Choose(Mode),
    /// `upgrade`: an earlier install exists, so the new bundle starts without the first-install welcome.
    Installed {
        upgrade: bool,
    },
    Launch,
    Connected {
        url: String,
    },
    Failed(BootFailure),
    Retry,
    Back,
}

pub fn next(state: &BootState, event: &BootEvent) -> BootState {
    if let BootState::Failed(failure) = state {
        return match (event, failure.from) {
            (BootEvent::Retry, FailureSource::Installing) => BootState::Installing {
                from: failure.stage.clone(),
            },
            (BootEvent::Retry, FailureSource::Starting) => BootState::Starting,
            _ => state.clone(),
        };
    }
    match (event, state) {
        (BootEvent::Shown, BootState::BootstrapNeeded) => BootState::Choosing,
        (BootEvent::Choose(Mode::Local), BootState::Choosing) => {
            BootState::Installing { from: None }
        }
        (BootEvent::Choose(Mode::Remote), BootState::Choosing) => {
            BootState::ConnectingRemote { url: None }
        }
        (BootEvent::Installed { upgrade: true }, BootState::Installing { .. }) => {
            BootState::Starting
        }
        (BootEvent::Installed { upgrade: false }, BootState::Installing { .. }) => BootState::Ready,
        (BootEvent::Launch, BootState::Ready) => BootState::Starting,
        (BootEvent::Connected { url }, _) => BootState::Connected { url: url.clone() },
        (BootEvent::Failed(failure), _) => BootState::Failed(failure.clone()),
        (BootEvent::Back, BootState::ConnectingRemote { .. }) => BootState::Choosing,
        _ => state.clone(),
    }
}

/// A local install resumes locally; a new bundle first reruns its idempotent install stages.
pub fn resolve_boot(
    record: Option<&InstallRecord>,
    stamp: Option<&str>,
    remote: Option<&str>,
) -> BootState {
    match (record, remote) {
        (Some(record), _) if stamp.is_some_and(|stamp| stamp != record.runtime_stamp) => {
            BootState::Installing { from: None }
        }
        (Some(_), _) => BootState::Starting,
        (None, Some(url)) => BootState::ConnectingRemote {
            url: Some(url.to_owned()),
        },
        (None, None) => BootState::BootstrapNeeded,
    }
}

/// Written once the install finishes; read on every launch to decide whether to start the local host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub completed_at: String,
    pub runtime_stamp: String,
    pub port: u16,
}

/// Windows has no bundled host, so it never has a local install; every caller goes through here.
pub fn read_install_record(file: &Path) -> Option<InstallRecord> {
    if !crate::platform::LOCAL_SUPPORTED {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

pub fn write_install_record(file: &Path, record: &InstallRecord) -> std::io::Result<()> {
    write_atomic(file, serde_json::to_string(record)?.as_bytes())
}

/// The bundled runtime's version, so a desktop update reruns the install stages.
pub fn runtime_stamp(directory: &Path) -> Option<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join("manifest.json")).ok()?)
            .ok()?;
    manifest.get("version")?.as_str().map(str::to_owned)
}

/// The environment of the host and the install CLI. `PATH` reaches user-installed tools a GUI app does not inherit.
pub fn runtime_environment(
    user_data: &Path,
    port: u16,
    base: &HashMap<String, String>,
    access: &ResolvedNetworkAccess,
) -> HashMap<String, String> {
    let home = home(base);
    let home_text = home.display().to_string();
    let mut environment: HashMap<String, String> = [
        ("SUPLEX_PACKAGED", "1".to_owned()),
        ("SUPLEX_BIND_ADDRESS", "127.0.0.1".to_owned()),
        ("SUPLEX_PORT", port.to_string()),
        ("SUPLEX_DATA_ROOT", user_data.join("data").display().to_string()),
        ("SUPLEX_ENV_FILE", user_data.join("suplex.env").display().to_string()),
        ("SUPLEX_REPOSITORY_ROOT", home.join("suplex/repos").display().to_string()),
        ("SUPLEX_WORKTREE_ROOT", home.join("suplex/worktrees").display().to_string()),
        ("HOME", home_text.clone()),
        ("USER", base.get("USER").cloned().unwrap_or_default()),
        ("TMPDIR", base.get("TMPDIR").cloned().unwrap_or_else(|| std::env::temp_dir().display().to_string())),
        ("PATH", format!("{home_text}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect();
    let mut set = |key: &str, value: &str| {
        environment.insert(key.to_owned(), value.to_owned());
    };
    match access {
        ResolvedNetworkAccess::Local => set("SUPLEX_ACCESS_MODE", "local"),
        ResolvedNetworkAccess::All => {
            set("SUPLEX_ACCESS_MODE", "all");
            set("SUPLEX_BIND_ADDRESS", "0.0.0.0");
        }
        ResolvedNetworkAccess::Tailscale { hostname, command } => {
            set("SUPLEX_ACCESS_MODE", "tailscale");
            set("SUPLEX_TAILSCALE_EXPOSURE", "serve");
            set("SUPLEX_TAILSCALE_ADDRESS", hostname);
            set("SUPLEX_TAILSCALE_COMMAND", command);
        }
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> InstallRecord {
        InstallRecord {
            completed_at: "2026-09-16T00:00:00.000Z".into(),
            runtime_stamp: "0.0.0-fixture".into(),
            port: DEFAULT_PORT,
        }
    }
    fn failure(from: FailureSource, stage: Option<&str>) -> BootFailure {
        BootFailure {
            from,
            title: "Install Herdr terminals".into(),
            reason: "curl exited 22".into(),
            remedy: Some("Check the network connection and retry.".into()),
            stage: stage.map(str::to_owned),
            log: vec!["herdr: checking".into()],
        }
    }
    const REMOTE: &str = "https://suplex.tail1234.ts.net/";

    #[test]
    fn a_matching_install_record_starts_locally_ahead_of_a_remembered_remote() {
        assert_eq!(
            resolve_boot(Some(&record()), Some("0.0.0-fixture"), Some(REMOTE)),
            BootState::Starting
        );
    }

    #[test]
    fn a_new_runtime_reruns_install_and_a_missing_stamp_still_starts() {
        assert_eq!(
            resolve_boot(Some(&record()), Some("1.0.0"), Some(REMOTE)),
            BootState::Installing { from: None }
        );
        assert_eq!(
            resolve_boot(Some(&record()), None, None),
            BootState::Starting
        );
        assert_eq!(
            resolve_boot(None, Some("0.0.0-fixture"), None),
            BootState::BootstrapNeeded
        );
        assert_eq!(
            resolve_boot(None, None, Some(REMOTE)),
            BootState::ConnectingRemote {
                url: Some(REMOTE.into())
            }
        );
    }

    #[test]
    fn the_local_path_runs_choice_install_ready_start_connected() {
        let mut state = BootState::BootstrapNeeded;
        for (event, expected) in [
            (BootEvent::Shown, BootState::Choosing),
            (
                BootEvent::Choose(Mode::Local),
                BootState::Installing { from: None },
            ),
            (BootEvent::Installed { upgrade: false }, BootState::Ready),
            (BootEvent::Launch, BootState::Starting),
            (
                BootEvent::Connected {
                    url: "http://127.0.0.1:4111/".into(),
                },
                BootState::Connected {
                    url: "http://127.0.0.1:4111/".into(),
                },
            ),
        ] {
            state = next(&state, &event);
            assert_eq!(state, expected, "{event:?}");
        }
    }

    #[test]
    fn an_upgrade_starts_after_its_install_stages_without_the_welcome() {
        let upgrading = resolve_boot(Some(&record()), Some("1.0.0"), None);
        assert_eq!(
            next(&upgrading, &BootEvent::Installed { upgrade: true }),
            BootState::Starting
        );
        let failed = next(
            &upgrading,
            &BootEvent::Failed(failure(FailureSource::Installing, Some("herdr"))),
        );
        let retried = next(&failed, &BootEvent::Retry);
        assert_eq!(
            next(&retried, &BootEvent::Installed { upgrade: true }),
            BootState::Starting
        );
    }

    #[test]
    fn the_remote_path_opens_the_form_and_returns_to_the_choice() {
        let remote = next(&BootState::Choosing, &BootEvent::Choose(Mode::Remote));
        assert_eq!(remote, BootState::ConnectingRemote { url: None });
        assert_eq!(next(&remote, &BootEvent::Back), BootState::Choosing);
        assert_eq!(
            next(&remote, &BootEvent::Connected { url: REMOTE.into() }),
            BootState::Connected { url: REMOTE.into() }
        );
    }

    #[test]
    fn failure_is_latched_until_a_retry_from_the_failed_stage() {
        let failed = next(
            &BootState::Installing { from: None },
            &BootEvent::Failed(failure(FailureSource::Installing, Some("herdr"))),
        );
        assert_eq!(
            failed,
            BootState::Failed(failure(FailureSource::Installing, Some("herdr")))
        );
        for event in [
            BootEvent::Shown,
            BootEvent::Launch,
            BootEvent::Installed { upgrade: false },
            BootEvent::Back,
            BootEvent::Choose(Mode::Local),
        ] {
            assert_eq!(next(&failed, &event), failed, "{event:?}");
        }
        assert_eq!(
            next(&failed, &BootEvent::Retry),
            BootState::Installing {
                from: Some("herdr".into())
            }
        );
        let start_failed = next(
            &BootState::Starting,
            &BootEvent::Failed(failure(FailureSource::Starting, None)),
        );
        assert_eq!(next(&start_failed, &BootEvent::Retry), BootState::Starting);
    }

    #[test]
    fn events_that_do_not_belong_to_the_state_change_nothing() {
        assert_eq!(
            next(&BootState::Choosing, &BootEvent::Launch),
            BootState::Choosing
        );
        assert_eq!(
            next(&BootState::Ready, &BootEvent::Installed { upgrade: false }),
            BootState::Ready
        );
        assert_eq!(
            next(&BootState::Starting, &BootEvent::Shown),
            BootState::Starting
        );
    }

    #[test]
    fn the_stamp_is_the_runtime_version_and_absent_without_a_runtime() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime");
        assert_eq!(runtime_stamp(&fixture).as_deref(), Some("0.0.0-fixture"));
        assert_eq!(runtime_stamp(&fixture.join("missing")), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_never_reads_a_local_install() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("install.json");
        write_install_record(&file, &record()).unwrap();
        assert_eq!(read_install_record(&file), None);
    }

    // Windows has no local host: no install record, and no host environment.
    #[cfg(unix)]
    #[test]
    fn the_install_record_round_trips_in_its_existing_format_and_rejects_anything_incomplete() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("install.json");
        assert_eq!(read_install_record(&file), None);
        write_install_record(&file, &record()).unwrap();
        assert_eq!(read_install_record(&file), Some(record()));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            r#"{"completedAt":"2026-09-16T00:00:00.000Z","runtimeStamp":"0.0.0-fixture","port":4111}"#
        );
        std::fs::write(
            &file,
            r#"{"completedAt":"2026-10-01T14:26:34.989Z","runtimeStamp":"1.2.1","port":4111}"#,
        )
        .unwrap();
        assert_eq!(read_install_record(&file).unwrap().runtime_stamp, "1.2.1");
        std::fs::write(&file, r#"{"completedAt":"2026-09-16T00:00:00.000Z"}"#).unwrap();
        assert_eq!(read_install_record(&file), None);
        std::fs::write(&file, "{corrupt").unwrap();
        assert_eq!(read_install_record(&file), None);
    }

    fn base(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    // Windows has no local host: no install record, and no host environment.
    #[cfg(unix)]
    #[test]
    fn the_local_runtime_environment_has_the_existing_meanings() {
        let environment = runtime_environment(
            Path::new("/data/Suplex"),
            4222,
            &base(&[
                ("HOME", "/Users/ada"),
                ("USER", "ada"),
                ("TMPDIR", "/tmp/x"),
            ]),
            &ResolvedNetworkAccess::Local,
        );
        let expected = base(&[
            ("SUPLEX_PACKAGED", "1"),
            ("SUPLEX_ACCESS_MODE", "local"),
            ("SUPLEX_BIND_ADDRESS", "127.0.0.1"),
            ("SUPLEX_PORT", "4222"),
            ("SUPLEX_DATA_ROOT", "/data/Suplex/data"),
            ("SUPLEX_ENV_FILE", "/data/Suplex/suplex.env"),
            ("SUPLEX_REPOSITORY_ROOT", "/Users/ada/suplex/repos"),
            ("SUPLEX_WORKTREE_ROOT", "/Users/ada/suplex/worktrees"),
            ("HOME", "/Users/ada"),
            ("USER", "ada"),
            ("TMPDIR", "/tmp/x"),
            ("PATH", "/Users/ada/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
        ]);
        assert_eq!(environment, expected);
    }

    #[test]
    fn tailscale_keeps_loopback_binding_with_the_fresh_hostname_and_executable() {
        let environment = runtime_environment(
            Path::new("/data/Suplex"),
            4333,
            &base(&[("HOME", "/Users/ada")]),
            &ResolvedNetworkAccess::Tailscale {
                hostname: "mac.example.ts.net".into(),
                command: "/Applications/Tailscale.app/Contents/MacOS/Tailscale".into(),
            },
        );
        for (key, value) in [
            ("SUPLEX_ACCESS_MODE", "tailscale"),
            ("SUPLEX_BIND_ADDRESS", "127.0.0.1"),
            ("SUPLEX_PORT", "4333"),
            ("SUPLEX_TAILSCALE_EXPOSURE", "serve"),
            ("SUPLEX_TAILSCALE_ADDRESS", "mac.example.ts.net"),
            (
                "SUPLEX_TAILSCALE_COMMAND",
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            ),
        ] {
            assert_eq!(
                environment.get(key).map(String::as_str),
                Some(value),
                "{key}"
            );
        }
    }

    #[test]
    fn all_networks_binds_every_ipv4_interface() {
        let environment = runtime_environment(
            Path::new("/d"),
            4111,
            &base(&[("HOME", "/h")]),
            &ResolvedNetworkAccess::All,
        );
        assert_eq!(environment["SUPLEX_ACCESS_MODE"], "all");
        assert_eq!(environment["SUPLEX_BIND_ADDRESS"], "0.0.0.0");
    }
}
