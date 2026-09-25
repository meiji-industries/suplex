use std::{error::Error, fmt};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use openssl::rand::rand_bytes;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::platform::database::{DatabaseResult, SuplexDatabase};

const SESSION_TTL_DAYS: i64 = 7;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub display_name: String,
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

#[derive(Debug)]
pub struct AuthFailure {
    pub message: &'static str,
    pub status_code: u16,
    pub code: &'static str,
}

impl AuthFailure {
    pub(crate) fn new(message: &'static str, status_code: u16, code: &'static str) -> Self {
        Self {
            message,
            status_code,
            code,
        }
    }
}

impl fmt::Display for AuthFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for AuthFailure {}

fn random_hex_id(prefix: &str) -> DatabaseResult<String> {
    let mut bytes = [0_u8; 16];
    rand_bytes(&mut bytes)?;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{prefix}_{hex}"))
}

fn new_session_token() -> DatabaseResult<String> {
    let mut bytes = [0_u8; 32];
    rand_bytes(&mut bytes)?;
    Ok(format!("session_v1_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn hash_secret(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn public_user(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<Option<AuthUser>> {
    let user = database
        .connection()
        .query_row(
            "SELECT id, display_name, username, avatar_seed, role, status FROM suplex_users WHERE id = ?1",
            [user_id],
            |row| {
                Ok(AuthUser {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    username: row.get(2)?,
                    avatar_seed: row.get(3)?,
                    role: row.get(4)?,
                    status: row.get(5)?,
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
    let now_iso = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let user_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT suplex_users.id FROM suplex_sessions INNER JOIN suplex_users ON suplex_sessions.user_id = suplex_users.id WHERE (suplex_sessions.token_hash = ?1 OR (suplex_sessions.legacy_token_hash = ?1 AND suplex_sessions.legacy_token_expires_at > ?2)) AND suplex_sessions.revoked_at IS NULL AND suplex_users.status = 'active' AND suplex_sessions.expires_at > ?2",
            params![hash_secret(raw_token), now_iso],
            |row| row.get(0),
        )
        .optional()?;
    user_id
        .map(|id| public_user(database, &id))
        .transpose()
        .map(Option::flatten)
}

pub fn bootstrap_required(database: &SuplexDatabase) -> DatabaseResult<bool> {
    let active_admins: i64 = database.connection().query_row(
        "SELECT COUNT(*) FROM suplex_users WHERE role = 'admin' AND status != 'revoked'",
        [],
        |row| row.get(0),
    )?;
    Ok(active_admins == 0)
}

fn create_session(
    database: &SuplexDatabase,
    user_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    let token = new_session_token()?;
    database.connection().execute(
        "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, revoked_at, token_version, legacy_token_hash, legacy_token_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 1, NULL, NULL)",
        params![
            random_hex_id("session")?,
            hash_secret(&token),
            user_id,
            (now + Duration::days(SESSION_TTL_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ],
    )?;
    Ok(token)
}

pub fn development_sign_in(
    database: &mut SuplexDatabase,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthResult> {
    database.transaction(false, |database| {
        let now_iso = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        database.connection().execute(
            "INSERT OR IGNORE INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_development', 'Operator', 'operator@suplex.local', 'operator@suplex.local', 'admin', 'active', ?1, ?1, 1)",
            [now_iso],
        )?;
        let user = public_user(database, "user_development")?.ok_or("development user missing")?;
        if user.role != "admin" || user.status != "active" {
            return Err(Box::new(AuthFailure::new(
                "Development user is unavailable",
                409,
                "auth_failure",
            )));
        }
        let session_token = create_session(database, &user.id, now)?;
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
        params![hash_secret(raw_token), now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
    )?;
    Ok(())
}

pub fn rollover_legacy_session(
    database: &mut SuplexDatabase,
    raw_token: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<String>> {
    if raw_token.is_empty() {
        return Ok(None);
    }
    database.transaction(false, |database| {
        let token = new_session_token()?;
        let old_hash = hash_secret(raw_token);
        let changes = database.connection().execute(
            "UPDATE suplex_sessions SET token_hash = ?2, token_version = 1, legacy_token_hash = ?1, legacy_token_expires_at = ?3 WHERE token_hash = ?1 AND token_version = 0 AND revoked_at IS NULL",
            params![old_hash, hash_secret(&token), (now + Duration::days(SESSION_TTL_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
        )?;
        Ok((changes == 1).then_some(token))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;

    #[test]
    fn session_lookup_development_sign_in_sign_out_and_legacy_rollover() {
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

        let legacy = "suplex_legacy_test_token";
        database.connection().execute(
            "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('legacy_session', ?1, 'user_development', ?2, ?3, 0)",
            params![hash_secret(legacy), (now + Duration::days(7)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true), now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
        ).unwrap();
        let replacement = rollover_legacy_session(&mut database, legacy, now)
            .unwrap()
            .unwrap();
        assert_eq!(
            get_user_by_session(&database, legacy, now).unwrap(),
            Some(signed_in.user.clone())
        );
        assert_eq!(
            get_user_by_session(&database, &replacement, now).unwrap(),
            Some(signed_in.user)
        );
        assert!(
            rollover_legacy_session(&mut database, legacy, now)
                .unwrap()
                .is_none()
        );
        sign_out(&database, legacy, now).unwrap();
        assert!(
            get_user_by_session(&database, &replacement, now)
                .unwrap()
                .is_none()
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
