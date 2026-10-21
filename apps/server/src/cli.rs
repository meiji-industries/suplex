//! Standalone commands and diagnostic maintenance.

use crate::shared::time::now_millis_rfc3339;
use std::{
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::http::routes::access::NetworkAccessMode;
use crate::{
    http::{AppState, routes::health, session::SessionConfig},
    platform::{
        app_update,
        backup::BackupService,
        config::Installation,
        database::{OpenMode, SchemaState, SuplexDatabase},
        install, log_viewer, setup, supervisor,
    },
};

pub type CliResult = Result<i32, Box<dyn std::error::Error + Send + Sync>>;

pub const HELP: &str = "\
Usage:  suplex COMMAND [OPTIONS]

Run and manage a Suplex installation.

Common Commands:
  up          Start Suplex in the background (alias: start)
  down        Stop Suplex (alias: stop)
  restart     Stop Suplex, then start it again
  update      Install the newest Suplex.app and restart Suplex (alias: upgrade)
  logs        Show the server log
  doctor      Check the installation and database
  version     Show the Suplex version (alias: --version, -V)
  desktop     Open Suplex.app

Setup Commands:
  setup       Configure this installation (alias: onboard)
  install     Install the tools that Suplex needs
  migrate     Apply database migrations
  recover     Issue an administrator recovery link
  company     Name the first company before onboarding (company rename NAME)

Diagnostic Commands:
  task        Show the stored state of one task
  serve       Run the server in the foreground

Operator Commands:
  hosted      Run the hosted billing, account, and suplex.sh service (hosted serve)
  billing     Rotate a hosted billing credential (billing rotate-credential)

Backup Commands:
  backup          Write a backup archive
  verify-backup   Check a backup archive
  restore         Restore a backup archive to a new directory
";

/// Runs a command other than `serve` and `mcp`. Returns the exit code.
pub async fn run(command: &str, arguments: &[String]) -> CliResult {
    match command {
        "help" | "-h" | "--help" => {
            print!("{HELP}");
            Ok(0)
        }
        "version" | "--version" | "-V" => {
            println!("suplex {}", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
        "logs" => logs(arguments),
        "setup" | "onboard" => {
            setup::run(arguments.iter().any(|arg| arg == "--local"))?;
            Ok(0)
        }
        "recover" => recover(arguments),
        "company" => company(arguments),
        "desktop" => desktop(),
        "install" => Ok(install::run(arguments).await),
        "start" | "up" => {
            let installation = Installation::load()?;
            let pid = supervisor::start(&installation)?;
            println!(
                "Suplex started at {}; owned processes: server#{pid}",
                installation.reachable_address
            );
            Ok(0)
        }
        "stop" | "down" => {
            let installation = Installation::load()?;
            println!("{}", supervisor::stop(&installation)?);
            Ok(0)
        }
        "restart" => {
            let installation = Installation::load()?;
            println!("{}", supervisor::stop(&installation)?);
            let pid = supervisor::start(&installation)?;
            println!(
                "Suplex restarted at {}; owned processes: 1 (server#{pid})",
                installation.reachable_address
            );
            Ok(0)
        }
        "update" | "upgrade" => update(arguments).await,
        "migrate" => migrate(),
        "doctor" => doctor(arguments).await,
        "task" => task(arguments),
        "backup" | "verify-backup" | "restore" => backup(command, arguments),
        _ => Err(format!("Unknown command: {command}. Run 'suplex help'.").into()),
    }
}

/// `company rename NAME`: names the company that every host start seeds, while
/// onboarding has not named it yet. A named company keeps its name.
fn company(arguments: &[String]) -> CliResult {
    let [action, name] = arguments else {
        return Err("Usage: suplex company rename NAME".into());
    };
    if action != "rename" {
        return Err("Usage: suplex company rename NAME".into());
    }
    let installation = Installation::load()?;
    let mut database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    let now = Utc::now();
    crate::platform::development::seed_development_data(&mut database, now)?;
    let user = "user_development";
    let companies = crate::identity::companies::list_visible_companies(&database, user)?;
    match companies.as_slice() {
        [seeded] if seeded.name == "My Company" && seeded.issue_code.is_none() => {
            crate::identity::companies::rename_company(&mut database, user, &seeded.id, name, now)?;
            println!("Company name: {}", name.trim());
        }
        _ => println!("The company already has a name. Change it in Suplex settings."),
    }
    Ok(0)
}

fn recover(arguments: &[String]) -> CliResult {
    if !arguments.iter().any(|arg| arg == "--confirm-recovery") {
        return Err("recover requires --confirm-recovery".into());
    }
    let installation = Installation::load()?;
    let mut database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    let metadata = json!({"initiationMethod":"local-cli","installationId":installation.installation_id,"confirmedAt":Utc::now().to_rfc3339()}).to_string();
    let token =
        crate::identity::auth::issue_recovery_invitation(&mut database, &metadata, Utc::now())?;
    let origin = crate::identity::remote_access_repository::external_https_origin(&database)?
        .unwrap_or(installation.reachable_address);
    println!(
        "Recovery link (shown once, works once, expires in 72 hours):\n{origin}/auth?mode=recovery&invite={token}\nOpen it from any browser that reaches this host and log in. That account becomes this host's owner."
    );
    Ok(0)
}

/// Updates the Suplex.app bundle that holds this executable.
async fn update(arguments: &[String]) -> CliResult {
    let assume_yes = arguments.iter().any(|arg| arg == "--yes" || arg == "-y");
    if crate::platform::archive_update::managed() {
        return crate::platform::archive_update::run(assume_yes).await;
    }
    let executable = crate::shared::fs::executable()?.canonicalize()?;
    let Some(app) = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
    else {
        return Err("This Suplex runs from a source checkout. Update it with 'git pull', then run 'suplex restart'.".into());
    };
    app_update::run(app, assume_yes).await
}

fn desktop() -> CliResult {
    let installation = Installation::load()?;
    let url = format!("http://localhost:{}", installation.port);
    if !cfg!(target_os = "macos") {
        // The Linux packages install the app as /usr/bin/Suplex; a running app receives the URL.
        std::process::Command::new("Suplex")
            .arg(format!("--url={url}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| format!("Suplex did not open: {error}"))?;
        println!("Suplex opened at {url}");
        return Ok(0);
    }
    let output = std::process::Command::new("open")
        .args(["-na", "Suplex", "--args", &format!("--url={url}")])
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "Suplex.app did not open: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    println!("Suplex.app opened at {url}");
    Ok(0)
}

fn state_label(state: SchemaState) -> String {
    format!("{state:?}").to_lowercase()
}

fn open_diagnostic_database(
    installation: &Installation,
    verbose: bool,
) -> io::Result<SuplexDatabase> {
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
        all: std::env::var("SUPLEX_LOG_REQUESTS").is_ok_and(|value| value == "1"),
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
    drop(open_diagnostic_database(
        &installation,
        arguments.iter().any(|value| value == "--verbose"),
    )?);
    log_viewer::run(&options, &mut io::stdout().lock())?;
    Ok(0)
}

fn migrate() -> CliResult {
    let installation = Installation::load()?;
    let database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)
        .map_err(|error| error.to_string())?;
    let status = database
        .schema_status()
        .map_err(|error| error.to_string())?;
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
    pub section: &'static str,
    pub name: String,
    pub detail: String,
    pub details: Vec<(String, String)>,
    pub remedy: Option<String>,
}

impl DoctorCheck {
    fn new(
        status: &'static str,
        section: &'static str,
        name: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            status,
            section,
            name: name.into(),
            detail: detail.into(),
            details: Vec::new(),
            remedy: None,
        }
    }
}

const SECTIONS: [&str; 6] = [
    "Installation",
    "Database",
    "Storage",
    "Integrations",
    "Agents",
    "Tasks",
];

fn section_for(id: &str) -> &'static str {
    match id {
        "executable" => "Installation",
        "database" => "Database",
        "artifact-root" | "disk-space" | "backup" => "Storage",
        id if id.starts_with("provider:") => "Agents",
        _ => "Integrations",
    }
}

/// `walMode: true` becomes `("wal mode", "yes")`.
fn detail_rows(details: &Value) -> Vec<(String, String)> {
    let label = |key: &str| {
        key.chars().fold(String::new(), |mut label, c| {
            if c.is_ascii_uppercase() {
                label.push(' ');
            }
            label.push(c.to_ascii_lowercase());
            label
        })
    };
    details
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| {
            let value = match value {
                Value::String(text) if text.is_empty() => "none".into(),
                Value::String(text) => home_relative(Path::new(text)),
                Value::Bool(true) => "yes".into(),
                Value::Bool(false) => "no".into(),
                Value::Null => "none".into(),
                Value::Number(number) if key.ends_with("Bytes") => {
                    format!(
                        "{:.1} GiB",
                        number.as_f64().unwrap_or(0.0) / 1_073_741_824.0
                    )
                }
                Value::Number(number)
                    if key.ends_with("Ms") && number.as_i64().is_some_and(|ms| ms >= 0) =>
                {
                    let minutes = number.as_i64().unwrap_or(0) / 60_000;
                    format!("{}h {}m", minutes / 60, minutes % 60)
                }
                other @ Value::Number(_) | other @ Value::Array(_) | other @ Value::Object(_) => {
                    other.to_string()
                }
            };
            let key = key
                .strip_suffix("Bytes")
                .or_else(|| key.strip_suffix("Ms"))
                .filter(|_| value.ends_with("GiB") || value.ends_with('m'))
                .unwrap_or(key);
            (label(key), value)
        })
        .collect()
}

fn paint(color: bool, code: &str, text: &str) -> String {
    if color {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_owned()
    }
}

/// `codex doctor` style: a notes digest, then each check grouped by section.
pub fn format_doctor(checks: &[DoctorCheck], color: bool, summary: bool) -> String {
    let marker = |status: &str| match status {
        "PASS" => paint(color, "32", "✓"),
        "WARN" => paint(color, "33", "⚠"),
        _ => paint(color, "31", "✗"),
    };
    let line = |check: &DoctorCheck| {
        format!(
            "  {} {:<22} {}\n",
            marker(check.status),
            check.name,
            check.detail
        )
    };
    let rule = paint(color, "2", &"─".repeat(61));
    let mut text = format!(
        "{} {}\n\n",
        paint(
            color,
            "1",
            &format!("Suplex Doctor v{}", env!("CARGO_PKG_VERSION"))
        ),
        paint(
            color,
            "2",
            &format!(
                "· {} · {}-{}",
                env!("SUPLEX_REVISION")
                    .get(..7)
                    .unwrap_or(env!("SUPLEX_REVISION")),
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        )
    );
    let notes = checks
        .iter()
        .filter(|check| check.status != "PASS")
        .collect::<Vec<_>>();
    if !notes.is_empty() {
        text.push_str(&paint(color, "1", "Notes"));
        text.push('\n');
        notes.iter().for_each(|check| text.push_str(&line(check)));
        text.push_str(&rule);
        text.push_str("\n\n");
    }
    for section in SECTIONS {
        let grouped = checks
            .iter()
            .filter(|check| check.section == section)
            .collect::<Vec<_>>();
        if grouped.is_empty() {
            continue;
        }
        text.push_str(&paint(color, "1", section));
        text.push('\n');
        for check in grouped {
            text.push_str(&line(check));
            if !summary {
                let width = check
                    .details
                    .iter()
                    .map(|(label, _)| label.len() + 1)
                    .fold(24, usize::max);
                for (label, value) in &check.details {
                    text.push_str(&paint(
                        color,
                        "2",
                        &format!("      {label:<width$} {value}"),
                    ));
                    text.push('\n');
                }
            }
            if let Some(remedy) = &check.remedy {
                text.push_str(&format!("    {} {remedy}\n", paint(color, "36", "→")));
            }
        }
        text.push('\n');
    }
    let count = |status: &str| checks.iter().filter(|check| check.status == status).count();
    let (ok, warn, fail) = (count("PASS"), count("WARN"), count("FAIL"));
    let verdict = if fail > 0 {
        paint(color, "31", "failing")
    } else if warn > 0 {
        paint(color, "33", "degraded")
    } else {
        paint(color, "32", "healthy")
    };
    text.push_str(&rule);
    text.push_str(&format!(
        "\n{ok} ok · {warn} warn · {fail} fail {verdict}\n"
    ));
    if !summary {
        text.push_str(&paint(color, "2", "\n--summary hide details"));
        text.push('\n');
    }
    text
}

fn home_relative(path: &Path) -> String {
    match std::env::var_os("HOME")
        .and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf))
    {
        Some(relative) => format!("~/{}", relative.display()),
        None => path.display().to_string(),
    }
}

