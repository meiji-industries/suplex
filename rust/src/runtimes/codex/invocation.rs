#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Root,
    Worker,
    Advisor,
}

pub struct BridgeServer<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub environment_names: &'a [String],
}

fn toml_string(value: &str) -> String {
    let mut quoted = String::from("\"");
    for character in value.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            character if character < ' ' || character == '\u{7f}' => {
                quoted.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

fn bridge_table(bridge: &BridgeServer<'_>) -> String {
    let args = bridge
        .args
        .iter()
        .map(|arg| toml_string(arg))
        .collect::<Vec<_>>()
        .join(",");
    let names = bridge
        .environment_names
        .iter()
        .map(|name| toml_string(name))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{command={},args=[{args}],env_vars=[{names}],default_tools_approval_mode=\"approve\"}}",
        toml_string(bridge.command)
    )
}

pub fn codex_arguments(
    model: &str,
    reasoning_effort: &str,
    role: Role,
    resume_thread_id: Option<&str>,
    bridge: Option<&BridgeServer<'_>>,
) -> Vec<String> {
    let mut args = vec!["exec".to_owned()];
    if let Some(thread_id) = resume_thread_id {
        args.extend(["resume".to_owned(), thread_id.to_owned()]);
    }
    args.extend([
        "--json".to_owned(),
        "--skip-git-repo-check".to_owned(),
        "-m".to_owned(),
        model.to_owned(),
        "-c".to_owned(),
        format!("model_reasoning_effort={}", toml_string(reasoning_effort)),
        "-c".to_owned(),
        "approval_policy=\"never\"".to_owned(),
        "-c".to_owned(),
        format!(
            "sandbox_mode=\"{}\"",
            if role == Role::Worker {
                "danger-full-access"
            } else {
                "read-only"
            }
        ),
    ]);
    if let Some(bridge) = bridge {
        let name = if role == Role::Root {
            "suplex_root"
        } else {
            "suplex_advisor"
        };
        args.extend([
            "-c".to_owned(),
            format!("mcp_servers.{name}={}", bridge_table(bridge)),
        ]);
    }
    args.push("-".to_owned());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_policy_and_bridge_use_environment_variable_names() {
        let args = codex_arguments(
            "gpt-6-sol",
            "medium",
            Role::Root,
            Some("thread-1"),
            Some(&BridgeServer {
                command: "/tmp/suplex\"bridge",
                args: &["mcp".to_owned(), "serve".to_owned()],
                environment_names: &["SUPLEX_ROOT_TOKEN".to_owned()],
            }),
        );
        assert_eq!(&args[..3], ["exec", "resume", "thread-1"]);
        assert!(args.iter().any(|arg| arg == "sandbox_mode=\"read-only\""));
        assert!(
            args.iter()
                .any(|arg| arg.contains("mcp_servers.suplex_root=")
                    && arg.contains("SUPLEX_ROOT_TOKEN")
                    && arg.contains("suplex\\\"bridge"))
        );
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn worker_can_write_without_bridge_and_uses_exec_stdin() {
        let args = codex_arguments("gpt-6-sol", "high", Role::Worker, None, None);
        assert!(
            args.iter()
                .any(|arg| arg == "sandbox_mode=\"danger-full-access\"")
        );
        assert!(!args.iter().any(|arg| arg.contains("mcp_servers.")));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }
}
