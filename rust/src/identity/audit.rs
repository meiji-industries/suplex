//! Append an audit event inside the caller's transaction.
use crate::platform::database::{DatabaseResult, SuplexDatabase};
use rusqlite::params;

pub fn record(
    database: &SuplexDatabase,
    id: &str,
    actor: (Option<&str>, Option<&str>),
    action: &str,
    target_user_id: Option<&str>,
    company_id: Option<&str>,
    metadata_json: &str,
    created_at: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, actor.0, actor.1, action, target_user_id, company_id, metadata_json, created_at],
    )?;
    Ok(())
}
