use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::platform::database::{DatabaseResult, SuplexDatabase};

use super::{
    auth::{self, AuthFailure, AuthResult},
    webauthn::{self, StoredCredential},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthOptions {
    pub challenge_id: String,
    pub options: Value,
}

#[derive(Clone, Copy)]
pub struct WebAuthnSite<'a> {
    pub origin: &'a str,
    pub rp_id: &'a str,
}

#[derive(Clone, Debug)]
struct Invitation {
    id: String,
    display_name: String,
    user_id: Option<String>,
    metadata_json: String,
}

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn invitation_failure() -> Box<dyn std::error::Error> {
    Box::new(AuthFailure::new(
        "Invitation is invalid or expired",
        400,
        "invitation_invalid",
    ))
}

fn passkey_failure() -> Box<dyn std::error::Error> {
    Box::new(AuthFailure::new(
        "Passkey could not be verified",
        400,
        "passkey_invalid",
    ))
}

fn valid_token_shape(token: &str, kind: &str) -> bool {
    [format!("invite_v1_{kind}_"), format!("suplex_{kind}_")]
        .iter()
        .any(|prefix| {
            token.strip_prefix(prefix).is_some_and(|tail| {
                tail.len() == 43
                    && tail
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
        })
}

fn valid_invitation(
    database: &SuplexDatabase,
    token: &str,
    kind: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<Invitation>> {
    if !valid_token_shape(token, kind) {
        return Ok(None);
    }
    let row = database.connection().query_row(
        "SELECT id, display_name, user_id, metadata_json, expires_at FROM suplex_invitations WHERE token_hash = ?1 AND kind = ?2 AND consumed_at IS NULL AND replaced_at IS NULL",
        params![auth::hash_secret(token), kind],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
    ).optional()?;
    let Some((id, display_name, user_id, metadata_json, expires_at)) = row else {
        return Ok(None);
    };
    if DateTime::parse_from_rfc3339(&expires_at)
        .is_ok_and(|expires| expires.timestamp_millis() <= now.timestamp_millis())
    {
        return Ok(None);
    }
    if kind == "bootstrap" && !auth::bootstrap_required(database)? {
        return Ok(None);
    }
    if kind == "user" {
        let Some(user_id) = &user_id else {
            return Ok(None);
        };
        let status: Option<String> = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_users WHERE id = ?1",
                [user_id],
                |row| row.get(0),
            )
            .optional()?;
        if status.as_deref() != Some("pending") {
            return Ok(None);
        }
    }
    Ok(Some(Invitation {
        id,
        display_name,
        user_id,
        metadata_json,
    }))
}

fn transports(raw: &str) -> Option<Vec<String>> {
    let serde_json::Value::Array(items) = serde_json::from_str(raw).ok()? else {
        return None;
    };
    Some(
        items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .filter(|item| {
                matches!(
                    item.as_str(),
                    "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb"
                )
            })
            .collect(),
    )
}

fn credentials_for_user(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<Vec<Value>> {
    let mut statement = database.connection().prepare("SELECT credential_id, transports FROM suplex_credentials WHERE user_id = ?1 AND revoked_at IS NULL")?;
    Ok(statement
        .query_map([user_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(id, stored_transports)| {
            let mut item = serde_json::Map::new();
            item.insert("id".into(), json!(id));
            if let Some(items) = transports(&stored_transports) {
                item.insert("transports".into(), json!(items));
            }
            item.insert("type".into(), json!("public-key"));
            Value::Object(item)
        })
        .collect())
}

pub fn begin_registration(
    database: &mut SuplexDatabase,
    kind: &str,
    token: &str,
    site: WebAuthnSite<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthOptions> {
    if !matches!(kind, "bootstrap" | "user" | "recovery") {
        return Err(invitation_failure());
    }
    let invitation =
        valid_invitation(database, token, kind, now)?.ok_or_else(invitation_failure)?;
    let user_id = invitation
        .user_id
        .clone()
        .unwrap_or(auth::random_hex_id("pending")?);
    let username = format!("user_v1_{user_id}");
    let exclude = match &invitation.user_id {
        Some(id) => credentials_for_user(database, id)?,
        None => Vec::new(),
    };
    let excluded_ids = exclude
        .iter()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let started = webauthn::start_registration(
        site.origin,
        site.rp_id,
        &username,
        &invitation.display_name,
        &excluded_ids,
    )
    .map_err(|_| passkey_failure())?;
    let challenge = started.state;
    let options = started.options;
    let challenge_id = auth::random_hex_id("challenge")?;
    database.transaction(false, |database| {
        let current = valid_invitation(database, token, kind, now)?.ok_or_else(invitation_failure)?;
        database.connection().execute(
            "INSERT INTO suplex_challenges (id, challenge, kind, invitation_id, user_id, expires_at, consumed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            params![challenge_id, challenge, format!("registration:{kind}"), current.id, current.user_id, timestamp(now + Duration::minutes(5)), timestamp(now)],
        )?;
        Ok(())
    })?;
    Ok(AuthOptions {
        challenge_id,
        options,
    })
}

fn valid_response(response: &Value) -> bool {
    response.get("type").and_then(Value::as_str) == Some("public-key")
        && response
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty() && id.encode_utf16().count() <= 512)
}

fn valid_challenge_id(id: &str) -> bool {
    !id.is_empty() && id.encode_utf16().count() <= 128
}

pub struct PreparedCredential {
    pub shape_valid: bool,
    pub payload: Option<Value>,
}

impl PreparedCredential {
    fn from_value(response: &Value) -> Self {
        Self {
            shape_valid: valid_response(response),
            payload: Some(response.clone()),
        }
    }
}

pub fn complete_registration(
    database: &mut SuplexDatabase,
    kind: &str,
    token: &str,
    challenge_id: &str,
    response: &Value,
    site: WebAuthnSite<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthResult> {
    complete_registration_prepared(
        database,
        kind,
        token,
        challenge_id,
        PreparedCredential::from_value(response),
        site,
        now,
    )
}

pub fn complete_registration_prepared(
    database: &mut SuplexDatabase,
    kind: &str,
    token: &str,
    challenge_id: &str,
    response: PreparedCredential,
    site: WebAuthnSite<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthResult> {
    let expected_challenge =
        consume_registration_challenge(database, kind, token, challenge_id, &response, now)?;
    let response = response.payload.as_ref().ok_or_else(passkey_failure)?;
    let verified =
        webauthn::finish_registration(response, &expected_challenge, site.origin, site.rp_id)
            .map_err(|_| passkey_failure())?;
    finish_registration(database, kind, token, verified, now)
}

pub fn consume_registration_challenge(
    database: &mut SuplexDatabase,
    kind: &str,
    token: &str,
    challenge_id: &str,
    response: &PreparedCredential,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    if !matches!(kind, "bootstrap" | "user" | "recovery")
        || !valid_token_shape(token, kind)
        || !valid_challenge_id(challenge_id)
    {
        return Err(invitation_failure());
    }
    if !response.shape_valid {
        return Err(passkey_failure());
    }
    database.transaction(false, |database| {
        let invitation = valid_invitation(database, token, kind, now)?.ok_or_else(invitation_failure)?;
        let challenge_row = database.connection().query_row(
            "SELECT challenge, invitation_id, expires_at, consumed_at FROM suplex_challenges WHERE id = ?1 AND kind = ?2",
            params![challenge_id, format!("registration:{kind}")],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
        ).optional()?;
        let Some((challenge, invitation_id, expires_at, consumed_at)) = challenge_row else { return Err(invitation_failure()); };
        if invitation_id.as_deref() != Some(&invitation.id) || consumed_at.is_some() || DateTime::parse_from_rfc3339(&expires_at).is_ok_and(|expires| expires.timestamp_millis() <= now.timestamp_millis()) { return Err(invitation_failure()); }
        let updated = database.connection().execute("UPDATE suplex_challenges SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL", params![challenge_id, timestamp(now)])?;
        if updated != 1 { return Err(invitation_failure()); }
        Ok(challenge)
    })
}

pub fn finish_registration(
    database: &mut SuplexDatabase,
    kind: &str,
    token: &str,
    verified: StoredCredential,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthResult> {
    database.transaction(false, |database| {
        let invitation = valid_invitation(database, token, kind, now)?.ok_or_else(invitation_failure)?;
        let now_iso = timestamp(now);
        let user_id = if kind == "user" {
            let id = invitation.user_id.ok_or_else(invitation_failure)?;
            let updated = database.connection().execute("UPDATE suplex_users SET status = 'active', updated_at = ?2 WHERE id = ?1 AND status = 'pending'", params![id, now_iso])?;
            if updated != 1 { return Err(invitation_failure()); }
            id
        } else {
            if kind == "bootstrap" && !auth::bootstrap_required(database)? { return Err(invitation_failure()); }
            if kind == "recovery" {
                database.connection().execute("UPDATE suplex_credentials SET revoked_at = ?1 WHERE user_id IN (SELECT id FROM suplex_users WHERE role = 'admin' AND status = 'active') AND revoked_at IS NULL", [now_iso.clone()])?;
                database.connection().execute("UPDATE suplex_sessions SET revoked_at = ?1 WHERE user_id IN (SELECT id FROM suplex_users WHERE role = 'admin' AND status = 'active') AND revoked_at IS NULL", [now_iso.clone()])?;
                database.connection().execute("UPDATE suplex_users SET status = 'revoked', updated_at = ?1 WHERE role = 'admin' AND status = 'active'", [now_iso.clone()])?;
            }
            let id = auth::random_hex_id("user")?;
            let username = format!("user_v1_{id}");
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES (?1, ?2, ?3, ?3, 'admin', 'active', ?4, ?4, 1)", params![id, invitation.display_name, username, now_iso])?;
            id
        };
        let credential_id = auth::random_hex_id("credential")?;
        if let Err(error) = database.connection().execute("INSERT INTO suplex_credentials (id, user_id, credential_id, public_key, counter, transports, created_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)", params![credential_id, user_id, verified.id, verified.public_key, verified.counter, serde_json::to_string(&verified.transports)?, now_iso]) {
            if matches!(&error, rusqlite::Error::SqliteFailure(_, Some(message)) if message.contains("UNIQUE constraint failed: suplex_credentials.credential_id")) {
                return Err(Box::new(AuthFailure::new("Credential is already registered", 409, "credential_duplicate")));
            }
            return Err(passkey_failure());
        }
        let consumed = database.connection().execute("UPDATE suplex_invitations SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL AND replaced_at IS NULL", params![invitation.id, now_iso])?;
        if consumed != 1 { return Err(invitation_failure()); }
        let action = if kind == "recovery" { "recovery_completed" } else { "user_enrolled" };
        let metadata = if kind == "recovery" {
            auth::metadata_with_string(&invitation.metadata_json, "invitationId", &invitation.id)
        } else { "{}".to_owned() };
        database.connection().execute("INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, NULL, NULL, ?2, ?3, NULL, ?4, ?5)", params![auth::random_hex_id("audit")?, action, user_id, metadata, now_iso])?;
        let user = auth::public_user(database, &user_id)?.ok_or_else(passkey_failure)?;
        if user.status != "active" { return Err(passkey_failure()); }
        let session_token = auth::create_session(database, &user_id, now)?;
        Ok(AuthResult { user, session_token })
    })
}

pub fn verify_consumed_registration(
    response: &PreparedCredential,
    expected_challenge: &str,
    site: WebAuthnSite<'_>,
) -> DatabaseResult<StoredCredential> {
    let response = response.payload.as_ref().ok_or_else(passkey_failure)?;
    webauthn::finish_registration(response, expected_challenge, site.origin, site.rp_id)
        .map_err(|_| passkey_failure())
}

pub fn begin_authentication(
    database: &SuplexDatabase,
    site: WebAuthnSite<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthOptions> {
    let mut statement = database.connection().prepare("SELECT suplex_credentials.credential_id, suplex_credentials.public_key, suplex_credentials.counter, suplex_credentials.transports FROM suplex_credentials INNER JOIN suplex_users ON suplex_users.id = suplex_credentials.user_id WHERE suplex_credentials.revoked_at IS NULL AND suplex_users.status = 'active' ORDER BY suplex_credentials.created_at ASC")?;
    let credentials = statement
        .query_map([], |row| {
            Ok(StoredCredential {
                id: row.get(0)?,
                public_key: row.get(1)?,
                counter: row.get(2)?,
                transports: transports(&row.get::<_, String>(3)?).unwrap_or_default(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let started =
        webauthn::start_authentication(site.origin, site.rp_id, &credentials).map_err(|_| {
            Box::new(AuthFailure::new(
                "No passkey is enrolled",
                400,
                "auth_failure",
            )) as Box<dyn std::error::Error>
        })?;
    let challenge = started.state;
    let options = started.options;
    let challenge_id = auth::random_hex_id("challenge")?;
    database.connection().execute("INSERT INTO suplex_challenges (id, challenge, kind, invitation_id, user_id, expires_at, consumed_at, created_at) VALUES (?1, ?2, 'authentication', NULL, NULL, ?3, NULL, ?4)", params![challenge_id, challenge, timestamp(now + Duration::minutes(5)), timestamp(now)])?;
    Ok(AuthOptions {
        challenge_id,
        options,
    })
}

pub fn complete_authentication(
    database: &mut SuplexDatabase,
    challenge_id: &str,
    response: &Value,
    site: WebAuthnSite<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthResult> {
    complete_authentication_prepared(
        database,
        challenge_id,
        PreparedCredential::from_value(response),
        site,
        now,
    )
}

pub fn complete_authentication_prepared(
    database: &mut SuplexDatabase,
    challenge_id: &str,
    response: PreparedCredential,
    site: WebAuthnSite<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthResult> {
    if !valid_challenge_id(challenge_id) || !response.shape_valid {
        return Err(passkey_failure());
    }
    let challenge = database.transaction(false, |database| {
        let row = database.connection().query_row("SELECT challenge, expires_at, consumed_at FROM suplex_challenges WHERE id = ?1 AND kind = 'authentication'", [challenge_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))).optional()?;
        let Some((challenge, expires_at, consumed_at)) = row else { return Err(passkey_failure()); };
        if consumed_at.is_some() || DateTime::parse_from_rfc3339(&expires_at).is_ok_and(|expires| expires.timestamp_millis() <= now.timestamp_millis()) { return Err(passkey_failure()); }
        let updated = database.connection().execute("UPDATE suplex_challenges SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL", params![challenge_id, timestamp(now)])?;
        if updated != 1 { return Err(passkey_failure()); }
        Ok(challenge)
    })?;
    let response = response.payload.as_ref().ok_or_else(passkey_failure)?;
    let response_id = response["id"].as_str().ok_or_else(passkey_failure)?;
    let row = database.connection().query_row("SELECT suplex_credentials.id, suplex_credentials.user_id, suplex_credentials.public_key, suplex_credentials.counter, suplex_credentials.transports FROM suplex_credentials INNER JOIN suplex_users ON suplex_users.id = suplex_credentials.user_id WHERE suplex_credentials.credential_id = ?1 AND suplex_credentials.revoked_at IS NULL AND suplex_users.status = 'active'", [response_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?, row.get::<_, u32>(3)?, row.get::<_, String>(4)?))).optional()?;
    let Some((credential_row_id, user_id, public_key, counter, stored_transports)) = row else {
        return Err(passkey_failure());
    };
    let verified = webauthn::finish_authentication(
        response,
        &challenge,
        site.origin,
        site.rp_id,
        &StoredCredential {
            id: response_id.to_owned(),
            public_key,
            counter,
            transports: transports(&stored_transports).unwrap_or_default(),
        },
    )
    .map_err(|_| passkey_failure())?;
    if counter > 0 && verified.counter <= counter {
        return Err(passkey_failure());
    }
    database.transaction(false, |database| {
        let updated = database.connection().execute("UPDATE suplex_credentials SET counter = ?3, public_key = ?4 WHERE id = ?1 AND counter = ?2 AND revoked_at IS NULL", params![credential_row_id, counter, verified.counter, verified.public_key])?;
        if updated != 1 { return Err(passkey_failure()); }
        let user = auth::public_user(database, &user_id)?.ok_or_else(passkey_failure)?;
        if user.status != "active" { return Err(passkey_failure()); }
        let session_token = auth::create_session(database, &user_id, now)?;
        Ok(AuthResult { user, session_token })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{identity::webauthn::test_support::synthetic, platform::database::OpenMode};
    use webauthn_rs::prelude::Passkey;

    fn setup() -> (SuplexDatabase, std::path::PathBuf, String, DateTime<Utc>) {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            auth::random_hex_id("suplex_highlevel_ceremony").unwrap()
        ));
        let database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let token = format!("invite_v1_user_{}", "A".repeat(43));
        let now = Utc::now();
        database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_existing', 'Fixture member', 'user_v1_user_existing', 'user_v1_user_existing', 'member', 'pending', ?1, ?1, 1)", [timestamp(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at, metadata_json) VALUES ('invitation_new', ?1, 'user', 'Fixture member', 'user_existing', ?2, ?3, '{}')", params![auth::hash_secret(&token), timestamp(now + Duration::days(1)), timestamp(now)]).unwrap();
        (database, path, token, now)
    }

    fn site() -> WebAuthnSite<'static> {
        WebAuthnSite {
            origin: "https://suplex.example.test:4111",
            rp_id: "suplex.example.test",
        }
    }

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn highlevel_options_store_state_with_none_attestation_and_required_uv() {
        let (mut database, path, token, now) = setup();
        let offered = begin_registration(&mut database, "user", &token, site(), now).unwrap();
        assert_eq!(offered.options["attestation"], "none");
        assert_eq!(
            offered.options["authenticatorSelection"]["userVerification"],
            "required"
        );
        assert_eq!(
            offered.options["pubKeyCredParams"],
            json!([
                {"type":"public-key","alg":-7},
                {"type":"public-key","alg":-257}
            ])
        );
        let state: String = database
            .connection()
            .query_row(
                "SELECT challenge FROM suplex_challenges WHERE id = ?1",
                [&offered.challenge_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(serde_json::from_str::<webauthn_rs::prelude::PasskeyRegistration>(&state).is_ok());
        drop(database);
        cleanup(&path);
    }

    #[test]
    fn signed_fresh_passkey_survives_reopen_and_updates_counter() {
        let (mut database, path, token, now) = setup();
        let offered = begin_registration(&mut database, "user", &token, site(), now).unwrap();
        let signed = synthetic(&json!({
            "mode":"register", "options":offered.options, "origin":site().origin
        }));
        let enrolled = complete_registration(
            &mut database,
            "user",
            &token,
            &offered.challenge_id,
            &signed["response"],
            site(),
            now,
        )
        .unwrap();
        assert_eq!(enrolled.user.id, "user_existing");
        let credential_id = signed["credentialId"].as_str().unwrap();
        let (stored, counter): (Vec<u8>, u32) = database
            .connection()
            .query_row(
                "SELECT public_key, counter FROM suplex_credentials WHERE credential_id = ?1",
                [credential_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(serde_json::from_slice::<Passkey>(&stored).is_ok());
        assert_eq!(counter, 0);
        database.connection().execute("INSERT INTO suplex_credentials (id, user_id, credential_id, public_key, counter, transports, created_at, revoked_at) VALUES ('old_credential_row', 'user_existing', 'old_raw_credential', X'010203', 0, '[]', ?1, NULL)", [timestamp(now)]).unwrap();
        drop(database);

        let mut database = SuplexDatabase::open(&path, OpenMode::ReadWrite).unwrap();
        let offered_auth = begin_authentication(&database, site(), now).unwrap();
        assert_eq!(
            offered_auth.options["allowCredentials"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(offered_auth.options["userVerification"], "required");
        let assertion = synthetic(&json!({
            "mode":"authenticate", "options":offered_auth.options,
            "origin":site().origin, "credentialId":credential_id,
            "token":signed["token"]
        }));
        let logged_in = complete_authentication(
            &mut database,
            &offered_auth.challenge_id,
            &assertion["response"],
            site(),
            now,
        )
        .unwrap();
        assert_eq!(logged_in.user.id, "user_existing");
        assert!(
            auth::get_user_by_session(&database, &logged_in.session_token, now)
                .unwrap()
                .is_some()
        );
        let (updated, counter): (Vec<u8>, u32) = database
            .connection()
            .query_row(
                "SELECT public_key, counter FROM suplex_credentials WHERE credential_id = ?1",
                [credential_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_ne!(updated, stored);
        assert_eq!(counter, 1);
        let old_bytes: Vec<u8> = database.connection().query_row(
            "SELECT public_key FROM suplex_credentials WHERE credential_id = 'old_raw_credential'",
            [], |row| row.get(0)
        ).unwrap();
        assert_eq!(old_bytes, vec![1, 2, 3]);
        let stale_challenge = begin_authentication(&database, site(), now).unwrap();
        let stale_assertion = synthetic(&json!({
            "mode":"authenticate", "options":stale_challenge.options,
            "origin":site().origin, "credentialId":credential_id,
            "token":signed["token"]
        }));
        assert!(
            complete_authentication(
                &mut database,
                &stale_challenge.challenge_id,
                &stale_assertion["response"],
                site(),
                now
            )
            .is_err()
        );
        assert!(
            complete_authentication(
                &mut database,
                &offered_auth.challenge_id,
                &assertion["response"],
                site(),
                now
            )
            .is_err()
        );
        drop(database);
        cleanup(&path);
    }
}
