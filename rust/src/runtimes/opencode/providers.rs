//! The configured OpenCode vendors and models, read from a disposable server.

use crate::shared::time::now_millis_rfc3339;
use std::{cmp::Ordering, fs, path::Path};

use serde_json::{Value, json};

use super::{
    server::{EnsureInput, client, ensure_server, read_server, resolve_executable, stop_server},
    session::BoxError,
};

// Case-insensitive, then lowercase first; ICU `localeCompare` also orders punctuation and accents.
fn locale_order(left: &str, right: &str) -> Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| right.cmp(left))
}

// A fresh, session-free server reads current native auth and configuration.
// Disposing it cannot interrupt a task's server or refresh its credentials.
pub async fn read_providers(
    directory: &Path,
    executable: Option<&Path>,
) -> Result<Value, BoxError> {
    let executable = resolve_executable(executable)?;
    let runtime = std::env::temp_dir().join(format!(
        "suplex-provider-observation-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&runtime)?;
    let result = async {
        let reference = ensure_server(EnsureInput {
            runtime_directory: &runtime,
            executable: &executable,
            directory,
            config: &json!({}),
            env: None,
        })
        .await?;
        let native = client(&reference)?
            .providers(Some(&reference.directory))
            .await?;
        let mut providers: Vec<_> = native
            .all
            .into_iter()
            .filter(|provider| native.connected.contains(&provider.id))
            .map(|provider| {
                let mut models: Vec<_> = provider.models.into_values().collect();
                models.sort_by(|left, right| locale_order(&left.name, &right.name));
                (provider.id, provider.name, models)
            })
            .collect();
        providers.sort_by(|left, right| locale_order(&left.1, &right.1));
        let providers: Vec<Value> = providers
            .into_iter()
            .map(|(id, label, models)| {
                json!({
                    "id": id, "label": label, "modelCount": models.len(), "status": "configured",
                    "models": models.into_iter().map(|model| json!({"id": model.id, "label": model.name})).collect::<Vec<_>>(),
                })
            })
            .collect();
        Ok::<_, BoxError>(json!({
            "directory": reference.directory,
            "observedAt": now_millis_rfc3339(),
            "providers": providers,
        }))
    }
    .await;
    let stopped = match read_server(&runtime) {
        Ok(Some(reference)) => stop_server(&reference),
        Ok(None) => Ok(()),
        Err(error) => Err(error),
    };
    let _ = fs::remove_dir_all(&runtime);
    let observation = result?;
    stopped?;
    Ok(observation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::opencode::server::tests::temporary;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn labels_sort_case_insensitively_with_lowercase_first() {
        let mut labels = vec!["beta", "Alpha", "alpha", "Gamma"];
        labels.sort_by(|left, right| locale_order(left, right));
        assert_eq!(labels, ["alpha", "Alpha", "beta", "Gamma"]);
    }

    #[tokio::test]
    async fn provider_observation_lists_connected_vendors_and_disposes_its_server() {
        let node = std::process::Command::new("which")
            .arg("node")
            .output()
            .unwrap();
        let node = String::from_utf8(node.stdout).unwrap();
        let directory = temporary("opencode-providers");
        let executable = directory.join("opencode");
        fs::write(
            &executable,
            format!(
                r#"#!{}
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((request, response) => {{
  response.setHeader("content-type", "application/json");
  if (request.url.startsWith("/global/health")) response.end(JSON.stringify({{ healthy: true, version: "test" }}));
  else if (request.url.startsWith("/provider")) response.end(JSON.stringify({{ all: [
    {{ id: "openai", name: "OpenAI", key: "secret", models: {{ b: {{ id: "b", name: "beta" }}, a: {{ id: "a", name: "Alpha" }} }} }},
    {{ id: "anthropic", name: "Anthropic", models: {{}} }},
    {{ id: "offline", name: "Offline", models: {{}} }}
  ], connected: ["openai", "anthropic"], default: {{}} }}));
  else {{ response.statusCode = 404; response.end("{{}}"); }}
}});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
"#,
                node.trim()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let observed = read_providers(&directory, Some(&executable)).await.unwrap();
        assert_eq!(
            observed["directory"],
            fs::canonicalize(&directory)
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(
            observed["providers"],
            json!([
                {"id":"anthropic","label":"Anthropic","modelCount":0,"status":"configured","models":[]},
                {"id":"openai","label":"OpenAI","modelCount":2,"status":"configured","models":[{"id":"a","label":"Alpha"},{"id":"b","label":"beta"}]},
            ])
        );
        assert!(!observed.to_string().contains("secret"));
        fs::remove_dir_all(directory).unwrap();
    }
}
