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

const INVITE_NEEDS_TEAM: &str =
    "Only the Team plan can invite users. Select Team in Settings > Billing.";
const JOIN_NEEDS_TEAM: &str =
    "This host's plan does not include other users. Ask an admin to select Team.";

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CompanyInvitation {
    pub id: String,
    pub company_id: String,
    pub user_id: String,
    pub full_name: String,
    pub email: String,
    /// The invited user's current role, which they keep when they join.
    pub role: UserRole,
    pub expires_at: String,
    pub sent_at: Option<String>,
    pub accepted_at: Option<String>,
    pub revoked_at: Option<String>,
}

pub fn list(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<Vec<CompanyInvitation>> {
    let mut statement = database.connection().prepare("SELECT i.id, i.company_id, i.user_id, i.full_name, i.email, u.role, i.expires_at, i.sent_at, i.accepted_at, i.revoked_at FROM suplex_company_invitations i JOIN suplex_users u ON u.id = i.user_id WHERE i.company_id = ?1 ORDER BY i.created_at DESC")?;
    Ok(statement
        .query_map([company_id], |row| {
            Ok(CompanyInvitation {
                id: row.get(0)?,
                company_id: row.get(1)?,
                user_id: row.get(2)?,
                full_name: row.get(3)?,
                email: row.get(4)?,
                role: row.get(5)?,
                expires_at: row.get(6)?,
                sent_at: row.get(7)?,
                accepted_at: row.get(8)?,
                revoked_at: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

#[allow(clippy::too_many_arguments)]
pub fn prepare(
    database: &mut SuplexDatabase,
    actor: &str,
    company_id: &str,
    full_name: &str,
    email: &str,
    role: UserRole,
    host_origin: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<CompanyInvitationBody> {
    companies::require_admin_company(database, actor, company_id)?;
    crate::billing::require_team(database, INVITE_NEEDS_TEAM)?;
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
        set_invited_role(database, &existing.user_id, role)?;
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
            set_invited_role(database, &id, role)?;
            id
        } else {
            let id = random_hex_id("user")?;
            let base: String = body.email.split('@').next().unwrap_or_default().chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).take(54).collect();
            let base = if base.len() < 2 { format!("{base}_") } else { base };
            let taken = database.connection().query_row("SELECT 1 FROM suplex_users WHERE username = ?1 COLLATE NOCASE", [&base], |_| Ok(())).optional()?.is_some();
            let username = if taken { format!("{base}-{}", &id[id.len() - 8..]) } else { base };
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES (?1, ?2, ?3, ?3, ?5, 'pending', ?4, ?4, 1)", params![id, full_name, username, timestamp, role])?;
            database.connection().execute("INSERT INTO suplex_account_users (user_id, email) VALUES (?1, ?2)", params![id, body.email])?;
            id
        };
        database.connection().execute("INSERT OR IGNORE INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, ?2, ?3)", params![user_id, company_id, timestamp])?;
        database.connection().execute("INSERT INTO suplex_company_invitations (id, company_id, user_id, email, full_name, host_origin, owner_account_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![body.id, company_id, user_id, body.email, full_name, host_origin, owner.account_id, timestamp, rfc3339_millis(now + Duration::days(7))])?;
        Ok(())
    })?;
    Ok(body)
}

/// A pending user takes the invited role. An active user only gains admin: an invitation never demotes.
fn set_invited_role(
    database: &SuplexDatabase,
    user_id: &str,
    role: UserRole,
) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_users SET role = ?2 WHERE id = ?1 AND (status = 'pending' OR ?2 = 'admin')",
        params![user_id, role],
    )?;
    Ok(())
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
            // suplex.sh keeps one account per email, so a new account for the invited email is the same person after an account deletion.
            let (id, _) = mapped.ok_or_else(|| PublicFailure::new(403, "This account has not been invited to this host"))?;
            let user = auth::public_user(database, &id)?.ok_or("User missing")?;
            if user.status == UserStatus::Revoked || user.company_ids.is_empty() { return Err(PublicFailure::new(403, "Company access was removed").into()); }
            // Joining for the first time needs Team. A member who already joined keeps logging in, so a lapsed Team stays readable.
            if user.status == UserStatus::Pending { crate::billing::require_team(database, JOIN_NEEDS_TEAM)?; }
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
        link_owner(database, account, token, r#"{"method":"recovery"}"#, now)
    })
}

/// True on a fresh host: no account owns it or signs in to it, and none ever owned it.
/// An owner who unlinked leaves the audit row, so only `suplex recover` relinks that host.
pub fn unclaimed(database: &SuplexDatabase) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM suplex_account) AND NOT EXISTS (SELECT 1 FROM suplex_account_users) AND NOT EXISTS (SELECT 1 FROM suplex_audit_events WHERE action = 'account_linked')",
        [],
        |row| row.get(0),
    )?)
}

