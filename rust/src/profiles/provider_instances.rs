//! Local provider instances: a private home directory per Claude Code login.

use crate::identity::IdentityError;
use crate::shared::time::now_millis_rfc3339;
use std::{
    error::Error,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::platform::database::SuplexDatabase;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const SELECTION: &str = "SELECT id, provider, label, home_directory, created_at, updated_at FROM suplex_provider_instances";

fn failure(message: &'static str, status_code: u16) -> Box<dyn Error> {
    IdentityError::auth(message, status_code, "auth_failure").into()
}

pub fn provider_instances_directory(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("provider-instances")
}

fn require_admin(database: &SuplexDatabase, user_id: &str) -> Result<()> {
    let role: Option<String> = database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [user_id],
            |row| row.get(0),
        )
        .optional()?;
    if role.as_deref() == Some("admin") {
        Ok(())
    } else {
        Err(failure("Administrator access required", 403))
    }
}

fn instance(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "provider": row.get::<_, String>(1)?,
        "label": row.get::<_, String>(2)?,
        "homeDirectory": row.get::<_, String>(3)?,
        "createdAt": row.get::<_, String>(4)?,
        "updatedAt": row.get::<_, String>(5)?,
    }))
}

fn get(database: &SuplexDatabase, id: &str) -> Result<Value> {
    database
        .connection()
        .query_row(&format!("{SELECTION} WHERE id = ?1"), [id], instance)
        .optional()?
        .ok_or_else(|| failure("Not found", 404))
}

pub fn list(database: &SuplexDatabase, user_id: &str) -> Result<Vec<Value>> {
    require_admin(database, user_id)?;
    let mut statement = database.connection().prepare(&format!(
        "{SELECTION} ORDER BY provider, label COLLATE NOCASE, id"
    ))?;
    Ok(statement
        .query_map([], instance)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// `provider` and `label` come from the validated create body.
pub fn create(
    database: &mut SuplexDatabase,
    user_id: &str,
    provider: &str,
    label: &str,
) -> Result<Value> {
    require_admin(database, user_id)?;
    if provider != "claude-code" {
        return Err(failure(
            "This provider does not support local instances",
            422,
        ));
    }
    let id = format!("instance_{}", uuid::Uuid::new_v4().simple());
    let database_path = PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Database has no file path")?,
    );
    let home = provider_instances_directory(&database_path).join(&id);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&home)?;
    let now = now_millis_rfc3339();
    database.transaction(true, |database| {
        database.connection().execute(
            "INSERT INTO suplex_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, provider, label, home.to_string_lossy(), now],
        )?;
        Ok(())
    })?;
    get(database, &id)
}

pub fn delete(database: &mut SuplexDatabase, user_id: &str, id: &str) -> Result<()> {
    require_admin(database, user_id)?;
    let instance = get(database, id)?;
    database.transaction(true, |database| {
        let referenced: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_profiles WHERE provider_instance_id = ?1) OR EXISTS(SELECT 1 FROM suplex_projects p, json_each(p.provider_policy_json, '$.allowedInstanceIds') allowed WHERE allowed.value = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if referenced {
            return Err(failure("This provider instance is used by an agent profile or project", 409));
        }
        database
            .connection()
            .execute("DELETE FROM suplex_provider_instances WHERE id = ?1", [id])?;
        Ok(())
    })?;
    match std::fs::remove_dir_all(instance["homeDirectory"].as_str().unwrap_or_default()) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}
