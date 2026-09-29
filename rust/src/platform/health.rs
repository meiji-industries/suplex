//! Live host health probes.
use crate::{
    http::AppState,
    integrations::github,
    platform::{
        backup,
        database::{DatabaseHealth, SchemaState},
        environment_settings::{self, js_number},
    },
    shared::time::now_millis_rfc3339,
};
use crate::{
    identity::auth::AuthUser,
    platform::database::SuplexDatabase,
    profiles::agent_profiles,
    projects::{ProjectError, service as projects},
    shared::PublicFailure,
};
use chrono::Utc;
use serde_json::{Value, json};
use std::{
    ffi::{CString, OsStr},
    fs::OpenOptions,
    os::unix::ffi::OsStrExt,
    path::Path,
};
const MINIMUM_ARTIFACT_FREE_BYTES: u64 = 100 * 1024 * 1024;

pub(crate) fn check(id: &str, label: &str, status: &str, summary: &str, details: Value) -> Value {
    json!({"id":id,"label":label,"status":status,"summary":summary,"details":details})
}

pub(crate) fn database_check(health: DatabaseHealth) -> Value {
    let current = health.schema_state == SchemaState::Current;
    let usable = health.wal_mode && health.readable && (health.writable || health.read_only);
    let status = if current && usable {
        "healthy"
    } else if health.schema_state == SchemaState::Ahead && usable {
        "warning"
    } else {
        "unhealthy"
    };
    let summary = match status {
        "healthy" if health.read_only => {
            "Schema is current and WAL is enabled. Writes are not tested in read-only mode"
                .to_owned()
        }
        "healthy" => "Schema is current and WAL is enabled".to_owned(),
        "warning" => {
            let unknown = health
                .applied_migrations
                .saturating_sub(health.expected_migrations);
            format!(
                "Database has {unknown} migration{} this build does not know about — pull/restart",
                if unknown == 1 { "" } else { "s" }
            )
        }
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

// statvfs block counts are u32 on macOS and u64 on Linux.
#[allow(clippy::unnecessary_cast)]
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

pub(crate) fn artifact_check(path: Option<&Path>) -> Value {
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
    fn bytes(path: Option<&Path>) -> Option<(&Path, (u64, u64))> {
        let path = path?;
        Some((path, filesystem_bytes(path)?))
    }
    let Some((
        (worktree, (worktree_free, worktree_total)),
        (artifact, (artifact_free, artifact_total)),
    )) = bytes(worktree).zip(bytes(artifact))
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
            "Free disk space could not be read",
            json!({}),
        );
    };
    let minimum = minimum_gb * (1024_u64.pow(3) as f64);
    let gb = |bytes: f64| format!("{:.2} GB", bytes / 1024_f64.powi(3));
    let low = [
        ("Worktree root", worktree_free),
        ("Artifact root", artifact_free),
    ]
    .into_iter()
    .filter(|(_, free)| minimum > 0.0 && (*free as f64) < minimum)
    .map(|(label, free)| format!("{label}: {} free", gb(free as f64)))
    .collect::<Vec<_>>();
    check(
        "disk-space",
        "Disk space",
        if low.is_empty() { "healthy" } else { "warning" },
        &if low.is_empty() {
            "Free disk space meets the configured minimum".to_owned()
        } else {
            format!("{}; minimum is {}", low.join("; "), gb(minimum))
        },
        json!({
            "freeBytes":worktree_free.min(artifact_free),"minFreeBytes":js_number(minimum),
            "worktreeRoot":worktree.display().to_string(),"worktreeFreeBytes":worktree_free,"worktreeTotalBytes":worktree_total,
            "artifactRoot":artifact.display().to_string(),"artifactFreeBytes":artifact_free,"artifactTotalBytes":artifact_total,
        }),
    )
}

/// `checkTailscale` from `platform/host-health.ts`, reported only when the
/// installation exposes itself through Tailscale Serve.
async fn tailscale_check() -> Value {
    let command =
        std::env::var_os("SUPLEX_TAILSCALE_COMMAND").unwrap_or_else(|| "tailscale".into());
    tailscale_check_with_command(&command).await
}

async fn tailscale_check_with_command(command: &OsStr) -> Value {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(command)
            .args(["status", "--json"])
            .env("TAILSCALE_BE_CLI", "1")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let failure = match output {
        Err(_) => "status-timeout",
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => "command-missing",
        Ok(Err(_)) => "status-failed",
        Ok(Ok(output)) if !output.status.success() => "status-failed",
        Ok(Ok(output)) => match tailscale_hostname(&output.stdout) {
            Some(hostname) => {
                return check(
                    "tailscale",
                    "Tailscale",
                    "healthy",
                    "Tailscale is available",
                    json!({"hostname": hostname}),
                );
            }
            None => "status-format",
        },
    };
    let missing = failure == "command-missing";
    json!({
        "id":"tailscale","label":"Tailscale","status":"warning",
        "summary": if missing { "Tailscale CLI is not installed" } else { "Tailscale is not running" },
        "remedy": if missing { "brew install --cask tailscale" } else { "Open the Tailscale app and sign in" },
        "details":{"failure":failure},
    })
}

