use crate::identity::IdentityError;
use crate::shared::ids::random_hex_id;
use crate::shared::time::rfc3339_millis;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use getrandom::fill as rand_bytes;
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
pub struct IssuedInvitation {
    pub token: String,
    pub kind: String,
    pub expires_at: String,
    pub user: AuthUser,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationSummary {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub expires_at: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub user_id: String,
    pub credential_id: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_user_id: Option<String>,
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
        &random_hex_id("audit")?,
        (actor_user_id, None),
        action,
        target_user_id,
        None,
        metadata_json,
        &rfc3339_millis(now),
    )?;
    Ok(())
}

fn valid_display_name(raw: &str) -> DatabaseResult<String> {
    let name = auth::js_trim(raw);
    if name.is_empty() || name.encode_utf16().count() > 120 {
        return Err(IdentityError::auth("Display name is invalid", 400, "auth_failure").into());
    }
    Ok(name.to_owned())
}

pub fn invite_user(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    raw_display_name: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<IssuedInvitation> {
    let display_name = valid_display_name(raw_display_name)?;
    database.transaction(false, |database| {
        companies::require_admin(database, actor_user_id)?;
        let user_id = random_hex_id("user")?;
        let neutral_username = format!("user_v1_{user_id}");
        let now_iso = rfc3339_millis(now);
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES (?1, ?2, ?3, ?3, 'member', 'pending', ?4, ?4, 1)",
            params![user_id, display_name, neutral_username, now_iso],
        )?;
        let mut secret = [0_u8; 32];
        rand_bytes(&mut secret)?;
        let token = format!("invite_v1_user_{}", URL_SAFE_NO_PAD.encode(secret));
        let hash = crate::shared::hash::sha256_hex(token.as_bytes());
        let expires_at = rfc3339_millis(now + Duration::hours(72));
        database.connection().execute(
            "INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, consumed_at, replaced_at, created_at, metadata_json) VALUES (?1, ?2, 'user', ?3, ?4, ?5, NULL, NULL, ?6, '{}')",
            params![random_hex_id("invitation")?, hash, display_name, user_id, expires_at, now_iso],
        )?;
        audit(database, None, "user_invitation_created", Some(&user_id), "{}", now)?;
        audit(database, Some(actor_user_id), "user_invited", Some(&user_id), "{}", now)?;
        Ok(IssuedInvitation {
            token,
            kind: "user".to_owned(),
            expires_at,
            user: auth::public_user(database, &user_id)?.ok_or("invited user missing")?,
        })
    })
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

pub fn list_invitations(
    database: &SuplexDatabase,
    actor_user_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Vec<InvitationSummary>> {
    companies::require_admin(database, actor_user_id)?;
    let mut statement = database.connection().prepare("SELECT id, kind, display_name, expires_at, consumed_at, replaced_at, created_at FROM suplex_invitations ORDER BY created_at DESC, id DESC")?;
    let rows = statement.query_map([], |row| {
        let expires_at: String = row.get(3)?;
        let consumed_at: Option<String> = row.get(4)?;
        let replaced_at: Option<String> = row.get(5)?;
        let expired = DateTime::parse_from_rfc3339(&expires_at)
            .is_ok_and(|time| time.timestamp_millis() <= now.timestamp_millis());
        Ok(InvitationSummary {
            id: row.get(0)?,
            kind: row.get(1)?,
            display_name: row.get(2)?,
            expires_at,
            status: if consumed_at.is_some() {
                "consumed"
            } else if replaced_at.is_some() {
                "replaced"
            } else if expired {
                "expired"
            } else {
                "active"
            }
            .to_owned(),
            created_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_credentials(
    database: &SuplexDatabase,
    actor_user_id: &str,
) -> DatabaseResult<Vec<CredentialSummary>> {
    companies::require_admin(database, actor_user_id)?;
    let mut statement = database.connection().prepare("SELECT id, user_id, credential_id, created_at, revoked_at FROM suplex_credentials ORDER BY created_at ASC, id ASC")?;
    Ok(statement
        .query_map([], |row| {
            Ok(CredentialSummary {
                id: row.get(0)?,
                user_id: row.get(1)?,
                credential_id: row.get(2)?,
                created_at: row.get(3)?,
                revoked_at: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn revoke_credential(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    credential_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        companies::require_admin(database, actor_user_id)?;
        let credential: Option<(String, Option<String>)> = database
            .connection()
            .query_row(
                "SELECT user_id, revoked_at FROM suplex_credentials WHERE id = ?1",
                [credential_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((user_id, None)) = credential else {
            return Err(IdentityError::not_found().into());
        };
        if user_id == actor_user_id {
            return Err(IdentityError::not_found().into());
        }
        database.connection().execute(
            "UPDATE suplex_credentials SET revoked_at = ?2 WHERE id = ?1",
            params![credential_id, rfc3339_millis(now)],
        )?;
        audit(
            database,
            Some(actor_user_id),
            "credential_revoked",
            Some(&user_id),
            "{}",
            now,
        )
    })
}

pub fn revoke_user(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    target_user_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        companies::require_admin(database, actor_user_id)?;
        let status: Option<String> = database.connection().query_row("SELECT status FROM suplex_users WHERE id = ?1", [target_user_id], |row| row.get(0)).optional()?;
        if status.is_none() || status.as_deref() == Some("revoked") || target_user_id == actor_user_id {
            return Err(IdentityError::not_found().into());
        }
        let now_iso = rfc3339_millis(now);
        database.connection().execute("UPDATE suplex_users SET status = 'revoked', updated_at = ?2 WHERE id = ?1", params![target_user_id, now_iso])?;
        database.connection().execute("UPDATE suplex_credentials SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL", params![target_user_id, now_iso])?;
        database.connection().execute("UPDATE suplex_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL", params![target_user_id, now_iso])?;
        audit(database, Some(actor_user_id), "user_revoked", Some(target_user_id), "{}", now)
    })
}

pub fn list_audit_events(
    database: &SuplexDatabase,
    actor_user_id: &str,
) -> DatabaseResult<Vec<AuditEvent>> {
    companies::require_admin(database, actor_user_id)?;
    let mut statement = database.connection().prepare("SELECT id, actor_user_id, action, target_user_id, company_id, metadata_json, created_at FROM suplex_audit_events ORDER BY created_at ASC, id ASC")?;
    Ok(statement
        .query_map([], |row| {
            let raw: String = row.get(5)?;
            Ok(AuditEvent {
                id: row.get(0)?,
                actor_user_id: row.get(1)?,
                action: row.get(2)?,
                target_user_id: row.get(3)?,
                company_id: row.get(4)?,
                metadata: Value::Object(auth::safe_metadata(&raw)),
                created_at: row.get(6)?,
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
        let events = list_audit_events(&database, &admin.user.id).unwrap();
        assert_eq!(
            events[0].metadata,
            serde_json::json!({"first":"one","second":"two"})
        );
        drop(database);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn invitation_and_revocation_keep_shared_database_lifecycle() {
        let path =
            std::env::temp_dir().join(format!("{}.sqlite", random_hex_id("suplex_admin").unwrap()));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap();
        let invalid = invite_user(&mut database, "missing", "  ", now).unwrap_err();
        assert_eq!(
            invalid.downcast_ref::<IdentityError>().unwrap().status(),
            400
        );
        let issued = invite_user(&mut database, &admin.user.id, "  API member  ", now).unwrap();
        assert!(issued.token.starts_with("invite_v1_user_"));
        assert_eq!(issued.user.display_name, "API member");
        assert_eq!(issued.user.status, "pending");
        assert_eq!(issued.user.username, format!("user_v1_{}", issued.user.id));
        let token_hash = crate::shared::hash::sha256_hex(issued.token.as_bytes());
        let stored_hash: String = database
            .connection()
            .query_row(
                "SELECT token_hash FROM suplex_invitations WHERE user_id = ?1",
                [&issued.user.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_hash, token_hash);
        assert_eq!(list_users(&database, &admin.user.id).unwrap().len(), 2);
        database
            .connection()
            .execute(
                "UPDATE suplex_users SET status = 'active' WHERE id = ?1",
                [&issued.user.id],
            )
            .unwrap();
        let member_list = list_users(&database, &issued.user.id).unwrap_err();
        assert_eq!(
            member_list
                .downcast_ref::<IdentityError>()
                .unwrap()
                .status(),
            404
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_users SET status = 'pending' WHERE id = ?1",
                [&issued.user.id],
            )
            .unwrap();
        assert_eq!(
            list_invitations(&database, &admin.user.id, now).unwrap()[0].status,
            "active"
        );
        assert_eq!(
            list_invitations(&database, &admin.user.id, now + Duration::hours(72)).unwrap()[0]
                .status,
            "expired"
        );
        let credential_id = random_hex_id("credential").unwrap();
        database.connection().execute(
            "INSERT INTO suplex_credentials (id, user_id, credential_id, public_key, counter, transports, created_at) VALUES (?1, ?2, 'member-passkey', X'00', 0, '[]', ?3)",
            params![credential_id, issued.user.id, rfc3339_millis(now)],
        ).unwrap();
        assert_eq!(
            list_credentials(&database, &admin.user.id).unwrap().len(),
            1
        );
        revoke_credential(&mut database, &admin.user.id, &credential_id, now).unwrap();
        assert!(
            list_credentials(&database, &admin.user.id).unwrap()[0]
                .revoked_at
                .is_some()
        );
        let duplicate =
            revoke_credential(&mut database, &admin.user.id, &credential_id, now).unwrap_err();
        assert_eq!(
            duplicate.downcast_ref::<IdentityError>().unwrap().status(),
            404
        );
        revoke_user(&mut database, &admin.user.id, &issued.user.id, now).unwrap();
        assert_eq!(
            list_users(&database, &admin.user.id).unwrap()[1].status,
            "revoked"
        );
        assert_eq!(
            list_audit_events(&database, &admin.user.id).unwrap().len(),
            4
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
        assert_eq!(
            actions,
            [
                "user_invitation_created",
                "user_invited",
                "credential_revoked",
                "user_revoked"
            ]
        );
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
