//! The Antigravity CLI (`agy`) contract that Suplex relies on, in one place so
//! a correction touches one file.
//!
//! Sources, read 2026-11-23 (no `agy` binary was available on the build host):
//! - Antigravity docs, "Getting started" and "CLI reference": the installer,
//!   `~/.local/bin/agy`, `agy --version`, and the print-mode flags `-p`, `-i`,
//!   `--model`, `--effort`, and `--mode plan`.
//! - Antigravity docs, "Agent Client Protocol (ACP)": `agy acp` serves ACP
//!   protocol version 1 over stdio; `agy acp --login` signs in by a pasted
//!   code and exits; the auth method ids; `Authentication required` is
//!   JSON-RPC error `-32000`; sessions can be loaded and resumed, and a resume
//!   does not replay history; the Model and Thinking level session options.
//! - t3code (`pingdotgg/t3code`), `apps/server/src/provider/acp/*` and
//!   `antigravityAuthSupport.ts`: the thinking option has category
//!   `thought_level`, the model option has id `model`, both are set with
//!   `session/set_config_option`; runtime 1.5 or later is required; the
//!   sign-in link line that `agy acp` prints when it has no credentials.

use crate::runtimes::task_harness::ExecutableSpec;

/// The profile provider and harness kind.
pub const PROVIDER: &str = "antigravity";

/// The official installer writes `~/.local/bin/agy`.
pub const EXECUTABLE: ExecutableSpec = ExecutableSpec {
    label: "Antigravity",
    binary: "agy",
    env_var: "SUPLEX_ANTIGRAVITY_COMMAND",
    home_paths: &[".local/bin/agy", "bin/agy"],
    fallback_paths: &["/opt/homebrew/bin/agy", "/usr/local/bin/agy"],
};

/// `agy acp`: the ACP server on stdin and stdout.
pub const ACP_ARGS: &[&str] = &["acp"];
/// Needed when the client passes an HTTP MCP server.
pub const PROCESS_PER_SESSION_ARG: &str = "--process-per-session";
pub const INSTALL_COMMAND: &str = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
/// An interactive sign-in that works without a browser on this host, then
/// exits. The credentials are the ones `agy acp` reuses.
pub const LOGIN_COMMAND: &str = "agy acp --login";

/// The ACP protocol version that `agy acp` speaks.
pub const PROTOCOL_VERSION: u64 = 1;
/// `Authentication required`.
pub const AUTH_REQUIRED_CODE: i64 = -32000;
/// The 1.5 CLI answers `authenticate` with this internal error when it has no
/// sign-in and cannot open a browser.
pub const NO_BROWSER_PREFIX: &str = "No browser is available here";
/// The line `agy acp` prints when a browser sign-in starts.
pub const SIGN_IN_LINK_PREFIX: &str = "Open the following link to authenticate the ACP server: ";

/// The ACP session option that selects the model.
pub const MODEL_OPTION: &str = "model";
/// The category of the ACP session option that selects the thinking level.
pub const THINKING_CATEGORY: &str = "thought_level";

/// Sessions need runtime 1.5 or later.
pub const MINIMUM_VERSION: (u64, u64, u64) = (1, 5, 0);

/// Routes a Suplex native session id back to this runtime.
pub const SESSION_PREFIX: &str = "antigravity-";
/// `suplex antigravity-turn`: the ACP client process of one turn.
pub const TURN_SUBCOMMAND: &str = "antigravity-turn";
/// `suplex antigravity-display <runtime directory>`.
pub const DISPLAY_SUBCOMMAND: &str = "antigravity-display";
/// `suplex antigravity-probe`: prints the version, sign-in, and models.
pub const PROBE_SUBCOMMAND: &str = "antigravity-probe";
pub const WAITING_LABEL: &str = "Waiting for Antigravity output...\n";

/// The sign-in method to try when `agy acp` reports `Authentication required`.
/// An API key or a Google Cloud project in the agent's environment selects
/// that method; otherwise the Google account that `agy` already signed in.
pub fn auth_method(environment: &dyn Fn(&str) -> Option<String>) -> &'static str {
    let present = |name: &str| environment(name).is_some_and(|value| !value.is_empty());
    if present("GEMINI_API_KEY") {
        "gemini-api-key"
    } else if present("GOOGLE_CLOUD_PROJECT") {
        "agent-platform"
    } else {
        "oauth-personal"
    }
}

/// The Antigravity thinking levels are Low, Medium, High, Extra, and Max,
/// which match the five Suplex reasoning levels in order.
pub fn thinking_names(reasoning_level: &str) -> &'static [&'static str] {
    match reasoning_level {
        "low" => &["low"],
        "medium" => &["medium"],
        "high" => &["high"],
        "xhigh" => &["extra", "xhigh", "extra high", "extra_high", "x-high"],
        "max" => &["max", "maximum"],
        _ => &[],
    }
}

/// The first `major.minor.patch` in a version text.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let pattern = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").expect("version pattern");
    let found = pattern.captures(text)?;
    Some((
        found[1].parse().ok()?,
        found[2].parse().ok()?,
        found[3].parse().ok()?,
    ))
}

pub fn supported_version(version: (u64, u64, u64)) -> bool {
    version >= MINIMUM_VERSION
}

pub fn older_version_message(version: &str) -> String {
    format!(
        "Antigravity {version} is older than 1.5. Update Antigravity to 1.5 or later: {INSTALL_COMMAND}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_from_free_text_and_compare_with_the_floor() {
        assert_eq!(parse_version("agy 1.5.12 (abc)"), Some((1, 5, 12)));
        assert_eq!(parse_version("Antigravity CLI v1.4.9\n"), Some((1, 4, 9)));
        assert_eq!(parse_version("unknown"), None);
        assert!(supported_version((1, 5, 0)));
        assert!(supported_version((2, 0, 0)));
        assert!(!supported_version((1, 4, 99)));
        assert!(older_version_message("1.4.2").contains("older than 1.5"));
    }

    #[test]
    fn the_sign_in_method_follows_the_agent_environment() {
        let none = |_: &str| None;
        assert_eq!(auth_method(&none), "oauth-personal");
        let key = |name: &str| (name == "GEMINI_API_KEY").then(|| "k".to_owned());
        assert_eq!(auth_method(&key), "gemini-api-key");
        let project = |name: &str| (name == "GOOGLE_CLOUD_PROJECT").then(|| "p".to_owned());
        assert_eq!(auth_method(&project), "agent-platform");
        let empty = |_: &str| Some(String::new());
        assert_eq!(auth_method(&empty), "oauth-personal");
    }

    #[test]
    fn every_suplex_reasoning_level_names_an_antigravity_thinking_level() {
        for level in ["low", "medium", "high", "xhigh", "max"] {
            assert!(!thinking_names(level).is_empty(), "{level}");
        }
        assert_eq!(thinking_names("xhigh")[0], "extra");
        assert!(thinking_names("auto").is_empty());
    }
}