/// `parseTailscaleHostname`: the MagicDNS name without its trailing dot.
pub(crate) fn tailscale_hostname(raw: &[u8]) -> Option<String> {
    let status: Value = serde_json::from_slice(raw).ok()?;
    let hostname = status["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    hostname.ends_with(".ts.net").then(|| hostname.to_owned())
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

/// The host health snapshot from `platform/health.ts` `inspectHostHealth`.
pub async fn snapshot(
    state: &AppState,
    providers: Vec<String>,
    github_override: Option<Value>,
) -> Value {
    let (database, minimum_gb, data_root) = state.with_database(|database| {
        let minimum_gb = environment_settings::read(database)
            .ok()
            .map(|settings| settings.min_free_disk_gb);
        let data_root = database
            .connection()
            .path()
            .filter(|path| !path.is_empty())
            .and_then(|path| Path::new(path).parent().map(Path::to_path_buf));
        (database.health(), minimum_gb, data_root)
    });
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
        crate::integrations::herdr_readiness::check_herdr_readiness(&state.herdr).await,
        github,
    ];
    if state.session_config.tailscale_exposure == "serve" {
        checks.push(tailscale_check().await);
    }
    if let Some(data_root) = data_root {
        checks.push(backup::health_check(&data_root, Utc::now()));
    }
    for provider in providers {
        checks.push(crate::profiles::provider_readiness::check(&provider, None, false).await);
    }
    let ready = checks
        .iter()
        .filter(|check| check["id"] == "database" || check["id"] == "artifact-root")
        .all(|check| check["status"] != "unhealthy");
    json!({
        "generatedAt":now_millis_rfc3339(),
        "reachableAddress":state.session_config.reachable_address,
        "version":env!("CARGO_PKG_VERSION"),
        "ready":ready,"checks":checks,
    })
}

pub fn provider_context(
    database: &SuplexDatabase,
    user: &AuthUser,
    project_id: Option<&str>,
    profile_ids: Option<&str>,
) -> Result<Vec<String>, PublicFailure> {
    if project_id.is_none() && profile_ids.is_none() {
        return Ok(Vec::new());
    }
    if project_id.is_some() && profile_ids.is_some() {
        return Err(PublicFailure::new(400, "Select one provider context"));
    }
    let profiles =
        agent_profiles::list(database, &user.id, true).map_err(crate::shared::public_failure)?;
    let requested = if let Some(project_id) = &project_id {
        let project = projects::get(database, &user.id, project_id).map_err(|error| {
            if let Some(failure) = error.downcast_ref::<ProjectError>() {
                PublicFailure::new(failure.status(), failure.to_string())
            } else {
                crate::shared::public_failure(error)
            }
        })?;
        [
            project.root_profile_id,
            project.alt_profile_id,
            project.worker_profile_id,
        ]
        .to_vec()
    } else {
        let mut ids = Vec::new();
        for id in profile_ids.unwrap_or_default().split(',') {
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
            if profile_ids.is_some() {
                return Err(PublicFailure::new(404, "Not found"));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tailscale_health_runs_the_cli_in_cli_mode() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("suplex-tailscale-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let command = root.join("tailscale");
        std::fs::write(
            &command,
            concat!(
                "#!/bin/sh\n",
                "if [ \"$TAILSCALE_BE_CLI\" != 1 ]; then\n",
                "  printf 'GUI failed to start'\n",
                "  exit 0\n",
                "fi\n",
                "printf '%s' '{\"Self\":{\"DNSName\":\"host.test-tailnet.ts.net.\"}}'\n",
            ),
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();

        let health = tailscale_check_with_command(command.as_os_str()).await;

        assert_eq!(health["status"], "healthy");
        assert_eq!(health["details"]["hostname"], "host.test-tailnet.ts.net");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_tailnet_observations_and_unreadable_storage_are_not_healthy() {
        for raw in [
            "not-json",
            r#"{"Self":{"DNSName":4}}"#,
            r#"{"Self":{"DNSName":"private-host.example.com"}}"#,
            "{}",
        ] {
            assert_eq!(tailscale_hostname(raw.as_bytes()), None);
        }
        assert_eq!(disk_check(None, None, Some(1.0))["status"], "warning");
        let directory = std::env::temp_dir();
        assert_eq!(
            disk_check(Some(&directory), Some(&directory), None)["status"],
            "warning"
        );
        let unavailable = DatabaseHealth {
            wal_mode: true,
            schema_state: SchemaState::Locked,
            expected_migrations: 1,
            applied_migrations: 1,
            readable: true,
            writable: false,
            read_only: false,
        };
        assert_eq!(database_check(unavailable)["status"], "unhealthy");
    }
}
