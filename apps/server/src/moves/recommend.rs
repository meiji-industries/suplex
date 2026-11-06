//! Move recommendations: the project's default Worker reads the repository,
//! once and read-only, and proposes moves for the commands the project
//! already defines. Nothing is saved; the person imports the ones they want.

use std::{collections::HashSet, error::Error};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{MoveRunner, agent};
use crate::http::AppState;

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
                && name.chars().count() <= agent::MAX_NAME
                && !prompt.is_empty()
                && prompt.chars().count() <= agent::MAX_PROMPT;
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
pub async fn recommend(
    state: &AppState,
    user_id: &str,
    project_id: &str,
) -> Result<MoveRecommendationsResponse, Box<dyn Error + Send + Sync>> {
    let reader = agent::Reader::open(state, user_id, project_id)?;
    let payload = reader
        .ask::<Payload>("recommendation", PROMPT, "The agent did not return moves.")
        .await?;
    Ok(MoveRecommendationsResponse {
        recommendations: admitted(payload.moves, &reader.existing),
        profile_id: reader.profile.profile_id,
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
            assert_eq!(
                agent::extract::<Payload>(&stdout).map(|payload| payload.moves.len()),
                Some(6)
            );
        }
        assert!(
            agent::extract::<Payload>(
                r#"{"type":"result","result":"I could not read the files."}"#
            )
            .is_none()
        );
    }

    #[test]
    fn only_new_distinct_usable_moves_are_recommended() {
        let moves = admitted(
            agent::extract::<Payload>(REPLY).unwrap().moves,
            &["deploy".to_owned()],
        );
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
