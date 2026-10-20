use std::path::Path;

use serde_json::json;

use super::cli::{BridgeRegistration, PiCli};

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

/// Delivery calls through the Root bridge can outlast the 60 second
/// default of Pi and the 30 second default of omp.
const BRIDGE_TIMEOUT_SECONDS: u64 = 3600;

/// Pi has the same level names as a Suplex profile, and omp adds only `auto`.
pub fn thinking_level(reasoning_effort: &str) -> &str {
    match reasoning_effort {
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => reasoning_effort,
        _ => "medium",
    }
}

fn bridge_environment(bridge: &BridgeServer<'_>) -> serde_json::Map<String, serde_json::Value> {
    bridge
        .environment_names
        .iter()
        .map(|name| (name.clone(), json!(format!("${{{name}}}"))))
        .collect()
}

/// An extension file that registers the role's bridge for one Pi process.
/// It holds no secret: `env` names variables that Pi resolves from its own
/// environment when it starts the server.
pub fn bridge_extension(name: &str, bridge: &BridgeServer<'_>) -> String {
    let config = json!({
        "command": bridge.command,
        "args": bridge.args,
        "env": bridge_environment(bridge),
        "exposure": "direct",
        "timeout": BRIDGE_TIMEOUT_SECONDS,
        "description": "Suplex task bridge",
    });
    format!(
        "// Suplex writes this file for each turn. Do not edit it.\nexport default function (pi: any) {{\n  pi.registerMcpServer({}, {config});\n}}\n",
        json!(name)
    )
}

/// The `.mcp.json` of the extension directory that declares the role's
/// bridge for one omp process. omp expands each `${NAME}` from its own
/// environment, so the file holds no secret. Its timeout is milliseconds.
pub fn bridge_mcp_config(name: &str, bridge: &BridgeServer<'_>) -> String {
    json!({
        "mcpServers": {
            name: {
                "type": "stdio",
                "command": bridge.command,
                "args": bridge.args,
                "env": bridge_environment(bridge),
                "timeout": BRIDGE_TIMEOUT_SECONDS * 1000,
            }
        }
    })
    .to_string()
}

/// How one turn reaches its native session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionArgument<'a> {
    /// `--session-id`: creates or continues the named session.
    Id(&'a str),
    /// `--resume <file>`: continues the session file.
    Resume(&'a Path),
    /// The first turn of a CLI that makes its own session id.
    New,
}

pub struct TurnArguments<'a> {
    pub model: &'a str,
    pub reasoning_effort: &'a str,
    pub role: Role,
    pub session_directory: &'a Path,
    pub session: SessionArgument<'a>,
    /// The role's bridge extension file or directory.
    pub bridge: Option<&'a Path>,
}

