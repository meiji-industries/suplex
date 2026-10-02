//! Environment, backup and factory reset routes from `http/routes/administration.ts`.

use crate::http::error::ApiError;
use crate::shared::time::now_millis_rfc3339;
use std::path::PathBuf;

use axum::{
    Json, Router,
    body::{Body, HttpBody},
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;

use crate::{
    http::{
        AppState,
        contracts::typed::system::{
            EnvironmentPatch, ExperimentsResponse, TelemetryNoticeBody, TelemetryResponse,
        },
        session,
        validation::Valid,
    },
    identity::auth::AuthUser,
    platform::{
        PlatformError,
        backup::{BackupFailure, BackupService},
        database::SuplexDatabase,
        development,
        environment_settings::{self, EnvironmentSettings, js_number},
        factory_reset,
    },
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/environment",
            get(read_environment).patch(update_environment),
        )
        .route("/api/experiments", get(read_experiments))
        .route("/api/telemetry", get(read_telemetry))
        .route("/api/admin/telemetry/notice", post(acknowledge_telemetry))
        .route("/api/admin/backups", get(list_backups).post(create_backup))
        .route("/api/admin/backups/restore", post(restore_backup))
        .route("/api/admin/backups/{name}", get(download_backup))
        .route("/api/admin/factory-reset", post(reset))
        .route("/api/admin/providers", get(providers))
        .route("/api/admin/models", get(models))
        .route("/api/models", get(models))
}

/// `GET /api/admin/providers`: one row per agent tool on this host.
async fn providers(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match administrator(&state, &headers, &Method::GET, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let directory = std::env::current_dir().unwrap_or_default();
    let observed =
        crate::profiles::provider_catalog::read_providers(&directory.to_string_lossy(), true).await;
    finish(private(Json(observed).into_response()), cookies)
}

/// `GET /api/admin/models` and `GET /api/models`: provider models for any signed-in user.
async fn models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match super::profiles::authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let directory = std::env::current_dir().unwrap_or_default();
    let providers =
        crate::profiles::provider_catalog::read_providers(&directory.to_string_lossy(), false)
            .await;
    let response = Json(crate::profiles::provider_catalog::list_models(&providers)).into_response();
    finish(response, cookies)
}

type Rejection = Box<Response>;

/// Session, origin and administrator checks in the order the TypeScript
/// authenticated plugin and `requireAdmin` apply them.
pub(crate) fn administrator(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
    message: &str,
) -> Result<(AuthUser, Vec<String>), Rejection> {
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(|error| Box::new(ApiError::response(error)))?;
    let Some(user) = session.user else {
        return Err(Box::new(auth::error(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        )));
    };
    if user.role != "admin" {
        let mut response = auth::error(StatusCode::FORBIDDEN, message);
        auth::append_cookies(&mut response, session.set_cookies);
        return Err(Box::new(response));
    }
    Ok((user, session.set_cookies))
}

const ADMIN_REQUIRED: &str = "Administrator access required";

fn finish(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

fn private(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    response
}

fn internal() -> Response {
    auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

pub(crate) fn record_audit(
    database: &SuplexDatabase,
    actor_user_id: Option<&str>,
    action: &str,
    metadata: Value,
) -> Result<(), Box<dyn std::error::Error>> {
    crate::identity::audit::record(
        database,
        &crate::identity::audit::AuditEvent {
            id: &crate::shared::ids::random_hex_id("audit")?,
            actor_user_id,
            actor_agent_id: None,
            action,
            target_user_id: None,
            company_id: None,
            metadata_json: &metadata.to_string(),
            created_at: &now_millis_rfc3339(),
        },
    )?;
    Ok(())
}

async fn read_environment(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match administrator(&state, &headers, &Method::GET, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| environment_settings::read(database)) {
        Ok(settings) => private(Json(settings.to_json()).into_response()),
        Err(_) => internal(),
    };
    finish(response, cookies)
}

async fn read_experiments(
    State(state): State<AppState>,
    _user: crate::http::access::SessionUser,
) -> Response {
    match state.with_database(|database| environment_settings::read(database)) {
        Ok(settings) => private(
            Json(ExperimentsResponse {
                today_page: settings.today_page_enabled,
                host_terminal: settings.host_terminal_enabled,
            })
            .into_response(),
        ),
        Err(_) => internal(),
    }
}

/// Whether this build and environment send telemetry at all.
fn telemetry_configured(state: &AppState) -> bool {
    state.installation.as_ref().is_some_and(|installation| {
        crate::telemetry::config(&installation.installation_id).is_some()
    })
}

/// `GET /api/telemetry`: whether this user must see the telemetry notice.
async fn read_telemetry(
    State(state): State<AppState>,
    crate::http::access::SessionUser(user): crate::http::access::SessionUser,
) -> Response {
    let configured = telemetry_configured(&state);
    let required = user.role == "admin"
        && state
            .with_database(|database| crate::telemetry::notice_required(database, configured))
            .unwrap_or(false);
    private(
        Json(TelemetryResponse {
            notice_required: required,
        })
        .into_response(),
    )
}

/// `POST /api/admin/telemetry/notice`: an administrator saw the notice, with
/// an optional email.
async fn acknowledge_telemetry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(body): Valid<TelemetryNoticeBody>,
) -> Response {
    let (_, cookies) = match administrator(&state, &headers, &Method::POST, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        crate::telemetry::acknowledge(database, body.email.as_deref(), Utc::now())
    });
    let response = match result {
        Ok(()) => private(StatusCode::NO_CONTENT.into_response()),
        Err(_) => internal(),
    };
    finish(response, cookies)
}

