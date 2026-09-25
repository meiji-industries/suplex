//! Diagnostic and maintenance commands from `cli.ts`, `platform/diagnostics/*`
//! and the backup commands. Supervisor commands (`start`, `stop`, `restart`,
//! `setup`, `install`, `desktop`) belong to the Node launcher, which starts
//! this binary as a single foreground server.

use std::{
    io::{self, Write},
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    http::{AppState, routes::health, session::SessionConfig},
    platform::{
        backup::BackupService,
        config::Installation,
        database::{OpenMode, SchemaState, SuplexDatabase},
        log_viewer,
    },
};

pub type CliResult = Result<i32, Box<dyn std::error::Error>>;

const USAGE: &str = "Usage: suplex <serve|migrate|doctor|task|backup|verify-backup|restore|logs|mcp> [options]\n";

/// Runs a command other than `serve` and `mcp`. Returns the exit code.
pub async fn run(command: &str, arguments: &[String]) -> CliResult {
    match command {
        "help" => {
            print!("{USAGE}");
            Ok(0)
        }
        "logs" => logs(arguments),
        "migrate" => migrate(),
        "doctor" => doctor(arguments).await,
        "task" => task(arguments),
        "backup" | "verify-backup" | "restore" => backup(command, arguments),
        _ => Err(format!("Unknown Suplex command: {command}").into()),
    }
}

fn state_label(state: SchemaState) -> String {
    format!("{state:?}").to_lowercase()
}

fn open_diagnostic_database(installation: &Installation, verbose: bool) -> io::Result<SuplexDatabase> {
    let database = SuplexDatabase::open(&installation.database, OpenMode::ReadOnly)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let status = database
        .schema_status()
        .map_err(|error| io::Error::other(error.to_string()))?;
    if status.state == SchemaState::Behind {
        eprintln!("database is behind this build — restart the stack to migrate");
    }
    if verbose {
        eprintln!("database open mode: read-only");
    }
    Ok(database)
}

fn logs(arguments: &[String]) -> CliResult {
    let installation = Installation::load()?;
    let mut options = log_viewer::Options {
        directory: installation.logs.clone(),
        ..log_viewer::Options::default()
    };
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].as_str();
        match argument {
            "--task" | "--since" => {
                index += 1;
                let value = arguments
                    .get(index)
                    .filter(|value| !value.is_empty())
                    .cloned()
                    .ok_or_else(|| format!("{argument} requires a value"))?;
                if argument == "--task" {
                    options.task_id = Some(value);
                } else {
                    options.since = Some(value);
                }
            }
            "--errors" => options.errors = true,
            "--follow" => options.follow = true,
            "--verbose" => {}
            other => return Err(format!("Unknown logs option: {other}").into()),
        }
        index += 1;
    }
    drop(open_diagnostic_database(&installation, arguments.iter().any(|value| value == "--verbose"))?);
    log_viewer::run(&options, &mut io::stdout().lock())?;
    Ok(0)
}

fn migrate() -> CliResult {
    let installation = Installation::load()?;
    let database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)
        .map_err(|error| error.to_string())?;
    let status = database.schema_status().map_err(|error| error.to_string())?;
    if status.state != SchemaState::Current {
        return Err(format!(
            "Database schema is {} after migration ({}/{} migrations applied)",
            state_label(status.state),
            status.applied.len(),
            status.expected.len()
        )
        .into());
    }
    println!(
        "Database schema is current ({}/{} migrations applied)",
        status.applied.len(),
        status.expected.len()
    );
    Ok(0)
}

pub struct DoctorCheck {
    pub status: &'static str,
    pub name: String,
    pub detail: String,
}

pub fn format_doctor(checks: &[DoctorCheck]) -> String {
    checks
        .iter()
        .map(|check| format!("{:<4} {}: {}\n", check.status, check.name, check.detail))
        .collect()
}

