//! Interactive provider sign-ins in a dedicated Herdr workspace, or in a host
//! terminal when the host terminal experiment is on.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::{
    integrations::herdr::{Herdr, HerdrResult},
    terminals::host::{HostTerminals, Spec},
};

use super::provider_readiness::{binary_name, claude_routing_variable, resolve_executable};
use crate::tasks::control::HarnessKind;

pub const PROVIDER_LOGIN_WORKSPACE_LABEL: &str = "suplex-provider-login";

const CLAUDE_AUTH_ENVIRONMENT_KEYS: [&str; 18] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_CONFIG_DIR",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_WORKSPACE_ID",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CONFIG_DIR",
];

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Interactive sign-in command for a provider; a local instance scopes Claude
/// Code to its home directory. The executable resolves like task runtimes do,
/// so the pane does not depend on the pane shell PATH; when resolution fails
/// the command falls back to the bare binary name so the pane stays usable.
pub fn provider_login_command(
    provider: &str,
    home_directory: Option<&str>,
    resolved: std::io::Result<std::path::PathBuf>,
) -> String {
    let binary = resolved.map_or_else(
        |_| binary_name(provider).to_owned(),
        |path| quoted(&path.to_string_lossy()),
    );
    let login = match HarnessKind::parse(provider) {
        Some(HarnessKind::Codex) => " login",
        // Pi has no sign-in subcommand; `/login` runs inside its session.
        Some(HarnessKind::Pi) => "",
        _ => " auth login",
    };
    scoped_command(provider, home_directory, format!("{binary}{login}"))
}

/// The provider executable for a shell command line, quoted when it resolves.
pub fn shell_binary(provider: &str) -> String {
    resolve_executable(provider).map_or_else(
        |_| binary_name(provider).to_owned(),
        |path| quoted(&path.to_string_lossy()),
    )
}

pub fn shell_quoted(value: &str) -> String {
    quoted(value)
}

/// A dedicated Claude Code login scopes the command to its home directory and
/// removes inherited account and routing variables.
pub fn scoped_command(provider: &str, home_directory: Option<&str>, command: String) -> String {
    let (Some(home), "claude-code") = (home_directory, provider) else {
        return command;
    };
    let mut removed = CLAUDE_AUTH_ENVIRONMENT_KEYS.map(str::to_owned).to_vec();
    for (key, _) in std::env::vars() {
        if claude_routing_variable(&key) && !removed.contains(&key) {
            removed.push(key);
        }
    }
    let removed = removed
        .iter()
        .map(|key| format!("-u {}", quoted(key)))
        .collect::<Vec<_>>()
        .join(" ");
    let anthropic = std::path::Path::new(home).join("anthropic");
    format!(
        "env {removed} CLAUDE_CONFIG_DIR={} ANTHROPIC_CONFIG_DIR={} {command} --setting-sources ''",
        quoted(home),
        quoted(&anthropic.to_string_lossy())
    )
}

