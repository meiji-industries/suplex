use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use tokio_util::sync::CancellationToken;

use crate::integrations::github_device::DeviceAuth;
use crate::platform::{database::SuplexDatabase, embedded};
use crate::projects::repository::Commands;
use crate::tasks::host::TaskHostHandle;

pub mod contracts;
pub mod routes {
    pub mod admin_identity;
    pub mod auth;
    pub mod avatars;
    pub mod companies;
    pub mod github_auth;
    pub mod health;
    pub mod pages;
    pub mod profiles;
    pub mod projects;
    pub mod task_agents;
    pub mod task_artifacts;
    pub mod task_history;
    pub mod task_reads;
    pub mod task_templates;
    pub mod task_timeline;
    pub mod tasks;
    pub mod unported;
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
    pub project_roots: Option<ProjectRoots>,
    pub artifact_root: Option<PathBuf>,
    pub project_commands: Commands,
    pub task_host: Option<TaskHostHandle>,
    pub history_shutdown: CancellationToken,
    pub github_device: Arc<DeviceAuth>,
    dev_assets_dir: Option<PathBuf>,
}

impl AppState {
    pub fn new(database: SuplexDatabase, session_config: session::SessionConfig) -> Self {
        Self {
            database: Arc::new(Mutex::new(database)),
            session_config,
            project_roots: None,
            artifact_root: None,
            project_commands: Commands::default(),
            task_host: None,
            history_shutdown: CancellationToken::new(),
            github_device: Arc::new(DeviceAuth::new().expect("GitHub device endpoints are valid")),
            dev_assets_dir: None,
        }
    }

    pub fn with_project_roots(mut self, repositories: PathBuf, worktrees: PathBuf) -> Self {
        self.project_roots = Some(ProjectRoots {
            repositories,
            worktrees,
        });
        self
    }

    pub fn with_project_commands(mut self, commands: Commands) -> Self {
        self.project_commands = commands;
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
        .merge(routes::admin_identity::router())
        .merge(routes::auth::router())
        .merge(routes::avatars::router())
        .merge(routes::companies::router())
        .merge(routes::github_auth::router())
        .merge(routes::health::router())
        .merge(routes::pages::router())
        .merge(routes::profiles::router())
        .merge(routes::projects::router())
        .merge(routes::task_agents::router())
        .merge(routes::task_artifacts::router())
        .merge(routes::task_reads::router())
        .merge(routes::task_timeline::router())
        .merge(routes::task_history::router())
        .merge(routes::task_templates::router())
        .merge(routes::tasks::router())
        .merge(routes::workflows::router())
        .merge(routes::unported::router())
        .route("/auth", get(auth_page))
        .route("/assets/{filename}", get(asset))
        .method_not_allowed_fallback(not_found)
        .fallback(not_found)
        .with_state(state)
}

async fn auth_page() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        ui::auth_page(),
    )
}

async fn asset(State(state): State<AppState>, Path(filename): Path<String>) -> Response {
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
    let content_type = if filename.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if filename.ends_with(".woff2") {
        "font/woff2"
    } else if filename.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    if let Some(body) = disk_body {
        return ([(header::CONTENT_TYPE, content_type)], body).into_response();
    }
    match embedded::frontend_asset(&filename) {
        Some(body) => ([(header::CONTENT_TYPE, content_type)], body).into_response(),
        None => (StatusCode::NOT_FOUND, "Suplex UI asset is not built").into_response(),
    }
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
            "suplex-rust-assets-{}-{}",
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
        let first = asset(State(state.clone()), Path(filename.clone())).await;
        assert_eq!(
            to_bytes(first.into_body(), 1024).await.unwrap(),
            "first build"
        );
        std::fs::write(directory.join(&filename), b"second build").unwrap();
        let second = asset(State(state), Path(filename.clone())).await;
        assert_eq!(
            to_bytes(second.into_body(), 1024).await.unwrap(),
            "second build"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn committed_callback_can_reenter_shared_database() {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-rust-http-{}-{}.sqlite",
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
            project_roots: None,
            artifact_root: None,
            project_commands: Commands::default(),
            task_host: None,
            history_shutdown: CancellationToken::new(),
            github_device: Arc::new(DeviceAuth::new().unwrap()),
            dev_assets_dir: None,
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
