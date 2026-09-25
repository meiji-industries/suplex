use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use openssl::rand::rand_bytes;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::platform::database::{DatabaseResult, SuplexDatabase};
use crate::shared::js_json::{JsDocument, JsNode};

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

fn challenge() -> DatabaseResult<String> {
    let mut bytes = [0_u8; 32];
    rand_bytes(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
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
    let document = JsDocument::parse(raw).ok()?;
    let JsNode::Array(items) = document.node(document.root()) else {
        return None;
    };
    Some(
        items
            .iter()
            .filter_map(|index| match document.node(*index) {
                JsNode::String(value) => String::from_utf16(value).ok(),
                _ => None,
            })
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
    rp_id: &str,
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
    let challenge = challenge()?;
    let options = json!({
        "challenge": challenge,
        "rp": { "name": "Suplex", "id": rp_id },
        "user": { "id": URL_SAFE_NO_PAD.encode(URL_SAFE_NO_PAD.encode(user_id.as_bytes()).as_bytes()), "name": username, "displayName": invitation.display_name },
        "pubKeyCredParams": [{"alg": -8, "type": "public-key"}, {"alg": -7, "type": "public-key"}, {"alg": -257, "type": "public-key"}],
        "timeout": 60000,
        "attestation": "none",
        "excludeCredentials": exclude,
        "authenticatorSelection": {"residentKey": "preferred", "userVerification": "required", "requireResidentKey": false},
        "extensions": {"credProps": true},
        "hints": [],
    });
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
        webauthn::verify_registration(response, &expected_challenge, site.origin, site.rp_id)
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

pub async fn verify_consumed_registration(
    response: &PreparedCredential,
    expected_challenge: &str,
    site: WebAuthnSite<'_>,
) -> DatabaseResult<StoredCredential> {
    let response = response.payload.as_ref().ok_or_else(passkey_failure)?;
    webauthn::verify_registration_with_revocation(
        response,
        expected_challenge,
        site.origin,
        site.rp_id,
    )
    .await
    .map_err(|_| passkey_failure())
}

pub fn begin_authentication(
    database: &SuplexDatabase,
    rp_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<AuthOptions> {
    let mut statement = database.connection().prepare("SELECT suplex_credentials.credential_id, suplex_credentials.transports FROM suplex_credentials INNER JOIN suplex_users ON suplex_users.id = suplex_credentials.user_id WHERE suplex_credentials.revoked_at IS NULL AND suplex_users.status = 'active' ORDER BY suplex_credentials.created_at ASC")?;
    let credentials = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if credentials.is_empty() {
        return Err(Box::new(AuthFailure::new(
            "No passkey is enrolled",
            400,
            "auth_failure",
        )));
    }
    let allow = credentials
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
        .collect::<Vec<_>>();
    let challenge = challenge()?;
    let options = json!({ "rpId": rp_id, "challenge": challenge, "allowCredentials": allow, "timeout": 60000, "userVerification": "required" });
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
    let verified = webauthn::verify_authentication(
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
    if counter > 0 && verified <= counter {
        return Err(passkey_failure());
    }
    database.transaction(false, |database| {
        let updated = database.connection().execute("UPDATE suplex_credentials SET counter = ?3 WHERE id = ?1 AND counter = ?2 AND revoked_at IS NULL", params![credential_row_id, counter, verified])?;
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
    use crate::platform::database::OpenMode;

    fn seed_shared_ceremony(
        database: &SuplexDatabase,
        token: &str,
        now: DateTime<Utc>,
        registration_id: &str,
    ) {
        database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_existing', 'Fixture member', 'user_v1_user_existing', 'user_v1_user_existing', 'member', 'pending', ?1, ?1, 1)", [timestamp(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at, metadata_json) VALUES ('invitation_shared', ?1, 'user', 'Fixture member', 'user_existing', ?2, ?3, '{}')", params![auth::hash_secret(token), timestamp(now + Duration::days(1)), timestamp(now)]).unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-interop.json"
        ))
        .unwrap();
        database.connection().execute("INSERT INTO suplex_challenges (id, challenge, kind, invitation_id, user_id, expires_at, created_at) VALUES (?1, ?2, 'registration:user', 'invitation_shared', 'user_existing', ?3, ?4)", params![registration_id, fixture["registrationChallenge"].as_str().unwrap(), timestamp(now + Duration::minutes(5)), timestamp(now)]).unwrap();
    }

    fn shared_auth_challenge(database: &SuplexDatabase, now: DateTime<Utc>, id: &str) {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-interop.json"
        ))
        .unwrap();
        database.connection().execute("INSERT INTO suplex_challenges (id, challenge, kind, expires_at, created_at) VALUES (?1, ?2, 'authentication', ?3, ?4)", params![id, fixture["authenticationChallenge"].as_str().unwrap(), timestamp(now + Duration::minutes(5)), timestamp(now)]).unwrap();
    }

    #[test]
    fn signed_registration_persists_authenticator_id_when_response_id_differs() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-interop.json"
        ))
        .unwrap();
        let token = format!("invite_v1_user_{}", "A".repeat(43));
        let now = Utc::now();
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            auth::random_hex_id("suplex_signed_internal_id").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        seed_shared_ceremony(&database, &token, now, "challenge_internal_id");
        let mut response = fixture["packedFullRs256"].clone();
        response["id"] = json!("YWJj");
        response["rawId"] = json!("YWJj");
        let enrolled = complete_registration(
            &mut database,
            "user",
            &token,
            "challenge_internal_id",
            &response,
            WebAuthnSite {
                origin: fixture["origin"].as_str().unwrap(),
                rp_id: fixture["rpId"].as_str().unwrap(),
            },
            now,
        )
        .unwrap();
        assert_eq!(enrolled.user.id, "user_existing");
        let stored: String = database
            .connection()
            .query_row("SELECT credential_id FROM suplex_credentials", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored, "g06So-HmBl8oCMHl5j466FSFEHvjutKcDJL3rhSZttc");
        assert_ne!(stored, response["id"]);
        drop(database);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    fn run_typescript(
        mode: &str,
        path: &std::path::Path,
        token: &str,
        challenge_id: &str,
    ) -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let output = std::process::Command::new("node")
            .current_dir(root)
            .args([
                "--import",
                "tsx",
                "tests/support/ceremony-cross-runtime.ts",
                mode,
            ])
            .arg(path)
            .args([token, challenge_id])
            .output()
            .expect("run TypeScript AuthService");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[test]
    #[ignore = "run explicitly with Node dependencies installed for signed TypeScript and Rust service interop"]
    fn signed_typescript_and_rust_services_share_credentials_and_sessions_both_directions() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-interop.json"
        ))
        .unwrap();
        let token = format!("invite_v1_user_{}", "A".repeat(43));
        let now = Utc::now();
        let site = WebAuthnSite {
            origin: fixture["origin"].as_str().unwrap(),
            rp_id: fixture["rpId"].as_str().unwrap(),
        };

        let ts_path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            auth::random_hex_id("suplex_ts_register").unwrap()
        ));
        let database = SuplexDatabase::open(&ts_path, OpenMode::Migrate).unwrap();
        seed_shared_ceremony(&database, &token, now, "challenge_ts_register");
        drop(database);
        let ts_enrolled = run_typescript("register", &ts_path, &token, "challenge_ts_register");
        assert_eq!(
            ts_enrolled,
            json!({"userId":"user_existing","sessionUserId":"user_existing"})
        );
        let mut database = SuplexDatabase::open(&ts_path, OpenMode::ReadWrite).unwrap();
        let (public_key, counter): (Vec<u8>, u32) = database
            .connection()
            .query_row(
                "SELECT public_key, counter FROM suplex_credentials WHERE credential_id = ?1",
                [fixture["credentialId"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(public_key), fixture["publicKey"]);
        assert_eq!(counter, 0);
        shared_auth_challenge(&database, now, "challenge_rust_auth");
        let rust_login = complete_authentication(
            &mut database,
            "challenge_rust_auth",
            &fixture["assertion"],
            site,
            now,
        )
        .unwrap();
        assert_eq!(rust_login.user.id, "user_existing");
        let counter: u32 = database
            .connection()
            .query_row(
                "SELECT counter FROM suplex_credentials WHERE credential_id = ?1",
                [fixture["credentialId"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(counter, 1);
        drop(database);

        let rust_path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            auth::random_hex_id("suplex_rust_register").unwrap()
        ));
        let mut database = SuplexDatabase::open(&rust_path, OpenMode::Migrate).unwrap();
        seed_shared_ceremony(&database, &token, now, "challenge_rust_register");
        let rust_enrolled = complete_registration(
            &mut database,
            "user",
            &token,
            "challenge_rust_register",
            &fixture["registration"],
            site,
            now,
        )
        .unwrap();
        assert_eq!(rust_enrolled.user.id, "user_existing");
        shared_auth_challenge(&database, now, "challenge_ts_auth");
        drop(database);
        let ts_login = run_typescript("authenticate", &rust_path, "", "challenge_ts_auth");
        assert_eq!(
            ts_login,
            json!({"userId":"user_existing","sessionUserId":"user_existing"})
        );
        let database = SuplexDatabase::open(&rust_path, OpenMode::ReadWrite).unwrap();
        let counter: u32 = database
            .connection()
            .query_row(
                "SELECT counter FROM suplex_credentials WHERE credential_id = ?1",
                [fixture["credentialId"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(counter, 1);
        drop(database);
        for path in [ts_path, rust_path] {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
            let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
        }
    }

    #[test]
    fn signed_simplewebauthn_responses_complete_shared_registration_and_login() {
        assert_eq!(
            transports(r#"["internal",1e400,"\ud800","usb"]"#),
            Some(vec!["internal".to_owned(), "usb".to_owned()])
        );
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/webauthn-interop.json"
        ))
        .unwrap();
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            auth::random_hex_id("suplex_ceremony").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let token = format!("invite_v1_user_{}", "A".repeat(43));
        let user_id = fixture["userId"].as_str().unwrap();
        database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES (?1, 'Fixture member', ?2, ?2, 'member', 'pending', ?3, ?3, 1)", params![user_id, format!("user_v1_{user_id}"), timestamp(now)]).unwrap();
        let invitation_id = auth::random_hex_id("invitation").unwrap();
        database.connection().execute("INSERT INTO suplex_invitations (id, token_hash, kind, display_name, user_id, expires_at, created_at, metadata_json) VALUES (?1, ?2, 'user', 'Fixture member', ?3, ?4, ?5, '{}')", params![invitation_id, auth::hash_secret(&token), user_id, timestamp(now + Duration::days(1)), timestamp(now)]).unwrap();
        let offered = begin_registration(
            &mut database,
            "user",
            &token,
            fixture["rpId"].as_str().unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(offered.options["attestation"], "none");
        assert_eq!(
            offered.options["user"]["id"],
            URL_SAFE_NO_PAD.encode(URL_SAFE_NO_PAD.encode(user_id.as_bytes()).as_bytes())
        );
        assert_eq!(
            offered.options["authenticatorSelection"]["userVerification"],
            "required"
        );
        assert_eq!(
            offered.options["pubKeyCredParams"],
            json!([{"alg":-8,"type":"public-key"},{"alg":-7,"type":"public-key"},{"alg":-257,"type":"public-key"}])
        );
        let raw_options = serde_json::to_string(&offered)
            .unwrap()
            .replace(&offered.challenge_id, "CHALLENGE_ID")
            .replace(offered.options["challenge"].as_str().unwrap(), "CHALLENGE");
        assert_eq!(
            raw_options,
            r#"{"challengeId":"CHALLENGE_ID","options":{"challenge":"CHALLENGE","rp":{"name":"Suplex","id":"suplex.example.test"},"user":{"id":"ZFhObGNsOWxlR2x6ZEdsdVp3","name":"user_v1_user_existing","displayName":"Fixture member"},"pubKeyCredParams":[{"alg":-8,"type":"public-key"},{"alg":-7,"type":"public-key"},{"alg":-257,"type":"public-key"}],"timeout":60000,"attestation":"none","excludeCredentials":[],"authenticatorSelection":{"residentKey":"preferred","userVerification":"required","requireResidentKey":false},"extensions":{"credProps":true},"hints":[]}}"#
        );
        let challenge_id = auth::random_hex_id("challenge").unwrap();
        database.connection().execute("INSERT INTO suplex_challenges (id, challenge, kind, invitation_id, user_id, expires_at, created_at) VALUES (?1, ?2, 'registration:user', ?3, ?4, ?5, ?6)", params![challenge_id, fixture["registrationChallenge"].as_str().unwrap(), invitation_id, user_id, timestamp(now + Duration::minutes(5)), timestamp(now)]).unwrap();
        let enrolled = complete_registration(
            &mut database,
            "user",
            &token,
            &challenge_id,
            &fixture["registration"],
            WebAuthnSite {
                origin: fixture["origin"].as_str().unwrap(),
                rp_id: fixture["rpId"].as_str().unwrap(),
            },
            now,
        )
        .unwrap();
        assert_eq!(enrolled.user.id, user_id);
        assert_eq!(enrolled.user.status, "active");
        assert!(
            auth::get_user_by_session(&database, &enrolled.session_token, now)
                .unwrap()
                .is_some()
        );
        let (stored_key, stored_counter, stored_id): (Vec<u8>, u32, String) = database.connection().query_row("SELECT public_key, counter, credential_id FROM suplex_credentials WHERE user_id = ?1", [user_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&stored_key),
            fixture["publicKey"].as_str().unwrap()
        );
        assert_eq!(stored_counter, 0);
        assert_eq!(stored_id, fixture["credentialId"]);
        let offered_auth =
            begin_authentication(&database, fixture["rpId"].as_str().unwrap(), now).unwrap();
        assert_eq!(offered_auth.options["allowCredentials"][0]["id"], stored_id);
        let authentication_challenge_id = auth::random_hex_id("challenge").unwrap();
        database.connection().execute("INSERT INTO suplex_challenges (id, challenge, kind, expires_at, created_at) VALUES (?1, ?2, 'authentication', ?3, ?4)", params![authentication_challenge_id, fixture["authenticationChallenge"].as_str().unwrap(), timestamp(now + Duration::minutes(5)), timestamp(now)]).unwrap();
        let logged_in = complete_authentication(
            &mut database,
            &authentication_challenge_id,
            &fixture["assertion"],
            WebAuthnSite {
                origin: fixture["origin"].as_str().unwrap(),
                rp_id: fixture["rpId"].as_str().unwrap(),
            },
            now,
        )
        .unwrap();
        assert_eq!(logged_in.user.id, user_id);
        let counter: u32 = database
            .connection()
            .query_row(
                "SELECT counter FROM suplex_credentials WHERE user_id = ?1",
                [user_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(counter, 1);
        assert!(
            auth::get_user_by_session(&database, &logged_in.session_token, now)
                .unwrap()
                .is_some()
        );
        let replay = complete_authentication(
            &mut database,
            &authentication_challenge_id,
            &fixture["assertion"],
            WebAuthnSite {
                origin: fixture["origin"].as_str().unwrap(),
                rp_id: fixture["rpId"].as_str().unwrap(),
            },
            now,
        )
        .unwrap_err();
        assert_eq!(
            replay.downcast_ref::<AuthFailure>().unwrap().code,
            "passkey_invalid"
        );
    }
}
