//! The agent command line of a prompt move or a one-shot read, and the local
//! endpoint that the profile model names, registered as task runs register it.
//! A one-shot read asks the project's default Worker one question, read-only,
//! and takes one JSON object from its reply. Recommendations and move drafts
//! use it.

use std::{
    error::Error,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::de::DeserializeOwned;
use serde_json::json;

use crate::{
    http::AppState,
    profiles::{
        local_endpoints,
        provider_login::{scoped_command, shell_binary, shell_quoted},
    },
    projects::service::{self as projects, Project},
    runtimes::{
        opencode::server::endpoint_provider,
        pi::{
            cli::{self, OMP, PI},
            invocation,
            task_runtime::ENDPOINT_EXTENSION,
        },
    },
    shared::fs::write_private,
    tasks::{
        TaskError,
        control::{HarnessKind, TaskProfile},
    },
};

/// An agent that reads a large repository can take a few minutes.
const TIME_LIMIT: Duration = Duration::from_secs(300);
/// The longest move name an agent can propose.
pub const MAX_NAME: usize = 80;
/// The longest move text an agent can propose.
pub const MAX_PROMPT: usize = 20_000;

/// A local endpoint registered for one agent process. The API key is only in
/// `environment`, never in an argument or a file.
pub struct Endpoint {
    /// The private directory of a Pi or OMP extension, removed when this value
    /// drops. Keep the value until the agent exits.
    directory: Option<PathBuf>,
    /// Variables for the agent process.
    pub environment: Vec<(String, String)>,
    /// Arguments right after the executable.
    args: Vec<String>,
}

impl Endpoint {
    /// `None` when the profile model names no local endpoint. `name` keeps the
    /// files of concurrent agents apart.
    pub fn register(
        database_path: &Path,
        profile: &TaskProfile,
        name: &str,
    ) -> Result<Option<Self>, Box<dyn Error + Send + Sync>> {
        // Only OpenCode, Pi, and OMP models name a local endpoint.
        if !matches!(
            profile.provider,
            HarnessKind::Opencode | HarnessKind::Pi | HarnessKind::Omp
        ) {
            return Ok(None);
        }
        let Some(endpoint) = local_endpoints::for_model(database_path, &profile.model)
            .map_err(|error| TaskError::new(error.to_string(), 422))?
        else {
            return Ok(None);
        };
        let Some(cli) = cli::for_provider(profile.provider.as_str()) else {
            let config = json!({"provider": {endpoint.id.clone(): endpoint_provider(&endpoint)}});
            return Ok(Some(Self {
                directory: None,
                environment: vec![("OPENCODE_CONFIG_CONTENT".to_owned(), config.to_string())],
                args: Vec::new(),
            }));
        };
        let directory = database_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("runtime/move-endpoints")
            .join(name);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)?;
        let extension = directory.join(ENDPOINT_EXTENSION);
        let registered = Self {
            directory: Some(directory),
            environment: endpoint
                .api_key
                .iter()
                .map(|key| (invocation::ENDPOINT_API_KEY_ENV.to_owned(), key.clone()))
                .collect(),
            args: vec!["-e".to_owned(), extension.to_string_lossy().into_owned()],
        };
        write_private(
            &extension,
            invocation::endpoint_extension(cli, &endpoint).as_bytes(),
        )?;
        Ok(Some(registered))
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        if let Some(directory) = &self.directory {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

/// The `environment` assignments, the resolved executable, the endpoint
/// arguments, and `args`, scoped to the provider instance.
pub fn line(
    profile: &TaskProfile,
    endpoint: Option<&Endpoint>,
    environment: &[(&str, &str)],
    args: &[&str],
) -> String {
    let provider = profile.provider.as_str();
    let line = environment
        .iter()
        .map(|(name, value)| format!("{name}={}", shell_quoted(value)))
        .chain(std::iter::once(shell_binary(provider)))
        .chain(
            endpoint
                .into_iter()
                .flat_map(|endpoint| &endpoint.args)
                .map(|arg| shell_quoted(arg)),
        )
        .chain(args.iter().map(|arg| shell_quoted(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    scoped_command(provider, profile.instance_home_directory(), line)
}

/// The agent's one-shot command line, with tools that can change files or run
/// commands turned off.
fn read_only_line(profile: &TaskProfile, endpoint: Option<&Endpoint>, prompt: &str) -> String {
    let effort = profile.reasoning_level.as_str();
    let codex_effort = format!("model_reasoning_effort=\"{effort}\"");
    let (environment, args) = match profile.provider {
        HarnessKind::ClaudeCode => (
            None,
            vec![
                "-p",
                prompt,
                "--output-format",
                "json",
                "--model",
                &profile.model,
                "--effort",
                effort,
                // Only file reading: no shell, edits, web, subagents, or MCP servers.
                "--tools",
                "Read,Glob,Grep",
                "--strict-mcp-config",
            ],
        ),
        HarnessKind::Codex => (
            None,
            vec![
                "exec",
                "--skip-git-repo-check",
                "-m",
                &profile.model,
                "-c",
                &codex_effort,
                "-c",
                "approval_policy=\"never\"",
                "-c",
                "sandbox_mode=\"read-only\"",
                prompt,
            ],
        ),
        // OpenCode does not offer a denied tool to the model.
        HarnessKind::Opencode => (
            Some((
                "OPENCODE_PERMISSION",
                r#"{"*":"deny","read":"allow","glob":"allow","grep":"allow","list":"allow"}"#,
            )),
            vec![
                "run",
                "--model",
                &profile.model,
                "--variant",
                effort,
                prompt,
            ],
        ),
        // In print mode, `auto` runs only read-only tools and rejects the rest.
        HarnessKind::Devin => (
            None,
            vec![
                "--model",
                &profile.model,
                "--permission-mode",
                "auto",
                "--respect-workspace-trust",
                "false",
                "--print",
                prompt,
            ],
        ),
        HarnessKind::Pi | HarnessKind::Omp => {
            let cli = if profile.provider == HarnessKind::Pi {
                &PI
            } else {
                &OMP
            };
            let mut args = vec!["-p", "--model", &profile.model, "--thinking", effort];
            args.extend(["--tools", cli.read_only_tools]);
            args.extend(cli.turn_args);
            args.push(prompt);
            (None, args)
        }
    };
    line(profile, endpoint, environment.as_slice(), &args)
}

/// The first JSON object of type `T` in the text.
// Tries a parse at each `{`, quadratic in the worst case; agent
// replies are small, so a streaming scanner is not worth it yet.
fn first_object<T: DeserializeOwned>(text: &str) -> Option<T> {
    text.match_indices('{').find_map(|(index, _)| {
        serde_json::Deserializer::from_str(&text[index..])
            .into_iter::<T>()
            .next()?
            .ok()
    })
}

/// Claude Code prints a result event, alone or last in an array of events,
/// with the reply in `result`; the other agents print the reply as is.
pub fn extract<T: DeserializeOwned>(stdout: &str) -> Option<T> {
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
            serde_json::from_value::<T>(event["structured_output"].clone())
                .ok()
                .or_else(|| first_object(event["result"].as_str()?))
        })
        .or_else(|| first_object(stdout))
}

/// What a one-shot read needs, after the user's access to the project passes.
pub struct Reader {
    project: Project,
    pub profile: TaskProfile,
    /// The names of the moves in the project.
    pub existing: Vec<String>,
    database_path: PathBuf,
}

impl Reader {
    /// The user must be able to change work in the project's company.
    pub fn open(
        state: &AppState,
        user_id: &str,
        project_id: &str,
    ) -> Result<Self, Box<dyn Error + Send + Sync>> {
        state.with_database(|database| {
            let project = projects::get(database, user_id, project_id)?;
            crate::identity::companies::require_company_edit(
                database,
                user_id,
                &project.company_id,
            )?;
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
            let path = database.connection().path().map(PathBuf::from);
            Ok(Self {
                project,
                profile,
                existing,
                database_path: path.unwrap_or_default(),
            })
        })
    }

    /// Runs the agent once in the repository and reads a `T` from its reply.
    /// `no_reply` starts the 502 message when the reply has none. A cancelled
    /// request ends the agent, because the child dies with the future.
    pub async fn ask<T: DeserializeOwned>(
        &self,
        label: &str,
        prompt: &str,
        no_reply: &str,
    ) -> Result<T, Box<dyn Error + Send + Sync>> {
        // Dropped when the agent ends or the request is cancelled.
        let endpoint = Endpoint::register(
            &self.database_path,
            &self.profile,
            &format!("{label}-{}", uuid::Uuid::new_v4().simple()),
        )?;
        let child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(read_only_line(&self.profile, endpoint.as_ref(), prompt))
            .current_dir(&self.project.repository_path)
            .env_clear()
            .envs(crate::terminals::host::user_environment())
            .envs(
                endpoint
                    .iter()
                    .flat_map(|endpoint| endpoint.environment.clone()),
            )
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let output = tokio::time::timeout(TIME_LIMIT, child)
            .await
            .map_err(|_| TaskError::new("The agent did not finish in 5 minutes", 504))??;
        extract(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim().lines().last().unwrap_or("");
            TaskError::new(format!("{no_reply} {detail}").trim_end().to_owned(), 502).into()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use std::{fs, os::unix::fs::PermissionsExt};

    fn profile(provider: &str, model: &str) -> TaskProfile {
        serde_json::from_value(json!({
            "profileId":"p", "provider":provider, "model":model,
            "reasoningLevel":"high", "serviceTier":"default"
        }))
        .unwrap()
    }

    fn endpoint_database() -> (PathBuf, PathBuf, String) {
        let base = std::env::temp_dir().join(format!("suplex-move-agent-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("suplex.db");
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let endpoint = local_endpoints::create(
            &mut database,
            &local_endpoints::LocalEndpointInput {
                base_url: "http://127.0.0.1:8080/v1".into(),
                api_key: Some("secret-key".into()),
                model_id: "qwen3-coder".into(),
                label: None,
            },
        )
        .unwrap();
        (base, path, endpoint.model())
    }

    #[test]
    fn a_one_shot_read_passes_the_prompt_with_only_read_tools() {
        for (provider, restriction) in [
            ("claude-code", "Read,Glob,Grep"),
            ("codex", "sandbox_mode"),
            ("opencode", "OPENCODE_PERMISSION"),
            ("devin", "--permission-mode"),
            ("pi", "--tools"),
            ("omp", "--tools"),
        ] {
            let line = read_only_line(&profile(provider, "model"), None, "the prompt's text");
            assert!(line.contains(restriction), "{provider}: {line}");
            assert!(line.contains("the prompt"), "{provider}: {line}");
        }
    }

    #[test]
    fn opencode_receives_the_endpoint_provider_in_its_configuration_variable() {
        let (base, database, model) = endpoint_database();
        let endpoint = Endpoint::register(&database, &profile("opencode", &model), "run")
            .unwrap()
            .unwrap();
        let [(name, config)] = &endpoint.environment[..] else {
            panic!("one variable");
        };
        let config: serde_json::Value = serde_json::from_str(config).unwrap();
        let provider = &config["provider"][model.split_once('/').unwrap().0];
        assert_eq!(name, "OPENCODE_CONFIG_CONTENT");
        assert_eq!(provider["options"]["apiKey"], "secret-key");
        assert!(provider["models"]["qwen3-coder"].is_object());
        let line = line(&profile("opencode", &model), Some(&endpoint), &[], &["x"]);
        assert!(!line.contains("secret-key"));
        assert!(!base.join("runtime").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pi_and_omp_load_a_private_extension_that_lasts_as_long_as_the_registration() {
        let (base, database, model) = endpoint_database();
        for provider in ["pi", "omp"] {
            let profile = profile(provider, &model);
            let endpoint = Endpoint::register(&database, &profile, provider)
                .unwrap()
                .unwrap();
            let directory = base.join("runtime/move-endpoints").join(provider);
            let extension = directory.join(ENDPOINT_EXTENSION);
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!((mode(&directory), mode(&extension)), (0o700, 0o600));
            assert!(
                !fs::read_to_string(&extension)
                    .unwrap()
                    .contains("secret-key")
            );
            assert_eq!(
                endpoint.environment,
                [(
                    invocation::ENDPOINT_API_KEY_ENV.to_owned(),
                    "secret-key".to_owned()
                )]
            );
            let line = line(&profile, Some(&endpoint), &[], &["--model", &model]);
            assert!(line.ends_with(&format!(
                " '-e' '{}' '--model' '{model}'",
                extension.display()
            )));
            assert!(!line.contains("secret-key"));
            let terminal = super::super::shell::command(&profile, Some(&endpoint), "main", "x");
            assert!(terminal.ends_with("; exec env -u SUPLEX_ENDPOINT_API_KEY \"$SHELL\" -l"));
            drop(endpoint);
            assert!(!directory.exists());
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn only_a_saved_endpoint_model_registers_and_a_deleted_one_fails() {
        let (base, database, model) = endpoint_database();
        for (provider, model) in [("opencode", "openai/gpt-5"), ("claude-code", &model)] {
            assert!(
                Endpoint::register(&database, &profile(provider, model), "run")
                    .unwrap()
                    .is_none()
            );
        }
        let failure = Endpoint::register(&database, &profile("pi", "local-000000000000/x"), "run")
            .err()
            .unwrap();
        assert!(matches!(
            failure.downcast_ref::<TaskError>(),
            Some(TaskError::Failure { status: 422, .. })
        ));
        fs::remove_dir_all(base).unwrap();
    }
}
