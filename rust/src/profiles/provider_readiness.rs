//! Provider CLI readiness, probed fresh on every call. The public check never
//! contains executable paths, account details other than the requested
//! Claude account, or raw probe output.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::{Map, Value, json};

use crate::profiles::agent_profiles::{executable, home_directory};

/// Label, binary, pinning variable, and home install paths per provider CLI.
fn spec(
    kind: &str,
) -> Option<(
    &'static str,
    &'static str,
    &'static str,
    &'static [&'static str],
)> {
    Some(match kind {
        "opencode" => (
            "OpenCode",
            "opencode",
            "SUPLEX_OPENCODE_COMMAND",
            &[".opencode/bin/opencode"],
        ),
        "claude-code" => (
            "Claude Code",
            "claude",
            "SUPLEX_CLAUDE_COMMAND",
            &[".local/bin/claude", ".claude/local/claude"],
        ),
        "devin" => (
            "Devin CLI",
            "devin",
            "SUPLEX_DEVIN_COMMAND",
            &[".local/bin/devin", ".devin/bin/devin"],
        ),
        "codex" => (
            "Codex CLI",
            "codex",
            "SUPLEX_CODEX_COMMAND",
            &[".local/bin/codex", ".codex/bin/codex"],
        ),
        _ => return None,
    })
}

pub fn binary_name(kind: &str) -> &'static str {
    spec(kind).map_or("", |(_, binary, _, _)| binary)
}

/// Resolves a provider CLI: a pinned
/// absolute path, then PATH, then the standard home install paths.
pub fn resolve_executable(kind: &str) -> io::Result<PathBuf> {
    let (label, binary, variable, home_paths) = spec(kind)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Unknown provider"))?;
    if let Some(configured) = std::env::var_os(variable) {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err(io::Error::other(format!(
                "{label} executable must be an absolute path. Check {variable}."
            )));
        }
        if !executable(&path) {
            return Err(io::Error::other(format!(
                "{label} executable cannot be executed. Check {variable}."
            )));
        }
        return Ok(path);
    }
    let home = home_directory().unwrap_or_default();
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(binary))
        .chain(home_paths.iter().map(|relative| home.join(relative)))
        .find(|candidate| executable(candidate))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("Install {label} or set {variable} to its absolute executable path."),
            )
        })
}

/// Dedicated Claude logins must not inherit a different account or gateway.
pub fn claude_routing_variable(name: &str) -> bool {
    name.starts_with("ANTHROPIC_")
        || name == "CLAUDE_CONFIG_DIR"
        || [
            "USE_", "OAUTH", "API_KEY", "SKIP_", "BEDROCK", "VERTEX", "FOUNDRY",
        ]
        .iter()
        .any(|suffix| name.starts_with(&format!("CLAUDE_CODE_{suffix}")))
}

