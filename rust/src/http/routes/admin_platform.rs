//! Environment, backup and factory reset routes from `http/routes/administration.ts`.

use crate::http::error::ApiError;
use crate::shared::time::now_millis_rfc3339;
use std::path::PathBuf;

use axum::{
    Json, Router,
    body::{Body, Bytes, HttpBody},
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;

use crate::{
    http::{AppState, contracts::typed::finding, session, validation},
    identity::auth::AuthUser,
    platform::{
        PlatformError,
        backup::{BackupFailure, BackupService},
        database::SuplexDatabase,
        development,
        environment_settings::{self, EnvironmentSettings, MAX_MIN_FREE_DISK_GB, js_number},
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
        &crate::shared::ids::random_hex_id("audit")?,
        (actor_user_id, None),
        action,
        None,
        None,
        &metadata.to_string(),
        &now_millis_rfc3339(),
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

struct EnvironmentPatch {
    min_free_disk_gb: Option<f64>,
    default_budget_usd: Option<f64>,
    default_max_turns: Option<i64>,
}

/// `EnvironmentSettingsBodySchema`: optional bounded numbers and at least one
/// known field. Unknown fields are stripped, as Zod does for a plain object.
fn environment_patch(input: Option<&Value>) -> Result<EnvironmentPatch, Vec<Value>> {
    let Some(Value::Object(fields)) = input else {
        return Err(vec![finding("invalid_type", &[])]);
    };
    let mut issues = Vec::new();
    let mut number = |name: &str, maximum: Option<f64>, integer: bool| -> Option<f64> {
        let value = fields.get(name)?;
        let Some(number) = value.as_f64() else {
            issues.push(finding("invalid_type", &[json!(name)]));
            return None;
        };
        if integer && number.fract() != 0.0 {
            issues.push(finding("invalid_type", &[json!(name)]));
            return None;
        }
        if number < 0.0 {
            issues.push(finding("too_small", &[json!(name)]));
            return None;
        }
        if maximum.is_some_and(|maximum| number > maximum) {
            issues.push(finding("too_big", &[json!(name)]));
            return None;
        }
        Some(number)
    };
    let patch = EnvironmentPatch {
        min_free_disk_gb: number("minFreeDiskGb", Some(MAX_MIN_FREE_DISK_GB), false),
        default_budget_usd: number("defaultBudgetUsd", None, false),
        default_max_turns: number("defaultMaxTurns", None, true).map(|value| value as i64),
    };
    if !issues.is_empty() {
        return Err(issues);
    }
    if patch.min_free_disk_gb.is_none()
        && patch.default_budget_usd.is_none()
        && patch.default_max_turns.is_none()
    {
        return Err(vec![finding("custom", &[])]);
    }
    Ok(patch)
}

async fn update_environment(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let patch =
        match auth::parsed_body(&headers, &body).map(|value| environment_patch(value.as_ref())) {
            Ok(Ok(patch)) => patch,
            Ok(Err(findings)) => return validation::validation_error_public(findings),
            Err(response) => return *response,
        };
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
            }),
        )?;
        Ok::<_, Box<dyn std::error::Error>>(updated)
    });
    let response = match result {
        Ok(settings) => private(Json(settings.to_json()).into_response()),
        Err(_) => internal(),
    };
    finish(response, cookies)
}

/// The backup service for this installation. The Rust binary has no
/// `SuplexConfig`, so the configuration record comes from its live paths.
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
    let installation_id = crate::cli::installation_id(&database_path);
    let mut configuration = Map::new();
    configuration.insert("accessMode".into(), json!("local"));
    configuration.insert(
        "tailscaleExposure".into(),
        json!(state.session_config.tailscale_exposure),
    );
    configuration.insert("bindAddress".into(), json!("127.0.0.1"));
    configuration.insert(
        "reachableAddress".into(),
        json!(state.session_config.reachable_address),
    );
    configuration.insert("port".into(), json!(state.session_config.port));
    configuration.insert("dataRoot".into(), json!(data_root));
    configuration.insert("databasePath".into(), json!(database_path));
    configuration.insert("artifactRoot".into(), json!(artifact_root));
    configuration.insert("runtimeRoot".into(), json!(data_root.join("runtime")));
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
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
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
