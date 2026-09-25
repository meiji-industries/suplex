//! Seeded workflow presets needed by the task creation UI.

use rusqlite::Row;
use serde::{Deserialize, Serialize};

use crate::{
    identity::auth::AuthFailure,
    platform::database::{DatabaseResult, SuplexDatabase},
};

#[derive(Debug, Default, Deserialize, Serialize)]
struct AdvisorProfileIds {
    #[serde(skip_serializing_if = "Option::is_none")]
    reviewer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    planner_a: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    planner_b: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rater: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Configuration {
    root_profile_id: Option<String>,
    worker_profile_id: Option<String>,
    #[serde(default)]
    advisor_profile_ids: AdvisorProfileIds,
    delivery_target: Option<String>,
    run_project_tests: Option<bool>,
    visual_evidence: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRecord {
    name: String,
    description: String,
    engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    root_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_profile_id: Option<String>,
    advisor_profile_ids: AdvisorProfileIds,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_project_tests: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    visual_evidence: Option<String>,
    id: String,
    archived_at: Option<String>,
    created_at: String,
    updated_at: String,
}

fn record(row: &Row<'_>) -> rusqlite::Result<WorkflowRecord> {
    let raw: String = row.get("configuration_json")?;
    let config: Configuration = serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(WorkflowRecord {
        name: row.get("name")?,
        description: row.get("description")?,
        engine: row.get("engine")?,
        root_profile_id: config.root_profile_id,
        worker_profile_id: config.worker_profile_id,
        advisor_profile_ids: config.advisor_profile_ids,
        delivery_target: config.delivery_target,
        run_project_tests: config.run_project_tests,
        visual_evidence: config.visual_evidence,
        id: row.get("id")?,
        archived_at: row.get("archived_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Check live user authority and return migration-seeded presets in source order.
pub fn list(
    database: &SuplexDatabase,
    user_id: &str,
    include_archived: bool,
) -> DatabaseResult<Vec<WorkflowRecord>> {
    let active: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_users WHERE id = ?1 AND status = 'active')",
        [user_id],
        |row| row.get(0),
    )?;
    if !active {
        return Err(Box::new(AuthFailure::new(
            "Authentication required",
            401,
            "auth_failure",
        )));
    }
    let sql = if include_archived {
        "SELECT * FROM suplex_workflows ORDER BY name COLLATE NOCASE, id"
    } else {
        "SELECT * FROM suplex_workflows WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id"
    };
    let mut statement = database.connection().prepare(sql)?;
    Ok(statement
        .query_map([], record)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
