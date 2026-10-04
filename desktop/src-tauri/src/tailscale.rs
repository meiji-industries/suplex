//! Tailscale on this Mac: live status, MagicDNS discovery, and removal of only the Serve route
//! that points at the shell-owned host. Every answer comes from a fresh CLI call; nothing is cached.

use std::{future::Future, time::Duration};

use serde_json::Value;

use crate::contracts::{TailnetMachine, TailscaleState, TailscaleStatus};

/// A GUI app does not inherit the shell's PATH, so the App Store bundle and Homebrew locations are tried too.
pub const COMMANDS: [&str; 4] = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "tailscale",
];

#[derive(Debug, PartialEq, Eq)]
pub enum RunError {
    NotFound,
    Failed(String),
}

pub trait Runner: Send + Sync {
    fn run(
        &self,
        command: &str,
        args: &[&str],
        timeout: Duration,
    ) -> impl Future<Output = Result<String, RunError>> + Send;
}

/// Runs the CLI. `TAILSCALE_BE_CLI=1` stops the App Store binary from starting its GUI and exiting 0.
pub struct SystemRunner;

impl Runner for SystemRunner {
    async fn run(
        &self,
        command: &str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<String, RunError> {
        let child = tokio::process::Command::new(command)
            .args(args)
            .env("TAILSCALE_BE_CLI", "1")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        match tokio::time::timeout(timeout, child).await {
            Err(_) => Err(RunError::Failed(format!(
                "{command} did not answer within {} seconds.",
                timeout.as_secs()
            ))),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(RunError::NotFound)
            }
            Ok(Err(error)) => Err(RunError::Failed(error.to_string())),
            Ok(Ok(output)) if output.status.success() => {
                Ok(String::from_utf8_lossy(&output.stdout).into_owned())
            }
            Ok(Ok(output)) => Err(RunError::Failed(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailscaleAccess {
    pub hostname: String,
    pub command: String,
}

fn self_hostname(raw: &str) -> Option<String> {
    let status: Value = serde_json::from_str(raw).ok()?;
    let hostname = status
        .get("Self")?
        .get("DNSName")?
        .as_str()?
        .trim_end_matches('.');
    (status.get("BackendState")?.as_str()? == "Running" && hostname.ends_with(".ts.net"))
        .then(|| hostname.to_owned())
}

/// The working executable and this Mac's current MagicDNS name, from one fresh status response.
pub async fn resolve_access(
    commands: &[&str],
    runner: &impl Runner,
) -> Result<TailscaleAccess, String> {
    let mut installed = false;
    for command in commands {
        match runner
            .run(command, &["status", "--json"], Duration::from_secs(5))
            .await
        {
            Ok(raw) => {
                installed = true;
                if let Some(hostname) = self_hostname(&raw) {
                    return Ok(TailscaleAccess {
                        hostname,
                        command: (*command).to_owned(),
                    });
                }
            }
            Err(RunError::Failed(_)) => installed = true,
            Err(RunError::NotFound) => {}
        }
    }
    Err(if installed {
        "Tailscale is not connected. Open Tailscale, connect this Mac, and retry.".into()
    } else {
        "Tailscale is not installed. Install Tailscale, connect this Mac, and retry.".into()
    })
}

const INVALID_SERVE: &str = "Tailscale returned invalid Serve status.";

/// The `host:port` whose root handler proxies to `proxy`, or `None`. Malformed status is an error, never safe absence.
pub fn find_serve_route(raw: &str, port: u16, proxy: &str) -> Result<Option<String>, String> {
    let Ok(Value::Object(status)) = serde_json::from_str::<Value>(raw) else {
        return Err(INVALID_SERVE.into());
    };
    let web = match status.get("Web") {
        None | Some(Value::Null) => {
            return match status.get("TCP") {
                None | Some(Value::Object(_)) => Ok(None),
                Some(_) => Err(INVALID_SERVE.into()),
            };
        }
        Some(Value::Object(web)) => web,
        Some(_) => return Err(INVALID_SERVE.into()),
    };
    let suffix = format!(":{port}");
    Ok(web
        .iter()
        .filter(|(host, _)| host.ends_with(&suffix))
        .find(|(_, server)| {
            server
                .get("Handlers")
                .and_then(|handlers| handlers.get("/"))
                .and_then(|root| root.get("Proxy"))
                .and_then(Value::as_str)
                == Some(proxy)
        })
        .map(|(host, _)| host.clone()))
}

/// Removes only the root handler that points at this desktop host, then observes the live Serve status again.
pub async fn remove_serve_route(
    access: &TailscaleAccess,
    port: u16,
    runner: &impl Runner,
) -> Result<(), String> {
    let proxy = format!("http://127.0.0.1:{port}");
    let failed = |error: RunError| match error {
        RunError::NotFound => format!("{} is missing.", access.command),
        RunError::Failed(reason) => reason.trim().to_owned(),
    };
    let status = runner
        .run(
            &access.command,
            &["serve", "status", "--json"],
            Duration::from_secs(5),
        )
        .await
        .map_err(failed)?;
    if find_serve_route(&status, port, &proxy)?.is_none() {
        return Ok(());
    }
    let https = format!("--https={port}");
    runner
        .run(
            &access.command,
            &["serve", &https, "--set-path=/", &proxy, "off"],
            Duration::from_secs(10),
        )
        .await
        .map_err(failed)?;
    let observed = runner
        .run(
            &access.command,
            &["serve", "status", "--json"],
            Duration::from_secs(5),
        )
        .await
        .map_err(failed)?;
    match find_serve_route(&observed, port, &proxy)? {
        None => Ok(()),
        Some(_) => Err("Tailscale still exposes this Suplex instance. Open Tailscale and remove the matching Serve route.".into()),
    }
}

fn state_of(backend: &str) -> Option<TailscaleState> {
    Some(match backend {
        "Running" => TailscaleState::On,
        "Stopped" => TailscaleState::Off,
        "Starting" | "NoState" => TailscaleState::Starting,
        "NeedsLogin" => TailscaleState::SignedOut,
        "NeedsMachineAuth" => TailscaleState::Approval,
        _ => return None,
    })
}

/// Other machines by MagicDNS name, online first. Phones, tablets, and Mullvad exit nodes cannot run Suplex.
pub fn parse_status(raw: &str) -> Option<TailscaleStatus> {
    let status: Value = serde_json::from_str(raw).ok()?;
    let state = state_of(status.get("BackendState")?.as_str()?)?;
    let mut machines: Vec<TailnetMachine> = status
        .get("Peer")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|peers| peers.values())
        .filter_map(|peer| {
            let host = peer.get("DNSName")?.as_str()?.trim_end_matches('.');
            let handheld = peer
                .get("OS")
                .and_then(Value::as_str)
                .is_some_and(|os| matches!(os.to_lowercase().as_str(), "ios" | "android"));
            if host.is_empty() || peer.get("Location").is_some() || handheld {
                return None;
            }
            Some(TailnetMachine {
                name: host.split('.').next().unwrap_or(host).to_owned(),
                host: host.to_owned(),
                online: peer.get("Online").and_then(Value::as_bool) == Some(true),
            })
        })
        .collect();
    machines.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.name.cmp(&b.name)));
    let tailnet = status
        .get("CurrentTailnet")
        .and_then(|tailnet| tailnet.get("Name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && state != TailscaleState::SignedOut)
        .map(str::to_owned);
    Some(TailscaleStatus {
        state,
        tailnet,
        machines: if state == TailscaleState::On {
            machines
        } else {
            Vec::new()
        },
    })
}

/// Installed or not, signed in or not, on or off. A CLI that cannot reach its service means not running.
pub async fn status(commands: &[&str], runner: &impl Runner) -> TailscaleStatus {
    let mut installed = false;
    for command in commands {
        match runner
            .run(command, &["status", "--json"], Duration::from_secs(5))
            .await
        {
            Ok(raw) => {
                installed = true;
                if let Some(status) = parse_status(&raw) {
                    return status;
                }
            }
            Err(RunError::Failed(_)) => installed = true,
            Err(RunError::NotFound) => {}
        }
    }
    TailscaleStatus {
        state: if installed {
            TailscaleState::NotRunning
        } else {
            TailscaleState::Missing
        },
        tailnet: None,
        machines: Vec::new(),
    }
}

/// A bare `tailscale up` brings the network online without changing settings; any flag makes it a
/// settings change, so the process timeout stands in for `--timeout`. Returns why it failed, or `None`.
pub async fn turn_on(commands: &[&str], runner: &impl Runner) -> Option<String> {
    let mut reason = "Tailscale is not installed on this Mac.".to_owned();
    for command in commands {
        match runner.run(command, &["up"], Duration::from_secs(25)).await {
            Ok(_) => return None,
            Err(RunError::NotFound) => {}
            Err(RunError::Failed(stderr)) => {
                let collapsed = stderr.split_whitespace().collect::<Vec<_>>().join(" ");
                reason = if collapsed.is_empty() {
                    "Tailscale did not start.".into()
                } else {
                    collapsed
                };
            }
        }
    }
    Some(reason)
}

#[cfg(test)]
mod tests {
    use std::{os::unix::fs::PermissionsExt, sync::Mutex};

    use super::*;

    fn status_json(backend: &str, peers: Value) -> String {
        serde_json::json!({ "BackendState": backend, "CurrentTailnet": { "Name": "example.com" }, "Self": { "HostName": "this-mac", "DNSName": "this-mac.tail1.ts.net." }, "Peer": peers }).to_string()
    }

    /// A real executable, so the system runner's not-found and failure handling are exercised too.
    fn script(directory: &tempfile::TempDir, name: &str, body: &str) -> String {
        let file = directory.path().join(name);
        std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        file.display().to_string()
    }

    struct Scripted(
        Mutex<Vec<Result<String, RunError>>>,
        Mutex<Vec<Vec<String>>>,
    );
    impl Scripted {
        fn new(answers: Vec<Result<String, RunError>>) -> Self {
            Self(
                Mutex::new(answers.into_iter().rev().collect()),
                Mutex::new(Vec::new()),
            )
        }
        fn calls(&self) -> Vec<Vec<String>> {
            self.1.lock().unwrap().clone()
        }
    }
    impl Runner for Scripted {
        async fn run(
            &self,
            command: &str,
            args: &[&str],
            timeout: Duration,
        ) -> Result<String, RunError> {
            let mut call = vec![command.to_owned()];
            call.extend(args.iter().map(|arg| arg.to_string()));
            call.push(timeout.as_secs().to_string());
            self.1.lock().unwrap().push(call);
            self.0
                .lock()
                .unwrap()
                .pop()
                .expect("an answer for every call")
        }
    }

    #[test]
    fn lists_machines_online_first_without_phones_or_exit_nodes() {
        let parsed = parse_status(&status_json("Running", serde_json::json!({
            "a": { "DNSName": "zed.tail1.ts.net.", "OS": "linux", "Online": true },
            "b": { "DNSName": "alpha.tail1.ts.net.", "OS": "macOS", "Online": false },
            "c": { "DNSName": "devbox.tail1.ts.net.", "OS": "linux", "Online": true },
            "d": { "DNSName": "phone.tail1.ts.net.", "OS": "iOS", "Online": true },
            "e": { "DNSName": "", "OS": "linux", "Online": true },
            "f": { "DNSName": "al-tia-wg-001.mullvad.ts.net.", "OS": "", "Online": true, "Location": { "Country": "Albania" } },
        }))).unwrap();
        assert_eq!(parsed.state, TailscaleState::On);
        assert_eq!(parsed.tailnet.as_deref(), Some("example.com"));
        let machines: Vec<(&str, &str, bool)> = parsed
            .machines
            .iter()
            .map(|m| (m.name.as_str(), m.host.as_str(), m.online))
            .collect();
        assert_eq!(
            machines,
            [
                ("devbox", "devbox.tail1.ts.net", true),
                ("zed", "zed.tail1.ts.net", true),
                ("alpha", "alpha.tail1.ts.net", false)
            ]
        );
    }

    #[test]
    fn tells_states_apart_and_lists_machines_only_when_on() {
        let peer = serde_json::json!({ "a": { "DNSName": "devbox.tail1.ts.net.", "OS": "linux", "Online": true } });
        let off = parse_status(&status_json("Stopped", peer.clone())).unwrap();
        assert_eq!(
            (off.state, off.tailnet.as_deref(), off.machines.len()),
            (TailscaleState::Off, Some("example.com"), 0)
        );
        let signed_out = parse_status(&status_json("NeedsLogin", peer)).unwrap();
        assert_eq!(
            (signed_out.state, signed_out.tailnet),
            (TailscaleState::SignedOut, None)
        );
        assert_eq!(
            parse_status(&status_json("NeedsMachineAuth", serde_json::json!({})))
                .unwrap()
                .state,
            TailscaleState::Approval
        );
        assert_eq!(
            parse_status(&status_json("Starting", serde_json::json!({})))
                .unwrap()
                .state,
            TailscaleState::Starting
        );
        assert_eq!(parse_status("not json"), None);
    }

    #[tokio::test]
    async fn missing_without_a_cli_and_not_running_when_a_cli_gives_no_status() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            status(&["/nonexistent/tailscale"], &SystemRunner)
                .await
                .state,
            TailscaleState::Missing
        );
        let broken = script(
            &directory,
            "broken",
            "echo 'failed to connect to local Tailscale service' >&2; exit 1",
        );
        assert_eq!(
            status(&["/nonexistent/tailscale", &broken], &SystemRunner)
                .await
                .state,
            TailscaleState::NotRunning
        );
    }

    #[tokio::test]
    async fn moves_on_when_a_cli_exits_zero_without_status_json() {
        let directory = tempfile::tempdir().unwrap();
        let working = script(
            &directory,
            "working",
            &format!(
                "echo '{}'",
                status_json(
                    "Running",
                    serde_json::json!({ "a": { "DNSName": "devbox.tail1.ts.net.", "OS": "linux", "Online": true } })
                )
            ),
        );
        let found = status(&["/bin/echo", &working], &SystemRunner).await;
        assert_eq!(
            found.machines,
            [TailnetMachine {
                name: "devbox".into(),
                host: "devbox.tail1.ts.net".into(),
                online: true
            }]
        );
    }

    #[tokio::test]
    async fn runs_the_app_store_binary_as_a_cli() {
        let directory = tempfile::tempdir().unwrap();
        let cli = script(
            &directory,
            "cli",
            &format!(
                "[ \"$TAILSCALE_BE_CLI\" = 1 ] && echo '{}'",
                status_json("Stopped", serde_json::json!({}))
            ),
        );
        assert_eq!(
            status(&[&cli], &SystemRunner).await.state,
            TailscaleState::Off
        );
    }

    #[tokio::test]
    async fn resolves_the_working_cli_and_the_current_name_from_the_same_status() {
        let directory = tempfile::tempdir().unwrap();
        let first = script(&directory, "first", "echo not-json");
        let second = script(
            &directory,
            "second",
            &format!("echo '{}'", status_json("Running", serde_json::json!({}))),
        );
        assert_eq!(
            resolve_access(&[&first, &second], &SystemRunner).await,
            Ok(TailscaleAccess {
                hostname: "this-mac.tail1.ts.net".into(),
                command: second
            })
        );
        let renamed = script(
            &directory,
            "renamed",
            r#"echo '{"BackendState":"Running","Self":{"DNSName":"renamed.tail1.ts.net."}}'"#,
        );
        assert_eq!(
            resolve_access(&[&renamed], &SystemRunner)
                .await
                .unwrap()
                .hostname,
            "renamed.tail1.ts.net"
        );
        assert!(resolve_access(&["/nonexistent/tailscale"], &SystemRunner)
            .await
            .unwrap_err()
            .contains("not installed"));
        assert!(resolve_access(&[&first], &SystemRunner)
            .await
            .unwrap_err()
            .contains("not connected"));
    }

    #[tokio::test]
    async fn cleanup_follows_the_live_hostname_and_preserves_sibling_paths_and_ports() {
        let before = serde_json::json!({ "Web": {
            "renamed.tail1.ts.net:4111": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:4111" }, "/docs": { "Proxy": "http://127.0.0.1:9000" } } },
            "renamed.tail1.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3100" } } },
        } }).to_string();
        let after = serde_json::json!({ "Web": {
            "renamed.tail1.ts.net:4111": { "Handlers": { "/docs": { "Proxy": "http://127.0.0.1:9000" } } },
            "renamed.tail1.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3100" } } },
        } }).to_string();
        let runner = Scripted::new(vec![Ok(before), Ok(String::new()), Ok(after.clone())]);
        remove_serve_route(
            &TailscaleAccess {
                hostname: "old.tail1.ts.net".into(),
                command: "/tailscale".into(),
            },
            4111,
            &runner,
        )
        .await
        .unwrap();
        assert_eq!(
            runner.calls()[1],
            [
                "/tailscale",
                "serve",
                "--https=4111",
                "--set-path=/",
                "http://127.0.0.1:4111",
                "off",
                "10"
            ]
        );
        assert_eq!(
            find_serve_route(&after, 4111, "http://127.0.0.1:4111"),
            Ok(None)
        );
        assert_eq!(
            find_serve_route(&after, 443, "http://127.0.0.1:3100"),
            Ok(Some("renamed.tail1.ts.net:443".into()))
        );
    }

    #[tokio::test]
    async fn a_route_that_survives_removal_is_reported() {
        let route = serde_json::json!({ "Web": { "mac.tail1.ts.net:4111": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:4111" } } } } }).to_string();
        let runner = Scripted::new(vec![Ok(route.clone()), Ok(String::new()), Ok(route)]);
        let error = remove_serve_route(
            &TailscaleAccess {
                hostname: "mac.tail1.ts.net".into(),
                command: "/tailscale".into(),
            },
            4111,
            &runner,
        )
        .await
        .unwrap_err();
        assert!(error.contains("still exposes"));
    }

    #[tokio::test]
    async fn cleanup_rejects_malformed_status_instead_of_treating_it_as_absence() {
        for raw in [
            "null",
            "[]",
            "not json",
            r#"{"Web":"invalid"}"#,
            r#"{"TCP":[]}"#,
        ] {
            let runner = Scripted::new(vec![Ok(raw.to_owned())]);
            let error = remove_serve_route(
                &TailscaleAccess {
                    hostname: "mac.tail1.ts.net".into(),
                    command: "/tailscale".into(),
                },
                4111,
                &runner,
            )
            .await
            .unwrap_err();
            assert!(error.contains("invalid Serve status"), "{raw}");
        }
    }

    #[tokio::test]
    async fn tcp_only_status_has_no_matching_http_route() {
        for raw in [
            "{}",
            r#"{"Web":null}"#,
            r#"{"TCP":{"4111":{"TCPForward":"127.0.0.1:9000"}}}"#,
            r#"{"TCP":{"4111":{"TCPForward":"127.0.0.1:9000"}},"Web":null}"#,
        ] {
            let runner = Scripted::new(vec![Ok(raw.to_owned())]);
            remove_serve_route(
                &TailscaleAccess {
                    hostname: "mac.tail1.ts.net".into(),
                    command: "/tailscale".into(),
                },
                4111,
                &runner,
            )
            .await
            .unwrap();
            assert_eq!(runner.calls().len(), 1, "{raw}");
        }
    }

    #[tokio::test]
    async fn turns_tailscale_on_with_a_bare_up_and_reports_why_not() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            turn_on(
                &[&script(&directory, "up", r#"[ "$*" = "up" ]"#)],
                &SystemRunner
            )
            .await,
            None
        );
        let refused = script(
            &directory,
            "refused",
            r"printf 'Error: changing settings requires\nall flags\n' >&2; exit 1",
        );
        assert_eq!(
            turn_on(&[&refused], &SystemRunner).await.as_deref(),
            Some("Error: changing settings requires all flags")
        );
        assert_eq!(
            turn_on(&["/nonexistent/tailscale"], &SystemRunner)
                .await
                .as_deref(),
            Some("Tailscale is not installed on this Mac.")
        );
    }
}
