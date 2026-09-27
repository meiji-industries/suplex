//! Append an audit event inside the caller's transaction.
use crate::platform::database::{DatabaseResult, SuplexDatabase};
use rusqlite::params;

/// One `suplex_audit_events` row.
pub struct AuditEvent<'a> {
    pub id: &'a str,
    pub actor_user_id: Option<&'a str>,
    pub actor_agent_id: Option<&'a str>,
    pub action: &'a str,
    pub target_user_id: Option<&'a str>,
    pub company_id: Option<&'a str>,
    pub metadata_json: &'a str,
    pub created_at: &'a str,
}

pub fn record(database: &SuplexDatabase, event: &AuditEvent<'_>) -> DatabaseResult<()> {
    let AuditEvent {
        id,
        actor_user_id,
        actor_agent_id,
        action,
        target_user_id,
        company_id,
        metadata_json,
        created_at,
    } = event;
    database.connection().execute(
        "INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at],
    )?;
    Ok(())
}
