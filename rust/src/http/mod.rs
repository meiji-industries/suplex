use std::borrow::Cow;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use tower_http::compression::CompressionLayer;

use crate::integrations::{github_device::DeviceAuth, herdr::Herdr};
use crate::platform::{config::Installation, database::SuplexDatabase, embedded};
use crate::profiles::provider_login::ProviderLogins;
use crate::projects::git::Github;
use crate::tasks::host::TaskHostHandle;

pub mod access;
pub mod agent_api_runtime;
pub mod contracts;
pub mod error;
mod logging;
pub mod routes {
    pub mod access;
    pub mod admin_identity;
    pub mod admin_platform;
    pub mod agent_api;
    pub mod agent_pairing;
    pub mod analytics;
    pub mod auth;
    pub mod avatars;
    pub mod companies;
    pub mod discovery;
    pub mod external_agent_administration;
    pub mod github_auth;
    pub mod github_triggers;
    pub mod health;
    pub mod mcp;
    pub mod oauth;
    pub mod pages;
    pub mod profiles;
    pub mod projects;
    pub mod provider_login;
    pub mod task_agents;
    pub mod task_artifacts;
    pub mod task_history;
    pub mod task_pane;
    pub mod task_reads;
    pub mod task_templates;
    pub mod task_timeline;
    pub mod task_worktree;
    pub mod tasks;
    pub mod today;
    pub mod update;
    pub mod workflows;
}
pub mod session;
pub mod validation;

#[derive(Clone)]
pub struct ProjectRoots {
    pub repositories: PathBuf,
    pub worktrees: PathBuf,
}

#[derive(Clone)]
pub struct AppState {
    database: Arc<Mutex<SuplexDatabase>>,
    pub session_config: session::SessionConfig,
    pub installation: Option<Installation>,
    pub project_roots: Option<ProjectRoots>,
    pub artifact_root: Option<PathBuf>,
    pub project_github: Github,
    pub task_host: Option<TaskHostHandle>,
    pub history_shutdown: CancellationToken,
    pub github_device: Arc<DeviceAuth>,
    pub herdr: Herdr,
    pub provider_logins: Arc<ProviderLogins>,
    dev_assets_dir: Option<PathBuf>,
    /// Dynamic client registrations per source address in the last hour.
    pub oauth_registrations: OAuthRegistrations,
}

pub type OAuthRegistrations =
    Arc<Mutex<std::collections::HashMap<String, Vec<std::time::Instant>>>>;

impl AppState {
    pub fn new(database: SuplexDatabase, session_config: session::SessionConfig) -> Self {
        Self {
            database: Arc::new(Mutex::new(database)),
            session_config,
            installation: None,
            project_roots: None,
            artifact_root: None,
            project_github: Github::default(),
            task_host: None,
            history_shutdown: CancellationToken::new(),
            github_device: Arc::new(DeviceAuth::new().expect("GitHub device endpoints are valid")),
            herdr: Herdr::default(),
            provider_logins: Arc::default(),
            dev_assets_dir: None,
            oauth_registrations: OAuthRegistrations::default(),
        }
    }

    pub fn with_project_roots(mut self, repositories: PathBuf, worktrees: PathBuf) -> Self {
        self.project_roots = Some(ProjectRoots {
            repositories,
            worktrees,
        });
        self
    }

    pub fn with_installation(mut self, installation: Installation) -> Self {
        self.installation = Some(installation);
        self
    }

    pub fn with_project_github(mut self, github: Github) -> Self {
        self.project_github = github;
        self
    }

    pub fn with_artifact_root(mut self, root: PathBuf) -> Self {
        self.artifact_root = Some(root);
        self
    }

    pub fn with_task_host(mut self, task_host: TaskHostHandle) -> Self {
        self.task_host = Some(task_host);
        self
    }

    pub fn with_dev_assets_dir(mut self, directory: PathBuf) -> Self {
        self.dev_assets_dir = Some(directory);
        self
    }

