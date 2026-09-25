//! Backups as `platform/backup.ts` writes them: a `suplex-backup/` tar.gz with
//! a SQLite snapshot without authentication state, the artifacts, the
//! configuration record, and a hashed manifest. Archives stay interchangeable
//! with the TypeScript backend.

use crate::shared::time::rfc3339_millis;
use std::{
    collections::HashSet,
    error::Error,
    fmt, fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{LazyLock, mpsc},
    time::{Duration, Instant, SystemTime},
};

use base64::Engine;
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::database::{OpenMode, SuplexDatabase};

pub type BackupResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const BACKUP_VERSION: u64 = 1;
const BACKUP_ROOT: &str = "suplex-backup";
pub const HEALTH_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1_000;
pub static BACKUP_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^suplex-backup-[0-9TZ-]+\.tar\.gz$").expect("backup name"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupFailure {
    Exists,
    Invalid,
    Unsafe,
    Verification,
}

impl fmt::Display for BackupFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::Exists => "exists",
            Self::Invalid => "invalid",
            Self::Unsafe => "unsafe",
            Self::Verification => "verification",
        };
        write!(formatter, "Suplex backup {code}")
    }
}

impl Error for BackupFailure {}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    pub bytes: u64,
    pub created_at: String,
}

#[derive(Debug)]
pub struct Verification {
    pub valid: bool,
    pub archive_path: PathBuf,
    pub manifest: Option<Value>,
    pub errors: Vec<String>,
    pub verified_at: String,
    pub duration_ms: u128,
}

#[derive(Debug)]
pub struct Created {
    pub archive_path: PathBuf,
    pub manifest: Value,
    pub archive_bytes: u64,
    pub duration_ms: u128,
}

/// The installation paths a backup reads and writes. `configuration` is the
/// public configuration record stored in `config/config.json`.
pub struct BackupService {
    pub data_root: PathBuf,
    pub database_path: PathBuf,
    pub artifact_root: PathBuf,
    pub configuration: Map<String, Value>,
}

fn staging(prefix: &str) -> BackupResult<PathBuf> {
    let path = std::env::temp_dir().join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
    fs::DirBuilder::new().mode(0o700).create(&path)?;
    Ok(path)
}

fn tar(args: &[&std::ffi::OsStr], seconds: u64) -> BackupResult<String> {
    let child = Command::new("tar")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = child.id() as libc::pid_t;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    match receiver.recv_timeout(Duration::from_secs(seconds)) {
        Ok(Ok(output)) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(Ok(output)) => Err(format!(
            "tar failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into()),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => {
            unsafe { libc::kill(pid, libc::SIGKILL) };
            Err("tar timed out".into())
        }
    }
}

/// Every regular file under `root` as a manifest entry. Links and other file
/// types are unsafe in a backup.
fn files_under(root: &Path, prefix: &str) -> BackupResult<Vec<Value>> {
    let mut names = fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
    names.sort_by_key(|entry| entry.file_name());
    let mut entries = Vec::new();
    for entry in names {
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let kind = entry.file_type()?;
        if kind.is_dir() {
            entries.extend(files_under(&entry.path(), &relative)?);
        } else if kind.is_file() {
            let bytes = fs::read(entry.path())?;
            entries.push(json!({"path": relative, "bytes": bytes.len(), "sha256": crate::shared::hash::sha256_hex(&bytes)}));
        } else {
            return Err(BackupFailure::Unsafe.into());
        }
    }
    Ok(entries)
}

/// Recursive copy. `overwrite` replaces existing files; otherwise an existing
/// destination file is an error.
fn copy_tree(source: &Path, destination: &Path, overwrite: bool) -> BackupResult<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, overwrite)?;
        } else if kind.is_file() {
            if !overwrite && target.exists() {
                return Err(BackupFailure::Exists.into());
            }
            fs::copy(entry.path(), target)?;
        } else {
            return Err(BackupFailure::Unsafe.into());
        }
    }
    Ok(())
}

fn safe_archive_name(path: &str) -> bool {
    (path == BACKUP_ROOT || path.starts_with(&format!("{BACKUP_ROOT}/")))
        && !path.contains('\\')
        && !path.split('/').any(|part| part == "..")
        && !path.starts_with('/')
}

fn safe_manifest_path(path: &str) -> bool {
    !path.is_empty() && safe_archive_name(&format!("{BACKUP_ROOT}/{path}"))
}

