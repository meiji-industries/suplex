//! Terminal runners, in a host terminal at a fresh worktree. A prompt runs
//! the selected agent, interactive, and you answer its permission prompts. A
//! script runs as written. Either way a login shell stays open afterward.

use std::{error::Error, path::Path, process::Command};

use super::agent::{self, Endpoint};
use crate::tasks::{
    TaskError,
    control::{HarnessKind, TaskProfile},
};

pub fn terminal_id(run_id: &str) -> String {
    format!("move-run:{run_id}")
}

fn preamble(base_branch: &str) -> String {
    format!(
        "You run a Suplex move in a dedicated Git worktree detached at origin/{base_branch}. To publish commits to {base_branch}, push HEAD:{base_branch}.\n\n"
    )
}

/// The agent's interactive command line, then a login shell, without the
/// endpoint variables, after it exits.
pub fn command(
    profile: &TaskProfile,
    endpoint: Option<&Endpoint>,
    base_branch: &str,
    prompt: &str,
) -> String {
    let effort = profile.reasoning_level.as_str();
    let model = profile.model.as_str();
    let prompt = format!("{}{prompt}", preamble(base_branch));
    let codex_effort = format!("model_reasoning_effort=\"{effort}\"");
    let args = match profile.provider {
        HarnessKind::ClaudeCode => vec!["--model", model, "--effort", effort, &prompt],
        HarnessKind::Codex => vec!["-m", model, "-c", &codex_effort, &prompt],
        // The OpenCode interface takes no reasoning effort, by flag or by configuration.
        HarnessKind::Opencode => vec!["--model", model, "--prompt", &prompt],
        // Devin takes no reasoning effort flag.
        HarnessKind::Devin => vec!["--model", model, "--", &prompt],
        HarnessKind::Pi | HarnessKind::Omp => vec!["--model", model, "--thinking", effort, &prompt],
    };
    let removed = endpoint
        .into_iter()
        .flat_map(|endpoint| &endpoint.environment)
        .map(|(name, _)| format!("-u {name} "))
        .collect::<String>();
    let shell = if removed.is_empty() {
        String::new()
    } else {
        format!("env {removed}")
    };
    format!(
        "{}; exec {shell}\"$SHELL\" -l",
        agent::line(profile, endpoint, &[], &args)
    )
}

/// The script as written, then a login shell after it exits.
pub fn script(script: &str) -> String {
    format!("{script}\nexec \"$SHELL\" -l")
}

fn git(directory: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

/// A detached worktree at the freshly fetched base. A failed fetch keeps the
/// last fetched base, and the agent can fetch again.
pub fn prepare_worktree(
    repository: &Path,
    worktree: &Path,
    base_branch: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let _ = git(repository, &["fetch", "origin", base_branch]);
    git(
        repository,
        &[
            "worktree",
            "add",
            "--detach",
            &worktree.to_string_lossy(),
            &format!("origin/{base_branch}"),
        ],
    )
    .map_err(|reason| {
        TaskError::new(
            format!("Suplex could not create the move worktree: {reason}"),
            422,
        )
        .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(provider: &str) -> TaskProfile {
        serde_json::from_value(json!({
            "profileId":"p", "provider":provider, "model":"opus",
            "reasoningLevel":"high", "serviceTier":"default"
        }))
        .unwrap()
    }

    #[test]
    fn the_prompt_is_one_quoted_argument_and_a_shell_follows_the_agent() {
        let line = command(&profile("claude-code"), None, "main", "Run it'; rm -rf / #");
        assert!(line.contains("'--model' 'opus' '--effort' 'high' 'You run a Suplex move"));
        assert!(line.contains("Run it'\\''; rm -rf / #'"));
        assert!(line.ends_with("; exec \"$SHELL\" -l"));
        assert!(
            command(&profile("codex"), None, "main", "x")
                .contains("'model_reasoning_effort=\"high\"'")
        );
    }

    #[test]
    fn every_provider_opens_its_interactive_command_line() {
        for (provider, arguments) in [
            ("opencode", "'--model' 'opus' '--prompt' 'You run"),
            ("devin", "'--model' 'opus' '--' 'You run"),
            ("pi", "'--model' 'opus' '--thinking' 'high' 'You run"),
            ("omp", "'--model' 'opus' '--thinking' 'high' 'You run"),
        ] {
            assert!(
                command(&profile(provider), None, "main", "x").contains(arguments),
                "{provider}"
            );
        }
    }
}
