//! Payloads the bridge hands to JavaScript. `window.suplexApp` keeps the shape declared in
//! `apps/web/vite-env.d.ts`; `window.suplexDesktop` keeps the shape the bundled setup pages read.
//! `tests/fixtures/bridge-payloads.json` pins both, so drift fails a test.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BootStateName {
    Resolve,
    BootstrapNeeded,
    Choosing,
    Installing,
    Ready,
    Starting,
    ConnectingRemote,
    Connected,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureSource {
    Installing,
    Starting,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootFailure {
    pub from: FailureSource,
    pub title: String,
    pub reason: String,
    pub remedy: Option<String>,
    pub stage: Option<String>,
    pub log: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallStage {
    pub name: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedStage {
    pub stage: String,
    pub skipped: bool,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "name", rename_all = "kebab-case")]
pub enum InstallEvent {
    Stages {
        stages: Vec<InstallStage>,
        from: usize,
    },
    StageStarted {
        stage: String,
    },
    Log {
        line: String,
    },
    #[serde(rename_all = "camelCase")]
    StageFinished {
        stage: String,
        skipped: bool,
        elapsed_ms: u64,
    },
    Failed {
        stage: String,
        title: String,
        reason: String,
        remedy: Option<String>,
    },
    Done,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub state: BootStateName,
    pub stages: Vec<InstallStage>,
    pub finished: Vec<FinishedStage>,
    pub current: Option<String>,
    pub log: Vec<String>,
    pub failure: Option<BootFailure>,
    pub hosts: Vec<String>,
    pub current_host: Option<String>,
    pub local_host: Option<String>,
    /// `macos`, `linux`, or `windows`: the setup pages offer a local host only where one runs.
    pub platform: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConnectionTest {
    pub ok: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TailscaleState {
    Missing,
    NotRunning,
    SignedOut,
    Approval,
    Off,
    Starting,
    On,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TailnetMachine {
    pub name: String,
    pub host: String,
    pub online: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TailscaleStatus {
    pub state: TailscaleState,
    pub tailnet: Option<String>,
    pub machines: Vec<TailnetMachine>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    #[default]
    Local,
    Tailscale,
    All,
}

/// `DesktopNetworkAccess` in `apps/web/vite-env.d.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AppNetworkAccess {
    Unmanaged { managed: False },
    Managed(ManagedNetworkAccess),
}

/// Serializes as JSON `false`, the discriminant the frontend checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct False;
impl Serialize for False {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedNetworkAccess {
    pub managed: bool,
    pub preference: NetworkMode,
    pub active: Option<NetworkMode>,
    pub pending: bool,
    pub busy: bool,
    pub https_url: Option<String>,
}

impl AppNetworkAccess {
    pub fn unmanaged() -> Self {
        Self::Unmanaged { managed: False }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/bridge-payloads.json")).unwrap()
    }

    fn check(name: &str, value: impl Serialize) {
        assert_eq!(
            serde_json::to_value(value).unwrap(),
            fixture()[name],
            "{name}"
        );
    }

    #[test]
    fn bridge_payloads_match_the_fixture() {
        check("unmanaged", AppNetworkAccess::unmanaged());
        check(
            "managed",
            AppNetworkAccess::Managed(ManagedNetworkAccess {
                managed: true,
                preference: NetworkMode::Tailscale,
                active: Some(NetworkMode::Local),
                pending: true,
                busy: false,
                https_url: None,
            }),
        );
        check(
            "snapshot",
            DesktopSnapshot {
                state: BootStateName::ConnectingRemote,
                stages: vec![InstallStage {
                    name: "herdr".into(),
                    title: "Install Herdr terminals".into(),
                }],
                finished: vec![FinishedStage {
                    stage: "herdr".into(),
                    skipped: true,
                    elapsed_ms: 12,
                }],
                current: None,
                log: vec!["herdr: working".into()],
                failure: Some(BootFailure {
                    from: FailureSource::Installing,
                    title: "Install Herdr terminals".into(),
                    reason: "curl exited 22".into(),
                    remedy: None,
                    stage: Some("herdr".into()),
                    log: vec![],
                }),
                hosts: vec!["https://suplex.example".into()],
                current_host: Some("https://suplex.example".into()),
                local_host: None,
                platform: "linux",
            },
        );
        check(
            "events",
            vec![
                InstallEvent::Stages {
                    stages: vec![InstallStage {
                        name: "data".into(),
                        title: "Prepare Suplex data".into(),
                    }],
                    from: 0,
                },
                InstallEvent::StageStarted {
                    stage: "data".into(),
                },
                InstallEvent::Log {
                    line: "data: working".into(),
                },
                InstallEvent::StageFinished {
                    stage: "data".into(),
                    skipped: false,
                    elapsed_ms: 5,
                },
                InstallEvent::Failed {
                    stage: "data".into(),
                    title: "Prepare Suplex data".into(),
                    reason: "disk full".into(),
                    remedy: Some("Free space and retry.".into()),
                },
                InstallEvent::Done,
            ],
        );
        check(
            "tailscale",
            TailscaleStatus {
                state: TailscaleState::NotRunning,
                tailnet: None,
                machines: vec![TailnetMachine {
                    name: "devbox".into(),
                    host: "devbox.tail1.ts.net".into(),
                    online: true,
                }],
            },
        );
        check(
            "connection",
            ConnectionTest {
                ok: false,
                reason: Some("No Suplex answered at https://x/health.".into()),
            },
        );
    }

    /// The frontend declaration and the fixture must name the same network-access fields.
    #[test]
    fn frontend_declaration_matches_the_fixture() {
        let declaration = include_str!("../../../web/vite-env.d.ts");
        let start = declaration.find("type DesktopNetworkAccess").unwrap();
        let body = &declaration[start..declaration[start..].find("};").unwrap() + start];
        let mut declared: Vec<&str> = body
            .split(['{', ';', '|'])
            .filter_map(|part| part.trim().split_once(':').map(|(name, _)| name.trim()))
            .collect();
        declared.sort_unstable();
        declared.dedup();
        let mut fixture_keys: Vec<String> = fixture()["managed"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        fixture_keys.sort_unstable();
        assert_eq!(declared, fixture_keys);
        assert_eq!(fixture()["unmanaged"], json!({ "managed": false }));
        for method in [
            "accountCleared",
            "openHostPicker",
            "networkAccess",
            "saveNetworkAccessPreference",
            "restartNetworkAccess",
            "onNetworkAccessChange",
        ] {
            assert!(declaration.contains(&format!("{method}(")), "{method}");
            assert!(
                include_str!("../../src/bridge.js").contains(&format!("{method}:")),
                "bridge.js defines {method}"
            );
        }
    }
}