fn installation_checks(installation: &Installation) -> Vec<DoctorCheck> {
    let mut config = DoctorCheck::new(
        "PASS",
        "Installation",
        "config",
        home_relative(&installation.configuration),
    );
    config.details = [
        ("data", &installation.data),
        ("database", &installation.database),
        ("logs", &installation.logs),
        ("repositories", &installation.repositories),
        ("worktrees", &installation.worktrees),
    ]
    .map(|(label, path)| (label.to_owned(), home_relative(path)))
    .to_vec();
    let mut access = DoctorCheck::new(
        "PASS",
        "Installation",
        "access",
        format!(
            "{} · {}",
            installation.access_mode, installation.reachable_address
        ),
    );
    access.details = vec![
        ("bind address".into(), installation.bind_address.clone()),
        ("port".into(), installation.port.to_string()),
    ];
    if installation.access_mode == NetworkAccessMode::Tailscale.as_str() {
        access.details.push((
            "tailscale exposure".into(),
            installation.tailscale_exposure.clone(),
        ));
    }
    let server = if supervisor::host_running(installation) {
        DoctorCheck::new("PASS", "Installation", "server", "running")
    } else {
        let listener = std::process::Command::new("lsof")
            .args([
                "-nP",
                &format!("-iTCP:{}", installation.port),
                "-sTCP:LISTEN",
                "-t",
            ])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|pids| pids.lines().next().map(str::to_owned));
        let mut server = DoctorCheck::new("WARN", "Installation", "server", "not running");
        server.remedy = Some(match listener {
            Some(pid) => {
                let command = std::process::Command::new("ps")
                    .args(["-o", "command=", "-p", &pid])
                    .output()
                    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                    .unwrap_or_default();
                server.detail = format!("not running; port {} is in use", installation.port);
                server.details = vec![
                    ("port owner".into(), format!("pid {pid}")),
                    ("command".into(), home_relative(Path::new(&command))),
                ];
                "Stop the other process, or set SUPLEX_PORT to a free port.".into()
            }
            None => "Run 'suplex up' or open Suplex.app.".into(),
        });
        server
    };
    vec![config, access, server]
}

