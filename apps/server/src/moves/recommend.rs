//! Move recommendations: the project's default Worker reads the repository,
//! once and read-only, and proposes moves for the commands the project
//! already defines. Nothing is saved; the person imports the ones they want.

use std::{collections::HashSet, error::Error, time::Duration};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{MoveRunner, shell};
use crate::{
    http::AppState,
    profiles::provider_login::{scoped_command, shell_binary, shell_quoted},
    projects::service as projects,
    tasks::{
        TaskError,
        control::{HarnessKind, TaskProfile},
    },
};

/// An agent that reads a large repository can take a few minutes.
const TIME_LIMIT: Duration = Duration::from_secs(300);
const MAX_RECOMMENDATIONS: usize = 20;

/// One proposed move. The browser imports it through the normal create route.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MoveRecommendation {
    pub name: String,
    pub runner: MoveRunner,
    pub prompt: String,
    /// The file that defines the command, when there is one.
    pub source: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MoveRecommendationsResponse {
    pub recommendations: Vec<MoveRecommendation>,
    /// The agent profile that read the repository.
    pub profile_id: String,
}

#[derive(Deserialize)]
struct Payload {
    moves: Vec<Draft>,
}

#[derive(Deserialize)]
struct Draft {
    name: String,
    runner: String,
    prompt: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

const PROMPT: &str = r#"You recommend Suplex moves for this repository. A move is a saved command or prompt that a person starts with one click. Read the repository. Do not change any file, and do not run any command.

Find the commands that this project already defines. Look in all of these places that exist:
- JavaScript and TypeScript: package.json scripts (also in each workspace package), pnpm-workspace.yaml, turbo.json, nx.json and project.json targets, lerna.json, rush.json, deno.json or deno.jsonc tasks, bunfig.toml.
- Task runners: Makefile, GNUmakefile, *.mk, mise.toml, .mise.toml, .mise/tasks/, mise-tasks/, justfile, Justfile, Taskfile.yml, Rakefile, magefile.go, Earthfile, xtask/.
- Python: pyproject.toml ([project.scripts], [tool.poetry.scripts], [tool.pdm.scripts], [tool.hatch.envs.*.scripts], [tool.taskipy.tasks]), tox.ini, noxfile.py, Pipfile [scripts], setup.cfg, manage.py.
- Other ecosystems: Cargo.toml and .cargo/config.toml aliases, go.mod, build.gradle or build.gradle.kts and gradlew, pom.xml and mvnw, build.sbt, mix.exs aliases, composer.json scripts, artisan, Gemfile and bin/, CMakeLists.txt, meson.build, BUILD or WORKSPACE (Bazel), flake.nix, devenv.nix.
- Run and deploy: Procfile, docker-compose.yml, compose.yaml, Dockerfile, fly.toml, render.yaml, vercel.json, netlify.toml, serverless.yml, *.tf, Chart.yaml, .devcontainer/.
- Automation: .github/workflows/*.yml, .gitlab-ci.yml, .circleci/config.yml, Jenkinsfile, azure-pipelines.yml, bitbucket-pipelines.yml, .pre-commit-config.yaml, lefthook.yml, .husky/.
- Scripts and notes: scripts/, bin/, *.sh in the root, README, CONTRIBUTING, and docs that list commands.

Recommend 5 to 15 moves that a developer runs often: install, develop, test, lint, format, type check, build, migrate, seed, release, deploy, and clean up. Use only commands that you found. Do not invent commands.

Each move has a runner:
- "script": the exact shell command or commands, one per line. Prefer the project's own task runner, for example "npm run test", "make deploy", or "mise run lint".
- "prompt": an instruction for a coding agent, for work that needs judgment. For example: "Run the tests with `npm run test`. If a test fails, find the cause and fix it."

A move can ask for a value when it starts. Write {{name}} for text, or {{name: a | b | c}} for a choice whose first option is the default. For example: "npm run deploy -- --env {{environment: staging | production}}".

Write each name as a short sentence-case action of 40 characters or fewer, such as "Run tests" or "Deploy to staging". Each name must be unique. Put the file where you found the command in "source", and one short sentence about why the move helps in "reason".

Reply with only this JSON object, with no other text:
{"moves":[{"name":"Run tests","runner":"script","prompt":"npm run test","source":"package.json","reason":"Runs the unit tests."}]}"#;

/// The agent's one-shot command line, with tools that can change files or run
/// commands turned off.
fn command(profile: &TaskProfile) -> Result<String, Box<dyn Error + Send + Sync>> {
    shell::check_provider(profile)?;
    let effort = profile.reasoning_level.as_str();
    let provider = profile.provider.as_str();
    let args = match profile.provider {
        HarnessKind::ClaudeCode => vec![
            "-p".to_owned(),
            PROMPT.to_owned(),
            "--output-format".to_owned(),
            "json".to_owned(),
            "--model".to_owned(),
            profile.model.clone(),
            "--effort".to_owned(),
            effort.to_owned(),
            // Only file reading: no shell, edits, web, subagents, or MCP servers.
            "--tools".to_owned(),
            "Read,Glob,Grep".to_owned(),
            "--strict-mcp-config".to_owned(),
        ],
        HarnessKind::Opencode | HarnessKind::Devin | HarnessKind::Codex => vec![
            "exec".to_owned(),
            "--skip-git-repo-check".to_owned(),
            "-m".to_owned(),
            profile.model.clone(),
            "-c".to_owned(),
            format!("model_reasoning_effort=\"{effort}\""),
            "-c".to_owned(),
            "approval_policy=\"never\"".to_owned(),
            "-c".to_owned(),
            "sandbox_mode=\"read-only\"".to_owned(),
            PROMPT.to_owned(),
        ],
    };
    let line = std::iter::once(shell_binary(provider))
        .chain(args.iter().map(|arg| shell_quoted(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(scoped_command(
        provider,
        profile.instance_home_directory(),
        line,
    ))
}

/// The first JSON object with a `moves` list in the text.
// Tries a parse at each `{`, quadratic in the worst case; agent
// replies are small, so a streaming scanner is not worth it yet.
fn moves_in(text: &str) -> Option<Vec<Draft>> {
    text.match_indices('{').find_map(|(index, _)| {
        serde_json::Deserializer::from_str(&text[index..])
            .into_iter::<Payload>()
            .next()?
            .ok()
            .map(|payload| payload.moves)
    })
}

/// Claude Code prints a result event, alone or last in an array of events,
/// with the reply in `result`; Codex prints the reply as is.
fn extract(stdout: &str) -> Option<Vec<Draft>> {
    let events = match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        Ok(serde_json::Value::Array(events)) => events,
        Ok(event @ serde_json::Value::Object(_)) => vec![event],
        _ => Vec::new(),
    };
    events
        .iter()
        .rev()
        .filter(|event| event["type"] == "result" || event.get("result").is_some())
        .find_map(|event| {
            serde_json::from_value::<Payload>(event["structured_output"].clone())
                .ok()
                .map(|payload| payload.moves)
                .or_else(|| moves_in(event["result"].as_str()?))
        })
        .or_else(|| moves_in(stdout))
}

/// Usable, distinct recommendations whose names the project does not use yet.
fn admitted(drafts: Vec<Draft>, existing: &[String]) -> Vec<MoveRecommendation> {
    let mut seen = existing
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect::<HashSet<_>>();
    drafts
        .into_iter()
        .filter_map(|draft| {
            let runner = match draft.runner.as_str() {
                "script" => MoveRunner::Script,
                "prompt" => MoveRunner::Prompt,
                _ => return None,
            };
            let name = draft.name.trim().to_owned();
            let prompt = draft.prompt.trim().to_owned();
            let usable = !name.is_empty()
                && name.chars().count() <= 80
                && !prompt.is_empty()
                && prompt.chars().count() <= 20_000;
            (usable && seen.insert(name.to_lowercase())).then(|| MoveRecommendation {
                name,
                runner,
                prompt,
                source: draft.source.filter(|source| !source.trim().is_empty()),
                reason: draft.reason.filter(|reason| !reason.trim().is_empty()),
            })
        })
        .take(MAX_RECOMMENDATIONS)
        .collect()
}

/// Reads the project with its default Worker and returns proposed moves.
/// A cancelled request ends the agent, because the child dies with the future.
pub async fn recommend(
    state: &AppState,
    user_id: &str,
    project_id: &str,
) -> Result<MoveRecommendationsResponse, Box<dyn Error + Send + Sync>> {
    let (project, profile, existing) = state.with_database(|database| {
        let project = projects::get(database, user_id, project_id)?;
        let profile = crate::tasks::commands::selected_profile(
            database,
            &project,
            None,
            &project.worker_profile_id,
            "worker",
        )?;
        let mut statement = database
            .connection()
            .prepare("SELECT name FROM suplex_moves WHERE project_id = ?1")?;
        let existing = statement
            .query_map([&project.id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok::<_, Box<dyn Error + Send + Sync>>((project, profile, existing))
    })?;
    let line = command(&profile)?;
    let child = tokio::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(line)
        .current_dir(&project.repository_path)
        .env_clear()
        .envs(crate::terminals::host::user_environment())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(TIME_LIMIT, child)
        .await
        .map_err(|_| TaskError::new("The agent did not finish in 5 minutes", 504))??;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(drafts) = extract(&stdout) else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim().lines().last().unwrap_or("").to_owned();
        return Err(TaskError::new(
            format!("The agent did not return moves. {detail}")
                .trim_end()
                .to_owned(),
            502,
        )
        .into());
    };
    Ok(MoveRecommendationsResponse {
        recommendations: admitted(drafts, &existing),
        profile_id: profile.profile_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLY: &str = r#"{"moves":[
        {"name":"Run tests","runner":"script","prompt":"npm run test","source":"package.json","reason":"Runs the tests."},
        {"name":"run TESTS","runner":"script","prompt":"npm test"},
        {"name":"Fix failing tests","runner":"prompt","prompt":"Run the tests. Fix any failure.","source":""},
        {"name":"Deploy","runner":"script","prompt":"make deploy"},
        {"name":"Repair","runner":"pull_request_tasks","prompt":"x"},
        {"name":"Empty","runner":"script","prompt":"  "}
    ]}"#;

    #[test]
    fn claude_and_codex_replies_both_yield_moves() {
        let result = serde_json::json!({"type": "result", "result": format!("Here you go:\n```json\n{REPLY}\n```")});
        let claude = result.to_string();
        let events = serde_json::json!([{"type": "system", "subtype": "init"}, {"type": "assistant", "message": {"content": "{}"}}, result]).to_string();
        let codex = format!("I read package.json.\n{REPLY}\n");
        for stdout in [claude, events, codex] {
            assert_eq!(extract(&stdout).map(|moves| moves.len()), Some(6));
        }
        assert!(extract(r#"{"type":"result","result":"I could not read the files."}"#).is_none());
    }

    #[test]
    fn only_new_distinct_usable_moves_are_recommended() {
        let moves = admitted(extract(REPLY).unwrap(), &["deploy".to_owned()]);
        let names = moves
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["Run tests", "Fix failing tests"]);
        assert_eq!(moves[0].source.as_deref(), Some("package.json"));
        assert_eq!(
            (moves[1].runner, moves[1].source.as_deref()),
            (MoveRunner::Prompt, None)
        );
    }
}
