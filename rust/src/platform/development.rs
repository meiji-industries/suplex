//! `platform/development.ts`: the Rust binary always runs in local loopback
//! mode, so the Operator exists and has a first company on every start.

use crate::identity::IdentityError;
use crate::shared::time::rfc3339_millis;
use chrono::{DateTime, Utc};

use super::database::{DatabaseResult, SuplexDatabase};
use crate::identity::{auth, companies};

pub fn seed_development_data(
    database: &mut SuplexDatabase,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let user_id = ensure_development_user(database, now)?;
    if companies::list_visible_companies(database, &user_id)?.is_empty() {
        companies::create_company(database, &user_id, "My Company", now)?;
    }
    Ok(())
}

fn ensure_development_user(
    database: &mut SuplexDatabase,
    now: DateTime<Utc>,
) -> DatabaseResult<String> {
    database.transaction(false, |database| {
        database.connection().execute(
            "INSERT OR IGNORE INTO suplex_users (id, display_name, username, avatar_seed, role, status, created_at, updated_at, identity_version) VALUES ('user_development', 'Operator', 'operator@suplex.local', 'operator@suplex.local', 'admin', 'active', ?1, ?1, 1)",
            [rfc3339_millis(now)],
        )?;
        let user = auth::public_user(database, "user_development")?.ok_or("development user missing")?;
        if user.role != "admin" || user.status != "active" {
            return Err(IdentityError::auth(
                "Development user is unavailable",
                409,
                "auth_failure",
            ).into());
        }
        Ok(user.id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;

    #[test]
    fn seeding_creates_one_company_for_the_operator_and_is_idempotent() {
        let path =
            std::env::temp_dir().join(format!("suplex-seed-{}.sqlite", uuid::Uuid::new_v4()));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        seed_development_data(&mut database, Utc::now()).unwrap();
        seed_development_data(&mut database, Utc::now()).unwrap();
        let companies = companies::list_visible_companies(&database, "user_development").unwrap();
        assert_eq!(companies.len(), 1);
        assert_eq!(companies[0].name, "My Company");
        drop(database);
        let _ = std::fs::remove_file(&path);
    }
}