/// `platform/diagnostics/doctor.ts`: schema, references, host health with
/// every provider, and each unarchived task that waits for a person.
pub async fn run_doctor(
    state: &AppState,
) -> Result<Vec<DoctorCheck>, Box<dyn std::error::Error + Send + Sync>> {
    let (schema, references) = state.with_database(|database| {
        let schema = database
            .schema_status()
            .map_err(|error| error.to_string())?;
        let references = if schema.state == SchemaState::Current {
            database
                .connection()
                .prepare("PRAGMA foreign_key_check")?
                .query_map([], |_| Ok(()))?
                .count()
        } else {
            0
        };
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>((schema, references))
    })?;
    let mut checks = vec![DoctorCheck::new(
        if schema.state == SchemaState::Current {
            "PASS"
        } else {
            "FAIL"
        },
        "Database",
        "schema",
        format!(
            "{} ({}/{} migrations)",
            state_label(schema.state),
            schema.applied.len(),
            schema.expected.len()
        ),
    )];
    if schema.state != SchemaState::Current {
        return Ok(checks);
    }
    checks.push(DoctorCheck::new(
        if references == 0 { "PASS" } else { "FAIL" },
        "Database",
        "references",
        format!("{references} invalid references"),
    ));
    let providers = ["opencode", "claude-code", "codex", "pi", "omp"]
        .map(str::to_owned)
        .to_vec();
    let snapshot = health::snapshot(state, providers, None).await;
    let herdr_required = !state.with_database(|database| crate::terminals::host_enabled(database));
    for check in snapshot["checks"].as_array().into_iter().flatten() {
        let id = check["id"].as_str().unwrap_or_default();
        let required = ["database", "artifact-root", "git"].contains(&id)
            || (herdr_required && id == "herdr-readiness");
        checks.push(DoctorCheck {
            status: if check["status"] == "healthy" {
                "PASS"
            } else if required {
                "FAIL"
            } else {
                "WARN"
            },
            section: section_for(id),
            name: check["label"].as_str().unwrap_or_default().to_owned(),
            detail: check["summary"].as_str().unwrap_or_default().to_owned(),
            details: detail_rows(&check["details"]),
            remedy: check["remedy"].as_str().map(str::to_owned),
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
            None => checks.push(DoctorCheck::new(
                "FAIL",
                "Tasks",
                id,
                "Task control is not available",
            )),
            Some("waiting_human") => checks.push(DoctorCheck::new(
                "WARN",
                "Tasks",
                id,
                question.unwrap_or_else(|| "Answer the task question".into()),
            )),
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
            reachable_address: installation.reachable_address.clone(),
            tailscale_exposure: installation.tailscale_exposure.clone(),
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
    let database = open_diagnostic_database(
        &installation,
        arguments.iter().any(|value| value == "--verbose"),
    )?;
    let mut checks = installation_checks(&installation);
    checks.extend(run_doctor(&diagnostic_state(&installation, database)).await?);
    let color = io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
    let summary = arguments.iter().any(|value| value == "--summary");
    print!("{}", format_doctor(&checks, color, summary));
    Ok(if checks.iter().any(|check| check.status == "FAIL") {
        1
    } else {
        0
    })
}

/// `platform/diagnostics/task.ts` without native observation: the durable
/// control, sessions and turns of one task.
pub fn inspect_task(
    database: &SuplexDatabase,
    task_id: &str,
    all_history: bool,
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
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
                        rusqlite::types::ValueRef::Text(value) => {
                            json!(String::from_utf8_lossy(value))
                        }
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
    let sessions =
        rows("SELECT * FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY kind, generation")?;
    let turns = rows("SELECT * FROM suplex_task_turns WHERE task_id = ?1 ORDER BY created_at, id")?;
    let skip = if all_history {
        0
    } else {
        turns.len().saturating_sub(30)
    };
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
        format!(
            "TASK {}: {}",
            text(&value["taskId"], ""),
            text(&value["title"], "")
        ),
        format!("status      {}", text(&value["control"]["status"], "")),
        format!(
            "question    {}",
            text(&value["control"]["human_question"], "none")
        ),
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
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
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
        ("accessMode", json!(installation.access_mode)),
        ("tailscaleExposure", json!(installation.tailscale_exposure)),
        ("bindAddress", json!(installation.bind_address)),
        ("reachableAddress", json!(installation.reachable_address)),
        ("port", json!(installation.port)),
        ("dataRoot", json!(installation.data)),
        ("databasePath", json!(installation.database)),
        ("artifactRoot", json!(installation.artifacts)),
        ("runtimeRoot", json!(installation.runtime)),
        ("repositoryRoot", json!(installation.repositories)),
        ("worktreeRoot", json!(installation.worktrees)),
        ("installationId", json!(installation.installation_id)),
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

/// A stable installation identity from the database path; the native binary has
/// no `SUPLEX_INSTALLATION_ID`.
pub fn installation_id(database_path: &Path) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(database_path.as_os_str().as_encoded_bytes());
    format!(
        "local-{}",
        digest[..6]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn backup(command: &str, arguments: &[String]) -> CliResult {
    let installation = Installation::load()?;
    let service = backup_service(&installation);
    let archive = arguments.first().map(PathBuf::from);
    match command {
        "backup" => {
            let archive = archive.ok_or("backup requires an archive path")?;
            let created = service
                .create(&archive)
                .map_err(|error| error.to_string())?;
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
            let result = service
                .verify(&archive)
                .map_err(|error| error.to_string())?;
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
            let (Some(archive), Some(destination)) = (archive, arguments.get(1).map(PathBuf::from))
            else {
                return Err("restore requires an archive path and separate destination".into());
            };
            let (verification, restore_ms) = service
                .restore(&archive, &destination)
                .map_err(|error| error.to_string())?;
            let restored = destination.join("suplex-backup/app/suplex.sqlite");
            drop(
                SuplexDatabase::open(&restored, OpenMode::Migrate)
                    .map_err(|error| error.to_string())?,
            );
            let handoff = json!({
                "version": 1,
                "restoredAt": now_millis_rfc3339(),
                "archivePath": verification.archive_path,
                "archiveBytes": std::fs::metadata(&verification.archive_path)?.len(),
                "backupDurationMs": verification.duration_ms as u64,
                "restoreDurationMs": restore_ms as u64,
                "verification": {"valid": verification.valid, "verifiedAt": verification.verified_at, "errors": verification.errors},
                "requiresReauthentication": true,
                "nextSteps": ["Restore repository and worktree paths before starting Suplex", "Sign in to OpenCode and GitHub on the restored host", "Preserve OpenCode session storage to continue existing tasks", "Start Suplex and review any specific recovery question"],
            });
            let path = destination.join("suplex-backup/restore-handoff.json");
            crate::shared::fs::write_private(
                &path,
                format!("{}\n", serde_json::to_string_pretty(&handoff)?).as_bytes(),
            )?;
            println!(
                "backup restored to {}; verification {} ({restore_ms}ms); see suplex-backup/restore-handoff.json",
                destination.display(),
                if verification.valid {
                    "passed"
                } else {
                    "failed"
                }
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
        let database =
            SuplexDatabase::open(&root.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
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
        let text = format_doctor(&checks, false, false);
        assert!(text.starts_with("Suplex Doctor v"));
        assert!(text.contains("\nDatabase\n  ✓ schema                 current ("));
        assert!(text.contains("  ✓ references             0 invalid references\n"));
        assert!(text.contains("  ✓ SQLite database        Schema is current and WAL is enabled\n"));
        assert!(text.contains("      wal mode                 yes\n"));
        assert_eq!(
            detail_rows(&json!({"freeBytes": 1_073_741_824u64, "ageMs": 3_660_000, "path": ""})),
            [
                ("free".into(), "1.0 GiB".into()),
                ("age".into(), "1h 1m".into()),
                ("path".into(), "none".into())
            ]
        );
        assert!(text.contains("  ⚠ Backup verification    No backup has been made yet\n"));
        assert!(text.contains("    → Create a backup in Settings → Backups\n"));
        assert!(!format_doctor(&checks, false, true).contains("wal mode"));
        assert!(!format_doctor(&checks, true, false).is_empty());
        assert!(
            checks
                .iter()
                .any(|check| check.name == "Codex CLI" && check.status != "FAIL")
        );
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