/// `platform/diagnostics/doctor.ts`: schema, references, host health with
/// every provider, and each unarchived task that waits for a person.
pub async fn run_doctor(state: &AppState) -> Result<Vec<DoctorCheck>, Box<dyn std::error::Error>> {
    let (schema, references) = state.with_database(|database| {
        let schema = database.schema_status().map_err(|error| error.to_string())?;
        let references = if schema.state == SchemaState::Current {
            database
                .connection()
                .prepare("PRAGMA foreign_key_check")?
                .query_map([], |_| Ok(()))?
                .count()
        } else {
            0
        };
        Ok::<_, Box<dyn std::error::Error>>((schema, references))
    })?;
    let mut checks = vec![DoctorCheck {
        status: if schema.state == SchemaState::Current { "PASS" } else { "FAIL" },
        name: "database schema".into(),
        detail: format!(
            "{} ({}/{} migrations)",
            state_label(schema.state),
            schema.applied.len(),
            schema.expected.len()
        ),
    }];
    if schema.state != SchemaState::Current {
        return Ok(checks);
    }
    checks.push(DoctorCheck {
        status: if references == 0 { "PASS" } else { "FAIL" },
        name: "database references".into(),
        detail: format!("{references} invalid references"),
    });
    let providers = ["opencode", "claude-code", "codex"].map(str::to_owned).to_vec();
    let snapshot = health::snapshot(state, providers, None).await;
    for check in snapshot["checks"].as_array().into_iter().flatten() {
        let id = check["id"].as_str().unwrap_or_default();
        let required = ["database", "artifact-root", "git", "herdr-readiness"].contains(&id);
        let remedy = check["remedy"]
            .as_str()
            .map(|remedy| format!(" ({remedy})"))
            .unwrap_or_default();
        checks.push(DoctorCheck {
            status: if check["status"] == "healthy" {
                "PASS"
            } else if required {
                "FAIL"
            } else {
                "WARN"
            },
            name: check["label"].as_str().unwrap_or_default().to_owned(),
            detail: format!("{}{remedy}", check["summary"].as_str().unwrap_or_default()),
        });
    }
    let waiting = state.with_database(|database| {
        database
            .connection()
            .prepare("SELECT tasks.id, controls.status, controls.human_question FROM suplex_tasks tasks LEFT JOIN suplex_task_controls controls ON controls.task_id = tasks.id WHERE tasks.archived_at IS NULL ORDER BY tasks.created_at, tasks.id")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
    })?;
    for (id, status, question) in waiting {
        match status.as_deref() {
            None => checks.push(DoctorCheck {
                status: "FAIL",
                name: id,
                detail: "Task control is not available".into(),
            }),
            Some("waiting_human") => checks.push(DoctorCheck {
                status: "WARN",
                name: id,
                detail: question.unwrap_or_else(|| "Answer the task question".into()),
            }),
            Some(_) => {}
        }
    }
    Ok(checks)
}

fn diagnostic_state(installation: &Installation, database: SuplexDatabase) -> AppState {
    AppState::new(
        database,
        SessionConfig {
            port: installation.port,
            reachable_address: format!("http://127.0.0.1:{}", installation.port),
            tailscale_exposure: "off".to_owned(),
        },
    )
    .with_project_roots(
        installation.repositories.clone(),
        installation.worktrees.clone(),
    )
    .with_artifact_root(installation.artifacts.clone())
}

async fn doctor(arguments: &[String]) -> CliResult {
    if arguments.iter().any(|argument| argument == "--fix") {
        return Err("doctor is read-only. Restart Suplex to apply pending migrations.".into());
    }
    let installation = Installation::load()?;
    let database = open_diagnostic_database(&installation, arguments.iter().any(|value| value == "--verbose"))?;
    let checks = run_doctor(&diagnostic_state(&installation, database)).await?;
    print!("{}", format_doctor(&checks));
    Ok(if checks.iter().any(|check| check.status == "FAIL") { 1 } else { 0 })
}

