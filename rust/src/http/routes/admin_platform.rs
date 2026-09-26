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
    database.connection().execute(
        "INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, ?2, NULL, ?3, NULL, NULL, ?4, ?5)",
        rusqlite::params![
            crate::shared::ids::random_hex_id("audit")?,
            actor_user_id,
            action,
            metadata.to_string(),
            now_millis_rfc3339()
        ],
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
mod tests {
    use super::*;
    use crate::{
        http::session::SessionConfig,
        platform::database::{OpenMode, SuplexDatabase},
    };

    struct Fixture {
        root: PathBuf,
        state: AppState,
        address: std::net::SocketAddr,
        server: tokio::task::JoinHandle<()>,
        cookie: std::sync::Mutex<Option<String>>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    async fn fixture() -> Fixture {
        let root =
            std::env::temp_dir().join(format!("suplex-admin-platform-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let database =
            SuplexDatabase::open(&data.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".into(),
                tailscale_exposure: "off".into(),
            },
        )
        .with_artifact_root(data.join("artifacts"))
        .with_project_roots(root.join("repositories"), root.join("worktrees"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = crate::http::router(state.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Fixture {
            root,
            state,
            address,
            server,
            cookie: Default::default(),
        }
    }

    impl Fixture {
        async fn call(
            &self,
            method: &str,
            uri: &str,
            content_type: Option<&str>,
            body: Vec<u8>,
        ) -> (StatusCode, HeaderMap, Vec<u8>) {
            let mut request = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap()
                .request(
                    method.parse().unwrap(),
                    format!("http://{}{uri}", self.address),
                )
                .header(header::HOST, "127.0.0.1:4113")
                .header(header::ORIGIN, "http://127.0.0.1:4113")
                .body(body);
            if let Some(content_type) = content_type {
                request = request.header(header::CONTENT_TYPE, content_type);
            }
            let cookie = self.cookie.lock().unwrap().clone();
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie);
            }
            let response = request.send().await.unwrap();
            if let Some(session) = response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .find_map(|value| {
                    value
                        .to_str()
                        .ok()
                        .filter(|value| value.starts_with("sid_v1="))
                })
            {
                *self.cookie.lock().unwrap() = session.split(';').next().map(str::to_owned);
            }
            let status = response.status();
            let headers = response.headers().clone();
            (status, headers, response.bytes().await.unwrap().to_vec())
        }
    }

    fn json_body(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    #[tokio::test]
    async fn environment_settings_default_and_persist_partial_administrator_updates() {
        let fixture = fixture().await;
        let state = &fixture.state;
        let (status, headers, body) = fixture
            .call("GET", "/api/admin/environment", None, vec![])
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
        assert_eq!(
            json_body(&body),
            json!({"minFreeDiskGb":5,"defaultBudgetUsd":15,"defaultMaxTurns":40})
        );
        let patch = |body: &str| {
            fixture.call(
                "PATCH",
                "/api/admin/environment",
                Some("application/json"),
                body.as_bytes().to_vec(),
            )
        };
        assert_eq!(
            json_body(&patch(r#"{"minFreeDiskGb":7.5}"#).await.2),
            json!({"minFreeDiskGb":7.5,"defaultBudgetUsd":15,"defaultMaxTurns":40})
        );
        assert_eq!(
            json_body(
                &patch(r#"{"defaultBudgetUsd":20,"defaultMaxTurns":30}"#)
                    .await
                    .2
            ),
            json!({"minFreeDiskGb":7.5,"defaultBudgetUsd":20,"defaultMaxTurns":30})
        );
        assert_eq!(
            json_body(
                &fixture
                    .call("GET", "/api/admin/environment", None, vec![])
                    .await
                    .2
            ),
            json!({"minFreeDiskGb":7.5,"defaultBudgetUsd":20,"defaultMaxTurns":30})
        );
        for invalid in [
            r#"{"defaultBudgetUsd":-1}"#,
            r#"{}"#,
            r#"{"other":1}"#,
            r#"{"defaultMaxTurns":1.5}"#,
            r#"{"minFreeDiskGb":2000}"#,
        ] {
            assert_eq!(patch(invalid).await.0, StatusCode::BAD_REQUEST, "{invalid}");
        }
        let audit: String = state.with_database(|database| database.connection().query_row("SELECT metadata_json FROM suplex_audit_events WHERE action = 'environment_settings_updated' ORDER BY created_at LIMIT 1", [], |row| row.get(0))).unwrap();
        assert_eq!(json_body(audit.as_bytes())["minFreeDiskGb"], "7.5");
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_users SET role = 'member'", [])
                .unwrap()
        });
        assert_eq!(
            fixture
                .call("GET", "/api/admin/environment", None, vec![])
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn administrators_create_list_download_and_restore_backups() {
        let fixture = fixture().await;
        assert_eq!(
            json_body(
                &fixture
                    .call("GET", "/api/admin/backups", None, vec![])
                    .await
                    .2
            ),
            json!({"backups":[]})
        );
        let (status, _, body) = fixture
            .call("POST", "/api/admin/backups", None, vec![])
            .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let name = json_body(&body)["name"].as_str().unwrap().to_owned();
        assert!(
            regex::Regex::new(r"^suplex-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.tar\.gz$")
                .unwrap()
                .is_match(&name)
        );
        let listed = json_body(
            &fixture
                .call("GET", "/api/admin/backups", None, vec![])
                .await
                .2,
        );
        assert_eq!(listed["backups"][0]["name"], name.as_str());
        let (status, headers, archive) = fixture
            .call("GET", &format!("/api/admin/backups/{name}"), None, vec![])
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers[header::CONTENT_DISPOSITION],
            format!("attachment; filename=\"{name}\"").as_str()
        );

        let before = json_body(
            &fixture
                .call("GET", "/api/admin/environment", None, vec![])
                .await
                .2,
        );
        fixture
            .call(
                "PATCH",
                "/api/admin/environment",
                Some("application/json"),
                br#"{"defaultMaxTurns":47}"#.to_vec(),
            )
            .await;
        let (status, _, body) = fixture
            .call(
                "POST",
                "/api/admin/backups/restore",
                Some("application/gzip"),
                archive,
            )
            .await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "{}",
            String::from_utf8_lossy(&body)
        );
        // The same session still works, and the live connection reads the restored data.
        assert_eq!(
            json_body(
                &fixture
                    .call("GET", "/api/admin/environment", None, vec![])
                    .await
                    .2
            ),
            before
        );
        let (status, _, body) = fixture
            .call(
                "POST",
                "/api/admin/backups/restore",
                Some("application/gzip"),
                b"not a backup".to_vec(),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            json_body(&body),
            json!({"error":"The file is not a valid Suplex backup."})
        );
        assert_eq!(
            fixture
                .call("GET", "/api/admin/backups/..%2Fsuplex.sqlite", None, vec![])
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            fixture
                .call(
                    "GET",
                    "/api/admin/backups/suplex-backup-2000-01-01T00-00-00Z.tar.gz",
                    None,
                    vec![]
                )
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn factory_reset_waits_for_live_sessions_then_restores_a_first_start_database() {
        let fixture = fixture().await;
        let state = &fixture.state;
        // A signed-in request creates the Operator; the task below keeps a session live.
        fixture
            .call("GET", "/api/admin/environment", None, vec![])
            .await;
        state.with_database(|database| {
            development::seed_development_data(database, Utc::now()).unwrap();
            let connection = database.connection();
            let company: String = connection.query_row("SELECT id FROM suplex_companies", [], |row| row.get(0)).unwrap();
            connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('reset_project',?1,'Project','/tmp/repo','/tmp/worktrees',NULL,'main','','','root','worker','{}','2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z')", [&company]).unwrap();
            // A minimal active control row: every required column gets a placeholder.
            connection.execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON").unwrap();
            let required: Vec<String> = connection.prepare("SELECT name FROM pragma_table_info('suplex_task_controls') WHERE \"notnull\" = 1 AND dflt_value IS NULL AND name NOT IN ('task_id', 'status')").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
            connection.execute(&format!("INSERT INTO suplex_task_controls (task_id, status{}) VALUES ('task_live', 'active'{})", required.iter().map(|name| format!(", {name}")).collect::<String>(), ", '{}'".repeat(required.len())), []).unwrap();
            connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = OFF").unwrap();
        });
        let (status, _, body) = fixture
            .call("POST", "/api/admin/factory-reset", None, vec![])
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            json_body(&body)["error"],
            factory_reset::LIVE_SESSIONS_BLOCK_RESET
        );
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_task_controls SET status = 'cancelled'", [])
                .unwrap()
        });
        let artifacts = fixture.root.join("data/artifacts/company");
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join("attachment.png"), "artifact").unwrap();
        std::fs::create_dir_all(fixture.root.join("data/provider-instances/claude-home")).unwrap();
        let worktree = fixture.root.join("worktrees/external-work");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join("keep.txt"), "uncommitted work").unwrap();
        let (status, _, body) = fixture
            .call("POST", "/api/admin/factory-reset", None, vec![])
            .await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "{}",
            String::from_utf8_lossy(&body)
        );
        state.with_database(|database| {
            // Local mode seeds the Operator and a first company again, so only their rows remain.
            for table in ["suplex_tasks", "suplex_projects", "suplex_sessions"] {
                let count: i64 = database
                    .connection()
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0, "{table}");
            }
            let companies: Vec<String> = database
                .connection()
                .prepare("SELECT name FROM suplex_companies")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(companies, ["My Company"]);
        });
        assert_eq!(
            std::fs::read_dir(fixture.root.join("data/artifacts"))
                .unwrap()
                .count(),
            0
        );
        assert!(!fixture.root.join("data/provider-instances").exists());
        assert_eq!(
            std::fs::read_to_string(worktree.join("keep.txt")).unwrap(),
            "uncommitted work"
        );
        let (status, headers, _) = fixture.call("GET", "/", None, vec![]).await;
        assert_eq!(status, StatusCode::FOUND);
        assert_eq!(headers[header::LOCATION], "/onboarding");
    }
}
