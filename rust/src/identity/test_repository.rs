use crate::platform::database::{DatabaseResult, SuplexDatabase};

pub fn revoke_seed_operator(database: &SuplexDatabase) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_users SET status = 'revoked' WHERE id = 'user_development'",
        [],
    )?;
    Ok(())
}