    pub fn with_database<T>(&self, operation: impl FnOnce(&mut SuplexDatabase) -> T) -> T {
        let mut database = self.database.lock().expect("Suplex database lock poisoned");
        database.defer_callbacks();
        let result = catch_unwind(AssertUnwindSafe(|| operation(&mut database)));
        let callbacks = database.take_deferred_callbacks();
        drop(database);
        for callback in callbacks {
            let _ = catch_unwind(AssertUnwindSafe(callback));
        }
        match result {
            Ok(value) => value,
            Err(payload) => resume_unwind(payload),
        }
    }

    pub fn shutdown_history(&self) {
        self.history_shutdown.cancel();
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(routes::access::router())
        .merge(routes::admin_identity::router())
        .merge(routes::agent_pairing::router())
        .merge(routes::external_agent_administration::router())
        .merge(routes::admin_platform::router())
        .merge(routes::analytics::router())
        .merge(routes::auth::router(&state))
        .merge(routes::avatars::router())
        .merge(routes::mcp::router())
        .merge(routes::oauth::router())
        .merge(routes::discovery::router())
        .merge(routes::agent_api::router())
        .merge(routes::companies::router())
        .merge(routes::github_auth::router())
        .merge(routes::github_triggers::router())
        .merge(routes::health::router())
        .merge(routes::pages::router())
        .merge(routes::profiles::router())
        .merge(routes::projects::router())
        .merge(routes::provider_login::router())
        .merge(routes::task_agents::router())
        .merge(routes::task_artifacts::router())
        .merge(routes::task_reads::router())
        .merge(routes::task_timeline::router())
        .merge(routes::task_history::router())
        .merge(routes::task_pane::router())
        .merge(routes::task_worktree::router())
        .merge(routes::task_templates::router())
        .merge(routes::tasks::router())
        .merge(routes::today::router())
        .merge(routes::workflows::router())
        .merge(routes::update::router())
        .route("/auth", get(auth_page))
        .route(
            "/assets/{filename}",
            get(asset).layer(CompressionLayer::new()),
        )
        .method_not_allowed_fallback(not_found)
        .fallback(not_found)
        .layer(axum::middleware::from_fn(access::cookie_refresh))
        .layer(axum::middleware::from_fn(logging::request))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            access::remote_access_boundary,
        ))
        .with_state(state)
}

async fn auth_page() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        ui::auth_page(),
    )
}

