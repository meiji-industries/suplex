use crate::identity::IdentityError;
use crate::identity::auth::{UserRole, UserStatus};
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

/// Makes a user an admin or a member. Suplex always keeps one active admin.
/// A demoted admin joins `company_id` (and every company when the plan does
/// not scope members), so the user keeps the access they were working in.
pub fn set_user_role(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    target_user_id: &str,
    role: UserRole,
    company_id: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        companies::require_admin(database, actor_user_id)?;
        let target: Option<(UserRole, UserStatus)> = database
            .connection()
            .query_row(
                "SELECT role, status FROM suplex_users WHERE id = ?1",
                [target_user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((current, status)) = target else {
            return Err(IdentityError::not_found().into());
        };
        if status == UserStatus::Revoked {
            return Err(IdentityError::not_found().into());
        }
        if current == role {
            return Ok(());
        }
        let now_iso = rfc3339_millis(now);
        if role == UserRole::Member {
            if status == UserStatus::Active {
                let other_admins: i64 = database.connection().query_row(
                    "SELECT COUNT(*) FROM suplex_users WHERE role = 'admin' AND status = 'active' AND id != ?1",
                    [target_user_id],
                    |row| row.get(0),
                )?;
                if other_admins == 0 {
                    return Err(IdentityError::auth(
                        "Suplex must keep at least one admin.",
                        409,
                        "last_admin",
                    )
                    .into());
                }
            }
            if let Some(company_id) = company_id {
                companies::require_company_access(database, actor_user_id, company_id)?;
                database.connection().execute(
                    "INSERT OR IGNORE INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, ?2, ?3)",
                    params![target_user_id, company_id, now_iso],
                )?;
            }
            if companies::grants_every_company(database)? {
                database.connection().execute(
                    "INSERT OR IGNORE INTO suplex_memberships (user_id, company_id, created_at) SELECT ?1, id, ?2 FROM suplex_companies WHERE status != 'archived'",
                    params![target_user_id, now_iso],
                )?;
            }
        }
        database.connection().execute(
            "UPDATE suplex_users SET role = ?2, updated_at = ?3 WHERE id = ?1",
            params![target_user_id, role, now_iso],
        )?;
        audit(
            database,
            Some(actor_user_id),
            "user_role_changed",
            Some(target_user_id),
            &serde_json::json!({"role": role.as_str(), "previousRole": current.as_str()}).to_string(),
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

    fn role_database() -> (SuplexDatabase, std::path::PathBuf, DateTime<Utc>) {
        let path =
            std::env::temp_dir().join(format!("{}.sqlite", random_hex_id("suplex_admin").unwrap()));
        let database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        (database, path, now)
    }

    fn insert_user(
        database: &SuplexDatabase,
        id: &str,
        role: &str,
        status: &str,
        now: DateTime<Utc>,
    ) {
        database
            .connection()
            .execute(
                "INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES (?1, ?1, ?1, ?1, ?2, ?3, ?4, ?4, 1)",
                params![id, role, status, rfc3339_millis(now)],
            )
            .unwrap();
    }

    fn role_of(database: &SuplexDatabase, id: &str) -> UserRole {
        database
            .connection()
            .query_row("SELECT role FROM suplex_users WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn status_of(error: Box<dyn std::error::Error + Send + Sync>) -> u16 {
        error.downcast_ref::<IdentityError>().unwrap().status()
    }

    fn role_audit_count(database: &SuplexDatabase) -> i64 {
        database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'user_role_changed'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn role_changes_promote_demote_and_audit() {
        let (mut database, path, now) = role_database();
        let admin = auth::development_sign_in(&mut database, now)
            .unwrap()
            .user
            .id;
        insert_user(&database, "user_member", "member", "pending", now);
        set_user_role(
            &mut database,
            &admin,
            "user_member",
            UserRole::Admin,
            None,
            now,
        )
        .unwrap();
        assert_eq!(role_of(&database, "user_member"), UserRole::Admin);
        let (actor, target, metadata): (String, String, String) = database
            .connection()
            .query_row(
                "SELECT actor_user_id, target_user_id, metadata_json FROM suplex_audit_events WHERE action = 'user_role_changed'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (actor.as_str(), target.as_str()),
            (admin.as_str(), "user_member")
        );
        assert_eq!(
            serde_json::from_str::<Value>(&metadata).unwrap(),
            serde_json::json!({"role": "admin", "previousRole": "member"})
        );
        // A no-op succeeds and records nothing.
        set_user_role(
            &mut database,
            &admin,
            "user_member",
            UserRole::Admin,
            None,
            now,
        )
        .unwrap();
        assert_eq!(role_audit_count(&database), 1);
        set_user_role(
            &mut database,
            &admin,
            "user_member",
            UserRole::Member,
            None,
            now,
        )
        .unwrap();
        assert_eq!(role_of(&database, "user_member"), UserRole::Member);
        assert_eq!(role_audit_count(&database), 2);
        drop(database);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn last_active_admin_cannot_be_demoted() {
        let (mut database, path, now) = role_database();
        let admin = auth::development_sign_in(&mut database, now)
            .unwrap()
            .user
            .id;
        insert_user(&database, "user_pending_admin", "admin", "pending", now);
        // A pending admin does not count as an active admin.
        let error =
            set_user_role(&mut database, &admin, &admin, UserRole::Member, None, now).unwrap_err();
        assert_eq!(status_of(error), 409);
        assert_eq!(role_of(&database, &admin), UserRole::Admin);
        assert_eq!(role_audit_count(&database), 0);
        // With a second active admin, self-demotion works.
        insert_user(&database, "user_second", "admin", "active", now);
        set_user_role(&mut database, &admin, &admin, UserRole::Member, None, now).unwrap();
        assert_eq!(role_of(&database, &admin), UserRole::Member);
        // The former admin is not an admin any more, so the last one stays.
        let error = set_user_role(
            &mut database,
            &admin,
            "user_second",
            UserRole::Member,
            None,
            now,
        )
        .unwrap_err();
        assert_eq!(status_of(error), 404);
        let error = set_user_role(
            &mut database,
            "user_second",
            "user_second",
            UserRole::Member,
            None,
            now,
        )
        .unwrap_err();
        assert_eq!(status_of(error), 409);
        assert_eq!(role_of(&database, "user_second"), UserRole::Admin);
        // Another admin can demote a pending admin.
        set_user_role(
            &mut database,
            "user_second",
            "user_pending_admin",
            UserRole::Member,
            None,
            now,
        )
        .unwrap();
        drop(database);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn role_change_rejects_missing_revoked_and_non_admin() {
        let (mut database, path, now) = role_database();
        let admin = auth::development_sign_in(&mut database, now)
            .unwrap()
            .user
            .id;
        insert_user(&database, "user_revoked", "member", "revoked", now);
        insert_user(&database, "user_member", "member", "active", now);
        for target in ["user_missing", "user_revoked"] {
            let error = set_user_role(&mut database, &admin, target, UserRole::Admin, None, now)
                .unwrap_err();
            assert_eq!(status_of(error), 404);
        }
        let error = set_user_role(
            &mut database,
            "user_member",
            &admin,
            UserRole::Member,
            None,
            now,
        )
        .unwrap_err();
        assert_eq!(status_of(error), 404);
        let error = set_user_role(
            &mut database,
            "user_member",
            "user_member",
            UserRole::Admin,
            None,
            now,
        )
        .unwrap_err();
        assert_eq!(status_of(error), 404);
        assert_eq!(role_of(&database, "user_revoked"), UserRole::Member);
        assert_eq!(role_of(&database, &admin), UserRole::Admin);
        assert_eq!(role_of(&database, "user_member"), UserRole::Member);
        assert_eq!(role_audit_count(&database), 0);
        drop(database);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn demoted_admin_keeps_the_company() {
        let (mut database, path, now) = role_database();
        let admin = auth::development_sign_in(&mut database, now)
            .unwrap()
            .user
            .id;
        insert_user(&database, "user_second", "admin", "active", now);
        let company =
            companies::create_company(&mut database, &admin, "Demotion Company", now).unwrap();
        assert!(
            auth::public_user(&database, "user_second")
                .unwrap()
                .unwrap()
                .company_ids
                .is_empty()
        );
        set_user_role(
            &mut database,
            &admin,
            "user_second",
            UserRole::Member,
            Some(&company.id),
            now,
        )
        .unwrap();
        let demoted = auth::public_user(&database, "user_second")
            .unwrap()
            .unwrap();
        assert_eq!(demoted.role, UserRole::Member);
        assert!(demoted.company_ids.contains(&company.id));
        let error = set_user_role(
            &mut database,
            &admin,
            "user_second",
            UserRole::Admin,
            Some("company_missing"),
            now,
        )
        .and_then(|()| {
            set_user_role(
                &mut database,
                &admin,
                "user_second",
                UserRole::Member,
                Some("company_missing"),
                now,
            )
        });
        assert_eq!(status_of(error.unwrap_err()), 404);
        assert_eq!(role_of(&database, "user_second"), UserRole::Admin);
        drop(database);
        let _ = std::fs::remove_file(&path);
    }
}
