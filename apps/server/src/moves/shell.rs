//! Terminal runners, in a host terminal at a fresh worktree. A prompt runs
//! the selected agent, interactive, and you answer its permission prompts. A
//! script runs as written. Either way a login shell stays open afterward.

use std::{error::Error, path::Path, process::Command};

use crate::{
    profiles::provider_login::{scoped_command, shell_binary, shell_quoted},
    tasks::{
        TaskError,
        control::{HarnessKind, TaskProfile},
    },
};

pub fn terminal_id(run_id: &str) -> String {
    format!("move-run:{run_id}")
}

fn preamble(base_branch: &str) -> String {
    format!(
        "You run a Suplex move in a dedicated Git worktree detached at origin/{base_branch}. To publish commits to {base_branch}, push HEAD:{base_branch}.\n\n"
    )
}

fn unsupported() -> TaskError {
    TaskError::new("Moves run Claude Code and Codex agents", 422)
}

/// Only these agents have an interactive command line for a move.
pub fn check_provider(profile: &TaskProfile) -> Result<(), TaskError> {
    match profile.provider {
        HarnessKind::ClaudeCode | HarnessKind::Codex => Ok(()),
        HarnessKind::Opencode | HarnessKind::Devin | HarnessKind::Pi => Err(unsupported()),
    }
}

/// The agent's interactive command line, then a login shell after it exits.
pub fn command(
    profile: &TaskProfile,
    base_branch: &str,
    prompt: &str,
) -> Result<String, Box<dyn Error + Send + Sync>> {
    let effort = profile.reasoning_level.as_str();
    let args = match profile.provider {
        HarnessKind::ClaudeCode => vec![
            "--model".to_owned(),
            profile.model.clone(),
            "--effort".to_owned(),
            effort.to_owned(),
        ],
        HarnessKind::Codex => vec![
            "-m".to_owned(),
            profile.model.clone(),
            "-c".to_owned(),
            format!("model_reasoning_effort=\"{effort}\""),
        ],
        HarnessKind::Opencode | HarnessKind::Devin | HarnessKind::Pi => {
            return Err(unsupported().into());
        }
    };
    let provider = profile.provider.as_str();
    let line = std::iter::once(shell_binary(provider))
        .chain(args.iter().map(|arg| shell_quoted(arg)))
        .chain(std::iter::once(shell_quoted(&format!(
            "{}{prompt}",
            preamble(base_branch)
        ))))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        "{}; exec \"$SHELL\" -l",
        scoped_command(provider, profile.instance_home_directory(), line)
    ))
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
        let line = command(&profile("claude-code"), "main", "Run it'; rm -rf / #").unwrap();
        assert!(line.contains("'--model' 'opus' '--effort' 'high' 'You run a Suplex move"));
        assert!(line.contains("Run it'\\''; rm -rf / #'"));
        assert!(line.ends_with("; exec \"$SHELL\" -l"));
        assert!(
            command(&profile("codex"), "main", "x")
                .unwrap()
                .contains("'model_reasoning_effort=\"high\"'")
        );
    }

    #[test]
    fn other_providers_cannot_run_a_move() {
        assert!(command(&profile("opencode"), "main", "x").is_err());
    }
}
