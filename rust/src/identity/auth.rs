use crate::identity::IdentityError;
use crate::shared::hash::sha256_hex;
use crate::shared::ids::random_hex_id;
use crate::shared::time::rfc3339_millis;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::platform::database::{DatabaseResult, SuplexDatabase};

const SESSION_TTL_DAYS: i64 = 7;

/// Match AuthService's constructor boundary for databases populated after
/// migrations ran, including an older database attached before server start.
pub fn normalize_legacy_users(database: &SuplexDatabase) -> DatabaseResult<usize> {
    Ok(database.connection().execute(
        "UPDATE suplex_users SET username = 'user_v1_' || id, identity_version = 1 WHERE identity_version < 1",
        [],
    )?)
}

pub(crate) fn safe_metadata(raw: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(fields)) => fields
            .into_iter()
            .filter(|(_, value)| value.is_string())
            .collect(),
        _ => Map::new(),
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub display_name: String,
    pub title: String,
    pub username: String,
    pub avatar_seed: String,
    pub role: String,
    pub status: String,
    pub company_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthResult {
    pub user: AuthUser,
    pub session_token: String,
}

#[derive(Default)]
pub struct ProfileUpdate {
    pub display_name: Option<String>,
    pub title: Option<String>,
    pub username: Option<String>,
    pub avatar_seed: Option<String>,
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

pub(crate) fn public_user(
    database: &SuplexDatabase,
    user_id: &str,
) -> DatabaseResult<Option<AuthUser>> {
    let user = database
        .connection()
        .query_row(
            "SELECT id, display_name, username, avatar_seed, role, status, title FROM suplex_users WHERE id = ?1",
            [user_id],
            |row| {
                Ok(AuthUser {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    username: row.get(2)?,
                    avatar_seed: row.get(3)?,
                    role: row.get(4)?,
                    status: row.get(5)?,
                    title: row.get(6)?,
                    company_ids: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut user) = user else {
        return Ok(None);
    };
    if user.avatar_seed.is_empty() {
        user.avatar_seed = user.username.clone();
    }
    let mut statement = database.connection().prepare(
        "SELECT company_id FROM suplex_memberships WHERE user_id = ?1 ORDER BY company_id ASC",
    )?;
    user.company_ids = statement
        .query_map([user_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(Some(user))
}

pub fn get_user_by_session(
    database: &SuplexDatabase,
    raw_token: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<AuthUser>> {
    if raw_token.is_empty() {
        return Ok(None);
    }
    let now_iso = rfc3339_millis(now);
    let user_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT suplex_users.id FROM suplex_sessions INNER JOIN suplex_users ON suplex_sessions.user_id = suplex_users.id WHERE (suplex_sessions.token_hash = ?1 OR (suplex_sessions.legacy_token_hash = ?1 AND suplex_sessions.legacy_token_expires_at > ?2)) AND suplex_sessions.revoked_at IS NULL AND suplex_users.status = 'active' AND suplex_sessions.expires_at > ?2",
            params![sha256_hex(raw_token), now_iso],
            |row| row.get(0),
        )
        .optional()?;
    user_id
        .map(|id| public_user(database, &id))
        .transpose()
        .map(Option::flatten)
}

pub fn get_user_by_session_with_provenance(
    database: &SuplexDatabase,
    raw_token: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<(AuthUser, String)>> {
    if raw_token.is_empty() {
        return Ok(None);
    }
    let now_iso = rfc3339_millis(now);
    let row: Option<(String, String)> = database.connection().query_row(
        "SELECT suplex_users.id, suplex_sessions.provenance FROM suplex_sessions INNER JOIN suplex_users ON suplex_sessions.user_id = suplex_users.id WHERE (suplex_sessions.token_hash = ?1 OR (suplex_sessions.legacy_token_hash = ?1 AND suplex_sessions.legacy_token_expires_at > ?2)) AND suplex_sessions.revoked_at IS NULL AND suplex_users.status = 'active' AND suplex_sessions.expires_at > ?2",
        params![sha256_hex(raw_token), now_iso],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((user_id, provenance)) = row else {
        return Ok(None);
    };
    Ok(public_user(database, &user_id)?.map(|user| (user, provenance)))
}

/// Issue the single-use owner recovery token that `suplex recover` prints.
pub fn issue_recovery_invitation(
    database: &mut SuplexDatabase,
    metadata: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    database.transaction(true, |database| {
        let now_iso = rfc3339_millis(now);
        database.connection().execute(
            "UPDATE suplex_invitations SET replaced_at = ?1 WHERE kind = 'recovery' AND consumed_at IS NULL AND replaced_at IS NULL",
            [&now_iso],
        )?;
        let token = crate::shared::ids::random_secret("invite_v1_recovery")?;
        database.connection().execute(
            "INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, consumed_at, replaced_at, created_at, metadata_json) VALUES (?1, ?2, 'recovery', 'Administrator recovery', NULL, ?3, NULL, NULL, ?4, ?5)",
            params![random_hex_id("invitation")?, sha256_hex(&token), rfc3339_millis(now + Duration::hours(72)), now_iso, metadata],
        )?;
        crate::identity::audit::record(database, &crate::identity::audit::AuditEvent {
            id: &random_hex_id("audit")?, actor_user_id: None, actor_agent_id: None,
            action: "recovery_invitation_created",
            target_user_id: None, company_id: None, metadata_json: metadata, created_at: &now_iso,
        })?;
        Ok(token)
    })
}

pub(crate) fn create_session_with_provenance(
    database: &SuplexDatabase,
    user_id: &str,
    provenance: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    let token = crate::shared::ids::random_secret("session_v1")?;
    database.connection().execute(
        "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, revoked_at, token_version, legacy_token_hash, legacy_token_expires_at, provenance) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 1, NULL, NULL, ?6)",
        params![
            random_hex_id("session")?,
            sha256_hex(&token),
            user_id,
            rfc3339_millis(now + Duration::days(SESSION_TTL_DAYS)),
            rfc3339_millis(now),
            provenance,
        ],
    )?;
    Ok(token)
}

#[cfg(test)]
pub(crate) fn create_session(
    database: &SuplexDatabase,
    user_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    create_session_with_provenance(database, user_id, "passkey", now)
}

pub fn development_sign_in(
    database: &mut SuplexDatabase,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthResult> {
    database.transaction(false, |database| {
        let now_iso = rfc3339_millis(now);
        database.connection().execute(
            "INSERT OR IGNORE INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_development', 'Operator', 'operator@suplex.local', 'operator@suplex.local', 'admin', 'active', ?1, ?1, 1)",
            [now_iso],
        )?;
        let user = public_user(database, "user_development")?.ok_or("development user missing")?;
        if user.role != "admin" || user.status != "active" {
            return Err(IdentityError::auth(
                "Development user is unavailable",
                409,
                "auth_failure",
            ).into());
        }
        let session_token = create_session_with_provenance(database, &user.id, "automatic", now)?;
        Ok(AuthResult {
            user,
            session_token,
        })
    })
}

pub fn sign_out(
    database: &SuplexDatabase,
    raw_token: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    if raw_token.is_empty() {
        return Ok(());
    }
    database.connection().execute(
        "UPDATE suplex_sessions SET revoked_at = ?2 WHERE (token_hash = ?1 OR legacy_token_hash = ?1) AND revoked_at IS NULL",
        params![sha256_hex(raw_token), rfc3339_millis(now)],
    )?;
    Ok(())
}

pub fn update_profile(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    input: ProfileUpdate,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthUser> {
    let display_name = input.display_name.map(|value| js_trim(&value).to_owned());
    if display_name
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.encode_utf16().count() > 120)
    {
        return Err(
            IdentityError::auth("Name must be 1–120 characters", 400, "auth_failure").into(),
        );
    }
    let title = input.title.map(|value| js_trim(&value).to_owned());
    if title
        .as_ref()
        .is_some_and(|value| value.encode_utf16().count() > 120)
    {
        return Err(IdentityError::auth(
            "Title must be 120 characters or fewer",
            400,
            "auth_failure",
        )
        .into());
    }
    let username = input.username.map(|value| js_trim(&value).to_owned());
    if username.as_ref().is_some_and(|value| {
        let bytes = value.as_bytes();
        !(2..=64).contains(&bytes.len())
            || !bytes[0].is_ascii_alphanumeric()
            || !bytes[1..].iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'@' | b'-')
            })
    }) {
        return Err(IdentityError::auth(
            "Username must be 2–64 characters and use letters, numbers, dots, hyphens, underscores, or @",
            400,
            "auth_failure",
        ).into());
    }
    let avatar_seed = input.avatar_seed.map(|value| js_trim(&value).to_owned());
    if avatar_seed
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.encode_utf16().count() > 128)
    {
        return Err(IdentityError::auth("Avatar seed is invalid", 400, "auth_failure").into());
    }
    database.transaction(false, |database| {
        let Some(user) = public_user(database, actor_user_id)? else {
            return Err(IdentityError::auth("Authentication required", 401, "auth_failure").into());
        };
        if user.status != "active" {
            return Err(IdentityError::auth("Authentication required", 401, "auth_failure").into());
        }
        let raw_avatar_seed: String = database.connection().query_row(
            "SELECT avatar_seed FROM suplex_users WHERE id = ?1",
            [actor_user_id],
            |row| row.get(0),
        )?;
        let previous_avatar_seed = if raw_avatar_seed.is_empty() {
            user.username.clone()
        } else {
            raw_avatar_seed.clone()
        };
        let next_display_name = display_name.unwrap_or_else(|| user.display_name.clone());
        let next_title = title.unwrap_or_else(|| user.title.clone());
        let next_username = username.unwrap_or_else(|| user.username.clone());
        let chosen_avatar_seed = avatar_seed.unwrap_or(raw_avatar_seed);
        let next_avatar_seed = if chosen_avatar_seed.is_empty() {
            next_username.clone()
        } else {
            chosen_avatar_seed
        };
        if user.display_name == next_display_name
            && user.title == next_title
            && user.username == next_username
            && previous_avatar_seed == next_avatar_seed
        {
            return Ok(user);
        }
        let now_iso = rfc3339_millis(now);
        if user.username != next_username
            && database
                .connection()
                .execute(
                    "UPDATE suplex_users SET username = ?2, updated_at = ?3 WHERE id = ?1",
                    params![actor_user_id, next_username, now_iso],
                )
                .is_err()
        {
            return Err(
                IdentityError::auth("Username is already in use", 409, "username_taken").into(),
            );
        }
        for (changed, column, value) in [
            (user.title != next_title, "title", &next_title),
            (
                user.display_name != next_display_name,
                "display_name",
                &next_display_name,
            ),
            (
                previous_avatar_seed != next_avatar_seed,
                "avatar_seed",
                &next_avatar_seed,
            ),
        ] {
            if changed {
                database.connection().execute(
                    &format!(
                        "UPDATE suplex_users SET {column} = ?2, updated_at = ?3 WHERE id = ?1"
                    ),
                    params![actor_user_id, value, now_iso],
                )?;
            }
        }
        for (changed, action) in [
            (user.title != next_title, "title_updated"),
            (
                user.display_name != next_display_name,
                "display_name_updated",
            ),
            (user.username != next_username, "username_updated"),
            (previous_avatar_seed != next_avatar_seed, "avatar_updated"),
        ] {
            if changed {
                crate::identity::audit::record(
                    database,
                    &crate::identity::audit::AuditEvent {
                        id: &random_hex_id("audit")?,
                        actor_user_id: Some(actor_user_id),
                        actor_agent_id: None,
                        action,
                        target_user_id: Some(actor_user_id),
                        company_id: None,
                        metadata_json: "{}",
                        created_at: &now_iso,
                    },
                )?;
            }
        }
        public_user(database, actor_user_id)?.ok_or_else(|| "updated user missing".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;

    #[test]
    fn legacy_users_attached_after_migration_normalize_at_auth_startup() {
        let filename =
            std::env::temp_dir().join(format!("{}.sqlite", random_hex_id("suplex_auth").unwrap()));
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('legacy-user', 'Legacy user', 'legacy@suplex.local', 'legacy@suplex.local', 'member', 'active', '2026-09-24T12:00:00.000Z', '2026-09-24T12:00:00.000Z', 0)",
            [],
        ).unwrap();
        drop(database);
        let database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        assert_eq!(normalize_legacy_users(&database).unwrap(), 1);
        let normalized: (String, i64, String, String) = database.connection().query_row(
            "SELECT username, identity_version, avatar_seed, updated_at FROM suplex_users WHERE id = 'legacy-user'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(
            normalized,
            (
                "user_v1_legacy-user".into(),
                1,
                "legacy@suplex.local".into(),
                "2026-09-24T12:00:00.000Z".into(),
            )
        );
        assert_eq!(normalize_legacy_users(&database).unwrap(), 0);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn metadata_filter_keeps_string_entries() {
        let raw = r#"{"first":"one","skip":1,"invitationId":"old"}"#;
        assert_eq!(
            Value::Object(safe_metadata(raw)).to_string(),
            r#"{"first":"one","invitationId":"old"}"#
        );
        assert_eq!(safe_metadata("not json"), Map::new());
    }

    #[test]
    fn session_lookup_development_sign_in_and_sign_out() {
        let filename =
            std::env::temp_dir().join(format!("{}.sqlite", random_hex_id("suplex_auth").unwrap()));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let signed_in = development_sign_in(&mut database, now).unwrap();
        assert_eq!(signed_in.user.id, "user_development");
        assert_eq!(signed_in.user.role, "admin");
        assert_eq!(
            get_user_by_session(&database, &signed_in.session_token, now).unwrap(),
            Some(signed_in.user.clone())
        );
        assert!(
            get_user_by_session(&database, &signed_in.session_token, now + Duration::days(7))
                .unwrap()
                .is_none()
        );
        sign_out(&database, &signed_in.session_token, now).unwrap();
        assert!(
            get_user_by_session(&database, &signed_in.session_token, now)
                .unwrap()
                .is_none()
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn profile_title_persists_clears_and_rejects_oversized_values() {
        let filename =
            std::env::temp_dir().join(format!("{}.sqlite", random_hex_id("suplex_title").unwrap()));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let original = development_sign_in(&mut database, now).unwrap().user;
        assert_eq!(original.title, "");
        let changed = update_profile(
            &mut database,
            &original.id,
            ProfileUpdate {
                title: Some("  CTO  ".into()),
                ..Default::default()
            },
            now,
        )
        .unwrap();
        assert_eq!(changed.title, "CTO");
        drop(database);
        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        assert_eq!(
            public_user(&database, &original.id).unwrap().unwrap().title,
            "CTO"
        );
        assert!(
            update_profile(
                &mut database,
                &original.id,
                ProfileUpdate {
                    title: Some("x".repeat(121)),
                    ..Default::default()
                },
                now
            )
            .is_err()
        );
        assert_eq!(
            public_user(&database, &original.id).unwrap().unwrap().title,
            "CTO"
        );
        let cleared = update_profile(
            &mut database,
            &original.id,
            ProfileUpdate {
                title: Some("  ".into()),
                ..Default::default()
            },
            now,
        )
        .unwrap();
        assert_eq!(cleared.title, "");
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn profile_changes_are_atomic_and_audited_once_per_field() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            random_hex_id("suplex_profile").unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let original = development_sign_in(&mut database, now).unwrap().user;
        database
            .connection()
            .execute(
                "UPDATE suplex_users SET avatar_seed = '' WHERE id = 'user_development'",
                [],
            )
            .unwrap();
        let changed = update_profile(
            &mut database,
            &original.id,
            ProfileUpdate {
                display_name: Some("  Renamed Operator  ".into()),
                username: Some("  operator-new  ".into()),
                avatar_seed: None,
                title: None,
            },
            now,
        )
        .unwrap();
        assert_eq!(changed.display_name, "Renamed Operator");
        assert_eq!(changed.username, "operator-new");
        assert_eq!(changed.avatar_seed, "operator-new");
        let mut statement = database
            .connection()
            .prepare("SELECT action FROM suplex_audit_events ORDER BY rowid")
            .unwrap();
        let actions = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            actions,
            ["display_name_updated", "username_updated", "avatar_updated"]
        );
        drop(statement);
        update_profile(
            &mut database,
            &original.id,
            ProfileUpdate {
                display_name: Some("Renamed Operator".into()),
                username: Some("operator-new".into()),
                avatar_seed: None,
                title: None,
            },
            now,
        )
        .unwrap();
        let count: i64 = database
            .connection()
            .query_row("SELECT COUNT(*) FROM suplex_audit_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('other', 'Other', 'taken', 'taken', 'member', 'active', ?1, ?1, 1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let failure = update_profile(
            &mut database,
            &original.id,
            ProfileUpdate {
                display_name: Some("Should Roll Back".into()),
                username: Some("taken".into()),
                avatar_seed: None,
                title: None,
            },
            now,
        )
        .unwrap_err();
        assert_eq!(
            failure.downcast_ref::<IdentityError>().unwrap().code(),
            "username_taken"
        );
        assert_eq!(
            public_user(&database, &original.id).unwrap().unwrap(),
            changed
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
