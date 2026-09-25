use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;

use crate::platform::database::{DatabaseResult, SuplexDatabase};

use super::auth::AuthFailure;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Company {
    pub id: String,
    pub name: String,
    pub status: String,
    pub issue_code: Option<String>,
    pub created_at: String,
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

fn active_role(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<String> {
    database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [user_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            Box::new(AuthFailure::new(
                "Authentication required",
                401,
                "auth_failure",
            )) as Box<dyn std::error::Error>
        })
}

pub fn require_admin(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<()> {
    if active_role(database, user_id)? != "admin" {
        return Err(Box::new(AuthFailure::new("Not found", 404, "auth_failure")));
    }
    Ok(())
}

pub fn list_visible_companies(
    database: &SuplexDatabase,
    user_id: &str,
) -> DatabaseResult<Vec<Company>> {
    let role = active_role(database, user_id)?;
    let sql = if role == "admin" {
        "SELECT id, name, status, issue_code, created_at FROM suplex_companies ORDER BY name ASC"
    } else {
        "SELECT suplex_companies.id, suplex_companies.name, suplex_companies.status, suplex_companies.issue_code, suplex_companies.created_at FROM suplex_companies INNER JOIN suplex_memberships ON suplex_memberships.company_id = suplex_companies.id WHERE suplex_memberships.user_id = ?1 ORDER BY suplex_companies.name ASC"
    };
    let mut statement = database.connection().prepare(sql)?;
    if role == "admin" {
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
        return Err(Box::new(AuthFailure::new("Not found", 404, "auth_failure")));
    }
    let role = active_role(database, user_id)?;
    let company = if role == "admin" {
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
    company.ok_or_else(|| Box::new(AuthFailure::new("Not found", 404, "auth_failure")) as _)
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
    let target: Option<String> = database
        .connection()
        .query_row(
            "SELECT status FROM suplex_users WHERE id = ?1",
            [target_user_id],
            |row| row.get(0),
        )
        .optional()?;
    if target.as_deref().is_none_or(|status| status == "revoked") {
        return Err(Box::new(AuthFailure::new("Not found", 404, "auth_failure")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{identity::auth, platform::database::OpenMode};
    use chrono::{DateTime, Utc};

    #[test]
    fn company_visibility_uses_live_membership_and_admin_role() {
        let filename =
            std::env::temp_dir().join(format!("suplex_company_{}.sqlite", std::process::id()));
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
}