/// The environment for a Claude Code process scoped to a local instance.
pub fn claude_environment(
    directory: Option<&str>,
    inherited: HashMap<String, String>,
) -> HashMap<String, String> {
    let Some(directory) = directory else {
        return inherited;
    };
    let mut environment = inherited
        .into_iter()
        .filter(|(key, _)| !claude_routing_variable(key))
        .collect::<HashMap<_, _>>();
    environment.insert("CLAUDE_CONFIG_DIR".into(), directory.into());
    environment.insert(
        "ANTHROPIC_CONFIG_DIR".into(),
        Path::new(directory)
            .join("anthropic")
            .to_string_lossy()
            .into_owned(),
    );
    environment
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Resolves on non-zero exits; fails only when the process cannot run at all.
pub async fn probe_command(
    command: &Path,
    args: &[&str],
    environment: Option<&HashMap<String, String>>,
) -> io::Result<ProbeResult> {
    let mut process = tokio::process::Command::new(command);
    process
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(environment) = environment {
        process.env_clear().envs(environment);
    }
    match tokio::time::timeout(Duration::from_secs(5), process.output()).await {
        Ok(output) => {
            let output = output?;
            Ok(ProbeResult {
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                exit_code: output.status.code(),
                timed_out: false,
            })
        }
        Err(_) => Ok(ProbeResult {
            timed_out: true,
            ..ProbeResult::default()
        }),
    }
}

pub fn strip_ansi(value: &str) -> String {
    regex::Regex::new(r"\x1b\[[0-9;]*m")
        .expect("ansi pattern")
        .replace_all(value, "")
        .into_owned()
}

struct Classified {
    state: &'static str,
    credentials: Option<u64>,
    account: Option<String>,
}

fn state(state: &'static str) -> Classified {
    Classified {
        state,
        credentials: None,
        account: None,
    }
}

fn classify(kind: &str, result: &ProbeResult) -> Classified {
    match kind {
        "opencode" => {
            if result.exit_code != Some(0) || result.timed_out {
                return state("unknown");
            }
            let count = regex::Regex::new(r"(\d+)\s+credentials?")
                .expect("credential pattern")
                .captures(&strip_ansi(&result.stdout))
                .and_then(|found| found[1].parse::<u64>().ok());
            match count {
                None => state("present"),
                Some(0) => Classified {
                    credentials: Some(0),
                    ..state("signed-out")
                },
                Some(count) => Classified {
                    credentials: Some(count),
                    ..state("signed-in")
                },
            }
        }
        "claude-code" => {
            if result.timed_out {
                return state("unknown");
            }
            let status = serde_json::from_str::<Value>(&result.stdout).ok();
            match status
                .as_ref()
                .and_then(|status| status["loggedIn"].as_bool())
            {
                Some(true) => Classified {
                    account: status
                        .as_ref()
                        .and_then(|status| status["email"].as_str())
                        .map(str::trim)
                        .filter(|email| !email.is_empty())
                        .map(str::to_owned),
                    ..state("signed-in")
                },
                Some(false) => state("signed-out"),
                None if result.exit_code == Some(0) => state("present"),
                None => state("unknown"),
            }
        }
        _ => {
            let output =
                strip_ansi(&format!("{}\n{}", result.stdout, result.stderr)).to_lowercase();
            if output.contains("not logged in") {
                state("signed-out")
            } else if output.contains("logged in using") {
                state("signed-in")
            } else if result.timed_out {
                state("unknown")
            } else if result.exit_code == Some(0) {
                state("signed-in")
            } else {
                state("unknown")
            }
        }
    }
}

fn provider_check(
    kind: &str,
    status: &str,
    summary: String,
    remedy: Option<(&str, &str)>,
    details: Value,
) -> Value {
    let mut check = Map::new();
    check.insert("id".into(), json!(format!("provider:{kind}")));
    check.insert("label".into(), json!(label(kind)));
    check.insert("provider".into(), json!(kind));
    check.insert("status".into(), json!(status));
    check.insert("summary".into(), json!(summary));
    if let Some((remedy, remedy_kind)) = remedy {
        check.insert("remedy".into(), json!(remedy));
        check.insert("remedyKind".into(), json!(remedy_kind));
    }
    check.insert("details".into(), details);
    Value::Object(check)
}

fn label(kind: &str) -> &'static str {
    spec(kind).map_or("", |(label, _, _, _)| label)
}

// Sources: official OpenCode, Claude Code, Devin CLI, and Codex installation guides.
fn install_remedy(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "opencode" => ("curl -fsSL https://opencode.ai/install | bash", "command"),
        "claude-code" => ("curl -fsSL https://claude.ai/install.sh | bash", "command"),
        "devin" => (
            "curl -fsSL https://cli.devin.ai/install.sh | bash",
            "command",
        ),
        "codex" => ("npm install -g @openai/codex", "command"),
        _ => ("", "command"),
    }
}

fn login_remedy(kind: &str) -> &'static str {
    match kind {
        "opencode" => "opencode auth login",
        "claude-code" => "claude auth login",
        _ => "codex login",
    }
}

pub fn auth_args(kind: &str) -> &'static [&'static str] {
    match kind {
        "opencode" => &["auth", "list"],
        "claude-code" => &["auth", "status", "--json"],
        _ => &["login", "status"],
    }
}

/// Classifies a resolution and probe into the public health check.
pub fn evaluate(
    kind: &str,
    executable: &io::Result<PathBuf>,
    result: Option<io::Result<ProbeResult>>,
    include_account: bool,
) -> Value {
    let label = label(kind);
    let absent = || {
        provider_check(
            kind,
            "unhealthy",
            format!("{label} is not installed"),
            Some(install_remedy(kind)),
            json!({"state":"absent"}),
        )
    };
    let Ok(executable) = executable else {
        return absent();
    };
    let command = executable
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    let result = match result {
        Some(Ok(result)) => result,
        Some(Err(error)) if error.kind() == io::ErrorKind::NotFound => return absent(),
        _ => {
            return provider_check(
                kind,
                "warning",
                format!("Suplex could not check the {label} sign-in"),
                None,
                json!({"command": command, "state": "unknown"}),
            );
        }
    };
    let classified = classify(kind, &result);
    let mut details = json!({"command": command, "state": classified.state});
    if let Some(credentials) = classified.credentials {
        details["credentials"] = json!(credentials);
    }
    if include_account && let Some(account) = &classified.account {
        details["account"] = json!(account);
    }
    match classified.state {
        "signed-in" => provider_check(
            kind,
            "healthy",
            format!("{label} is signed in. Model access is not tested."),
            None,
            details,
        ),
        "signed-out" => provider_check(
            kind,
            "unhealthy",
            format!("{label} is not signed in"),
            Some((login_remedy(kind), "command")),
            details,
        ),
        "present" => provider_check(
            kind,
            "warning",
            format!("{label} is installed. Suplex could not check the sign-in."),
            None,
            details,
        ),
        _ => provider_check(
            kind,
            "warning",
            format!("Suplex could not check the {label} sign-in"),
            None,
            details,
        ),
    }
}