/// `platform/diagnostics/task.ts` without native observation: the durable
/// control, sessions and turns of one task.
pub fn inspect_task(database: &SuplexDatabase, task_id: &str, all_history: bool) -> Result<Value, Box<dyn std::error::Error>> {
    let rows = |sql: &str| -> rusqlite::Result<Vec<Value>> {
        let mut statement = database.connection().prepare(sql)?;
        let names = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        statement
            .query_map([task_id], |row| {
                let mut object = Map::new();
                for (index, name) in names.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(value) => json!(value),
                        rusqlite::types::ValueRef::Real(value) => json!(value),
                        rusqlite::types::ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
                        rusqlite::types::ValueRef::Blob(_) => Value::Null,
                    };
                    object.insert(name.clone(), value);
                }
                Ok(Value::Object(object))
            })?
            .collect()
    };
    let title = rows("SELECT title FROM suplex_tasks WHERE id = ?1")?
        .pop()
        .ok_or("Task not found")?["title"]
        .clone();
    let control = rows("SELECT * FROM suplex_task_controls WHERE task_id = ?1")?
        .pop()
        .ok_or("Task control is not available")?;
    let sessions = rows("SELECT * FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY kind, generation")?;
    let turns = rows("SELECT * FROM suplex_task_turns WHERE task_id = ?1 ORDER BY created_at, id")?;
    let skip = if all_history { 0 } else { turns.len().saturating_sub(30) };
    Ok(json!({
        "taskId": task_id,
        "title": title,
        "control": control,
        "sessions": sessions,
        "turns": turns[skip..],
    }))
}

pub fn format_task(value: &Value) -> String {
    let text = |value: &Value, fallback: &str| value.as_str().unwrap_or(fallback).to_owned();
    let worktree = value["control"]["worktree_json"]
        .as_str()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|worktree| worktree["path"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "none".into());
    let mut lines = vec![
        format!("TASK {}: {}", text(&value["taskId"], ""), text(&value["title"], "")),
        format!("status      {}", text(&value["control"]["status"], "")),
        format!("question    {}", text(&value["control"]["human_question"], "none")),
        format!("worktree    {worktree}"),
    ];
    for session in value["sessions"].as_array().into_iter().flatten() {
        lines.push(format!(
            "{:<11} {} not observed",
            text(&session["kind"], ""),
            text(&session["native_session_id"], "reserved")
        ));
    }
    lines.push(format!(
        "turns       {}",
        value["turns"].as_array().map_or(0, Vec::len)
    ));
    lines.push(String::new());
    lines.join("\n")
}

