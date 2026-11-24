//! Antigravity readiness from the agent itself: `agy acp` reports its version
//! in `initialize`, and a new session shows whether it is signed in and which
//! models the account offers. Nothing here sends a model request.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::{
    acp::{self, AcpError, AcpProcess, Client},
    cli, task_runtime,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const SESSION_TIMEOUT: Duration = Duration::from_secs(60);
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(20);
/// Settings and System health ask often; one probe serves them for a while.
const CACHE_TTL: Duration = Duration::from_secs(120);

/// `signed-in`, `signed-out`, or `unknown`.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub version: Option<String>,
    pub state: &'static str,
    /// `(id, label)` of each model the signed-in account offers.
    pub models: Vec<(String, String)>,
    pub thinking_levels: Vec<String>,
    pub detail: Option<String>,
}

impl Probe {
    fn unknown(version: Option<String>, detail: String) -> Self {
        Self {
            version,
            state: "unknown",
            models: Vec::new(),
            thinking_levels: Vec::new(),
            detail: Some(detail),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "state": self.state,
            "models": self.models.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
            "thinkingLevels": self.thinking_levels,
            "detail": self.detail,
        })
    }
}

/// A probe answers no permission request: it sends no prompt.
struct Quiet;

impl Client for Quiet {
    fn notification(&mut self, _method: &str, _params: &Value) {}
    fn request(&mut self, method: &str, _params: &Value) -> Result<Value, (i64, String)> {
        Err((-32601, format!("Suplex does not offer {method}")))
    }
}

/// The models of a new session: the `model` config option, else the
/// session's `models` list.
pub fn session_models(session: &Value) -> Vec<(String, String)> {
    if let Some(option) = acp::model_option(&session["configOptions"]) {
        return acp::option_values(option);
    }
    session["models"]["availableModels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model["modelId"].as_str()?;
            Some((
                id.to_owned(),
                model["name"].as_str().unwrap_or(id).to_owned(),
            ))
        })
        .collect()
}

/// One blocking probe in `workspace`, which Antigravity may write skill
/// folders into.
pub fn probe(agy: &Path, environment: &HashMap<String, String>, workspace: &Path) -> Probe {
    if let Err(error) = std::fs::create_dir_all(workspace) {
        return Probe::unknown(None, error.to_string());
    }
    let args = cli::ACP_ARGS
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect::<Vec<_>>();
    let mut agent = match AcpProcess::spawn(agy, &args, workspace, environment, false) {
        Ok(agent) => agent,
        Err(error) => return Probe::unknown(None, error.to_string()),
    };
    let mut quiet = Quiet;
    let initialized = match agent.request(
        "initialize",
        acp::initialize_params(),
        Some(STARTUP_TIMEOUT),
        &mut quiet,
    ) {
        Ok(initialized) => initialized,
        Err(error) => return Probe::unknown(None, error.to_string()),
    };
    let version = initialized["agentInfo"]["version"]
        .as_str()
        .map(str::to_owned);
    let params = json!({"cwd": workspace.to_string_lossy(), "mcpServers": []});
    let mut session = agent.request(
        "session/new",
        params.clone(),
        Some(SESSION_TIMEOUT),
        &mut quiet,
    );
    if session.as_ref().is_err_and(AcpError::sign_in_required) {
        let lookup = |name: &str| environment.get(name).cloned();
        session = agent
            .request(
                "authenticate",
                json!({"methodId": cli::auth_method(&lookup)}),
                Some(SIGN_IN_TIMEOUT),
                &mut quiet,
            )
            .and_then(|_| agent.request("session/new", params, Some(SESSION_TIMEOUT), &mut quiet));
    }
    agent.shutdown(Duration::from_secs(1));
    match session {
        Ok(session) => Probe {
            version,
            state: "signed-in",
            models: session_models(&session),
            thinking_levels: acp::thinking_option(&session["configOptions"])
                .map(|option| {
                    acp::option_values(option)
                        .into_iter()
                        .map(|(value, _)| value)
                        .collect()
                })
                .unwrap_or_default(),
            detail: None,
        },
        Err(error) if error.sign_in_required() => Probe {
            version,
            state: "signed-out",
            models: Vec::new(),
            thinking_levels: Vec::new(),
            detail: None,
        },
        Err(AcpError::Timeout(_)) => Probe::unknown(version, "The sign-in check timed out".into()),
        Err(error) => Probe::unknown(version, error.to_string()),
    }
}

struct Cached {
    at: Instant,
    executable: PathBuf,
    probe: Probe,
}

static CACHE: LazyLock<tokio::sync::Mutex<Option<Cached>>> = LazyLock::new(Default::default);

/// The probe directory that Suplex owns.
fn workspace() -> PathBuf {
    std::env::temp_dir().join("suplex-antigravity-probe")
}

/// The executable and its probe. Concurrent callers share one run, and a
/// recent probe of the same executable answers without a new one.
pub async fn observe() -> (io::Result<PathBuf>, Option<Probe>) {
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    let executable = task_runtime::resolve_agy(None, &environment);
    let Ok(path) = &executable else {
        return (executable, None);
    };
    let mut cache = CACHE.lock().await;
    if let Some(cached) = cache.as_ref()
        && cached.executable == *path
        && cached.at.elapsed() < CACHE_TTL
    {
        return (executable, Some(cached.probe.clone()));
    }
    let agy = path.clone();
    let observed = tokio::task::spawn_blocking(move || probe(&agy, &environment, &workspace()))
        .await
        .unwrap_or_else(|error| Probe::unknown(None, error.to_string()));
    *cache = Some(Cached {
        at: Instant::now(),
        executable: path.clone(),
        probe: observed.clone(),
    });
    (executable, Some(observed))
}

/// The models of the latest probe, without starting one.
pub fn cached_models() -> Vec<(String, String)> {
    CACHE
        .try_lock()
        .ok()
        .and_then(|cache| cache.as_ref().map(|cached| cached.probe.models.clone()))
        .unwrap_or_default()
}

/// Entry point for `suplex antigravity-probe`: prints the probe and exits 0
/// only when Antigravity is signed in.
pub async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (executable, observed) = observe().await;
    let observed = match (executable, observed) {
        (Err(error), _) => {
            println!(
                "{}",
                json!({"state": "absent", "detail": error.to_string()})
            );
            std::process::exit(1);
        }
        (Ok(_), observed) => observed.unwrap_or_else(|| Probe::unknown(None, String::new())),
    };
    println!("{}", observed.to_json());
    std::process::exit(if observed.state == "signed-in" { 0 } else { 1 });
}
