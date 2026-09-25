//! Project task-template listing from stored configuration.

use std::error::Error;

use rusqlite::OptionalExtension;
use serde_json::Value;

use crate::{
    http::contracts::typed::task_templates::{self, TemplateResponse},
    identity::companies,
    platform::database::SuplexDatabase,
};

use super::commands::TaskFailure;

pub fn list(
    database: &SuplexDatabase,
    user_id: &str,
    project_id: &str,
) -> Result<Vec<TemplateResponse>, Box<dyn Error>> {
    let company_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_projects WHERE id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()?;
    let company_id = company_id.ok_or_else(|| TaskFailure {
        public_message: "Not found".into(),
        status_code: 404,
        code: "task_failure",
    })?;
    companies::require_company_access(database, user_id, &company_id)?;
    let mut statement = database.connection().prepare(
        "SELECT id, project_id, configuration_json, created_at, updated_at \
         FROM suplex_task_templates WHERE project_id = ?1 ORDER BY name COLLATE NOCASE, id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    rows.map(|row| {
        let (id, project_id, configuration_json, created_at, updated_at) = row?;
        let value: Value = serde_json::from_str(&configuration_json)?;
        let configuration =
            task_templates::parse_stored_configuration(value).map_err(std::io::Error::other)?;
        Ok(TemplateResponse {
            configuration,
            id,
            project_id,
            created_at,
            updated_at,
        })
    })
    .collect()
}