async fn asset(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    request_headers: HeaderMap,
) -> Response {
    if !filename
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || filename.is_empty()
    {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let disk_body = state
        .dev_assets_dir
        .as_ref()
        .and_then(|directory| std::fs::read(directory.join(&filename)).ok());
    let Some(body) = disk_body
        .map(Cow::Owned)
        .or_else(|| embedded::frontend_asset(&filename).map(Cow::Borrowed))
    else {
        return (StatusCode::NOT_FOUND, "Suplex UI asset is not built").into_response();
    };
    let content_type = if filename.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if filename.ends_with(".woff2") {
        "font/woff2"
    } else if filename.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    // Vite hashes chunk names, so only the fixed suplex-ui.* entry files change under one name.
    let cache_control = if filename.starts_with("suplex-ui.") {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    let etag = format!(
        "\"{}\"",
        Sha256::digest(&body)[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let headers = [
        (header::CONTENT_TYPE, content_type),
        (header::CACHE_CONTROL, cache_control),
        (header::ETAG, etag.as_str()),
    ];
    if request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag))
    {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }
    (headers, body).into_response()
}

async fn not_found(State(_state): State<AppState>, uri: axum::http::Uri) -> Response {
    if uri.path().starts_with("/api/") {
        (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": "Not found" })),
        )
            .into_response()
    } else {
        (StatusCode::NOT_FOUND, "Not found").into_response()
    }
}

mod ui;

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

    use super::*;
    use crate::platform::database::OpenMode;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn development_assets_refresh_without_restarting_the_server() {
        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "suplex-assets-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let database =
            SuplexDatabase::open(&directory.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
        )
        .with_dev_assets_dir(directory.clone());
        let filename = "suplex-ui.js".to_owned();
        std::fs::write(directory.join(&filename), b"first build").unwrap();
        let first = asset(
            State(state.clone()),
            Path(filename.clone()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(first.headers()[header::CACHE_CONTROL], "no-cache");
        let etag = first.headers()[header::ETAG].clone();
        assert_eq!(
            to_bytes(first.into_body(), 1024).await.unwrap(),
            "first build"
        );
        let mut revalidate = HeaderMap::new();
        revalidate.insert(header::IF_NONE_MATCH, etag);
        let unchanged = asset(
            State(state.clone()),
            Path(filename.clone()),
            revalidate.clone(),
        )
        .await;
        assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
        std::fs::write(directory.join(&filename), b"second build").unwrap();
        let second = asset(State(state.clone()), Path(filename.clone()), revalidate).await;
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(second.into_body(), 1024).await.unwrap(),
            "second build"
        );
        std::fs::write(directory.join("cpp-D7oTDj03.js"), b"chunk").unwrap();
        let chunk = asset(
            State(state),
            Path("cpp-D7oTDj03.js".to_owned()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(
            chunk.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn committed_callback_can_reenter_shared_database() {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-http-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed)
        ));
        let state = AppState {
            database: Arc::new(Mutex::new(
                SuplexDatabase::open(&path, OpenMode::Migrate).unwrap(),
            )),
            session_config: session::SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".to_owned(),
                tailscale_exposure: "off".to_owned(),
            },
            installation: None,
            project_roots: None,
            artifact_root: None,
            project_github: Github::default(),
            task_host: None,
            history_shutdown: CancellationToken::new(),
            github_device: Arc::new(DeviceAuth::new().unwrap()),
            herdr: Herdr::default(),
            provider_logins: Arc::default(),
            dev_assets_dir: None,
            oauth_registrations: OAuthRegistrations::default(),
        };
        let observed = Arc::new(AtomicBool::new(false));
        let callback_state = state.clone();
        let callback_observed = observed.clone();
        state
            .with_database(|database| {
                database.transaction(false, |database| {
                    database.after_commit(move || {
                        if callback_state.database.try_lock().is_err() {
                            return;
                        }
                        let count: i64 = callback_state.with_database(|database| {
                            database
                                .connection()
                                .query_row("SELECT 1", [], |row| row.get(0))
                                .unwrap()
                        });
                        callback_observed.store(count == 1, Ordering::Relaxed);
                    });
                    Ok(())
                })
            })
            .unwrap();
        assert!(observed.load(Ordering::Relaxed));
        let events = Arc::new(Mutex::new(Vec::new()));
        let first = events.clone();
        state
            .with_database(|database| {
                database.transaction(false, |database| {
                    database.after_commit(move || first.lock().unwrap().push("first"));
                    Ok(())
                })
            })
            .unwrap();
        let second = events.clone();
        let later_error: crate::platform::database::DatabaseResult<()> =
            state.with_database(|database| {
                assert_eq!(&*events.lock().unwrap(), &["first"]);
                database.transaction(false, |database| {
                    database.after_commit(move || second.lock().unwrap().push("second"));
                    Ok(())
                })?;
                Err("later service step failed".into())
            });
        assert!(later_error.is_err());
        assert_eq!(&*events.lock().unwrap(), &["first", "second"]);
        let failure = catch_unwind(AssertUnwindSafe(|| {
            state.with_database(|database| {
                let _: crate::platform::database::DatabaseResult<()> =
                    database.transaction(false, |_| panic!("transaction failed"));
            });
        }));
        assert!(failure.is_err());
        let value: i64 = state.with_database(|database| {
            database
                .connection()
                .query_row("SELECT 1", [], |row| row.get(0))
                .unwrap()
        });
        assert_eq!(value, 1);
        drop(state);
        let _ = std::fs::remove_file(path);
    }
}
