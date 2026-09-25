use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::{Arc, Mutex};

use axum::{
    Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};

use crate::platform::{database::SuplexDatabase, embedded};

pub mod contracts;
pub mod routes {
    pub mod auth;
    pub mod companies;
}
pub mod session;

#[derive(Clone)]
pub struct AppState {
    database: Arc<Mutex<SuplexDatabase>>,
    pub session_config: session::SessionConfig,
}

impl AppState {
    pub fn new(database: SuplexDatabase, session_config: session::SessionConfig) -> Self {
        Self {
            database: Arc::new(Mutex::new(database)),
            session_config,
        }
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
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(routes::auth::router())
        .merge(routes::companies::router())
        .route("/auth", get(auth_page))
        .route("/assets/{filename}", get(asset))
        .fallback(not_found)
        .with_state(state)
}

async fn auth_page() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        ui::auth_page(),
    )
}

async fn asset(Path(filename): Path<String>) -> Response {
    if !filename
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || filename.is_empty()
    {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let Some(body) = embedded::frontend_asset(&filename) else {
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
    ([(header::CONTENT_TYPE, content_type)], body).into_response()
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
