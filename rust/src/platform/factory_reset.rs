//! `platform/factory-reset.ts`: replaces the live database with a freshly
//! migrated one and deletes artifacts and provider homes. Backups, worktrees and
//! repositories stay on disk. Live native sessions block the reset, because
//! their agents would keep running with no task to stop them.

use std::{fs, path::Path};

use rusqlite::{Connection, OptionalExtension};

use super::database::{DatabaseResult, OpenMode, SuplexDatabase};

pub const LIVE_SESSIONS_BLOCK_RESET: &str =
    "Cancel active tasks and wait for their sessions to stop before you factory reset Suplex";

#[derive(Debug)]
pub struct LiveSessionsBlockReset;

impl std::fmt::Display for LiveSessionsBlockReset {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(LIVE_SESSIONS_BLOCK_RESET)
    }
}

impl std::error::Error for LiveSessionsBlockReset {}

pub fn factory_reset(
    database: &SuplexDatabase,
    database_path: &Path,
    artifact_root: &Path,
) -> DatabaseResult<()> {
    let live = database
        .connection()
        .query_row(
            "SELECT 1 FROM suplex_task_controls WHERE status IN ('active', 'waiting_human') UNION ALL SELECT 1 FROM suplex_task_sessions WHERE stop_requested_at IS NOT NULL AND stopped_at IS NULL LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?;
    if live.is_some() {
        return Err(Box::new(LiveSessionsBlockReset));
    }
    let staging = std::env::temp_dir().join(format!(
        "suplex-factory-reset-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&staging)?;
    let result = (|| -> DatabaseResult<()> {
        let path = staging.join("suplex.sqlite");
        drop(SuplexDatabase::open(&path, OpenMode::Migrate)?);
        // SQLite's backup API swaps the pages under open connections, which see the empty database on their next read.
        Connection::open(&path)?.backup(rusqlite::MAIN_DB, database_path, None)?;
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    result?;
    match fs::remove_dir_all(artifact_root) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    fs::create_dir_all(artifact_root)?;
    let provider_instances = database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("provider-instances");
    match fs::remove_dir_all(provider_instances) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}