async fn update_environment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(patch): Valid<EnvironmentPatch>,
) -> Response {
    let (user, cookies) = match administrator(&state, &headers, &Method::PATCH, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        let previous = environment_settings::read(database)?;
        let updated = environment_settings::update(
            database,
            EnvironmentSettings {
                min_free_disk_gb: patch.min_free_disk_gb.unwrap_or(previous.min_free_disk_gb),
                default_budget_usd: patch
                    .default_budget_usd
                    .unwrap_or(previous.default_budget_usd),
                default_max_turns: patch
                    .default_max_turns
                    .unwrap_or(previous.default_max_turns),
                today_page_enabled: patch
                    .today_page_enabled
                    .unwrap_or(previous.today_page_enabled),
                host_terminal_enabled: patch
                    .host_terminal_enabled
                    .unwrap_or(previous.host_terminal_enabled),
                git2_enabled: patch.git2_enabled.unwrap_or(previous.git2_enabled),
                telemetry_enabled: patch
                    .telemetry_enabled
                    .unwrap_or(previous.telemetry_enabled),
            },
        )?;
        record_audit(
            database,
            Some(&user.id),
            "environment_settings_updated",
            json!({
                "previousMinFreeDiskGb": js_number(previous.min_free_disk_gb).to_string(),
                "minFreeDiskGb": js_number(updated.min_free_disk_gb).to_string(),
                "previousDefaultBudgetUsd": js_number(previous.default_budget_usd).to_string(),
                "defaultBudgetUsd": js_number(updated.default_budget_usd).to_string(),
                "previousDefaultMaxTurns": previous.default_max_turns.to_string(),
                "defaultMaxTurns": updated.default_max_turns.to_string(),
                "previousTodayPageEnabled": previous.today_page_enabled.to_string(),
                "todayPageEnabled": updated.today_page_enabled.to_string(),
                "previousHostTerminalEnabled": previous.host_terminal_enabled.to_string(),
                "hostTerminalEnabled": updated.host_terminal_enabled.to_string(),
                "previousGit2Enabled": previous.git2_enabled.to_string(),
                "git2Enabled": updated.git2_enabled.to_string(),
                "previousTelemetryEnabled": previous.telemetry_enabled.to_string(),
                "telemetryEnabled": updated.telemetry_enabled.to_string(),
            }),
        )?;
        Ok::<_, Box<dyn std::error::Error>>(updated)
    });
    if let Ok(settings) = &result {
        crate::projects::git::set_libgit2_transport(settings.git2_enabled);
    }
    let response = match result {
        Ok(settings) => private(Json(settings.to_json()).into_response()),
        Err(_) => internal(),
    };
    finish(response, cookies)
}

/// The restored or reset database can hold a different experiment setting.
fn refresh_git_transport(state: &AppState) {
    if let Ok(settings) = state.with_database(|database| environment_settings::read(database)) {
        crate::projects::git::set_libgit2_transport(settings.git2_enabled);
    }
}

/// The backup service for this installation.
fn backups(state: &AppState) -> Option<BackupService> {
    let database_path = state.with_database(|database| {
        database
            .connection()
            .path()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
    })?;
    let data_root = database_path.parent()?.to_path_buf();
    let artifact_root = state.artifact_root.clone()?;
    let installation = state.installation.as_ref();
    let installation_id = installation
        .map(|value| value.installation_id.clone())
        .unwrap_or_else(|| crate::cli::installation_id(&database_path));
    let mut configuration = Map::new();
    configuration.insert(
        "accessMode".into(),
        json!(
            installation
                .map(|value| value.access_mode.as_str())
                .unwrap_or("local")
        ),
    );
    configuration.insert(
        "tailscaleExposure".into(),
        json!(state.session_config.tailscale_exposure),
    );
    configuration.insert(
        "bindAddress".into(),
        json!(
            installation
                .map(|value| value.bind_address.as_str())
                .unwrap_or("127.0.0.1")
        ),
    );
    configuration.insert(
        "reachableAddress".into(),
        json!(state.session_config.reachable_address),
    );
    configuration.insert("port".into(), json!(state.session_config.port));
    configuration.insert("dataRoot".into(), json!(data_root));
    configuration.insert("databasePath".into(), json!(database_path));
    configuration.insert("artifactRoot".into(), json!(artifact_root));
    configuration.insert(
        "runtimeRoot".into(),
        json!(
            installation
                .map(|value| value.runtime.clone())
                .unwrap_or_else(|| data_root.join("runtime"))
        ),
    );
    if let Some(roots) = &state.project_roots {
        configuration.insert("repositoryRoot".into(), json!(roots.repositories));
        configuration.insert("worktreeRoot".into(), json!(roots.worktrees));
    }
    configuration.insert("installationId".into(), json!(installation_id));
    Some(BackupService {
        data_root,
        database_path,
        artifact_root,
        configuration,
    })
}

