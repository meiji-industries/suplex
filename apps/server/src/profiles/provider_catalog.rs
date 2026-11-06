//! One row per agent tool.

use crate::shared::time::rfc3339_millis;
use std::{
    collections::HashMap,
    fs,
    hash::Hash,
    path::Path,
    sync::{LazyLock, Mutex},
};

use chrono::Utc;
use futures::{
    FutureExt,
    future::{BoxFuture, Future, Shared, join_all},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::profiles::local_endpoints::{self, LocalEndpoint};
use crate::runtimes::pi::cli::{self as pi_cli, PiCli};
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
/// Pi and omp select `provider/id`; these cover a host where the listing is
/// not available.
const PI_MODELS: &[(&str, &str)] = &[
    ("anthropic/claude-opus-5-5", "Claude Opus 5.5 (anthropic)"),
    (
        "anthropic/claude-sonnet-5-5",
        "Claude Sonnet 5.5 (anthropic)",
    ),
    ("anthropic/claude-haiku-5-5", "Claude Haiku 5.5 (anthropic)"),
    ("openai/gpt-6-sol", "gpt-6-sol (openai)"),
    ("openai/gpt-5.6-sol", "gpt-5.6-sol (openai)"),
    ("google/gemini-3.5-flash", "gemini-3.5-flash (google)"),
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

/// The models Pi or omp lists for its current credentials, including the
/// custom providers of a local server; the static list otherwise.
pub fn pi_models(cli: &PiCli, listing: Option<&str>) -> Vec<Value> {
    let listed = listing
        .map(|listing| crate::runtimes::pi::models::parse_model_list(cli, listing))
        .unwrap_or_default()
        .into_iter()
        .map(|id| {
            let (provider, model) = id.split_once('/').unwrap_or(("", id.as_str()));
            json!({"label": format!("{model} ({provider})"), "id": id})
        })
        .collect::<Vec<_>>();
    if listed.is_empty() {
        models(PI_MODELS)
    } else {
        listed
    }
}

async fn read_pi_models(cli: &PiCli, environment: &HashMap<String, String>) -> Vec<Value> {
    let listing =
        match crate::runtimes::pi::executable::resolve_pi_executable(cli, None, environment) {
            Ok(pi) => {
                crate::profiles::provider_readiness::probe_command(&pi, cli.list_models_args, None)
                    .await
                    .ok()
                    .filter(|result| result.exit_code == Some(0))
                    .map(|result| result.stdout)
            }
            Err(_) => None,
        };
    pi_models(cli, listing.as_deref())
}

/// `readProviders`. OpenCode's own vendors fold into its row as vendor-qualified
/// model ids; neither observation sends a model request. `probe` checks each sign-in.
/// Each local endpoint follows the tool rows as its own row; `probe` asks it for its models.
pub async fn read_providers(directory: &str, probe: bool, endpoints: &[LocalEndpoint]) -> Value {
    let listing = single_flight(
        &TOOL_LISTINGS,
        (directory.to_owned(), probe),
        read_tools(directory.to_owned(), probe),
    )
    .await;
    let installed = listing
        .tools
        .iter()
        .filter(|tool| tool.installed)
        .map(|tool| tool.id)
        .collect::<Vec<_>>();
    let endpoint_harness = ENDPOINT_HARNESSES
        .into_iter()
        .find(|harness| installed.contains(harness));
    let mut providers = listing
        .tools
        .into_iter()
        .map(|mut tool| {
            // Pi and OMP also run each endpoint model when they are installed.
            if tool.installed && Some(tool.id) != endpoint_harness && ENDPOINT_HARNESSES.contains(&tool.id) {
                tool.models.extend(endpoints.iter().map(endpoint_model));
            }
            json!({
                "id": tool.id, "kind": "cli", "harness": tool.id, "label": tool.label, "modelCount": tool.models.len(), "models": tool.models,
                "status": if tool.installed { "configured" } else { "missing" },
                "connection": tool.connection,
            })
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
    let connections = join_all(endpoints.iter().map(|endpoint| async move {
        match endpoint_harness {
            None => {
                json!({"status": "not-connected", "summary": "OpenCode, Pi, or OMP is necessary to run the model of this endpoint."})
            }
            Some(_) if !probe => {
                json!({"status": "unknown", "summary": "Suplex did not check the endpoint."})
            }
            Some(_) => local_endpoints::connection(
                &local_endpoints::test(
                    &endpoint.base_url,
                    endpoint.api_key.as_deref(),
                    &endpoint.model_id,
                )
                .await,
            ),
        }
    }))
    .await;
    for (endpoint, connection) in endpoints.iter().zip(connections) {
        providers.push(endpoint_row(
            endpoint,
            endpoint_harness.unwrap_or(ENDPOINT_HARNESSES[0]),
            connection,
        ));
    }
    json!({"directory": listing.directory, "observedAt": listing.observed_at, "providers": providers})
}

/// One agent tool row before its endpoint models are added.
#[derive(Clone)]
struct Tool {
    id: &'static str,
    label: &'static str,
    installed: bool,
    models: Vec<Value>,
    connection: Value,
}

#[derive(Clone)]
struct ToolListing {
    directory: Value,
    observed_at: Value,
    tools: Vec<Tool>,
}

type InFlight<K, T> = Mutex<HashMap<K, Shared<BoxFuture<'static, T>>>>;

/// The tool listings that are running, per directory and probe. The onboarding
/// page asks for the providers and the default agents at the same time, and a
/// sign-in pane polls every few seconds: each would start its own OpenCode
/// server and probe every CLI again.
static TOOL_LISTINGS: LazyLock<InFlight<(String, bool), ToolListing>> =
    LazyLock::new(Default::default);

/// Runs `run` for `key`, unless a run for `key` is in flight: then it awaits that
/// run's result instead.
async fn single_flight<K: Clone + Eq + Hash, T: Clone>(
    in_flight: &InFlight<K, T>,
    key: K,
    run: impl Future<Output = T> + Send + 'static,
) -> T {
    let shared = in_flight
        .lock()
        .expect("tool listings lock poisoned")
        .entry(key.clone())
        .or_insert_with(|| run.boxed().shared())
        .clone();
    let value = shared.clone().await;
    let mut in_flight = in_flight.lock().expect("tool listings lock poisoned");
    if in_flight
        .get(&key)
        .is_some_and(|current| current.ptr_eq(&shared))
    {
        in_flight.remove(&key);
    }
    value
}

/// Every CLI observation at once: the OpenCode vendor listing, the Pi and OMP
/// model listings, then one sign-in probe per tool. Each has its own timeout, so
/// the listing takes the slowest one, not their sum.
async fn read_tools(directory: String, probe: bool) -> ToolListing {
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    let (native, pi_models, omp_models) = tokio::join!(
        crate::runtimes::opencode::providers::read_providers(Path::new(&directory), None),
        read_pi_models(&pi_cli::PI, &environment),
        read_pi_models(&pi_cli::OMP, &environment),
    );
    let native = native.unwrap_or_else(|_| {
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
        (&pi_cli::PI.executable, pi_cli::PI.provider, pi_models),
        (&pi_cli::OMP.executable, pi_cli::OMP.provider, omp_models),
    ];
    let connections = if probe {
        join_all(
            rows.iter()
                .map(|(_, id, _)| crate::profiles::provider_connection::provider_connection(id)),
        )
        .await
    } else {
        vec![
            json!({"status": "unknown", "summary": "Suplex did not check the sign-in."});
            rows.len()
        ]
    };
    let tools = rows
        .into_iter()
        .zip(connections)
        .map(|((spec, id, models), connection)| Tool {
            id,
            label: spec.label,
            installed: resolve_executable(spec, None, &environment, home.as_deref()).is_ok(),
            models,
            connection,
        })
        .collect();
    ToolListing {
        directory: native["directory"].clone(),
        observed_at: native["observedAt"].clone(),
        tools,
    }
}

/// The runtimes that can run an endpoint model, in the order that its row prefers them.
const ENDPOINT_HARNESSES: [&str; 3] = ["opencode", "pi", "omp"];

fn endpoint_model(endpoint: &LocalEndpoint) -> Value {
    json!({"id": endpoint.model(), "label": format!("{} ({})", endpoint.model_id, endpoint.label)})
}

/// One endpoint as a provider row. Its models run on `harness`.
fn endpoint_row(endpoint: &LocalEndpoint, harness: &str, connection: Value) -> Value {
    json!({
        "id": endpoint.id, "kind": "local-endpoint", "harness": harness, "label": endpoint.label,
        "modelCount": 1, "models": [endpoint_model(endpoint)], "status": "configured",
        "connection": connection,
        "endpoint": {"baseUrl": endpoint.base_url, "modelId": endpoint.model_id, "hasApiKey": endpoint.api_key.is_some()},
    })
}

/// `ProjectService.listModels`: every provider model as a selectable option.
pub fn list_models(providers: &Value) -> Value {
    let models = providers["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|provider| {
            provider["models"].as_array().into_iter().flatten().map(move |model| {
                json!({"id": model["id"], "provider": provider["harness"], "providerLabel": provider["label"], "providerStatus": provider["status"], "displayName": model["label"]})
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

    #[test]
    fn pi_models_come_from_its_listing_and_fall_back_to_the_static_list() {
        let listed = pi_models(
            &pi_cli::PI,
            Some(concat!(
                "provider   model        context  max-out  thinking  images\n",
                "llama-server  qwen3-coder-30b  128K  16.4K  yes  no\n",
                "anthropic  claude-sonnet-5  1M  128K  yes  yes\n",
            )),
        );
        assert_eq!(
            listed,
            vec![
                json!({"id":"llama-server/qwen3-coder-30b","label":"qwen3-coder-30b (llama-server)"}),
                json!({"id":"anthropic/claude-sonnet-5","label":"claude-sonnet-5 (anthropic)"}),
            ]
        );
        assert_eq!(
            pi_models(&pi_cli::PI, Some("No models available.")),
            models(PI_MODELS)
        );
        assert_eq!(pi_models(&pi_cli::PI, None), models(PI_MODELS));
        assert_eq!(
            pi_models(
                &pi_cli::OMP,
                Some(
                    r#"{"models":[{"provider":"llama-server","kind":"chat","id":"qwen3-coder-30b","selector":"llama-server/qwen3-coder-30b"}]}"#
                )
            ),
            vec![
                json!({"id":"llama-server/qwen3-coder-30b","label":"qwen3-coder-30b (llama-server)"})
            ]
        );
        assert_eq!(
            pi_models(&pi_cli::OMP, Some("{\"models\":[]}")),
            models(PI_MODELS)
        );
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
        assert_eq!(json_body(&body)["providers"].as_array().unwrap().len(), 6);
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
    async fn concurrent_callers_share_one_run_and_a_later_caller_starts_another() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        static IN_FLIGHT: LazyLock<InFlight<&'static str, usize>> = LazyLock::new(Default::default);
        let run = || async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            RUNS.fetch_add(1, Ordering::SeqCst)
        };
        let (first, second) = tokio::join!(
            single_flight(&IN_FLIGHT, "key", run()),
            single_flight(&IN_FLIGHT, "key", run()),
        );
        assert_eq!((first, second), (0, 0));
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
        assert_eq!(single_flight(&IN_FLIGHT, "key", run()).await, 1);
        assert_eq!(RUNS.load(Ordering::SeqCst), 2);
        assert!(IN_FLIGHT.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn providers_list_one_sorted_row_per_tool_and_models_flatten_them() {
        let providers = read_providers("/work", false, &[]).await;
        let labels = providers["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["label"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            [
                "Claude Code",
                "Codex CLI",
                "Devin CLI",
                "OMP",
                "OpenCode",
                "Pi"
            ]
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
