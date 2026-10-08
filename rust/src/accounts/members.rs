//! Company invitations belong to the host. Hosted login proves the email;
//! current host membership decides access on every request.
use crate::identity::auth::UserRole;
use crate::identity::auth::UserStatus;
use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use super::wire::{CompanyInvitationBody, HostedAccount};
use crate::{
    identity::{auth, companies},
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::{PublicFailure, hash::sha256_hex, ids::random_hex_id, time::rfc3339_millis},
};

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CompanyInvitation {
    pub id: String,
    pub company_id: String,
    pub user_id: String,
    pub full_name: String,
    pub email: String,
    pub expires_at: String,
    pub sent_at: Option<String>,
    pub accepted_at: Option<String>,
    pub revoked_at: Option<String>,
}

pub fn list(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<Vec<CompanyInvitation>> {
    let mut statement = database.connection().prepare("SELECT id, company_id, user_id, full_name, email, expires_at, sent_at, accepted_at, revoked_at FROM suplex_company_invitations WHERE company_id = ?1 ORDER BY created_at DESC")?;
    Ok(statement
        .query_map([company_id], |row| {
            Ok(CompanyInvitation {
                id: row.get(0)?,
                company_id: row.get(1)?,
                user_id: row.get(2)?,
                full_name: row.get(3)?,
                email: row.get(4)?,
                expires_at: row.get(5)?,
                sent_at: row.get(6)?,
                accepted_at: row.get(7)?,
                revoked_at: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn prepare(
    database: &mut SuplexDatabase,
    actor: &str,
    company_id: &str,
    full_name: &str,
    email: &str,
    host_origin: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<CompanyInvitationBody> {
    companies::require_admin_company(database, actor, company_id)?;
    let owner = super::linked(database)?
        .ok_or_else(|| PublicFailure::new(409, "Log in to Suplex before adding users"))?;
    let company = companies::require_company_access(database, actor, company_id)?;
    let email = email.trim().to_ascii_lowercase();
    let full_name = full_name.trim();
    let mut body = CompanyInvitationBody {
        id: super::wire::random_token()?,
        company_id: company_id.into(),
        company_name: company.name,
        full_name: full_name.into(),
        email,
        host_origin: host_origin.into(),
    };
    if !body.valid() {
        return Err(PublicFailure::new(
            400,
            "Enter a full name, valid email, and HTTPS host address",
        )
        .into());
    }
    if body.email.eq_ignore_ascii_case(&owner.email) {
        return Err(PublicFailure::new(409, "This account already owns the host").into());
    }
    if let Some(existing) = list(database, company_id)?.into_iter().find(|invite| {
        invite.email == body.email
            && invite.revoked_at.is_none()
            && invite.accepted_at.is_none()
            && invite.expires_at > rfc3339_millis(now)
    }) {
        body.id = existing.id;
        body.full_name = existing.full_name;
        return Ok(body);
    }
    database.transaction(true, |database| {
        let timestamp = rfc3339_millis(now);
        database.connection().execute("UPDATE suplex_company_invitations SET revoked_at = ?3 WHERE company_id = ?1 AND email = ?2 AND accepted_at IS NULL AND revoked_at IS NULL", params![company_id, body.email, timestamp])?;
        let existing: Option<String> = database.connection().query_row("SELECT user_id FROM suplex_account_users WHERE email = ?1 COLLATE NOCASE", [&body.email], |row| row.get(0)).optional()?;
        let user_id = if let Some(id) = existing {
            let user = auth::public_user(database, &id)?.ok_or("User missing")?;
            if user.status == UserStatus::Revoked { return Err(PublicFailure::new(409, "This user was revoked").into()); }
            if user.company_ids.iter().any(|id| id == company_id) && user.status == UserStatus::Active { return Err(PublicFailure::new(409, "This user is already a member").into()); }
            id
        } else {
            let id = random_hex_id("user")?;
            let base: String = body.email.split('@').next().unwrap_or_default().chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).take(54).collect();
            let base = if base.len() < 2 { format!("{base}_") } else { base };
            let taken = database.connection().query_row("SELECT 1 FROM suplex_users WHERE username = ?1 COLLATE NOCASE", [&base], |_| Ok(())).optional()?.is_some();
            let username = if taken { format!("{base}-{}", &id[id.len() - 8..]) } else { base };
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES (?1, ?2, ?3, ?3, 'member', 'pending', ?4, ?4, 1)", params![id, full_name, username, timestamp])?;
            database.connection().execute("INSERT INTO suplex_account_users (user_id, email) VALUES (?1, ?2)", params![id, body.email])?;
            id
        };
        database.connection().execute("INSERT OR IGNORE INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, ?2, ?3)", params![user_id, company_id, timestamp])?;
        database.connection().execute("INSERT INTO suplex_company_invitations (id, company_id, user_id, email, full_name, host_origin, owner_account_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![body.id, company_id, user_id, body.email, full_name, host_origin, owner.account_id, timestamp, rfc3339_millis(now + Duration::days(7))])?;
        Ok(())
    })?;
    Ok(body)
}

pub fn accept(
    database: &mut SuplexDatabase,
    account: &HostedAccount,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    if !account.valid() {
        return Err(PublicFailure::new(403, "The account could not be verified").into());
    }
    database.transaction(true, |database| {
        let owner = super::linked(database)?;
        let user_id = if owner.as_ref().is_some_and(|owner| owner.account_id == account.id) {
            "user_development".to_owned()
        } else {
            let mapped: Option<(String, Option<String>)> = database.connection().query_row("SELECT user_id, account_id FROM suplex_account_users WHERE email = ?1 COLLATE NOCASE", [&account.email], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            let (id, saved_account) = mapped.ok_or_else(|| PublicFailure::new(403, "This account has not been invited to this host"))?;
            if saved_account.as_ref().is_some_and(|saved| saved != &account.id) { return Err(PublicFailure::new(403, "This email is linked to another account").into()); }
            let user = auth::public_user(database, &id)?.ok_or("User missing")?;
            if user.status == UserStatus::Revoked || user.company_ids.is_empty() { return Err(PublicFailure::new(403, "Company access was removed").into()); }
            let timestamp = rfc3339_millis(now);
            let invitations: i64 = database.connection().query_row("SELECT COUNT(*) FROM suplex_company_invitations i JOIN suplex_memberships m ON m.user_id = i.user_id AND m.company_id = i.company_id WHERE i.user_id = ?1 AND i.revoked_at IS NULL AND i.sent_at IS NOT NULL AND (i.accepted_at IS NOT NULL OR i.expires_at > ?2)", params![id, timestamp], |row| row.get(0))?;
            if invitations == 0 { return Err(PublicFailure::new(403, "The invitation expired or was removed").into()); }
            database.connection().execute("UPDATE suplex_account_users SET account_id = ?2 WHERE user_id = ?1", params![id, account.id])?;
            database.connection().execute("UPDATE suplex_users SET status = 'active', updated_at = ?2 WHERE id = ?1", params![id, timestamp])?;
            database.connection().execute("UPDATE suplex_company_invitations SET accepted_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL AND sent_at IS NOT NULL AND accepted_at IS NULL AND expires_at > ?2", params![id, timestamp])?;
            id
        };
        let token = auth::create_session_with_provenance(database, &user_id, "automatic", now)?;
        database.connection().execute("INSERT INTO suplex_account_sessions (token_hash, account_id) VALUES (?1, ?2)", params![sha256_hex(&token), account.id])?;
        Ok(token)
    })
}

/// The unused `suplex recover` invitation that `token` names, if any. Only shell access to the host can issue one.
pub fn recovery_invitation(
    database: &SuplexDatabase,
    token: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<String>> {
    Ok(database.connection().query_row(
        "SELECT id FROM suplex_invitations WHERE token_hash = ?1 AND kind = 'recovery' AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > ?2",
        params![sha256_hex(token), rfc3339_millis(now)],
        |row| row.get(0),
    ).optional()?)
}

/// Uses the recovery invitation once, links `account` as this host's owner, and signs it in as the owner.
pub fn recover(
    database: &mut SuplexDatabase,
    invitation_id: &str,
    account: &HostedAccount,
    token: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    database.transaction(true, |database| {
        let timestamp = rfc3339_millis(now);
        let used = database.connection().execute(
            "UPDATE suplex_invitations SET consumed_at = ?2 WHERE id = ?1 AND kind = 'recovery' AND consumed_at IS NULL AND replaced_at IS NULL AND expires_at > ?2",
            params![invitation_id, timestamp],
        )?;
        if used == 0 {
            return Err(PublicFailure::new(403, "This recovery link expired or was used. Run suplex recover again.").into());
        }
        super::link(database, account, token)?;
        crate::identity::audit::record(database, &crate::identity::audit::AuditEvent {
            id: &random_hex_id("audit")?, actor_user_id: Some("user_development"), actor_agent_id: None,
            action: "account_linked", target_user_id: None, company_id: None,
            metadata_json: r#"{"method":"recovery"}"#, created_at: &timestamp,
        })?;
        accept(database, account, now)
    })
}

pub fn session_verified(
    database: &SuplexDatabase,
    token: &str,
    user: &auth::AuthUser,
) -> DatabaseResult<bool> {
    let account: Option<String> = database
        .connection()
        .query_row(
            "SELECT account_id FROM suplex_account_sessions WHERE token_hash = ?1",
            [sha256_hex(token)],
            |row| row.get(0),
        )
        .optional()?;
    let Some(account) = account else {
        return Ok(false);
    };
    if user.id == "user_development" {
        return Ok(super::linked(database)?.is_some_and(|owner| owner.account_id == account));
    }
    Ok(
        (user.role == UserRole::Admin || !user.company_ids.is_empty())
            && database
                .connection()
                .query_row(
                    "SELECT 1 FROM suplex_account_users WHERE user_id = ?1 AND account_id = ?2",
                    params![user.id, account],
                    |_| Ok(()),
                )
                .optional()?
                .is_some(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::routes::auth::tests::state;

    fn account(email: &str, id: &str) -> HostedAccount {
        HostedAccount {
            id: id.into(),
            email: email.into(),
            name: Some("Invited Member".into()),
        }
    }

    #[test]
    fn verified_email_joins_live_membership_without_replacing_owner() {
        let (state, _) = state();
        state.with_database(|db| {
            let now = Utc::now();
            auth::development_sign_in(db, now).unwrap();
            let owner = account("owner@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0c8");
            super::super::link(db, &owner, &"k".repeat(43)).unwrap();
            db.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_test', 'Test', 'active', ?1)", [rfc3339_millis(now)]).unwrap();
            let invited = account("member@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0c9");
            let unknown = account("unknown@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0ca");
            assert!(accept(db, &unknown, now).is_err());
            let invitation = prepare(db, "user_development", "company_test", "Invited Member", &invited.email, "https://host.example.com", now).unwrap();
            assert!(accept(db, &invited, now).is_err(), "unsent invitation grants nothing");
            db.connection().execute("UPDATE suplex_company_invitations SET sent_at = ?2 WHERE id = ?1", params![invitation.id, rfc3339_millis(now)]).unwrap();
            assert!(accept(db, &invited, now + Duration::days(8)).is_err(), "expired invitation grants nothing");
            let token = accept(db, &invited, now).unwrap();
            let user = auth::get_user_by_session(db, &token, now).unwrap().unwrap();
            assert_eq!(user.company_ids, vec!["company_test"]);
            assert!(session_verified(db, &token, &user).unwrap());
            assert_eq!(super::super::linked(db).unwrap().unwrap().account_id, owner.id);
            // Current membership remains authoritative even when a session survives restart.
            companies::remove_membership(db, "user_development", &user.id, "company_test", now).unwrap();
            assert!(accept(db, &invited, now).is_err());
            let current = auth::get_user_by_session(db, &token, now).unwrap().unwrap();
            assert!(!session_verified(db, &token, &current).unwrap());
        });
    }
}