/// The first login to a fresh host links `account` as its owner and signs it in as the owner. `None` once the host has an owner.
pub fn claim(
    database: &mut SuplexDatabase,
    account: &HostedAccount,
    token: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<String>> {
    database.transaction(true, |database| {
        if !unclaimed(database)? {
            return Ok(None);
        }
        link_owner(database, account, token, r#"{"method":"first_login"}"#, now).map(Some)
    })
}

fn link_owner(
    database: &mut SuplexDatabase,
    account: &HostedAccount,
    token: &str,
    metadata_json: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    super::link(database, account, token)?;
    crate::identity::audit::record(
        database,
        &crate::identity::audit::AuditEvent {
            id: &random_hex_id("audit")?,
            actor_user_id: Some("user_development"),
            actor_agent_id: None,
            action: "account_linked",
            target_user_id: None,
            company_id: None,
            metadata_json,
            created_at: &rfc3339_millis(now),
        },
    )?;
    accept(database, account, now)
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
            crate::billing::tests::grant_team(db);
            db.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_test', 'Test', 'active', ?1)", [rfc3339_millis(now)]).unwrap();
            let invited = account("member@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0c9");
            let unknown = account("unknown@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0ca");
            assert!(accept(db, &unknown, now).is_err());
            let invitation = prepare(db, "user_development", "company_test", "Invited Member", &invited.email, UserRole::Member, "https://host.example.com", now).unwrap();
            assert!(accept(db, &invited, now).is_err(), "unsent invitation grants nothing");
            db.connection().execute("UPDATE suplex_company_invitations SET sent_at = ?2 WHERE id = ?1", params![invitation.id, rfc3339_millis(now)]).unwrap();
            assert!(accept(db, &invited, now + Duration::days(8)).is_err(), "expired invitation grants nothing");
            let token = accept(db, &invited, now).unwrap();
            let user = auth::get_user_by_session(db, &token, now).unwrap().unwrap();
            assert_eq!(user.company_ids, vec!["company_test"]);
            assert!(session_verified(db, &token, &user).unwrap());
            assert_eq!(super::super::linked(db).unwrap().unwrap().account_id, owner.id);
            // After the member deletes the Suplex account, a new account for the same email logs in again; the old session no longer verifies.
            let recreated = account("member@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0cb");
            let again = accept(db, &recreated, now).unwrap();
            let same = auth::get_user_by_session(db, &again, now).unwrap().unwrap();
            assert_eq!(same.id, user.id);
            assert!(session_verified(db, &again, &same).unwrap());
            assert!(!session_verified(db, &token, &same).unwrap());
            // Current membership remains authoritative even when a session survives restart.
            crate::billing::tests::grant_team(db);
            companies::remove_membership(db, "user_development", &user.id, "company_test", now).unwrap();
            assert!(accept(db, &invited, now).is_err());
            let current = auth::get_user_by_session(db, &token, now).unwrap().unwrap();
            assert!(!session_verified(db, &token, &current).unwrap());
        });
    }

    #[test]
    fn only_team_invites_and_a_first_join_needs_team() {
        let (state, _) = state();
        state.with_database(|db| {
            let now = Utc::now();
            auth::development_sign_in(db, now).unwrap();
            super::super::link(db, &account("owner@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0c8"), &"k".repeat(43)).unwrap();
            db.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_test', 'Test', 'active', ?1)", [rfc3339_millis(now)]).unwrap();
            let invited = account("member@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0c9");
            let invite = |db: &mut SuplexDatabase| prepare(db, "user_development", "company_test", "Invited Member", &invited.email, UserRole::Member, "https://host.example.com", now);
            assert!(invite(db).is_err(), "Free cannot invite");
            crate::billing::tests::grant_pro(db);
            assert!(invite(db).is_err(), "Pro cannot invite");
            crate::billing::tests::grant_team(db);
            let invitation = invite(db).unwrap();
            db.connection().execute("UPDATE suplex_company_invitations SET sent_at = ?2 WHERE id = ?1", params![invitation.id, rfc3339_millis(now)]).unwrap();
            db.connection().execute("UPDATE suplex_plan SET plan = NULL", []).unwrap();
            assert!(accept(db, &invited, now).is_err(), "a sent invitation cannot be redeemed on Pro");
            crate::billing::tests::grant_team(db);
            accept(db, &invited, now).unwrap();
            // A member who joined keeps logging in after Team lapses to Pro.
            db.connection().execute("UPDATE suplex_plan SET plan = NULL", []).unwrap();
            accept(db, &invited, now).unwrap();
        });
    }

    #[test]
    fn invited_role_applies_on_join_and_never_demotes() {
        let (state, _) = state();
        state.with_database(|db| {
            let now = Utc::now();
            auth::development_sign_in(db, now).unwrap();
            super::super::link(db, &account("owner@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0c8"), &"k".repeat(43)).unwrap();
            crate::billing::tests::grant_team(db);
            db.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_test', 'Test', 'active', ?1)", [rfc3339_millis(now)]).unwrap();
            let invited = account("admin@example.com", "user_67e55044-10b1-426f-9247-bb680e5fe0c9");
            prepare(db, "user_development", "company_test", "Invited Admin", &invited.email, UserRole::Member, "https://host.example.com", now).unwrap();
            // A second send before the person joins changes the role they join with.
            let invitation = prepare(db, "user_development", "company_test", "Invited Admin", &invited.email, UserRole::Admin, "https://host.example.com", now).unwrap();
            db.connection().execute("UPDATE suplex_company_invitations SET sent_at = ?2 WHERE id = ?1", params![invitation.id, rfc3339_millis(now)]).unwrap();
            let token = accept(db, &invited, now).unwrap();
            let user = auth::get_user_by_session(db, &token, now).unwrap().unwrap();
            assert_eq!(user.role, UserRole::Admin);
            db.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_other', 'Other', 'active', ?1)", [rfc3339_millis(now)]).unwrap();
            db.connection().execute("DELETE FROM suplex_memberships WHERE user_id = ?1 AND company_id = 'company_other'", [&user.id]).unwrap();
            prepare(db, "user_development", "company_other", "Invited Admin", &invited.email, UserRole::Member, "https://host.example.com", now).unwrap();
            assert_eq!(auth::public_user(db, &user.id).unwrap().unwrap().role, UserRole::Admin);
        });
    }
}
