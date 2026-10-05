//! One row per agent tool.

use crate::shared::time::rfc3339_millis;
use std::{collections::HashMap, fs, path::Path};

use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::runtimes::task_harness::{ExecutableSpec, resolve_executable};

const OPENCODE: ExecutableSpec = ExecutableSpec {
    label: "OpenCode",
    binary: "opencode",
    env_var: "SUPLEX_OPENCODE_COMMAND",
    home_paths: &[".opencode/bin/opencode"],
    fallback_paths: &[],
};
const CLAUDE: ExecutableSpec = ExecutableSpec {
    label: "Claude Code",
    binary: "claude",
    env_var: "SUPLEX_CLAUDE_COMMAND",
    home_paths: &[".local/bin/claude", ".claude/local/claude"],
    fallback_paths: &[],
};
const DEVIN: ExecutableSpec = ExecutableSpec {
    label: "Devin CLI",
    binary: "devin",
    env_var: "SUPLEX_DEVIN_COMMAND",
    home_paths: &[".local/bin/devin", ".devin/bin/devin"],
    fallback_paths: &[],
};
const CODEX: ExecutableSpec = ExecutableSpec {
    label: "Codex CLI",
    binary: "codex",
    env_var: "SUPLEX_CODEX_COMMAND",
    home_paths: &[".local/bin/codex", ".codex/bin/codex"],
    fallback_paths: &[],
};

