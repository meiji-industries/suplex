use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, params};

use crate::{
    identity::{IdentityError, auth, webauthn::StoredCredential},
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::{ids::random_hex_id, time::rfc3339_millis},
};

fn passkey_failure() -> Box<dyn std::error::Error> {
    IdentityError::auth("Passkey verification failed", 400, "passkey_invalid").into()
}

pub fn insert_self_challenge(
    database: &SuplexDatabase,
    challenge_id: &str,
    challenge: &str,
    user_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.connection().execute(
        "INSERT INTO suplex_challenges (id, challenge, kind, invitation_id, user_id, expires_at, consumed_at, created_at) VALUES (?1, ?2, 'self_registration', NULL, ?3, ?4, NULL, ?5)",
        params![challenge_id, challenge, user_id, rfc3339_millis(now + Duration::minutes(5)), rfc3339_millis(now)],
    )?;
    Ok(())
}

pub fn consume_self_challenge(
    database: &mut SuplexDatabase,
    challenge_id: &str,
    user_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    database.transaction(false, |database| {
        let row = database.connection().query_row(
            "SELECT challenge, user_id, expires_at, consumed_at FROM suplex_challenges WHERE id = ?1 AND kind = 'self_registration'",
            [challenge_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
        ).optional()?;
        let Some((challenge, challenge_user_id, expires_at, consumed_at)) = row else {
            return Err(passkey_failure());
        };
        if challenge_user_id.as_deref() != Some(user_id)
            || consumed_at.is_some()
            || DateTime::parse_from_rfc3339(&expires_at)
                .is_ok_and(|expires| expires.timestamp_millis() <= now.timestamp_millis())
        {
            return Err(passkey_failure());
        }
        let updated = database.connection().execute(
            "UPDATE suplex_challenges SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL AND user_id = ?3",
            params![challenge_id, rfc3339_millis(now), user_id],
        )?;
        if updated != 1 {
            return Err(passkey_failure());
        }
        Ok(challenge)
    })
}

pub fn insert_self_credential(
    database: &mut SuplexDatabase,
    user_id: &str,
    credential: &StoredCredential,
    label: &str,
    rp_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        let active = auth::public_user(database, user_id)?
            .is_some_and(|user| user.status == "active");
        if !active {
            return Err(passkey_failure());
        }
        let result = database.connection().execute(
            "INSERT INTO suplex_credentials (id, user_id, credential_id, public_key, counter, transports, created_at, revoked_at, label, rp_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)",
            params![random_hex_id("credential")?, user_id, credential.id, credential.public_key, credential.counter, serde_json::to_string(&credential.transports)?, rfc3339_millis(now), label, rp_id],
        );
        match result {
            Ok(_) => Ok(()),
            Err(rusqlite::Error::SqliteFailure(_, Some(message)))
                if message.contains("UNIQUE constraint failed: suplex_credentials.credential_id") =>
            {
                Err(IdentityError::auth(
                    "Credential is already registered",
                    409,
                    "credential_duplicate",
                )
                .into())
            }
            Err(_) => Err(passkey_failure()),
        }
    })
}

pub fn rename_own_credential(
    database: &SuplexDatabase,
    user_id: &str,
    credential_id: &str,
    label: &str,
) -> DatabaseResult<usize> {
    Ok(database.connection().execute(
        "UPDATE suplex_credentials SET label = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
        params![credential_id, user_id, label],
    )?)
}

pub fn revoke_own_credential(
    database: &SuplexDatabase,
    user_id: &str,
    credential_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<usize> {
    Ok(database.connection().execute(
        "UPDATE suplex_credentials SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
        params![credential_id, user_id, rfc3339_millis(now)],
    )?)
}

#[cfg(test)]
pub fn activate_user(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_users SET status = 'active' WHERE id = ?1",
        [user_id],
    )?;
    Ok(())
}

#[cfg(test)]
pub fn active_credential_identity(
    database: &SuplexDatabase,
    user_id: &str,
) -> DatabaseResult<(String, Option<String>)> {
    Ok(database.connection().query_row(
        "SELECT label, rp_id FROM suplex_credentials WHERE user_id = ?1 AND revoked_at IS NULL",
        [user_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}
