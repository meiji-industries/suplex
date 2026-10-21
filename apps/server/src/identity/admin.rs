use crate::identity::IdentityError;
use crate::identity::auth::UserStatus;
use crate::shared::ids::random_hex_id;
use crate::shared::time::rfc3339_millis;
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use crate::platform::database::{DatabaseResult, SuplexDatabase};

use super::{
    auth::{self, AuthUser},
    companies,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_agent_id: Option<String>,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_id: Option<String>,
    pub metadata: Value,
    pub created_at: String,
}

fn audit(
    database: &SuplexDatabase,
    actor_user_id: Option<&str>,
    action: &str,
    target_user_id: Option<&str>,
    metadata_json: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    crate::identity::audit::record(
        database,
        &crate::identity::audit::AuditEvent {
            id: &random_hex_id("audit")?,
            actor_user_id,
            actor_agent_id: None,
            action,
            target_user_id,
            company_id: None,
            metadata_json,
            created_at: &rfc3339_millis(now),
        },
    )?;
    Ok(())
}

pub fn list_users(database: &SuplexDatabase, actor_user_id: &str) -> DatabaseResult<Vec<AuthUser>> {
    companies::require_admin(database, actor_user_id)?;
    let mut statement = database
        .connection()
        .prepare("SELECT id FROM suplex_users ORDER BY created_at ASC")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter()
        .map(|id| auth::public_user(database, id)?.ok_or_else(|| "listed user missing".into()))
        .collect()
}

pub fn revoke_user(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    target_user_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        companies::require_admin(database, actor_user_id)?;
        let status: Option<UserStatus> = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_users WHERE id = ?1",
                [target_user_id],
                |row| row.get(0),
            )
            .optional()?;
        if status.is_none()
            || status == Some(UserStatus::Revoked)
            || target_user_id == actor_user_id
        {
            return Err(IdentityError::not_found().into());
        }
        let now_iso = rfc3339_millis(now);
        database.connection().execute(
            "UPDATE suplex_users SET status = 'revoked', updated_at = ?2 WHERE id = ?1",
            params![target_user_id, now_iso],
        )?;
        database.connection().execute(
            "UPDATE suplex_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL",
            params![target_user_id, now_iso],
        )?;
        audit(
            database,
            Some(actor_user_id),
            "user_revoked",
            Some(target_user_id),
            "{}",
            now,
        )
    })
}

pub fn list_audit_events(
    database: &SuplexDatabase,
    actor_user_id: &str,
) -> DatabaseResult<Vec<AuditEvent>> {
    companies::require_admin(database, actor_user_id)?;
    let mut statement = database.connection().prepare("SELECT id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at FROM suplex_audit_events ORDER BY created_at ASC, id ASC")?;
    Ok(statement
        .query_map([], |row| {
            let raw: String = row.get(6)?;
            Ok(AuditEvent {
                id: row.get(0)?,
                actor_user_id: row.get(1)?,
                actor_agent_id: row.get(2)?,
                action: row.get(3)?,
                target_user_id: row.get(4)?,
                company_id: row.get(5)?,
                metadata: Value::Object(auth::safe_metadata(&raw)),
                created_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;

    #[test]
    fn audit_listing_filters_nonstring_metadata() {
        let path =
            std::env::temp_dir().join(format!("{}.sqlite", random_hex_id("suplex_admin").unwrap()));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap();
        database.connection().execute(
            r#"INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES ('audit_fixed', 'user_development', NULL, 'fixture', NULL, NULL, '{"first":"one","second":"two","skip":1}', '2026-09-24T12:00:00.000Z')"#,
            [],
        ).unwrap();
        database.connection().execute_batch(
            r#"INSERT INTO suplex_agents (id, kind, name, avatar_seed, created_at, updated_at) VALUES ('agent_fixed', 'external', 'Agent', 'seed', 'now', 'now');
            INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES ('audit_agent', NULL, 'agent_fixed', 'task_force_started', NULL, NULL, '{}', '2026-09-24T12:00:01.000Z')"#,
        ).unwrap();
        let events = list_audit_events(&database, &admin.user.id).unwrap();
        assert_eq!(
            events[0].metadata,
            serde_json::json!({"first":"one","second":"two"})
        );
        assert_eq!(events[1].actor_agent_id.as_deref(), Some("agent_fixed"));
        assert_eq!(events[1].actor_user_id, None);
        drop(database);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn listing_and_revocation_keep_shared_database_lifecycle() {
        let path =
            std::env::temp_dir().join(format!("{}.sqlite", random_hex_id("suplex_admin").unwrap()));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap();
        let member = "user_member";
        database
            .connection()
            .execute(
                "INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES (?1, 'API member', ?1, ?1, 'member', 'pending', ?2, ?2, 1)",
                params![member, rfc3339_millis(now)],
            )
            .unwrap();
        assert_eq!(list_users(&database, &admin.user.id).unwrap().len(), 2);
        database
            .connection()
            .execute(
                "UPDATE suplex_users SET status = 'active' WHERE id = ?1",
                [member],
            )
            .unwrap();
        let member_list = list_users(&database, member).unwrap_err();
        assert_eq!(
            member_list
                .downcast_ref::<IdentityError>()
                .unwrap()
                .status(),
            404
        );
        revoke_user(&mut database, &admin.user.id, member, now).unwrap();
        let users = list_users(&database, &admin.user.id).unwrap();
        assert_eq!(
            users.iter().find(|user| user.id == member).unwrap().status,
            UserStatus::Revoked
        );
        assert_eq!(
            list_audit_events(&database, &admin.user.id).unwrap().len(),
            1
        );
        let mut audit_statement = database
            .connection()
            .prepare("SELECT action FROM suplex_audit_events ORDER BY rowid ASC")
            .unwrap();
        let actions = audit_statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(actions, ["user_revoked"]);
        drop(audit_statement);
        let self_revoke =
            revoke_user(&mut database, &admin.user.id, &admin.user.id, now).unwrap_err();
        assert_eq!(
            self_revoke
                .downcast_ref::<IdentityError>()
                .unwrap()
                .status(),
            404
        );
    }
}