/// Readiness for one registered task runtime. `environment` replaces the
/// process environment; a Claude Code `CLAUDE_CONFIG_DIR` in it isolates the
/// probe to that local instance.
pub async fn check(
    kind: &str,
    environment: Option<HashMap<String, String>>,
    include_account: bool,
) -> Value {
    let executable = resolve_executable(kind);
    let result = match &executable {
        Ok(path) => {
            let directory = (kind == "claude-code")
                .then(|| {
                    environment
                        .as_ref()
                        .and_then(|environment| environment.get("CLAUDE_CONFIG_DIR").cloned())
                })
                .flatten();
            let mut args = auth_args(kind).to_vec();
            if directory.is_some() {
                args.extend(["--setting-sources", ""]);
            }
            let environment = environment.map(|environment| {
                if kind == "claude-code" {
                    claude_environment(directory.as_deref(), environment)
                } else {
                    environment
                }
            });
            Some(probe_command(path, &args, environment.as_ref()).await)
        }
        Err(_) => None,
    };
    evaluate(kind, &executable, result, include_account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[expect(
        clippy::unnecessary_wraps,
        reason = "stands in for executable resolution"
    )]
    fn present(path: &str) -> io::Result<PathBuf> {
        Ok(PathBuf::from(path))
    }

    fn absent() -> io::Result<PathBuf> {
        Err(io::Error::new(io::ErrorKind::NotFound, "Install the tool"))
    }

    #[expect(clippy::unnecessary_wraps, reason = "stands in for a probe result")]
    fn ok(stdout: &str) -> Option<io::Result<ProbeResult>> {
        Some(Ok(ProbeResult {
            stdout: stdout.into(),
            exit_code: Some(0),
            ..ProbeResult::default()
        }))
    }

    #[test]
    fn opencode_reports_absent_signed_out_signed_in_and_indeterminate_states() {
        let missing = evaluate("opencode", &absent(), None, false);
        assert_eq!(
            missing,
            json!({"id":"provider:opencode","label":"OpenCode","provider":"opencode","status":"unhealthy","summary":"OpenCode is not installed","remedy":"curl -fsSL https://opencode.ai/install | bash","remedyKind":"command","details":{"state":"absent"}})
        );
        let removed = evaluate(
            "opencode",
            &present("/private/bin/opencode"),
            Some(Err(io::Error::new(
                io::ErrorKind::NotFound,
                "ENOENT /private",
            ))),
            false,
        );
        assert_eq!(removed["details"], json!({"state":"absent"}));
        let signed_out = evaluate(
            "opencode",
            &present("/private/bin/opencode"),
            ok("0 credentials\n"),
            false,
        );
        assert_eq!(
            signed_out,
            json!({"id":"provider:opencode","label":"OpenCode","provider":"opencode","status":"unhealthy","summary":"OpenCode is not signed in","remedy":"opencode auth login","remedyKind":"command","details":{"command":"opencode","state":"signed-out","credentials":0}})
        );
        let signed_in = evaluate(
            "opencode",
            &present("/private/bin/opencode"),
            ok("4 credentials\n"),
            false,
        );
        assert_eq!(
            (
                signed_in["status"].as_str(),
                &signed_in["details"]["credentials"]
            ),
            (Some("healthy"), &json!(4))
        );
        let unknown = evaluate(
            "opencode",
            &present("/private/bin/opencode"),
            Some(Err(io::Error::other("auth list /private/state.db locked"))),
            false,
        );
        assert_eq!(
            unknown["summary"],
            "Suplex could not check the OpenCode sign-in"
        );
        for check in [missing, removed, signed_out, signed_in, unknown] {
            assert!(!check.to_string().contains("private"));
        }
    }

    #[test]
    fn claude_code_reports_states_and_exposes_only_the_requested_account() {
        let status = |logged_in: bool| {
            ok(&json!({"loggedIn":logged_in,"email":"private-account@example.com","orgName":"private-org"}).to_string())
        };
        let claude = present("/private/bin/claude");
        let signed_out = evaluate("claude-code", &claude, status(false), false);
        assert_eq!(
            (
                signed_out["summary"].as_str(),
                signed_out["remedy"].as_str()
            ),
            (
                Some("Claude Code is not signed in"),
                Some("claude auth login")
            )
        );
        let signed_in = evaluate("claude-code", &claude, status(true), false);
        assert_eq!(
            signed_in["summary"],
            "Claude Code is signed in. Model access is not tested."
        );
        for check in [&signed_out, &signed_in] {
            assert!(!check.to_string().contains("private") && !check.to_string().contains('@'));
        }
        assert_eq!(
            evaluate("claude-code", &claude, status(true), true)["details"]["account"],
            "private-account@example.com"
        );
        assert!(
            evaluate("claude-code", &claude, status(false), true)["details"]
                .get("account")
                .is_none()
        );
        assert_eq!(
            evaluate(
                "claude-code",
                &claude,
                ok("not json /private/config"),
                false
            )["details"]["state"],
            "present"
        );
        let failed = Some(Ok(ProbeResult {
            stderr: "boom".into(),
            exit_code: Some(2),
            ..ProbeResult::default()
        }));
        assert_eq!(
            evaluate("claude-code", &claude, failed, false)["summary"],
            "Suplex could not check the Claude Code sign-in"
        );
    }

    #[test]
    fn codex_cli_reports_absent_signed_out_signed_in_and_indeterminate_states() {
        let said = |stderr: &str, code: i32| {
            Some(Ok(ProbeResult {
                stderr: stderr.into(),
                exit_code: Some(code),
                ..ProbeResult::default()
            }))
        };
        let codex = present("/private/bin/codex");
        assert_eq!(
            evaluate("codex", &absent(), None, false)["remedy"],
            "npm install -g @openai/codex"
        );
        let signed_out = evaluate("codex", &codex, said("Not logged in\n", 1), false);
        assert_eq!(
            (
                signed_out["summary"].as_str(),
                signed_out["remedy"].as_str()
            ),
            (Some("Codex CLI is not signed in"), Some("codex login"))
        );
        assert_eq!(
            evaluate(
                "codex",
                &codex,
                said("\x1b[1mLogged in using ChatGPT\x1b[0m\n", 0),
                false
            )["status"],
            "healthy"
        );
        let timed_out = Some(Ok(ProbeResult {
            timed_out: true,
            ..ProbeResult::default()
        }));
        assert_eq!(
            evaluate("codex", &codex, timed_out, false)["summary"],
            "Suplex could not check the Codex CLI sign-in"
        );
        assert_eq!(auth_args("opencode"), ["auth", "list"]);
        assert_eq!(auth_args("claude-code"), ["auth", "status", "--json"]);
        assert_eq!(auth_args("codex"), ["login", "status"]);
    }

    #[test]
    fn claude_instance_environment_drops_routing_variables() {
        let inherited = HashMap::from([
            ("PATH".to_owned(), "/bin".to_owned()),
            ("ANTHROPIC_API_KEY".to_owned(), "secret".to_owned()),
            ("CLAUDE_CODE_USE_BEDROCK".to_owned(), "1".to_owned()),
        ]);
        let environment = claude_environment(Some("/tmp/instance"), inherited);
        assert_eq!(
            environment.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some("/tmp/instance")
        );
        assert_eq!(
            environment.get("ANTHROPIC_CONFIG_DIR").map(String::as_str),
            Some("/tmp/instance/anthropic")
        );
        assert!(
            !environment.contains_key("ANTHROPIC_API_KEY")
                && !environment.contains_key("CLAUDE_CODE_USE_BEDROCK")
        );
        assert!(environment.contains_key("PATH"));
    }

    #[tokio::test]
    async fn probes_resolve_on_nonzero_exit_and_fail_only_when_the_process_cannot_run() {
        let result = probe_command(
            Path::new("/bin/sh"),
            &["-c", "echo out; echo err >&2; exit 3"],
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            (
                result.stdout.as_str(),
                result.stderr.as_str(),
                result.exit_code
            ),
            ("out\n", "err\n", Some(3))
        );
        let missing = probe_command(Path::new("/nonexistent/suplex-provider"), &[], None)
            .await
            .unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);
    }
}