pub fn login_command(provider: &str, home_directory: Option<&str>) -> String {
    provider_login_command(provider, home_directory, resolve_executable(provider))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderLoginSession {
    pub target: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub label: String,
    /// The sign-in runs in a host terminal, not in Herdr.
    pub host: bool,
}

/// The registry is the authority for which panes the terminal route can
/// attach to. A session whose pane or host terminal disappeared is forgotten
/// and recreated on demand. Only one sign-in runs at a time: a new sign-in
/// closes the previous session, so no orphaned workspaces remain.
#[derive(Default)]
pub struct ProviderLogins {
    sessions: Mutex<Vec<ProviderLoginSession>>,
    host: Arc<HostTerminals>,
}

impl ProviderLogins {
    pub fn new(host: Arc<HostTerminals>) -> Self {
        Self {
            sessions: Mutex::default(),
            host,
        }
    }

    fn sessions(&self) -> MutexGuard<'_, Vec<ProviderLoginSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn end(&self, herdr: &Herdr, session: &ProviderLoginSession) {
        if session.host {
            self.host.close(&session.pane_id);
        } else {
            let _ = herdr.close_pane(&session.pane_id);
            let _ = herdr.close_workspace(&session.workspace_id);
        }
    }

    fn replace(
        &self,
        herdr: &Herdr,
        sessions: &mut Vec<ProviderLoginSession>,
        session: ProviderLoginSession,
    ) -> ProviderLoginSession {
        for previous in sessions.drain(..) {
            self.end(herdr, &previous);
        }
        sessions.push(session.clone());
        session
    }

    pub fn start(
        &self,
        herdr: &Herdr,
        target: &str,
        label: &str,
        command: &str,
        cwd: &str,
    ) -> HerdrResult<ProviderLoginSession> {
        let mut sessions = self.sessions();
        if let Some(existing) = sessions
            .iter()
            .find(|session| session.target == target && !session.host)
            && herdr
                .get_pane(&existing.pane_id)
                .is_ok_and(|pane| pane.is_some())
        {
            return Ok(existing.clone());
        }
        let (workspace, root) = herdr.create_workspace(PROVIDER_LOGIN_WORKSPACE_LABEL, cwd)?;
        if let Err(failure) = herdr.run_pane_command(&root.pane_id, command) {
            let _ = herdr.close_workspace(&workspace.workspace_id);
            return Err(failure);
        }
        let session = ProviderLoginSession {
            target: target.into(),
            pane_id: root.pane_id,
            workspace_id: workspace.workspace_id,
            label: label.into(),
            host: false,
        };
        Ok(self.replace(herdr, &mut sessions, session))
    }

    /// Starts the sign-in in a host terminal. `herdr` closes a previous
    /// sign-in that Herdr still shows. Must run inside a Tokio runtime.
    pub fn start_host(
        &self,
        herdr: &Herdr,
        target: &str,
        label: &str,
        command: &str,
        cwd: &str,
    ) -> pty_process::Result<ProviderLoginSession> {
        let mut sessions = self.sessions();
        if let Some(existing) = sessions.iter().find(|session| {
            session.target == target && session.host && self.host.contains(&session.pane_id)
        }) {
            return Ok(existing.clone());
        }
        let pane_id = format!("host-login-{}", uuid::Uuid::new_v4());
        // The route attaches its own viewer, so this one detaches at once.
        self.host
            .open(&pane_id, Spec::sign_in(command, cwd.into()), 80, 24)?;
        let session = ProviderLoginSession {
            target: target.into(),
            pane_id,
            workspace_id: String::new(),
            label: label.into(),
            host: true,
        };
        Ok(self.replace(herdr, &mut sessions, session))
    }

    pub fn get(&self, pane_id: &str) -> Option<ProviderLoginSession> {
        let mut sessions = self.sessions();
        sessions.retain(|session| !session.host || self.host.contains(&session.pane_id));
        sessions
            .iter()
            .find(|session| session.pane_id == pane_id)
            .cloned()
    }

    /// A view of a host sign-in terminal that is still running.
    pub fn attach_host(&self, pane_id: &str) -> Option<crate::terminals::host::Viewer> {
        self.host.attach(pane_id)
    }

    pub fn close(&self, herdr: &Herdr, pane_id: &str) -> bool {
        let mut sessions = self.sessions();
        let Some(index) = sessions
            .iter()
            .position(|session| session.pane_id == pane_id)
        else {
            return false;
        };
        let session = sessions.remove(index);
        self.end(herdr, &session);
        true
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{
        io,
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use serde_json::json;

    use super::*;
    use crate::integrations::herdr::fake;

    /// Scripted Herdr for sign-in panes: each workspace gets `pane-login-N`.
    pub(crate) fn login_herdr() -> (Herdr, Arc<Mutex<Vec<Vec<String>>>>) {
        let created = Arc::new(AtomicUsize::new(0));
        let open = Arc::new(Mutex::new(Vec::<String>::new()));
        fake::herdr(move |args| match (args[0].as_str(), args[1].as_str()) {
            ("workspace", "create") => {
                let id = created.fetch_add(1, Ordering::SeqCst) + 1;
                open.lock().unwrap().push(format!("pane-login-{id}"));
                fake::envelope(
                    json!({"workspace":{"workspace_id":format!("ws-login-{id}"),"label":args[3]},
                    "tab":{"tab_id":format!("tab-{id}")},"root_pane":{"pane_id":format!("pane-login-{id}")}}),
                )
            }
            ("pane", "get") if open.lock().unwrap().contains(&args[2]) => {
                fake::envelope(json!({"pane":{"pane_id":args[2]}}))
            }
            ("pane", "get") => fake::failed(json!({"error":{"code":"pane_not_found"}})),
            ("pane", "close") => {
                open.lock().unwrap().retain(|pane| *pane != args[2]);
                fake::envelope(json!({}))
            }
            _ => fake::envelope(json!({})),
        })
    }

    #[test]
    fn the_login_command_embeds_the_resolved_executable_and_falls_back_to_the_binary() {
        let resolved = |path: &str| -> io::Result<PathBuf> { Ok(PathBuf::from(path)) };
        let missing = || -> io::Result<PathBuf> { Err(io::Error::from(io::ErrorKind::NotFound)) };
        assert_eq!(
            provider_login_command("claude-code", None, resolved("/opt/claude cli/claude")),
            "'/opt/claude cli/claude' auth login"
        );
        assert!(
            provider_login_command("claude-code", Some("/home/work laptop"), resolved("/opt/claude cli/claude"))
                .contains("CLAUDE_CONFIG_DIR='/home/work laptop' ANTHROPIC_CONFIG_DIR='/home/work laptop/anthropic' '/opt/claude cli/claude' auth login --setting-sources ''")
        );
        assert!(
            provider_login_command("claude-code", Some("/home"), resolved("/c"))
                .starts_with("env -u 'ANTHROPIC_API_KEY' ")
        );
        assert_eq!(
            provider_login_command("devin", None, resolved("/opt/devin/devin")),
            "'/opt/devin/devin' auth login"
        );
        assert_eq!(
            provider_login_command("codex", None, resolved("/opt/codex/codex")),
            "'/opt/codex/codex' login"
        );
        assert_eq!(
            provider_login_command("opencode", None, missing()),
            "opencode auth login"
        );
        assert_eq!(
            provider_login_command("pi", None, resolved("/opt/pi/pi")),
            "'/opt/pi/pi'"
        );
        assert_eq!(provider_login_command("pi", None, missing()), "pi");
    }

    #[test]
    fn sign_ins_reuse_a_live_pane_and_close_the_previous_session() {
        let (herdr, calls) = login_herdr();
        let logins = ProviderLogins::default();
        let first = logins
            .start(
                &herdr,
                "provider:claude-code",
                "claude-code",
                "claude auth login",
                "/",
            )
            .unwrap();
        assert_eq!(first.pane_id, "pane-login-1");
        assert_eq!(
            logins
                .start(&herdr, "provider:claude-code", "claude-code", "x", "/")
                .unwrap(),
            first
        );
        let second = logins
            .start(&herdr, "provider:devin", "devin", "devin auth login", "/")
            .unwrap();
        assert_eq!(second.pane_id, "pane-login-2");
        let calls = calls.lock().unwrap().clone();
        assert!(calls.contains(&["pane", "close", "pane-login-1"].map(String::from).to_vec()));
        assert!(
            calls.contains(
                &["workspace", "close", "ws-login-1"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert!(
            calls.contains(
                &["pane", "run", "pane-login-2", "devin auth login"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert!(logins.get("pane-login-1").is_none());
        assert!(!logins.close(&herdr, "pane-login-1"));
        assert!(logins.close(&herdr, "pane-login-2"));
        assert!(logins.get("pane-login-2").is_none());
    }
}