/// The prompt comes from standard input, so it never reaches argv.
pub fn pi_arguments(cli: &PiCli, turn: &TurnArguments<'_>) -> Vec<String> {
    let session_directory = turn.session_directory.to_string_lossy();
    let mut args = [
        "--mode",
        "json",
        "--model",
        turn.model,
        "--thinking",
        thinking_level(turn.reasoning_effort),
        "--session-dir",
        session_directory.as_ref(),
    ]
    .map(str::to_owned)
    .to_vec();
    match turn.session {
        SessionArgument::Id(id) => args.extend(["--session-id".to_owned(), id.to_owned()]),
        SessionArgument::Resume(file) => {
            args.extend(["--resume".to_owned(), file.to_string_lossy().into_owned()]);
        }
        SessionArgument::New => {}
    }
    args.extend(cli.turn_args.iter().map(|arg| (*arg).to_owned()));
    if let Some(name) = turn.role.bridge_name() {
        args.push("--tools".to_owned());
        args.push(match cli.bridge {
            BridgeRegistration::Extension => format!("{},mcp__{name}__*", cli.read_only_tools),
            BridgeRegistration::McpDirectory => cli.read_only_tools.to_owned(),
        });
        if let Some(bridge) = turn.bridge {
            args.extend(["-e".to_owned(), bridge.to_string_lossy().into_owned()]);
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::pi::cli::{OMP, PI};

    fn turn<'a>(
        role: Role,
        reasoning_effort: &'a str,
        session: SessionArgument<'a>,
        bridge: Option<&'a Path>,
    ) -> TurnArguments<'a> {
        TurnArguments {
            model: "anthropic/claude-sonnet-5",
            reasoning_effort,
            role,
            session_directory: Path::new("/runtime/session/pi-sessions"),
            session,
            bridge,
        }
    }

    #[test]
    fn coordinator_is_read_only_with_its_bridge_and_resumes_its_session() {
        let args = pi_arguments(
            &PI,
            &turn(
                Role::Root,
                "xhigh",
                SessionArgument::Id("pi-1"),
                Some(Path::new("/runtime/session/suplex-bridge.ts")),
            ),
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
            &PI,
            &turn(Role::Worker, "max", SessionArgument::Id("pi-2"), None),
        );
        assert!(!worker.iter().any(|arg| arg == "--tools" || arg == "-e"));
        assert_eq!(worker[5], "max");
        let advisor = pi_arguments(
            &PI,
            &turn(
                Role::Advisor,
                "unexpected",
                SessionArgument::Id("pi-3"),
                Some(Path::new("/s/bridge.ts")),
            ),
        );
        assert_eq!(advisor[5], "medium");
        assert!(advisor.contains(&"read,grep,find,ls,mcp__suplex_advisor__*".to_owned()));
    }

    #[test]
    fn omp_resumes_its_session_file_and_loads_the_bridge_directory() {
        // Flags from `omp --help` 18.12.3: omp has no `--session-id`.
        let first = pi_arguments(
            &OMP,
            &turn(Role::Worker, "high", SessionArgument::New, None),
        );
        assert_eq!(
            first,
            [
                "--mode",
                "json",
                "--model",
                "anthropic/claude-sonnet-5",
                "--thinking",
                "high",
                "--session-dir",
                "/runtime/session/pi-sessions",
                "--no-title",
            ]
        );
        let root = pi_arguments(
            &OMP,
            &turn(
                Role::Root,
                "max",
                SessionArgument::Resume(Path::new("/s/omp-sessions/t_019c.jsonl")),
                Some(Path::new("/s/suplex-bridge")),
            ),
        );
        assert_eq!(
            root[8..],
            [
                "--resume",
                "/s/omp-sessions/t_019c.jsonl",
                "--no-title",
                "--tools",
                "read,grep,glob",
                "-e",
                "/s/suplex-bridge",
            ]
        );
    }

    #[test]
    fn bridge_files_name_variables_without_their_values() {
        let bridge = BridgeServer {
            command: "/opt/suplex\"bin",
            args: &["mcp".to_owned(), "root".to_owned()],
            environment_names: &["SUPLEX_ROOT_TOKEN".to_owned()],
        };
        let source = bridge_extension("suplex_root", &bridge);
        assert!(source.contains("pi.registerMcpServer(\"suplex_root\", {"));
        assert!(source.contains("\"command\":\"/opt/suplex\\\"bin\""));
        assert!(source.contains("\"SUPLEX_ROOT_TOKEN\":\"${SUPLEX_ROOT_TOKEN}\""));
        assert!(source.contains("\"exposure\":\"direct\""));
        let config: serde_json::Value =
            serde_json::from_str(&bridge_mcp_config("suplex_root", &bridge)).unwrap();
        assert_eq!(
            config,
            json!({"mcpServers":{"suplex_root":{
                "type":"stdio","command":"/opt/suplex\"bin","args":["mcp","root"],
                "env":{"SUPLEX_ROOT_TOKEN":"${SUPLEX_ROOT_TOKEN}"},"timeout":3_600_000,
            }}})
        );
    }
}
