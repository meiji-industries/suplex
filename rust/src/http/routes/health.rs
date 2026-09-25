//! Host health uses the installation's live resources. Contextual provider
//! selection is authorized even while provider-specific probes are unported.

use std::{ffi::CString, fs::OpenOptions, os::unix::ffi::OsStrExt, path::Path};

use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use garde::Validate;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    http::{AppState, contracts::typed::finding, session, validation},
    identity::auth::AuthUser,
    integrations::github,
    platform::database::{DatabaseHealth, SchemaState, SuplexDatabase},
    profiles::agent_profiles,
    projects::service as projects,
};

use super::auth;

const MINIMUM_ARTIFACT_FREE_BYTES: u64 = 100 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

#[derive(Default, Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
struct HealthQuery {
    #[garde(inner(length(min = 1)))]
    project_id: Option<String>,
    #[garde(inner(length(min = 1)))]
    profile_ids: Option<String>,
    #[serde(flatten)]
    #[garde(skip)]
    unknown: serde_json::Map<String, Value>,
}

fn query(raw: Option<&str>) -> Result<HealthQuery, Box<Response>> {
    let mut values = serde_json::Map::new();
    let mut duplicate_project = false;
    let mut duplicate_profiles = false;
    for (name, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        match values.entry(name.into_owned()) {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(Value::String(value.into_owned()));
            }
            serde_json::map::Entry::Occupied(entry) => match entry.key().as_str() {
                "projectId" => duplicate_project = true,
                "profileIds" => duplicate_profiles = true,
                _ => (),
            },
        }
    }
    if duplicate_project {
        values.remove("projectId");
    }
    if duplicate_profiles {
        values.remove("profileIds");
    }
    let parsed: HealthQuery = serde_json::from_value(Value::Object(values)).map_err(|_| {
        Box::new(validation::validation_error_public(vec![finding(
            "invalid_type",
            &[],
        )]))
    })?;
    let mut findings = Vec::new();
    if duplicate_project {
        findings.push(finding("invalid_type", &[json!("projectId")]));
    }
    if duplicate_profiles {
        findings.push(finding("invalid_type", &[json!("profileIds")]));
    }
    if let Err(report) = parsed.validate() {
        for (path, _) in report.iter() {
            let field = match path.to_string().as_str() {
                "project_id" | ".project_id" => "projectId",
                "profile_ids" | ".profile_ids" => "profileIds",
                _ => continue,
            };
            findings.push(finding("too_small", &[json!(field)]));
        }
    }
    if !parsed.unknown.is_empty() {
        findings.push(finding("unrecognized_keys", &[]));
    }
    if !findings.is_empty() {
        return Err(Box::new(validation::validation_error_public(findings)));
    }
    Ok(parsed)
}

fn provider_context(
    database: &SuplexDatabase,
    user: &AuthUser,
    query: &HealthQuery,
) -> Result<Vec<String>, Box<Response>> {
    if query.project_id.is_none() && query.profile_ids.is_none() {
        return Ok(Vec::new());
    }
    if query.project_id.is_some() && query.profile_ids.is_some() {
        return Err(Box::new(auth::error(
            StatusCode::BAD_REQUEST,
            "Select one provider context",
        )));
    }
    let profiles = agent_profiles::list(database, &user.id, true)
        .map_err(auth::service_error)
        .map_err(Box::new)?;
    let requested = if let Some(project_id) = &query.project_id {
        let project = projects::get(database, &user.id, project_id).map_err(|error| {
            if let Some(failure) = error.downcast_ref::<projects::ProjectFailure>() {
                Box::new(auth::error(
                    StatusCode::from_u16(failure.status_code)
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    failure.message,
                ))
            } else {
                Box::new(auth::service_error(error))
            }
        })?;
        [project.root_profile_id, project.worker_profile_id].to_vec()
    } else {
        let mut ids = Vec::new();
        for id in query.profile_ids.as_deref().unwrap_or_default().split(',') {
            let id = id.trim();
            if !id.is_empty() && !ids.iter().any(|saved| saved == id) {
                ids.push(id.to_owned());
            }
        }
        ids
    };
    let mut providers = Vec::new();
    for id in requested {
        let Some(profile) = profiles.iter().find(|profile| profile.id == id) else {
            if query.profile_ids.is_some() {
                return Err(Box::new(auth::error(StatusCode::NOT_FOUND, "Not found")));
            }
            continue;
        };
        if ["opencode", "claude-code", "codex"].contains(&profile.provider.as_str())
            && !providers.contains(&profile.provider)
        {
            providers.push(profile.provider.clone());
        }
    }
    Ok(providers)
}