fn task(arguments: &[String]) -> CliResult {
    let Some(task_id) = arguments.first().filter(|value| !value.starts_with("--")) else {
        return Err("task requires a task ID".into());
    };
    let flag = |name: &str| arguments.iter().any(|argument| argument == name);
    let installation = Installation::load()?;
    let database = open_diagnostic_database(&installation, flag("--verbose"))?;
    let diagnostic = inspect_task(&database, task_id, flag("--history") || flag("--bundle"))?;
    if flag("--bundle") {
        let directory = installation.data.join("bundles");
        std::fs::create_dir_all(&directory)?;
        let safe = task_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect::<String>();
        let path = directory.join(format!("{safe}-{}.json", Utc::now().timestamp_millis()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(serde_json::to_string_pretty(&diagnostic)?.as_bytes())?;
        println!("bundle      {}", path.display());
    }
    if flag("--json") {
        println!("{}", serde_json::to_string_pretty(&diagnostic)?);
    } else {
        print!("{}", format_task(&diagnostic));
    }
    Ok(0)
}

fn backup_service(installation: &Installation) -> BackupService {
    let mut configuration = Map::new();
    for (key, value) in [
        ("accessMode", json!("local")),
        ("tailscaleExposure", json!("off")),
        ("bindAddress", json!("127.0.0.1")),
        ("reachableAddress", json!(format!("http://127.0.0.1:{}", installation.port))),
        ("port", json!(installation.port)),
        ("dataRoot", json!(installation.data)),
        ("databasePath", json!(installation.database)),
        ("artifactRoot", json!(installation.artifacts)),
        ("runtimeRoot", json!(installation.runtime)),
        ("repositoryRoot", json!(installation.repositories)),
        ("worktreeRoot", json!(installation.worktrees)),
        ("installationId", json!(installation_id(&installation.database))),
    ] {
        configuration.insert(key.into(), value);
    }
    BackupService {
        data_root: installation.data.clone(),
        database_path: installation.database.clone(),
        artifact_root: installation.artifacts.clone(),
        configuration,
    }
}

/// A stable installation identity from the database path; the Rust binary has
/// no `SUPLEX_INSTALLATION_ID`.
pub fn installation_id(database_path: &Path) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(database_path.as_os_str().as_encoded_bytes());
    format!(
        "rust-{}",
        digest[..6].iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    )
}

fn backup(command: &str, arguments: &[String]) -> CliResult {
    let installation = Installation::load()?;
    let service = backup_service(&installation);
    let archive = arguments.first().map(PathBuf::from);
    match command {
        "backup" => {
            let archive = archive.ok_or("backup requires an archive path")?;
            let created = service.create(&archive).map_err(|error| error.to_string())?;
            println!(
                "Backup created at {} ({} files, {} bytes, {}ms)",
                created.archive_path.display(),
                created.manifest["entries"].as_array().map_or(0, Vec::len),
                created.archive_bytes,
                created.duration_ms
            );
            Ok(0)
        }
        "verify-backup" => {
            let archive = archive.ok_or("verify-backup requires an archive path")?;
            let result = service.verify(&archive).map_err(|error| error.to_string())?;
            println!(
                "Backup verification {} ({}ms){}",
                if result.valid { "passed" } else { "failed" },
                result.duration_ms,
                if result.errors.is_empty() {
                    String::new()
                } else {
                    format!(": {}", result.errors.join("; "))
                }
            );
            Ok(if result.valid { 0 } else { 1 })
        }
        _ => {
            let (Some(archive), Some(destination)) = (archive, arguments.get(1).map(PathBuf::from)) else {
                return Err("restore requires an archive path and separate destination".into());
            };
            let (verification, restore_ms) = service
                .restore(&archive, &destination)
                .map_err(|error| error.to_string())?;
            let restored = destination.join("suplex-backup/app/suplex.sqlite");
            drop(SuplexDatabase::open(&restored, OpenMode::Migrate).map_err(|error| error.to_string())?);
            let handoff = json!({
                "version": 1,
                "restoredAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "archivePath": verification.archive_path,
                "archiveBytes": std::fs::metadata(&verification.archive_path)?.len(),
                "backupDurationMs": verification.duration_ms as u64,
                "restoreDurationMs": restore_ms as u64,
                "verification": {"valid": verification.valid, "verifiedAt": verification.verified_at, "errors": verification.errors},
                "requiresReauthentication": true,
                "nextSteps": ["Restore repository and worktree paths before starting Suplex", "Sign in to OpenCode and GitHub on the restored host", "Preserve OpenCode session storage to continue existing tasks", "Start Suplex and review any specific recovery question"],
            });
            let path = destination.join("suplex-backup/restore-handoff.json");
            std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&handoff)?))?;
            std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
            println!(
                "backup restored to {}; verification {} ({restore_ms}ms); see suplex-backup/restore-handoff.json",
                destination.display(),
                if verification.valid { "passed" } else { "failed" }
            );
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn doctor_reports_schema_references_health_and_waiting_tasks() {
        let root = std::env::temp_dir().join(format!("suplex-doctor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("worktrees")).unwrap();
        let database = SuplexDatabase::open(&root.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
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
        let checks = run_doctor(&state).await.unwrap();
        let text = format_doctor(&checks);
        assert!(text.starts_with("PASS database schema: current ("));
        assert!(text.contains("PASS database references: 0 invalid references\n"));
        assert!(text.contains("PASS SQLite database: Schema is current and WAL is enabled\n"));
        assert!(text.contains(" Backup verification: No backup has been made yet (Create a backup in Settings → Backups)\n"));
        assert!(checks.iter().any(|check| check.name == "Codex CLI" && check.status == "WARN"));
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_diagnostic_formats_durable_control_sessions_and_turns() {
        let text = format_task(&json!({
            "taskId":"task_one","title":"Fix login",
            "control":{"status":"waiting_human","human_question":"Which branch?","worktree_json":"{\"path\":\"/tmp/wt\"}"},
            "sessions":[{"kind":"root","native_session_id":"thread-1"},{"kind":"worker","native_session_id":null}],
            "turns":[{},{}],
        }));
        assert_eq!(
            text,
            "TASK task_one: Fix login\nstatus      waiting_human\nquestion    Which branch?\nworktree    /tmp/wt\nroot        thread-1 not observed\nworker      reserved not observed\nturns       2\n"
        );
    }
}
