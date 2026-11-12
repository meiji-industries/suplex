//! The merge turn: soft coordination so that one task at a time on this host
//! requests a merge into a repository and base branch.
//!
//! The turn is Suplex-owned task intent, not a copy of GitHub state, and it
//! never refuses an operation. A task that finds another live task holding the
//! turn parks on a `merge_turn` delivery wait and retries automatically. A turn
//! heals itself: it expires after [`TURN_SECONDS`] without renewal, and a turn
//! whose holder is cancelled, delivered, archived, or gone is free.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, params};

use crate::{
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::time::rfc3339_millis,
};

/// A turn that is not renewed for this long is free.
pub const TURN_SECONDS: i64 = 600;

/// The holder task still works toward delivery.
const LIVE_HOLDER: &str = "EXISTS (SELECT 1 FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = suplex_merge_turns.holder_task_id AND c.status IN ('active', 'waiting_human') AND t.archived_at IS NULL)";

/// One turn key. GitHub repository names are case-insensitive.
fn repository_key(repository: &str) -> String {
    repository.to_ascii_lowercase()
}

/// Take the turn for `task_id` in one statement. The turn is free when nobody
/// holds it, when this task holds it, when it expired, or when its holder is no
/// longer live. Returns the other live holder when the turn is not free.
pub fn acquire(
    database: &SuplexDatabase,
    repository: &str,
    base_branch: &str,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<String>> {
    let repository = repository_key(repository);
    let at = rfc3339_millis(now);
    let expires = rfc3339_millis(now + Duration::seconds(TURN_SECONDS));
    // A holder can finish between the two statements; then the next attempt takes the turn.
    for _ in 0..3 {
        let taken = database.connection().execute(
            &format!(
                "INSERT INTO suplex_merge_turns (repository, base_branch, holder_task_id, acquired_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (repository, base_branch) DO UPDATE SET
                   acquired_at = CASE WHEN suplex_merge_turns.holder_task_id = excluded.holder_task_id THEN suplex_merge_turns.acquired_at ELSE excluded.acquired_at END,
                   holder_task_id = excluded.holder_task_id,
                   expires_at = excluded.expires_at
                 WHERE suplex_merge_turns.holder_task_id = excluded.holder_task_id
                   OR suplex_merge_turns.expires_at <= excluded.acquired_at
                   OR NOT {LIVE_HOLDER}"
            ),
            params![repository, base_branch, task_id, at, expires],
        )?;
        if taken == 1 {
            return Ok(None);
        }
        if let Some(holder) = holder(database, &repository, base_branch, task_id, now)? {
            return Ok(Some(holder));
        }
    }
    Ok(Some("another task".into()))
}

/// The other live task that holds an unexpired turn, if any.
pub fn holder(
    database: &SuplexDatabase,
    repository: &str,
    base_branch: &str,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<String>> {
    Ok(database
        .connection()
        .query_row(
            &format!(
                "SELECT holder_task_id FROM suplex_merge_turns WHERE repository = ?1 AND base_branch = ?2 AND holder_task_id <> ?3 AND expires_at > ?4 AND {LIVE_HOLDER}"
            ),
            params![
                repository_key(repository),
                base_branch,
                task_id,
                rfc3339_millis(now)
            ],
            |row| row.get(0),
        )
        .optional()?)
}

/// Extend every turn `task_id` holds while it waits on its own merge.
pub fn renew(database: &SuplexDatabase, task_id: &str, now: DateTime<Utc>) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_merge_turns SET expires_at = ?1 WHERE holder_task_id = ?2",
        params![
            rfc3339_millis(now + Duration::seconds(TURN_SECONDS)),
            task_id
        ],
    )?;
    Ok(())
}

/// Give up every turn `task_id` holds.
pub fn release(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<()> {
    database.connection().execute(
        "DELETE FROM suplex_merge_turns WHERE holder_task_id = ?1",
        [task_id],
    )?;
    Ok(())
}