fn check(id: &str, label: &str, status: &str, summary: &str, details: Value) -> Value {
    json!({"id":id,"label":label,"status":status,"summary":summary,"details":details})
}

fn database_check(health: DatabaseHealth) -> Value {
    let current = health.schema_state == SchemaState::Current;
    let usable = health.wal_mode && health.readable && health.writable;
    let status = if current && usable {
        "healthy"
    } else if health.schema_state == SchemaState::Ahead && usable {
        "warning"
    } else {
        "unhealthy"
    };
    let summary = match status {
        "healthy" => "Schema is current and WAL is enabled".to_owned(),
        "warning" => "The database has migrations this build does not know about".to_owned(),
        _ if current && !health.wal_mode => "Schema is current but WAL is disabled".to_owned(),
        _ => format!(
            "Schema state is {}",
            format!("{:?}", health.schema_state).to_lowercase()
        ),
    };
    check(
        "database",
        "SQLite database",
        status,
        &summary,
        json!({
            "schemaState":format!("{:?}", health.schema_state).to_lowercase(),
            "expectedMigrations":health.expected_migrations,
            "appliedMigrations":health.applied_migrations,
            "walMode":health.wal_mode,
        }),
    )
}

fn filesystem_bytes(path: &Path) -> Option<(u64, u64)> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut result = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), result.as_mut_ptr()) } != 0 {
        return None;
    }
    let result = unsafe { result.assume_init() };
    let unit = result.f_frsize;
    Some((
        (result.f_bavail as u64).saturating_mul(unit),
        (result.f_blocks as u64).saturating_mul(unit),
    ))
}

