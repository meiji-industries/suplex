//! The Pi command line family. Pi and its fork omp (oh-my-pi) print the same
//! `--mode json` turn events and keep the same session file, so one runtime
//! runs both. A descriptor holds only what differs between them.

use crate::runtimes::task_harness::ExecutableSpec;

/// How a turn names the native session it continues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionIdentity {
    /// `--session-id <id>`: the Suplex id is the native id, and the session
    /// file is `<timestamp>_<id>.jsonl`.
    Named,
    /// The CLI makes its own id. The private session directory holds one
    /// session, and each later turn continues it with `--resume <file>`.
    Resumed,
}

/// How a Coordinator or Advisor turn loads its bridge server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeRegistration {
    /// `-e <file>`: a TypeScript extension calls `pi.registerMcpServer`, and
    /// `--tools` adds `mcp__<server>__*`.
    Extension,
    /// `-e <directory>`: the directory's `.mcp.json` declares the server. omp
    /// mounts its tools as `xd://` devices that the `write` tool calls; a
    /// restricted `write` reaches only devices and session scratch files.
    McpDirectory,
}

/// The output of the model listing command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelListing {
    /// `pi --list-models`: a `provider model ...` table.
    Table,
    /// `omp models --json`: `{"models":[{"selector":"provider/id"}]}`.
    Json,
}

pub struct PiCli {
    /// The profile provider and harness kind.
    pub provider: &'static str,
    pub executable: ExecutableSpec,
    /// `--session-dir` inside the Suplex session runtime directory.
    pub session_directory: &'static str,
    /// Routes a Suplex native session id back to this runtime.
    pub session_prefix: &'static str,
    pub session_identity: SessionIdentity,
    pub bridge: BridgeRegistration,
    /// Read-only built-in tools for Coordinator and Advisor turns.
    pub read_only_tools: &'static str,
    /// Arguments that every turn adds after the session arguments.
    pub turn_args: &'static [&'static str],
    pub list_models_args: &'static [&'static str],
    pub model_listing: ModelListing,
    /// The `suplex <subcommand> <runtime directory>` passive display.
    pub display_subcommand: &'static str,
    pub waiting_label: &'static str,
    pub install_command: &'static str,
    /// The command that signs in to a model provider.
    pub login_command: &'static str,
}

/// `npm install -g` puts `pi` beside `node` on PATH; the pi.dev installer
/// uses `~/.local/bin`, `~/bin`, its agent directory, or a Homebrew bin.
pub const PI: PiCli = PiCli {
    provider: "pi",
    executable: ExecutableSpec {
        label: "Pi",
        binary: "pi",
        env_var: "SUPLEX_PI_COMMAND",
        home_paths: &[".local/bin/pi", ".pi/agent/bin/pi", "bin/pi"],
        fallback_paths: &["/opt/homebrew/bin/pi", "/usr/local/bin/pi"],
    },
    session_directory: "pi-sessions",
    session_prefix: "pi-",
    session_identity: SessionIdentity::Named,
    bridge: BridgeRegistration::Extension,
    read_only_tools: "read,grep,find,ls",
    turn_args: &[],
    // `--offline` skips the catalog refresh, so the listing is local and fast.
    list_models_args: &["--offline", "--list-models"],
    model_listing: ModelListing::Table,
    display_subcommand: "pi-display",
    waiting_label: "Waiting for Pi output...\n",
    install_command: "curl -fsSL https://pi.dev/install.sh | sh",
    // `/login` inside Pi stores a credential in its agent directory.
    login_command: "pi",
};

/// The omp.sh installer writes `~/.local/bin/omp`; `bun install -g` uses
/// `~/.bun/bin`. omp keeps its state in `~/.omp/agent` unless
/// `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, or `OMP_PROFILE` moves it; the
/// private `--session-dir` overrides only where the session files go.
pub const OMP: PiCli = PiCli {
    provider: "omp",
    executable: ExecutableSpec {
        label: "OMP",
        binary: "omp",
        env_var: "SUPLEX_OMP_COMMAND",
        home_paths: &[".local/bin/omp", ".bun/bin/omp", "bin/omp"],
        fallback_paths: &["/opt/homebrew/bin/omp", "/usr/local/bin/omp"],
    },
    session_directory: "omp-sessions",
    session_prefix: "omp-",
    session_identity: SessionIdentity::Resumed,
    bridge: BridgeRegistration::McpDirectory,
    // omp has no `ls`, and `find` is not available without its own setting.
    read_only_tools: "read,grep,glob",
    // A title is a second model request on every new session.
    turn_args: &["--no-title"],
    list_models_args: &["models", "--json"],
    model_listing: ModelListing::Json,
    display_subcommand: "omp-display",
    waiting_label: "Waiting for OMP output...\n",
    install_command: "curl -fsSL https://omp.sh/install | sh",
    login_command: "omp login",
};

pub const ALL: [&PiCli; 2] = [&PI, &OMP];

/// The descriptor for a profile provider.
pub fn for_provider(provider: &str) -> Option<&'static PiCli> {
    ALL.into_iter().find(|cli| cli.provider == provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_cli_owns_distinct_routing_and_private_paths() {
        assert_eq!(for_provider("pi").unwrap().executable.binary, "pi");
        assert_eq!(for_provider("omp").unwrap().executable.binary, "omp");
        assert!(for_provider("opencode").is_none());
        assert_ne!(PI.session_prefix, OMP.session_prefix);
        assert!(!OMP.session_prefix.starts_with(PI.session_prefix));
        assert_ne!(PI.session_directory, OMP.session_directory);
        assert_ne!(PI.display_subcommand, OMP.display_subcommand);
    }
}
