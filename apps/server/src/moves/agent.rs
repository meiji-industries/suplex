//! The agent command line of a prompt move or a recommendation, and the local
//! endpoint that the profile model names, registered as task runs register it.

use std::{
    error::Error,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

use serde_json::json;

use crate::{
    profiles::{
        local_endpoints,
        provider_login::{scoped_command, shell_binary, shell_quoted},
    },
    runtimes::{
        opencode::server::endpoint_provider,
        pi::{cli, invocation, task_runtime::ENDPOINT_EXTENSION},
    },
    shared::fs::write_private,
    tasks::{
        TaskError,
        control::{HarnessKind, TaskProfile},
    },
};

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