async fn list_backups(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match administrator(&state, &headers, &Method::GET, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match backups(&state).map(|service| service.list()) {
        Some(Ok(backups)) => private(Json(json!({ "backups": backups })).into_response()),
        _ => internal(),
    };
    finish(response, cookies)
}

async fn create_backup(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user, cookies) = match administrator(&state, &headers, &Method::POST, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(service) = backups(&state) else {
        return finish(private(internal()), cookies);
    };
    let created = tokio::task::spawn_blocking(move || service.create_in_library(Utc::now())).await;
    let response = match created {
        Ok(Ok(backup)) => {
            let audit = state.with_database(|database| {
                record_audit(
                    database,
                    Some(&user.id),
                    "backup_created",
                    json!({"name": backup.name, "bytes": backup.bytes.to_string()}),
                )
            });
            match audit {
                Ok(()) => Json(backup).into_response(),
                Err(_) => internal(),
            }
        }
        Ok(Err(error)) if matches!(error.downcast_ref(), Some(BackupFailure::Exists)) => {
            auth::error(
                StatusCode::CONFLICT,
                "A backup is already being created. Try again in a moment.",
            )
        }
        _ => internal(),
    };
    finish(private(response), cookies)
}

async fn download_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let (_, cookies) = match administrator(&state, &headers, &Method::GET, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(service) = backups(&state) else {
        return finish(internal(), cookies);
    };
    let not_found = || auth::error(StatusCode::NOT_FOUND, "Backup not found");
    let Some(path) = service.path_of(&name) else {
        return finish(not_found(), cookies);
    };
    let Ok(file) = tokio::fs::File::open(&path).await else {
        return finish(not_found(), cookies);
    };
    let response = (
        [
            (header::CONTENT_TYPE, "application/gzip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response();
    finish(private(response), cookies)
}

async fn restore_backup(State(state): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let (user, cookies) = match administrator(&state, &headers, &Method::POST, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(service) = backups(&state) else {
        return finish(internal(), cookies);
    };
    let staging = std::env::temp_dir().join(format!(
        "suplex-backup-upload-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
        tokio::fs::create_dir_all(&staging).await?;
        // Backups can be hundreds of megabytes, so the archive streams to disk instead of through the body limit.
        let archive = staging.join("upload.tar.gz");
        let mut file = tokio::fs::File::create(&archive).await?;
        let mut body = body;
        while let Some(frame) =
            std::future::poll_fn(|context| std::pin::Pin::new(&mut body).poll_frame(context)).await
        {
            if let Ok(chunk) = frame?.into_data() {
                file.write_all(&chunk).await?;
            }
        }
        file.flush().await?;
        drop(file);
        tokio::task::spawn_blocking(move || service.restore_in_place(&archive)).await??;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    let response = match result {
        Ok(()) => {
            refresh_git_transport(&state);
            // The restored users can hold this username under another id, so the event names the user instead of referencing it.
            match state.with_database(|database| {
                record_audit(
                    database,
                    None,
                    "backup_restored",
                    json!({"username": user.username}),
                )
            }) {
                Ok(()) => StatusCode::NO_CONTENT.into_response(),
                Err(_) => internal(),
            }
        }
        Err(error) if error.downcast_ref::<BackupFailure>().is_some() => auth::error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The file is not a valid Suplex backup.",
        ),
        Err(_) => internal(),
    };
    finish(response, cookies)
}

async fn reset(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match administrator(&state, &headers, &Method::POST, ADMIN_REQUIRED) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(artifact_root) = state.artifact_root.clone() else {
        return finish(internal(), cookies);
    };
    let result = state.with_database(|database| {
        let path = database
            .connection()
            .path()
            .map(PathBuf::from)
            .ok_or("Database is unavailable")?;
        factory_reset::factory_reset(database, &path, &artifact_root)?;
        // Same seed as a first start, so the next page load signs in and opens onboarding.
        development::seed_development_data(database, Utc::now())
    });
    let response = match result {
        Ok(()) => {
            refresh_git_transport(&state);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error)
            if matches!(
                error.downcast_ref(),
                Some(PlatformError::LiveSessionsBlockReset)
            ) =>
        {
            auth::error(
                StatusCode::CONFLICT,
                factory_reset::LIVE_SESSIONS_BLOCK_RESET,
            )
        }
        Err(_) => internal(),
    };
    finish(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/admin_platform.rs");
