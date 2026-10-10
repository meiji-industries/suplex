use crate::identity::IdentityError;
use crate::shared::ids::random_hex_id;
use crate::shared::time::rfc3339_millis;
use chrono::{DateTime, Utc};
use rusqlite::{Error as SqliteError, OptionalExtension, Row, params};
use serde::Serialize;

use crate::platform::database::{DatabaseResult, SuplexDatabase};

use super::auth::{self, UserRole, UserStatus};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Company {
    pub id: String,
    pub name: String,
    pub status: CompanyStatus,
    pub issue_code: Option<String>,
    pub created_at: String,
}

crate::shared::wire_enum! {
    pub enum CompanyStatus { Active = "active", Paused = "paused", Archived = "archived" }
}

fn company(row: &Row<'_>) -> rusqlite::Result<Company> {
    Ok(Company {
        id: row.get(0)?,
        name: row.get(1)?,
        status: row.get(2)?,
        issue_code: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn active_role(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<UserRole> {
    database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [user_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| IdentityError::auth("Authentication required", 401, "auth_failure").into())
}

pub fn require_admin(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<()> {
    if active_role(database, user_id)? != UserRole::Admin {
        return Err(IdentityError::not_found().into());
    }
    Ok(())
}

pub fn list_visible_companies(
    database: &SuplexDatabase,
    user_id: &str,
) -> DatabaseResult<Vec<Company>> {
    let role = active_role(database, user_id)?;
    let sql = if role == UserRole::Admin {
        "SELECT id, name, status, issue_code, created_at FROM suplex_companies ORDER BY name ASC"
    } else {
        "SELECT suplex_companies.id, suplex_companies.name, suplex_companies.status, suplex_companies.issue_code, suplex_companies.created_at FROM suplex_companies INNER JOIN suplex_memberships ON suplex_memberships.company_id = suplex_companies.id WHERE suplex_memberships.user_id = ?1 ORDER BY suplex_companies.name ASC"
    };
    let mut statement = database.connection().prepare(sql)?;
    if role == UserRole::Admin {
        Ok(statement
            .query_map([], company)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    } else {
        Ok(statement
            .query_map([user_id], company)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub fn require_company_access(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> DatabaseResult<Company> {
    if company_id.is_empty() || company_id.encode_utf16().count() > 128 {
        return Err(IdentityError::not_found().into());
    }
    let role = active_role(database, user_id)?;
    let company = if role == UserRole::Admin {
        database
            .connection()
            .query_row(
                "SELECT id, name, status, issue_code, created_at FROM suplex_companies WHERE id = ?1",
                [company_id],
                company,
            )
            .optional()?
    } else {
        database
            .connection()
            .query_row(
                "SELECT suplex_companies.id, suplex_companies.name, suplex_companies.status, suplex_companies.issue_code, suplex_companies.created_at FROM suplex_companies INNER JOIN suplex_memberships ON suplex_memberships.company_id = suplex_companies.id WHERE suplex_companies.id = ?1 AND suplex_memberships.user_id = ?2",
                params![company_id, user_id],
                company,
            )
            .optional()?
    };
    company.ok_or_else(|| IdentityError::not_found().into())
}

crate::shared::wire_enum! {
    /// What a member can do in a company. Admins always edit.
    pub enum CompanyAccess { Edit = "edit", Read = "read" }
}

/// The user's access in a company they can see. A lapsed Team plan makes
/// everyone read-only.
pub fn company_access(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> DatabaseResult<CompanyAccess> {
    if crate::billing::team_lapsed(database)? {
        return Ok(CompanyAccess::Read);
    }
    if active_role(database, user_id)? == UserRole::Admin {
        return Ok(CompanyAccess::Edit);
    }
    Ok(database
        .connection()
        .query_row(
            "SELECT access FROM suplex_memberships WHERE user_id = ?1 AND company_id = ?2",
            params![user_id, company_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(CompanyAccess::Read))
}

/// Choosing which companies a member sees and making a member read-only are
/// Team features. A lapsed Team keeps them, so an administrator can still
/// narrow access.
fn require_scoping(database: &SuplexDatabase) -> DatabaseResult<()> {
    if crate::billing::plan(database)? == crate::billing::Plan::Team
        || crate::billing::team_lapsed(database)?
    {
        return Ok(());
    }
    Err(crate::shared::PublicFailure::new(
        402,
        "Select Team in Settings > Billing to choose what each user can see and change",
    )
    .with_code("team_required")
    .into())
}

/// On Free and Pro every member sees every company: invitations and new
/// companies include all of them. A lapsed Team never widens access.
pub fn grants_every_company(database: &SuplexDatabase) -> DatabaseResult<bool> {
    Ok(
        crate::billing::plan(database)? != crate::billing::Plan::Team
            && !crate::billing::team_lapsed(database)?,
    )
}

/// `require_company_access` for an action that changes work in the company.
/// Someone who cannot see the company still gets 404.
pub fn require_company_edit(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> DatabaseResult<Company> {
    let company = require_company_access(database, user_id, company_id)?;
    if company_access(database, user_id, company_id)? == CompanyAccess::Read {
        if crate::billing::team_lapsed(database)? {
            return Err(IdentityError::auth(
                "Team ended. Work is read-only until an administrator selects Team again.",
                403,
                "team_lapsed",
            )
            .into());
        }
        return Err(IdentityError::auth(
            "You have read-only access to this company",
            403,
            "company_read_only",
        )
        .into());
    }
    Ok(company)
}

pub fn require_admin_company(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> DatabaseResult<Company> {
    require_admin(database, user_id)?;
    require_company_access(database, user_id, company_id)
}

pub fn require_membership_target(
    database: &SuplexDatabase,
    target_user_id: &str,
) -> DatabaseResult<()> {
    let target: Option<UserStatus> = database
        .connection()
        .query_row(
            "SELECT status FROM suplex_users WHERE id = ?1",
            [target_user_id],
            |row| row.get(0),
        )
        .optional()?;
    if target.is_none_or(|status| status == UserStatus::Revoked) {
        return Err(IdentityError::not_found().into());
    }
    Ok(())
}

fn audit(
    database: &SuplexDatabase,
    actor_user_id: &str,
    action: &str,
    target_user_id: Option<&str>,
    company_id: &str,
    metadata_json: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    crate::identity::audit::record(
        database,
        &crate::identity::audit::AuditEvent {
            id: &random_hex_id("audit")?,
            actor_user_id: Some(actor_user_id),
            actor_agent_id: None,
            action,
            target_user_id,
            company_id: Some(company_id),
            metadata_json,
            created_at: &rfc3339_millis(now),
        },
    )?;
    Ok(())
}

fn company_name(raw_name: &str) -> DatabaseResult<String> {
    let name = auth::js_trim(raw_name);
    if name.is_empty() || name.encode_utf16().count() > 120 {
        return Err(IdentityError::auth("Company name is invalid", 400, "auth_failure").into());
    }
    Ok(name.to_owned())
}

pub fn create_company(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    raw_name: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Company> {
    // TypeScript validates the name before checking the actor's role.
    let name = company_name(raw_name)?;
    database.transaction(false, |database| {
        require_admin(database, actor_user_id)?;
        crate::billing::require(database, crate::billing::Limit::Companies, now)?;
        let company_id = random_hex_id("company")?;
        let created_at = rfc3339_millis(now);
        if database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, issue_code, next_issue_number, created_at) VALUES (?1, ?2, 'active', NULL, 1, ?3)",
            params![company_id, name, created_at],
        ).is_err() {
            return Err(IdentityError::auth("Company name is already in use", 400, "auth_failure").into());
        }
        audit(database, actor_user_id, "company_created", None, &company_id, "{}", now)?;
        if grants_every_company(database)? {
            database.connection().execute(
                "INSERT OR IGNORE INTO suplex_memberships (user_id, company_id, created_at) SELECT id, ?1, ?2 FROM suplex_users WHERE role = 'member' AND status != 'revoked'",
                params![company_id, created_at],
            )?;
        }
        require_company_access(database, actor_user_id, &company_id)
    })
}

pub fn rename_company(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
    raw_name: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Company> {
    database.transaction(false, |database| {
        require_admin(database, actor_user_id)?;
        if company_id.is_empty() || company_id.encode_utf16().count() > 128 {
            return Err(IdentityError::not_found().into());
        }
        let name = company_name(raw_name)?;
        let previous = require_company_access(database, actor_user_id, company_id)?;
        if previous.name == name {
            return Ok(previous);
        }
        if database
            .connection()
            .execute(
                "UPDATE suplex_companies SET name = ?2 WHERE id = ?1",
                params![company_id, name],
            )
            .is_err()
        {
            return Err(
                IdentityError::auth("Company name is already in use", 400, "auth_failure").into(),
            );
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct RenameMetadata<'a> {
            previous_name: &'a str,
            new_name: &'a str,
        }
        let metadata = serde_json::to_string(&RenameMetadata {
            previous_name: &previous.name,
            new_name: &name,
        })?;
        audit(
            database,
            actor_user_id,
            "company_renamed",
            None,
            company_id,
            &metadata,
            now,
        )?;
        require_company_access(database, actor_user_id, company_id)
    })
}

pub fn set_company_issue_code(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
    raw_issue_code: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<Company> {
    if company_id.is_empty() || company_id.encode_utf16().count() > 128 {
        return Err(IdentityError::not_found().into());
    }
    database.transaction(false, |database| {
        require_admin(database, actor_user_id)?;
        let issue_code = raw_issue_code.map(|value| auth::js_trim(value).to_uppercase());
        if issue_code.as_ref().is_some_and(|code| {
            let bytes = code.as_bytes();
            !(2..=10).contains(&bytes.len())
                || !bytes[0].is_ascii_uppercase()
                || !bytes[1..].iter().all(u8::is_ascii_alphanumeric)
        }) {
            return Err(IdentityError::auth(
                "Issue code must be 2–10 letters or numbers and start with a letter",
                400,
                "auth_failure",
            )
            .into());
        }
        let previous = require_company_access(database, actor_user_id, company_id)?;
        if previous.issue_code == issue_code {
            return Ok(previous);
        }
        let next_issue_number: i64 = database.connection().query_row(
            "SELECT next_issue_number FROM suplex_companies WHERE id = ?1",
            [company_id],
            |row| row.get(0),
        )?;
        if previous.issue_code.is_some() && next_issue_number > 1 {
            return Err(IdentityError::auth(
                "Issue code cannot be changed after issues have been created",
                409,
                "company_issue_code_locked",
            )
            .into());
        }
        database.connection().execute(
            "UPDATE suplex_companies SET issue_code = ?2 WHERE id = ?1",
            params![company_id, issue_code],
        )?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct IssueCodeMetadata<'a> {
            previous_issue_code: &'a str,
            new_issue_code: &'a str,
        }
        let metadata = serde_json::to_string(&IssueCodeMetadata {
            previous_issue_code: previous.issue_code.as_deref().unwrap_or(""),
            new_issue_code: issue_code.as_deref().unwrap_or(""),
        })?;
        audit(
            database,
            actor_user_id,
            "company_issue_code_updated",
            None,
            company_id,
            &metadata,
            now,
        )?;
        require_company_access(database, actor_user_id, company_id)
    })
}

pub fn set_company_status(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    company_id: &str,
    status: CompanyStatus,
    now: DateTime<Utc>,
) -> DatabaseResult<Company> {
    if company_id.is_empty() || company_id.encode_utf16().count() > 128 {
        return Err(IdentityError::not_found().into());
    }
    database.transaction(false, |database| {
        require_admin(database, actor_user_id)?;
        let previous = require_company_access(database, actor_user_id, company_id)?;
        // Restoring an archived company counts toward the plan again.
        if previous.status == CompanyStatus::Archived && status != CompanyStatus::Archived {
            crate::billing::require(database, crate::billing::Limit::Companies, now)?;
        }
        database.connection().execute(
            "UPDATE suplex_companies SET status = ?2 WHERE id = ?1",
            params![company_id, status],
        )?;
        audit(
            database,
            actor_user_id,
            &format!("company_{status}"),
            None,
            company_id,
            "{}",
            now,
        )?;
        require_company_access(database, actor_user_id, company_id)
    })
}

pub fn add_membership(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    target_user_id: &str,
    company_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        require_admin(database, actor_user_id)?;
        require_membership_target(database, target_user_id)?;
        require_company_access(database, actor_user_id, company_id)?;
        if let Err(error) = database.connection().execute(
            "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, ?2, ?3)",
            params![target_user_id, company_id, rfc3339_millis(now)],
        ) {
            if matches!(&error, SqliteError::SqliteFailure(_, Some(message)) if message.contains("UNIQUE constraint failed: suplex_memberships")) {
                return Err(IdentityError::auth("Membership already exists", 409, "membership_duplicate").into());
            }
            return Err(Box::new(error));
        }
        audit(database, actor_user_id, "membership_added", Some(target_user_id), company_id, "{}", now)?;
        Ok(())
    })
}

pub fn remove_membership(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    target_user_id: &str,
    company_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        require_admin(database, actor_user_id)?;
        require_scoping(database)?;
        if database.connection().execute(
            "DELETE FROM suplex_memberships WHERE user_id = ?1 AND company_id = ?2",
            params![target_user_id, company_id],
        )? != 1
        {
            return Err(IdentityError::not_found().into());
        }
        database.connection().execute("UPDATE suplex_company_invitations SET revoked_at = ?3 WHERE user_id = ?1 AND company_id = ?2 AND revoked_at IS NULL", params![target_user_id, company_id, rfc3339_millis(now)])?;
        audit(
            database,
            actor_user_id,
            "membership_removed",
            Some(target_user_id),
            company_id,
            "{}",
            now,
        )
    })
}

/// Sets what a member can do in a company. Making a member read-only is a
/// Team feature; giving back edit access is always allowed.
pub fn set_membership_access(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    target_user_id: &str,
    company_id: &str,
    access: CompanyAccess,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        require_admin(database, actor_user_id)?;
        if access == CompanyAccess::Read {
            require_scoping(database)?;
        }
        if database.connection().execute(
            "UPDATE suplex_memberships SET access = ?3 WHERE user_id = ?1 AND company_id = ?2",
            params![target_user_id, company_id, access],
        )? != 1
        {
            return Err(IdentityError::not_found().into());
        }
        audit(
            database,
            actor_user_id,
            "membership_access_changed",
            Some(target_user_id),
            company_id,
            &crate::shared::js_json::stringify(&serde_json::json!({"access": access})),
            now,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{identity::auth, platform::database::OpenMode};
    use chrono::{DateTime, Utc};

    #[test]
    fn team_scopes_and_restricts_members_and_a_team_lapse_makes_everyone_read_only() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            random_hex_id("suplex_company").unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap().user;
        let sql = |database: &SuplexDatabase, statement: &str| {
            database.connection().execute(statement, []).unwrap();
        };
        sql(
            &database,
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'Member', 'member', 'member', 'active', '2026-09-24', '2026-09-24', 1)",
        );
        sql(
            &database,
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_one', 'One', 'active', '2026-09-24')",
        );
        sql(
            &database,
            "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES ('member', 'company_one', '2026-09-24')",
        );
        sql(
            &database,
            "INSERT INTO suplex_account (id, account_id, email, token, linked_at) VALUES ('host', 'acct', 'owner@example.com', 't', '2026-09-24')",
        );
        let paid = |database: &SuplexDatabase, plan: &str, until: &str| {
            database.connection().execute(
                "INSERT OR REPLACE INTO suplex_plan (id, account_id, access_until, checked_at, plan) VALUES ('host', 'acct', ?1, '2026-09-24', ?2)",
                params![until, plan],
            ).unwrap();
        };
        let code = |error: Box<dyn std::error::Error + Send + Sync>| {
            crate::shared::public_failure(error).code
        };

        // Pro has no scoping: a new company includes every member, and
        // narrowing access needs Team. Giving edit access is always allowed.
        paid(&database, "pro", "2099-01-01T00:00:00.000Z");
        let two = create_company(&mut database, &admin.id, "Two", now).unwrap();
        assert!(require_company_access(&database, "member", &two.id).is_ok());
        let read = set_membership_access(
            &mut database,
            &admin.id,
            "member",
            "company_one",
            CompanyAccess::Read,
            now,
        );
        assert_eq!(code(read.unwrap_err()), Some("team_required"));
        let removed = remove_membership(&mut database, &admin.id, "member", &two.id, now);
        assert_eq!(code(removed.unwrap_err()), Some("team_required"));
        set_membership_access(
            &mut database,
            &admin.id,
            "member",
            "company_one",
            CompanyAccess::Edit,
            now,
        )
        .unwrap();

        // Team: a read-only member sees the company but cannot change work.
        paid(&database, "team", "2099-01-01T00:00:00.000Z");
        set_membership_access(
            &mut database,
            &admin.id,
            "member",
            "company_one",
            CompanyAccess::Read,
            now,
        )
        .unwrap();
        assert!(require_company_access(&database, "member", "company_one").is_ok());
        let denied = require_company_edit(&database, "member", "company_one");
        assert_eq!(code(denied.unwrap_err()), Some("company_read_only"));
        assert!(require_company_edit(&database, "member", &two.id).is_ok());
        let three = create_company(&mut database, &admin.id, "Three", now).unwrap();
        assert!(require_company_access(&database, "member", &three.id).is_err());
        remove_membership(&mut database, &admin.id, "member", &two.id, now).unwrap();

        // A confirmed Team lapse makes everyone read-only, admins too, and
        // never widens access.
        paid(&database, "team", "2000-01-01T00:00:00.000Z");
        let lapsed = require_company_edit(&database, &admin.id, "company_one");
        assert_eq!(code(lapsed.unwrap_err()), Some("team_lapsed"));
        assert_eq!(
            company_access(&database, &admin.id, "company_one").unwrap(),
            CompanyAccess::Read
        );
        assert!(require_company_access(&database, "member", "company_one").is_ok());
        assert!(!grants_every_company(&database).unwrap());
        // Paying again restores edit access.
        paid(&database, "team", "2099-01-01T00:00:00.000Z");
        assert!(require_company_edit(&database, &admin.id, "company_one").is_ok());
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn company_visibility_uses_live_membership_and_admin_role() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            random_hex_id("suplex_company").unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'Member', 'user_v1_member', 'member', 'active', ?1, ?1, 1)",
            [now.to_rfc3339()],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_one', 'One', 'active', ?1)",
            [now.to_rfc3339()],
        ).unwrap();
        assert_eq!(
            list_visible_companies(&database, &admin.id).unwrap().len(),
            1
        );
        assert!(
            list_visible_companies(&database, "member")
                .unwrap()
                .is_empty()
        );
        assert!(require_company_access(&database, "member", "company_one").is_err());
        assert!(require_admin(&database, "member").is_err());
        database.connection().execute(
            "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES ('member', 'company_one', ?1)",
            [now.to_rfc3339()],
        ).unwrap();
        assert_eq!(
            list_visible_companies(&database, "member").unwrap()[0].id,
            "company_one"
        );
        assert_eq!(
            require_company_access(&database, "member", "company_one")
                .unwrap()
                .name,
            "One"
        );
        database.connection().execute(
            "DELETE FROM suplex_memberships WHERE user_id = 'member' AND company_id = 'company_one'",
            [],
        ).unwrap();
        assert!(require_company_access(&database, "member", "company_one").is_err());
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn company_mutations_enforce_role_uniqueness_issue_lock_and_audit() {
        let filename = std::env::temp_dir().join(format!(
            "{}.sqlite",
            random_hex_id("suplex_company_mutations").unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        crate::billing::tests::grant_team(&database);
        let now = DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let admin = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member_company', 'Member', 'member_company', 'member', 'active', ?1, ?1, 1)",
            [now.to_rfc3339()],
        ).unwrap();
        assert_eq!(
            create_company(&mut database, "member_company", "   ", now)
                .unwrap_err()
                .downcast_ref::<IdentityError>()
                .unwrap()
                .status(),
            400
        );
        assert_eq!(
            create_company(&mut database, "member_company", "Member Company", now)
                .unwrap_err()
                .downcast_ref::<IdentityError>()
                .unwrap()
                .status(),
            404
        );
        let created = create_company(
            &mut database,
            &admin.id,
            "\u{FEFF}  Company A  \u{FEFF}",
            now,
        )
        .unwrap();
        assert_eq!(created.name, "Company A");
        assert_eq!(created.issue_code, None);
        assert_eq!(
            create_company(&mut database, &admin.id, "Company A", now)
                .unwrap_err()
                .to_string(),
            "Company name is already in use"
        );
        assert_eq!(
            rename_company(
                &mut database,
                &admin.id,
                &created.id,
                " Company Renamed ",
                now
            )
            .unwrap()
            .name,
            "Company Renamed"
        );
        assert_eq!(
            set_company_issue_code(&mut database, &admin.id, &created.id, Some(" ad4m "), now)
                .unwrap()
                .issue_code
                .as_deref(),
            Some("AD4M")
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_companies SET next_issue_number = 2 WHERE id = ?1",
                [&created.id],
            )
            .unwrap();
        assert_eq!(
            set_company_issue_code(&mut database, &admin.id, &created.id, Some("NEXT"), now)
                .unwrap_err()
                .downcast_ref::<IdentityError>()
                .unwrap()
                .code(),
            "company_issue_code_locked"
        );
        assert_eq!(
            set_company_status(
                &mut database,
                &admin.id,
                &created.id,
                CompanyStatus::Paused,
                now
            )
            .unwrap()
            .status,
            CompanyStatus::Paused
        );
        add_membership(&mut database, &admin.id, "member_company", &created.id, now).unwrap();
        assert_eq!(
            add_membership(&mut database, &admin.id, "member_company", &created.id, now)
                .unwrap_err()
                .downcast_ref::<IdentityError>()
                .unwrap()
                .code(),
            "membership_duplicate"
        );
        assert_eq!(
            list_visible_companies(&database, "member_company")
                .unwrap()
                .len(),
            1
        );
        remove_membership(&mut database, &admin.id, "member_company", &created.id, now).unwrap();
        assert!(
            list_visible_companies(&database, "member_company")
                .unwrap()
                .is_empty()
        );
        let mut statement = database
            .connection()
            .prepare("SELECT action, metadata_json FROM suplex_audit_events ORDER BY rowid")
            .unwrap();
        let events = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.0.as_str())
                .collect::<Vec<_>>(),
            [
                "company_created",
                "company_renamed",
                "company_issue_code_updated",
                "company_paused",
                "membership_added",
                "membership_removed"
            ]
        );
        assert_eq!(
            events[1].1,
            r#"{"previousName":"Company A","newName":"Company Renamed"}"#
        );
        assert_eq!(
            events[2].1,
            r#"{"previousIssueCode":"","newIssueCode":"AD4M"}"#
        );
        drop(statement);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
