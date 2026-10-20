use std::path::Path;

use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Root,
    Worker,
    Advisor,
}

impl Role {
    /// The MCP server name of the role's task bridge.
    pub fn bridge_name(self) -> Option<&'static str> {
        match self {
            Self::Root => Some("suplex_root"),
            Self::Advisor => Some("suplex_advisor"),
            Self::Worker => None,
        }
    }
}

pub struct BridgeServer<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub environment_names: &'a [String],
}

/// Pi's read-only built-in tools. Coordinator and Advisor turns get these
/// and their bridge; a Worker keeps Pi's default `read,bash,edit,write`.
pub const READ_ONLY_TOOLS: &str = "read,grep,find,ls";

/// Delivery calls through the Root bridge can outlast Pi's 60 second default.
const BRIDGE_TIMEOUT_SECONDS: u64 = 3600;

/// Pi has the same level names as a Suplex profile.
pub fn thinking_level(reasoning_effort: &str) -> &str {
    match reasoning_effort {
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => reasoning_effort,
        _ => "medium",
    }
}

/// An extension file that registers the role's bridge for one Pi process.
/// It holds no secret: `env` names variables that Pi resolves from its own
/// environment when it starts the server.
pub fn bridge_extension(name: &str, bridge: &BridgeServer<'_>) -> String {
    let environment = bridge
        .environment_names
        .iter()
        .map(|name| (name.clone(), json!(format!("${{{name}}}"))))
        .collect::<serde_json::Map<_, _>>();
    let config = json!({
        "command": bridge.command,
        "args": bridge.args,
        "env": environment,
        "exposure": "direct",
        "timeout": BRIDGE_TIMEOUT_SECONDS,
        "description": "Suplex task bridge",
    });
    format!(
        "// Suplex writes this file for each turn. Do not edit it.\nexport default function (pi: any) {{\n  pi.registerMcpServer({}, {config});\n}}\n",
        json!(name)
    )
}

/// The prompt comes from standard input, so it never reaches argv.
pub fn pi_arguments(
    model: &str,
    reasoning_effort: &str,
    role: Role,
    session_directory: &Path,
    session_id: &str,
    bridge_extension: Option<&Path>,
) -> Vec<String> {
    let session_directory = session_directory.to_string_lossy();
    let mut args = [
        "--mode",
        "json",
        "--model",
        model,
        "--thinking",
        thinking_level(reasoning_effort),
        "--session-dir",
        session_directory.as_ref(),
        "--session-id",
        session_id,
    ]
    .map(str::to_owned)
    .to_vec();
    if let Some(name) = role.bridge_name() {
        args.extend([
            "--tools".to_owned(),
            format!("{READ_ONLY_TOOLS},mcp__{name}__*"),
        ]);
        if let Some(extension) = bridge_extension {
            args.extend(["-e".to_owned(), extension.to_string_lossy().into_owned()]);
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinator_is_read_only_with_its_bridge_and_resumes_its_session() {
        let args = pi_arguments(
            "anthropic/claude-sonnet-5",
            "xhigh",
            Role::Root,
            Path::new("/runtime/session/pi-sessions"),
            "pi-1",
            Some(Path::new("/runtime/session/suplex-bridge.ts")),
        );
        assert_eq!(
            args,
            [
                "--mode",
                "json",
                "--model",
                "anthropic/claude-sonnet-5",
                "--thinking",
                "xhigh",
                "--session-dir",
                "/runtime/session/pi-sessions",
                "--session-id",
                "pi-1",
                "--tools",
                "read,grep,find,ls,mcp__suplex_root__*",
                "-e",
                "/runtime/session/suplex-bridge.ts",
            ]
        );
    }

    #[test]
    fn worker_keeps_default_tools_and_advisor_gets_only_its_report_bridge() {
        let worker = pi_arguments(
            "ollama/qwen3-coder",
            "max",
            Role::Worker,
            Path::new("/s"),
            "pi-2",
            None,
        );
        assert!(!worker.iter().any(|arg| arg == "--tools" || arg == "-e"));
        assert_eq!(worker[5], "max");
        let advisor = pi_arguments(
            "m",
            "unexpected",
            Role::Advisor,
            Path::new("/s"),
            "pi-3",
            Some(Path::new("/s/bridge.ts")),
        );
        assert_eq!(advisor[5], "medium");
        assert!(advisor.contains(&"read,grep,find,ls,mcp__suplex_advisor__*".to_owned()));
    }

    #[test]
    fn bridge_extension_names_variables_without_their_values() {
        let source = bridge_extension(
            "suplex_root",
            &BridgeServer {
                command: "/opt/suplex\"bin",
                args: &["mcp".to_owned(), "root".to_owned()],
                environment_names: &["SUPLEX_ROOT_TOKEN".to_owned()],
            },
        );
        assert!(source.contains("pi.registerMcpServer(\"suplex_root\", {"));
        assert!(source.contains("\"command\":\"/opt/suplex\\\"bin\""));
        assert!(source.contains("\"SUPLEX_ROOT_TOKEN\":\"${SUPLEX_ROOT_TOKEN}\""));
        assert!(source.contains("\"exposure\":\"direct\""));
    }
}