fn artifact_check(path: Option<&Path>) -> Value {
    let Some(path) = path else {
        return check(
            "artifact-root",
            "Artifact root",
            "unhealthy",
            "Artifact storage is not configured",
            json!({"writable":false,"readable":false}),
        );
    };
    let result = (|| {
        std::fs::create_dir_all(path).ok()?;
        let probe = path.join(format!(
            ".suplex-health-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .ok()?;
        let written = std::io::Write::write_all(&mut file, b"ok").is_ok();
        drop(file);
        let removed = std::fs::remove_file(&probe).is_ok();
        (written && removed)
            .then(|| filesystem_bytes(path))
            .flatten()
    })();
    match result {
        Some((free, _)) => check(
            "artifact-root",
            "Artifact root",
            if free >= MINIMUM_ARTIFACT_FREE_BYTES {
                "healthy"
            } else {
                "unhealthy"
            },
            if free >= MINIMUM_ARTIFACT_FREE_BYTES {
                "Artifact storage is writable with sufficient space"
            } else {
                "Artifact storage is low on space"
            },
            json!({"writable":true,"readable":true,"freeBytes":free}),
        ),
        None => check(
            "artifact-root",
            "Artifact root",
            "unhealthy",
            "Artifact storage is not writable or cannot be inspected",
            json!({"writable":false,"readable":false}),
        ),
    }
}

fn disk_check(worktree: Option<&Path>, artifact: Option<&Path>, minimum_gb: Option<f64>) -> Value {
    let Some(((worktree_free, worktree_total), (artifact_free, artifact_total))) = worktree
        .and_then(filesystem_bytes)
        .zip(artifact.and_then(filesystem_bytes))
    else {
        return check(
            "disk-space",
            "Disk space",
            "warning",
            "Free disk space could not be read",
            json!({}),
        );
    };
    let Some(minimum_gb) = minimum_gb else {
        return check(
            "disk-space",
            "Disk space",
            "warning",
            "Free disk space was measured, but the minimum could not be read",
            json!({"freeBytes":worktree_free.min(artifact_free)}),
        );
    };
    let minimum = minimum_gb * (1024_u64.pow(3) as f64);
    let low =
        minimum > 0.0 && ((worktree_free as f64) < minimum || (artifact_free as f64) < minimum);
    check(
        "disk-space",
        "Disk space",
        if low { "warning" } else { "healthy" },
        if low {
            "Free disk space is below the configured minimum"
        } else {
            "Free disk space meets the configured minimum"
        },
        json!({
            "freeBytes":worktree_free.min(artifact_free),"minFreeBytes":minimum,
            "worktreeRoot":worktree.unwrap().display().to_string(),"worktreeFreeBytes":worktree_free,"worktreeTotalBytes":worktree_total,
            "artifactRoot":artifact.unwrap().display().to_string(),"artifactFreeBytes":artifact_free,"artifactTotalBytes":artifact_total,
        }),
    )
}

fn git_check() -> Value {
    let (major, minor, patch) = git2::Version::get().libgit2_version();
    check(
        "git",
        "Git",
        "healthy",
        "libgit2 is available for source control",
        json!({"version":format!("libgit2 {major}.{minor}.{patch}"),"engine":"libgit2"}),
    )
}

async fn github_check() -> Value {
    match github::Access::load().await {
        Ok(access) if access.token().is_some() => match access.current_user_login().await {
            Ok(login) => check(
                "gh-auth",
                "GitHub",
                "healthy",
                "GitHub is connected",
                json!({"method":"device","source":access.source().as_str(),"status":"connected","logins":login}),
            ),
            Err(error) if matches!(error.downcast_ref::<octocrab::Error>(), Some(octocrab::Error::GitHub { source, .. }) if source.status_code.as_u16() == 401) => {
                check(
                    "gh-auth",
                    "GitHub",
                    "warning",
                    "Sign in to GitHub to use branches and pull requests",
                    json!({"method":"device","source":access.source().as_str(),"status":"sign_in_required"}),
                )
            }
            Err(_) => check(
                "gh-auth",
                "GitHub",
                "warning",
                "GitHub could not confirm the account",
                json!({"method":"device","source":access.source().as_str(),"status":"unavailable"}),
            ),
        },
        Ok(_) => check(
            "gh-auth",
            "GitHub",
            "warning",
            "Sign in to GitHub to use branches and pull requests",
            json!({"method":"device","source":"none","status":"sign_in_required"}),
        ),
        Err(_) => check(
            "gh-auth",
            "GitHub",
            "warning",
            "GitHub authentication is not available",
            json!({"method":"device","source":"none","status":"unavailable"}),
        ),
    }
}

async fn health(
    State(state): State<AppState>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> Response {
    health_with_github(state, raw_query, headers, None).await
}

async fn health_with_github(
    state: AppState,
    raw_query: Option<String>,
    headers: HeaderMap,
    github_override: Option<Value>,
) -> Response {
    let query = match query(raw_query.as_deref()) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return auth::service_error(error),
    };
    let Some(user) = session.user else {
        return auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    let (providers, database, minimum_gb) =
        match state.with_database(|database| {
            provider_context(database, &user, &query).map(|providers| {
                let minimum_gb = database.connection().query_row(
                "SELECT min_free_disk_gb FROM suplex_environment_settings WHERE id = 'host'",
                [],
                |row| row.get::<_, f64>(0),
            ).optional().ok().map(|value| value.unwrap_or(5.0));
                (providers, database.health(), minimum_gb)
            })
        }) {
            Ok(value) => value,
            Err(mut response) => {
                auth::append_cookies(&mut response, session.set_cookies);
                return *response;
            }
        };
    let artifact_root = state.artifact_root.clone();
    let worktree_root = state
        .project_roots
        .as_ref()
        .map(|roots| roots.worktrees.clone());
    let (artifact, disk) = tokio::task::spawn_blocking(move || {
        (
            artifact_check(artifact_root.as_deref()),
            disk_check(
                worktree_root.as_deref(),
                artifact_root.as_deref(),
                minimum_gb,
            ),
        )
    })
    .await
    .unwrap_or_else(|_| {
        (
            check(
                "artifact-root",
                "Artifact root",
                "unhealthy",
                "Artifact storage could not be checked",
                json!({}),
            ),
            check(
                "disk-space",
                "Disk space",
                "warning",
                "Free disk space could not be read",
                json!({}),
            ),
        )
    });
    let github = match github_override {
        Some(github) => github,
        None => github_check().await,
    };
    let mut checks = vec![
        database_check(database),
        artifact,
        disk,
        git_check(),
        check(
            "herdr-readiness",
            "Herdr",
            "warning",
            "Herdr health is not available in this build",
            json!({}),
        ),
        github,
    ];
    for provider in providers {
        let label = match provider.as_str() {
            "opencode" => "OpenCode",
            "claude-code" => "Claude Code",
            _ => "Codex CLI",
        };
        checks.push(json!({"id":format!("provider:{provider}"),"label":label,"provider":provider,"status":"warning","summary":"Provider health is not available in this build","details":{}}));
    }
    let ready = checks
        .iter()
        .filter(|check| check["id"] == "database" || check["id"] == "artifact-root")
        .all(|check| check["status"] != "unhealthy");
    let mut response = Json(json!({
        "generatedAt":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "reachableAddress":state.session_config.reachable_address,
        "ready":ready,"checks":checks,
    }))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        http::session::SessionConfig,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::body::to_bytes;

    #[tokio::test]
    async fn health_query_keeps_public_field_order_for_empty_duplicate_and_unknown_keys() {
        let invalid = match query(Some("projectId=&other=x")) {
            Err(response) => response,
            Ok(_) => panic!("invalid health query was accepted"),
        };
        let body: Value =
            serde_json::from_slice(&to_bytes((*invalid).into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(
            body["findings"],
            json!([
                {"code":"invalid-too_small","field":".projectId","message":"Request value is invalid"},
                {"code":"invalid-unrecognized_keys","field":".","message":"Request value is invalid"},
            ])
        );
        let duplicate = match query(Some("projectId=x&projectId=y&profileIds=")) {
            Err(response) => response,
            Ok(_) => panic!("duplicate health query was accepted"),
        };
        let body: Value =
            serde_json::from_slice(&to_bytes((*duplicate).into_body(), 4096).await.unwrap())
                .unwrap();
        assert_eq!(
            body["findings"],
            json!([
                {"code":"invalid-invalid_type","field":".projectId","message":"Request value is invalid"},
                {"code":"invalid-too_small","field":".profileIds","message":"Request value is invalid"},
            ])
        );
    }

    #[tokio::test]
    async fn health_uses_live_owned_checks_and_authorizes_requested_context() {
        let root = std::env::temp_dir().join(format!("suplex-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = SuplexDatabase::open(&root.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".into(),
                tailscale_exposure: "off".into(),
            },
        )
        .with_artifact_root(root.join("artifacts"))
        .with_project_roots(root.join("repositories"), root.join("worktrees"));
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_environment_settings SET min_free_disk_gb = 0 WHERE id = 'host'",
                    [],
                )
                .unwrap();
        });
        std::fs::create_dir_all(root.join("worktrees")).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:4113".parse().unwrap());
        let fake_github = check(
            "gh-auth",
            "GitHub",
            "warning",
            "Sign in to GitHub",
            json!({"method":"device","source":"none","status":"sign_in_required"}),
        );
        let response = health_with_github(
            state.clone(),
            None,
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 128 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["reachableAddress"], "http://127.0.0.1:4113");
        assert_eq!(body["ready"], true);
        assert_eq!(body["checks"][0]["id"], "database");
        assert_eq!(body["checks"][0]["status"], "healthy");
        assert_eq!(body["checks"][1]["id"], "artifact-root");
        assert_eq!(body["checks"][1]["status"], "healthy");
        assert_eq!(body["checks"][2]["status"], "healthy");
        assert_eq!(body["checks"][3]["id"], "git");
        assert!(
            body["checks"][3]["details"]["version"]
                .as_str()
                .unwrap()
                .starts_with("libgit2 ")
        );
        assert_eq!(body["checks"][4]["status"], "warning");
        assert_eq!(body["checks"][5]["details"]["method"], "device");
        state.with_database(|database| {
            database.connection().execute("UPDATE suplex_environment_settings SET min_free_disk_gb = 1024 WHERE id = 'host'", []).unwrap();
        });
        let low = health_with_github(
            state.clone(),
            None,
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        let low: Value =
            serde_json::from_slice(&to_bytes(low.into_body(), 128 * 1024).await.unwrap()).unwrap();
        assert_eq!(low["checks"][2]["status"], "warning");
        let unknown = health_with_github(
            state.clone(),
            Some("profileIds=missing".into()),
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        let unknown_project = health_with_github(
            state.clone(),
            Some("projectId=missing".into()),
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(unknown_project.status(), StatusCode::NOT_FOUND);
        let conflict = health_with_github(
            state.clone(),
            Some("projectId=x&profileIds=y".into()),
            headers.clone(),
            Some(fake_github),
        )
        .await;
        assert_eq!(conflict.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            health_with_github(
                state.clone(),
                Some("other=x".into()),
                HeaderMap::new(),
                None
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