fn component(entries: &[Value], prefix: &str) -> Value {
    let selected = entries
        .iter()
        .filter(|entry| {
            entry["path"]
                .as_str()
                .is_some_and(|path| path.starts_with(prefix))
        })
        .collect::<Vec<_>>();
    json!({
        "path": prefix.trim_end_matches('/'),
        "count": selected.len(),
        "bytes": selected.iter().filter_map(|entry| entry["bytes"].as_u64()).sum::<u64>(),
    })
}

fn remove_authentication_state(snapshot: &Path) -> BackupResult<()> {
    let mut connection = Connection::open(snapshot)?;
    let transaction = connection.transaction()?;
    for table in [
        "suplex_challenges",
        "suplex_sessions",
        "suplex_credentials",
        "suplex_invitations",
        "suplex_external_agent_credentials",
        "suplex_external_agent_pairing_codes",
        "suplex_oauth_access_tokens",
        "suplex_oauth_refresh_tokens",
        "suplex_oauth_token_families",
        "suplex_oauth_authorization_codes",
        "suplex_oauth_pending_authorizations",
    ] {
        transaction.execute(&format!("DELETE FROM {table}"), [])?;
    }
    let grants = transaction
        .prepare("SELECT id FROM suplex_oauth_grants")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for grant in grants {
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|error| error.to_string())?;
        transaction.execute(
            "UPDATE suplex_oauth_grants SET cursor_key = ?1 WHERE id = ?2",
            params![
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
                grant
            ],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn modified_iso(time: SystemTime) -> String {
    rfc3339_millis(DateTime::<Utc>::from(time))
}

impl BackupService {
    pub fn directory(&self) -> PathBuf {
        self.data_root.join("backups")
    }

    /// The stored archive's path, or none when this service never writes the name.
    pub fn path_of(&self, name: &str) -> Option<PathBuf> {
        BACKUP_NAME
            .is_match(name)
            .then(|| self.directory().join(name))
    }

    pub fn list(&self) -> BackupResult<Vec<BackupEntry>> {
        let Ok(entries) = fs::read_dir(self.directory()) else {
            return Ok(Vec::new());
        };
        let mut backups = Vec::new();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !BACKUP_NAME.is_match(&name) {
                continue;
            }
            let metadata = fs::metadata(entry.path())?;
            backups.push(BackupEntry {
                name,
                bytes: metadata.len(),
                created_at: modified_iso(metadata.modified()?),
            });
        }
        backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(backups)
    }

    /// Creates and verifies a backup in the host's backup directory.
    pub fn create_in_library(&self, now: DateTime<Utc>) -> BackupResult<BackupEntry> {
        fs::create_dir_all(&self.artifact_root)?;
        let name = format!(
            "suplex-backup-{}.tar.gz",
            now.to_rfc3339_opts(SecondsFormat::Secs, true)
                .replace(':', "-")
        );
        let created = self.create(&self.directory().join(&name))?;
        let verification = self.verify(&created.archive_path)?;
        if !verification.valid {
            let _ = fs::remove_file(&created.archive_path);
            return Err(BackupFailure::Verification.into());
        }
        Ok(BackupEntry {
            name,
            bytes: created.archive_bytes,
            created_at: rfc3339_millis(now),
        })
    }

    pub fn create(&self, destination: &Path) -> BackupResult<Created> {
        let started = Instant::now();
        let destination = std::path::absolute(destination)?;
        if destination.exists() {
            return Err(BackupFailure::Exists.into());
        }
        if !self.database_path.exists() || !self.artifact_root.exists() {
            return Err(BackupFailure::Invalid.into());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let staging = staging("suplex-backup-create-")?;
        let result = (|| {
            let root = staging.join(BACKUP_ROOT);
            fs::create_dir_all(root.join("app"))?;
            fs::create_dir_all(root.join("config"))?;
            let snapshot = root.join("app/suplex.sqlite");
            Connection::open_with_flags(&self.database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?
                .backup(rusqlite::MAIN_DB, &snapshot, None)?;
            remove_authentication_state(&snapshot)?;
            copy_tree(&self.artifact_root, &root.join("app/artifacts"), false)?;
            crate::shared::fs::write_private(
                &root.join("config/config.json"),
                &serde_json::to_vec_pretty(&json!({
                    "version": BACKUP_VERSION,
                    "config": self.configuration,
                    "requiresReauthentication": true,
                }))?,
            )?;
            let entries = files_under(&root, "")?;
            let manifest = json!({
                "version": BACKUP_VERSION,
                "createdAt": crate::shared::time::now_millis_rfc3339(),
                "components": {
                    "application": component(&entries, "app/"),
                    "artifacts": component(&entries, "app/artifacts/"),
                    "configuration": component(&entries, "config/"),
                },
                "entries": entries,
                "database": {"path": "app/suplex.sqlite", "integrity": "ok"},
                "secretsExcluded": ["credential registrations", "passkeys", "sessions", "challenges", "invitation tokens", "external agent credentials", "OAuth tokens and authorization codes", "OAuth pending authorizations", "OAuth cursor keys", "provider API keys", "external agent pairing codes", "cookies", "private keys", "provider tokens", "Engine API keys", "generated environment files"],
                "requiredConfiguration": ["accessMode", "reachableAddress", "databasePath", "artifactRoot", "installationId"],
            });
            crate::shared::fs::write_private(
                &root.join("manifest.json"),
                &serde_json::to_vec_pretty(&manifest)?,
            )?;
            tar(
                &[
                    "-czf".as_ref(),
                    destination.as_os_str(),
                    "-C".as_ref(),
                    staging.as_os_str(),
                    BACKUP_ROOT.as_ref(),
                ],
                60,
            )?;
            Ok(Created {
                archive_bytes: fs::metadata(&destination)?.len(),
                archive_path: destination.clone(),
                manifest,
                duration_ms: started.elapsed().as_millis(),
            })
        })();
        let _ = fs::remove_dir_all(&staging);
        result
    }

    pub fn verify(&self, archive_path: &Path) -> BackupResult<Verification> {
        let started = Instant::now();
        let archive = std::path::absolute(archive_path)?;
        let mut errors = Vec::new();
        let mut manifest = None;
        let staging = staging("suplex-backup-verify-")?;
        if let Err(error) = self.inspect(&archive, &staging, &mut errors, &mut manifest) {
            errors.push(error.to_string());
        }
        let _ = fs::remove_dir_all(&staging);
        let verification = Verification {
            valid: errors.is_empty(),
            archive_path: archive,
            manifest,
            errors,
            verified_at: crate::shared::time::now_millis_rfc3339(),
            duration_ms: started.elapsed().as_millis(),
        };
        fs::create_dir_all(&self.data_root)?;
        crate::shared::fs::write_private(
            &self.data_root.join("backup-status.json"),
            &serde_json::to_vec_pretty(&json!({
                "verifiedAt": verification.verified_at,
                "valid": verification.valid,
                "archivePath": verification.archive_path,
                "errors": verification.errors,
                "durationMs": verification.duration_ms as u64,
            }))?,
        )?;
        Ok(verification)
    }

    fn inspect(
        &self,
        archive: &Path,
        staging: &Path,
        errors: &mut Vec<String>,
        manifest_slot: &mut Option<Value>,
    ) -> BackupResult<()> {
        if !archive.exists() {
            return Err(BackupFailure::Invalid.into());
        }
        let listing = tar(&["-tzf".as_ref(), archive.as_os_str()], 30)?;
        if listing
            .lines()
            .filter(|line| !line.trim_end_matches('\r').is_empty())
            .any(|name| !safe_archive_name(name.trim_end_matches('\r').trim_end_matches('/')))
        {
            errors.push("archive contains an unsafe path".into());
            return Err(BackupFailure::Unsafe.into());
        }
        tar(
            &[
                "-xzf".as_ref(),
                archive.as_os_str(),
                "-C".as_ref(),
                staging.as_os_str(),
                "--no-same-owner".as_ref(),
            ],
            60,
        )?;
        let root = staging.join(BACKUP_ROOT);
        let manifest: Value = serde_json::from_slice(&fs::read(root.join("manifest.json"))?)?;
        *manifest_slot = Some(manifest.clone());
        if manifest["version"] != BACKUP_VERSION {
            errors.push("unsupported backup version".into());
        }
        let empty = Vec::new();
        let manifest_entries = manifest["entries"].as_array().unwrap_or(&empty);
        let actual = files_under(&root, "")?
            .into_iter()
            .filter(|entry| entry["path"] != "manifest.json")
            .collect::<Vec<_>>();
        let mut expected_paths = Vec::<String>::new();
        let text = |value: &Value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        for entry in manifest_entries {
            let path = text(&entry["path"]);
            if !safe_manifest_path(&path) {
                errors.push(format!("unsafe manifest path: {path}"));
                continue;
            }
            if expected_paths.contains(&path) {
                errors.push(format!("duplicate manifest entry: {path}"));
            } else {
                expected_paths.push(path);
            }
        }
        let actual_paths = actual
            .iter()
            .map(|entry| text(&entry["path"]))
            .collect::<HashSet<_>>();
        for path in &expected_paths {
            if !actual_paths.contains(path) {
                errors.push(format!("missing entry: {path}"));
            }
        }
        let expected_set = expected_paths.iter().collect::<HashSet<_>>();
        for entry in &actual {
            let path = text(&entry["path"]);
            if !expected_set.contains(&path) {
                errors.push(format!("unexpected entry: {path}"));
            }
        }
        for entry in manifest_entries {
            let path = text(&entry["path"]);
            if !safe_manifest_path(&path) {
                continue;
            }
            match fs::read(root.join(&path)) {
                Ok(bytes)
                    if Some(bytes.len() as u64) == entry["bytes"].as_u64()
                        && entry["sha256"] == crate::shared::hash::sha256_hex(&bytes) => {}
                Ok(_) => errors.push(format!("hash mismatch: {path}")),
                Err(_) => errors.push(format!("missing entry: {path}")),
            }
        }
        let configuration: Value =
            serde_json::from_slice(&fs::read(root.join("config/config.json"))?)?;
        if configuration["version"] != BACKUP_VERSION
            || !configuration["requiresReauthentication"]
                .as_bool()
                .unwrap_or(false)
        {
            errors.push("required configuration is missing".into());
        }
        for required in manifest["requiredConfiguration"]
            .as_array()
            .unwrap_or(&empty)
        {
            let key = text(required);
            if configuration["config"].get(&key).is_none() {
                errors.push(format!("missing configuration: {key}"));
            }
        }
        let database_path = manifest["database"]["path"]
            .as_str()
            .unwrap_or("app/suplex.sqlite");
        if !safe_manifest_path(database_path) {
            return Err(BackupFailure::Unsafe.into());
        }
        let database = Connection::open_with_flags(
            root.join(database_path),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let integrity: String =
            database.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            errors.push("database integrity check failed".into());
        }
        let artifacts = database
            .prepare("SELECT storage_path, byte_size, sha256 FROM suplex_artifacts")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (storage_path, byte_size, digest) in artifacts {
            let relative = format!("app/artifacts/{storage_path}");
            if !safe_manifest_path(&relative) {
                errors.push(format!("unsafe artifact path: {storage_path}"));
                continue;
            }
            match fs::read(root.join(&relative)) {
                Ok(bytes)
                    if bytes.len() as i64 == byte_size
                        && crate::shared::hash::sha256_hex(&bytes) == digest => {}
                Ok(_) => errors.push(format!("artifact hash mismatch: {storage_path}")),
                Err(_) => errors.push(format!("missing artifact: {storage_path}")),
            }
        }
        Ok(())
    }

    pub fn restore(
        &self,
        archive_path: &Path,
        destination: &Path,
    ) -> BackupResult<(Verification, u128)> {
        let started = Instant::now();
        let target = std::path::absolute(destination)?;
        if fs::read_dir(&target).is_ok_and(|mut entries| entries.next().is_some()) {
            return Err(BackupFailure::Exists.into());
        }
        let verification = self.verify(archive_path)?;
        if !verification.valid {
            return Err(BackupFailure::Verification.into());
        }
        fs::create_dir_all(&target)?;
        tar(
            &[
                "-xzf".as_ref(),
                std::path::absolute(archive_path)?.as_os_str(),
                "-C".as_ref(),
                target.as_os_str(),
                "--no-same-owner".as_ref(),
            ],
            60,
        )?;
        Ok((verification, started.elapsed().as_millis()))
    }

    /// Replaces the live database and adds the backup's artifacts. Current
    /// users, passkeys and sessions stay, because the backup excludes them and
    /// the administrator who restores must stay signed in.
    pub fn restore_in_place(&self, archive_path: &Path) -> BackupResult<()> {
        let staging = staging("suplex-backup-restore-")?;
        let result = (|| {
            self.restore(archive_path, &staging)?;
            let root = staging.join(BACKUP_ROOT);
            let staged_path = root.join("app/suplex.sqlite");
            // Opening migrates the backup to this build's schema.
            drop(
                SuplexDatabase::open(&staged_path, OpenMode::Migrate)
                    .map_err(|error| error.to_string())?,
            );
            let staged = Connection::open(&staged_path)?;
            staged.pragma_update(None, "foreign_keys", "ON")?;
            staged.execute(
                "ATTACH DATABASE ?1 AS live",
                [self.database_path.to_string_lossy()],
            )?;
            let columns = |table: &str| -> rusqlite::Result<Vec<String>> {
                staged
                    .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .map(|name| name.map(|name| format!("\"{name}\"")))
                    .collect()
            };
            staged.execute_batch("BEGIN")?;
            let copied = (|| -> rusqlite::Result<()> {
                staged.execute(
                    &format!(
                        "INSERT OR IGNORE INTO main.suplex_users SELECT {} FROM live.suplex_users",
                        columns("suplex_users")?.join(", ")
                    ),
                    [],
                )?;
                // A backup from another host can hold the same username under another id; passkeys follow the username.
                for table in ["suplex_credentials", "suplex_sessions"] {
                    let names = columns(table)?;
                    let values = names
                        .iter()
                        .map(|name| {
                            if name == "\"user_id\"" {
                                "restored.id".to_owned()
                            } else {
                                format!("row.{name}")
                            }
                        })
                        .collect::<Vec<_>>();
                    staged.execute(&format!("INSERT OR IGNORE INTO main.{table} ({}) SELECT {} FROM live.{table} row JOIN live.suplex_users current ON current.id = row.user_id JOIN main.suplex_users restored ON restored.username = current.username", names.join(", "), values.join(", ")), [])?;
                }
                Ok(())
            })();
            match copied {
                Ok(()) => staged.execute_batch("COMMIT")?,
                Err(error) => {
                    staged.execute_batch("ROLLBACK")?;
                    return Err(error.into());
                }
            }
            staged.execute_batch("DETACH DATABASE live")?;
            copy_tree(&root.join("app/artifacts"), &self.artifact_root, true)?;
            // SQLite's backup API swaps the pages under open connections, which see the restored data on their next read.
            staged.backup(rusqlite::MAIN_DB, &self.database_path, None)?;
            Ok(())
        })();
        let _ = fs::remove_dir_all(&staging);
        result
    }
}

/// The `backup` health check from the recorded verification status.
pub fn health_check(data_root: &Path, now: DateTime<Utc>) -> Value {
    let status = fs::read(data_root.join("backup-status.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(status) = status else {
        return json!({"id":"backup","label":"Backup verification","status":"warning","summary":"No backup has been made yet","remedy":"Create a backup in Settings → Backups","details":{"verifiedAt":"never","ageMs":-1,"errors":"missing-status"}});
    };
    let verified_at = status["verifiedAt"].as_str().unwrap_or_default();
    let parsed = DateTime::parse_from_rfc3339(verified_at).ok();
    let valid = status["valid"] == true && parsed.is_some();
    let age = parsed.map_or(-1, |time| {
        (now.timestamp_millis() - time.timestamp_millis()).max(0)
    });
    let fresh = valid && age <= HEALTH_MAX_AGE_MS;
    let errors = status["errors"]
        .as_array()
        .map(|errors| {
            errors
                .iter()
                .map(|error| {
                    error
                        .as_str()
                        .map_or_else(|| error.to_string(), str::to_owned)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    json!({
        "id":"backup","label":"Backup verification",
        "status": if fresh { "healthy" } else if valid { "warning" } else { "unhealthy" },
        "summary": if fresh { "The latest recorded backup verification passed" } else if valid { "The latest recorded backup verification is stale" } else { "No verified backup is recorded" },
        "details": {"verifiedAt": if verified_at.is_empty() { "never" } else { verified_at }, "ageMs": if valid { age } else { -1 }, "errors": errors},
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(root: &Path) -> BackupService {
        let data = root.join("data");
        let database_path = data.join("suplex.sqlite");
        drop(SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap());
        let artifact_root = data.join("artifacts");
        fs::create_dir_all(&artifact_root).unwrap();
        let configuration = json!({
            "accessMode":"local","reachableAddress":"http://127.0.0.1:4113",
            "databasePath":database_path,"artifactRoot":artifact_root,"installationId":"rust-test-install",
        });
        BackupService {
            data_root: data,
            database_path,
            artifact_root,
            configuration: configuration.as_object().unwrap().clone(),
        }
    }

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("suplex-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn backup_round_trip_excludes_authentication_and_verifies_artifacts() {
        let root = root();
        let backups = service(&root);
        let connection = Connection::open(&backups.database_path).unwrap();
        connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('user_one', 'One', 'one', 'admin', 'active', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 1)", []).unwrap();
        connection.execute("INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('session_one', 'hash', 'user_one', '2099-01-01T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 1)", []).unwrap();
        drop(connection);
        fs::create_dir_all(backups.artifact_root.join("company")).unwrap();
        fs::write(backups.artifact_root.join("company/image.png"), "artifact").unwrap();
        let archive = root.join("out/backup.tar.gz");
        let created = backups.create(&archive).unwrap();
        assert!(created.archive_bytes > 0);
        assert_eq!(created.manifest["components"]["artifacts"]["count"], 1);
        assert!(matches!(
            backups
                .create(&archive)
                .unwrap_err()
                .downcast_ref::<BackupFailure>(),
            Some(BackupFailure::Exists)
        ));
        let verification = backups.verify(&archive).unwrap();
        assert!(verification.valid, "{:?}", verification.errors);
        assert_eq!(
            health_check(&backups.data_root, Utc::now())["status"],
            "healthy"
        );

        let destination = root.join("restored");
        backups.restore(&archive, &destination).unwrap();
        let restored =
            Connection::open(destination.join("suplex-backup/app/suplex.sqlite")).unwrap();
        let sessions: i64 = restored
            .query_row("SELECT count(*) FROM suplex_sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sessions, 0);
        assert_eq!(
            fs::read_to_string(destination.join("suplex-backup/app/artifacts/company/image.png"))
                .unwrap(),
            "artifact"
        );
        assert!(matches!(
            backups
                .restore(&archive, &destination)
                .unwrap_err()
                .downcast_ref::<BackupFailure>(),
            Some(BackupFailure::Exists)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verification_rejects_tampered_and_unsafe_archives() {
        let root = root();
        let backups = service(&root);
        let archive = root.join("backup.tar.gz");
        backups.create(&archive).unwrap();
        let unpacked = root.join("unpacked");
        fs::create_dir_all(&unpacked).unwrap();
        tar(
            &[
                "-xzf".as_ref(),
                archive.as_os_str(),
                "-C".as_ref(),
                unpacked.as_os_str(),
            ],
            30,
        )
        .unwrap();
        fs::write(
            unpacked.join("suplex-backup/config/config.json"),
            "{\"version\":1,\"config\":{},\"requiresReauthentication\":true}",
        )
        .unwrap();
        let tampered = root.join("tampered.tar.gz");
        tar(
            &[
                "-czf".as_ref(),
                tampered.as_os_str(),
                "-C".as_ref(),
                unpacked.as_os_str(),
                BACKUP_ROOT.as_ref(),
            ],
            30,
        )
        .unwrap();
        let verification = backups.verify(&tampered).unwrap();
        assert!(!verification.valid);
        assert!(
            verification
                .errors
                .contains(&"hash mismatch: config/config.json".to_owned())
        );
        assert!(
            verification
                .errors
                .contains(&"missing configuration: installationId".to_owned())
        );

        let outside = root.join("outside");
        fs::create_dir_all(outside.join("elsewhere")).unwrap();
        fs::write(outside.join("elsewhere/file"), "x").unwrap();
        let unsafe_archive = root.join("unsafe.tar.gz");
        tar(
            &[
                "-czf".as_ref(),
                unsafe_archive.as_os_str(),
                "-C".as_ref(),
                outside.as_os_str(),
                "elsewhere".as_ref(),
            ],
            30,
        )
        .unwrap();
        let verification = backups.verify(&unsafe_archive).unwrap();
        assert_eq!(
            verification.errors,
            ["archive contains an unsafe path", "Suplex backup unsafe"]
        );
        assert_eq!(
            health_check(&backups.data_root, Utc::now())["status"],
            "unhealthy"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_health_reports_missing_and_stale_verification() {
        let root = root();
        assert_eq!(
            health_check(&root, Utc::now())["summary"],
            "No backup has been made yet"
        );
        fs::write(
            root.join("backup-status.json"),
            r#"{"valid":true,"verifiedAt":"2026-09-01T00:00:00.000Z","errors":[]}"#,
        )
        .unwrap();
        let later = DateTime::parse_from_rfc3339("2026-09-03T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(health_check(&root, later)["status"], "warning");
        fs::remove_dir_all(root).unwrap();
    }
}