// Supported models for each native runtime.
const CLAUDE_CODE_MODELS: &[(&str, &str)] = &[
    ("fable", "Fable (latest)"),
    ("opus", "Opus (latest)"),
    ("sonnet", "Sonnet (latest)"),
    ("haiku", "Haiku (latest)"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
];
const DEVIN_MODELS: &[(&str, &str)] = &[
    ("swe", "SWE (latest)"),
    ("swe-2", "SWE-2"),
    ("opus", "Opus (latest)"),
    ("gpt", "GPT (latest)"),
];
const CODEX_MODELS: &[(&str, &str)] = &[
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-terra", "GPT-5.6 Terra"),
    ("gpt-5.6-luna", "GPT-5.6 Luna"),
    ("gpt-6-astra", "GPT-6 Astra"),
    ("gpt-6-sol", "GPT-6 Sol"),
    ("gpt-5.5", "GPT-5.5"),
];

fn models(list: &[(&str, &str)]) -> Vec<Value> {
    list.iter()
        .map(|(id, label)| json!({"id": id, "label": label}))
        .collect()
}

#[derive(Deserialize)]
struct CodexModelCache {
    models: Vec<CodexModel>,
}

#[derive(Deserialize)]
struct CodexModel {
    slug: String,
    display_name: Option<String>,
    visibility: Option<String>,
}

/// Codex keeps the account's current model list in its home; the static list only covers a fresh install.
pub fn read_codex_models(codex_home: &Path) -> Vec<Value> {
    let cache = fs::read(codex_home.join("models_cache.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CodexModelCache>(&bytes).ok())
        .filter(|cache| cache.models.iter().all(|model| !model.slug.is_empty()));
    let listed = cache
        .map(|cache| {
            cache
                .models
                .into_iter()
                .filter(|model| model.visibility.as_deref() != Some("hide"))
                .map(|model| {
                    let label = model.display_name.unwrap_or_else(|| model.slug.clone());
                    json!({"id": model.slug, "label": label})
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if listed.is_empty() {
        models(CODEX_MODELS)
    } else {
        listed
    }
}

/// `readProviders`. OpenCode's own vendors fold into its row as vendor-qualified
/// model ids; neither observation sends a model request. `probe` checks each sign-in.
pub async fn read_providers(directory: &str, probe: bool) -> Value {
    let native = crate::runtimes::opencode::providers::read_providers(Path::new(directory), None)
        .await
        .unwrap_or_else(|_| {
            json!({"directory": directory, "observedAt": rfc3339_millis(Utc::now()), "providers": []})
        });
    let open_code_models = native["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|vendor| {
            vendor["models"].as_array().into_iter().flatten().map(move |model| {
                json!({
                    "id": format!("{}/{}", vendor["id"].as_str().unwrap_or_default(), model["id"].as_str().unwrap_or_default()),
                    "label": format!("{} ({})", model["label"].as_str().unwrap_or_default(), vendor["label"].as_str().unwrap_or_default()),
                })
            })
        })
        .collect::<Vec<_>>();
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    let home = crate::profiles::agent_profiles::home_directory();
    let codex_home = environment
        .get("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".codex")))
        .unwrap_or_default();
    let rows = [
        (&OPENCODE, "opencode", open_code_models),
        (&CLAUDE, "claude-code", models(CLAUDE_CODE_MODELS)),
        (&DEVIN, "devin", models(DEVIN_MODELS)),
        (&CODEX, "codex", read_codex_models(&codex_home)),
    ];
    let mut providers = Vec::new();
    for (spec, id, models) in rows {
        let installed = resolve_executable(spec, None, &environment, home.as_deref()).is_ok();
        let connection = if probe {
            crate::profiles::provider_connection::provider_connection(id).await
        } else {
            json!({"status": "unknown", "summary": "Suplex did not check the sign-in."})
        };
        providers.push(json!({
            "id": id, "label": spec.label, "modelCount": models.len(), "models": models,
            "status": if installed { "configured" } else { "missing" },
            "connection": connection,
        }));
    }
    providers.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
    json!({"directory": native["directory"], "observedAt": native["observedAt"], "providers": providers})
}

/// `ProjectService.listModels`: every provider model as a selectable option.
pub fn list_models(providers: &Value) -> Value {
    let models = providers["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|provider| {
            provider["models"].as_array().into_iter().flatten().map(move |model| {
                json!({"id": model["id"], "provider": provider["id"], "providerLabel": provider["label"], "providerStatus": provider["status"], "displayName": model["label"]})
            })
        })
        .collect::<Vec<_>>();
    json!({"models": models})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_models_come_from_the_visible_cache_and_fall_back_to_the_static_list() {
        let home =
            std::env::temp_dir().join(format!("suplex-codex-models-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        assert_eq!(read_codex_models(&home), models(CODEX_MODELS));
        fs::write(home.join("models_cache.json"), json!({"models":[{"slug":"gpt-7","display_name":"GPT-7"},{"slug":"hidden","visibility":"hide"},{"slug":"raw"}]}).to_string()).unwrap();
        assert_eq!(
            read_codex_models(&home),
            vec![
                json!({"id":"gpt-7","label":"GPT-7"}),
                json!({"id":"raw","label":"raw"})
            ]
        );
        fs::write(home.join("models_cache.json"), "{").unwrap();
        assert_eq!(read_codex_models(&home), models(CODEX_MODELS));
        fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn provider_routes_require_an_administrator_and_models_any_session() {
        use crate::http::routes::avatars::tests::{call, json_body};
        use axum::http::StatusCode;
        let (state, filename) = crate::http::routes::auth::tests::state();
        let now = Utc::now();
        let admin = crate::http::routes::auth::tests::operator_account(&state, now);
        let member = state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'M', 'member', 'member', 'active', ?1, ?1, 1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_models', 'Models', 'active', ?1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_memberships (company_id, user_id, created_at) VALUES ('company_models', 'member', ?1)", [now.to_rfc3339()]).unwrap();
            crate::http::routes::auth::tests::verified_session(database, "member", now).unwrap()
        });
        crate::http::routes::auth::tests::require_remote_login(&state);
        let app = crate::http::router(state.clone());
        let admin = format!("sid_v1={admin}");
        let member = format!("sid_v1={member}");
        let (status, headers, body) =
            call(&app, "GET", "/api/admin/providers", Some(&admin), None).await;
        assert_eq!(
            (status, headers["cache-control"].to_str().unwrap()),
            (StatusCode::OK, "private, no-store")
        );
        assert_eq!(json_body(&body)["providers"].as_array().unwrap().len(), 4);
        for (method, path) in [
            ("PUT", "/api/admin/providers/openrouter/credential"),
            ("DELETE", "/api/admin/providers/openrouter/credential"),
            ("POST", "/api/admin/providers/openrouter/test"),
        ] {
            assert_eq!(
                call(&app, method, path, Some(&admin), None).await.0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            call(&app, "GET", "/api/admin/providers", Some(&member), None)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        for path in ["/api/admin/models", "/api/models"] {
            let (status, _, body) = call(&app, "GET", path, Some(&member), None).await;
            assert_eq!(
                (status, json_body(&body)["models"][0]["provider"].clone()),
                (StatusCode::OK, json!("claude-code"))
            );
            assert_eq!(
                call(&app, "GET", path, None, None).await.0,
                StatusCode::UNAUTHORIZED
            );
        }
        drop(app);
        drop(state);
        let _ = fs::remove_file(filename);
    }

    #[tokio::test]
    async fn providers_list_one_sorted_row_per_tool_and_models_flatten_them() {
        let providers = read_providers("/work", false).await;
        let labels = providers["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["label"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            ["Claude Code", "Codex CLI", "Devin CLI", "OpenCode"]
        );
        assert_eq!(providers["providers"][0]["modelCount"], 9);
        assert_eq!(providers["providers"][0]["connection"]["status"], "unknown");
        let listed = list_models(&providers);
        assert_eq!(
            listed["models"][0],
            json!({"id":"fable","provider":"claude-code","providerLabel":"Claude Code","providerStatus":providers["providers"][0]["status"],"displayName":"Fable (latest)"})
        );
    }
}
