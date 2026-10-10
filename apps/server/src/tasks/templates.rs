//! Project task templates: saved task configurations, per project.

use crate::shared::ids::random_hex_id;
use crate::shared::time::now_millis_rfc3339;
use crate::tasks::TaskError;
use std::error::Error;

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::{
    coordination::workflow_records::normalize_workflow_input,
    http::contracts::typed::task_templates::{self, TemplateConfiguration, TemplateResponse},
    identity::companies,
    platform::database::SuplexDatabase,
};

use super::response;

/// The project's company is visible to the user; `edit` also needs edit access.
fn require_project(
    database: &SuplexDatabase,
    user_id: &str,
    project_id: &str,
    edit: bool,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let company_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_projects WHERE id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()?;
    let company_id = company_id.ok_or_else(TaskError::not_found)?;
    if edit {
        companies::require_company_edit(database, user_id, &company_id)?;
    } else {
        companies::require_company_access(database, user_id, &company_id)?;
    }
    Ok(())
}

type TemplateRow = (String, String, String, String, String);

fn template(
    (id, project_id, configuration_json, created_at, updated_at): TemplateRow,
) -> Result<TemplateResponse, Box<dyn Error + Send + Sync>> {
    let value: Value = serde_json::from_str(&configuration_json)?;
    let configuration = task_templates::parse_stored_configuration(value)?;
    Ok(TemplateResponse {
        configuration,
        id,
        project_id,
        created_at,
        updated_at,
    })
}

const COLUMNS: &str =
    "SELECT id, project_id, configuration_json, created_at, updated_at FROM suplex_task_templates";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TemplateRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

pub fn list(
    database: &SuplexDatabase,
    user_id: &str,
    project_id: &str,
) -> Result<Vec<TemplateResponse>, Box<dyn Error + Send + Sync>> {
    require_project(database, user_id, project_id, false)?;
    let mut statement = database.connection().prepare(&format!(
        "{COLUMNS} WHERE project_id = ?1 ORDER BY name COLLATE NOCASE, id"
    ))?;
    let rows = statement.query_map([project_id], row)?;
    rows.map(|value| template(value?)).collect()
}

/// Apply workflow defaults, then the create schema.
fn normalized(
    mut input: Map<String, Value>,
) -> Result<TemplateConfiguration, Box<dyn Error + Send + Sync>> {
    normalize_workflow_input(&mut input, false).map_err(|message| TaskError::new(message, 422))?;
    Ok(task_templates::parse_stored_configuration(Value::Object(
        input,
    ))?)
}

fn assert_name(
    database: &SuplexDatabase,
    project_id: &str,
    name: &str,
    id: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let taken: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_templates WHERE project_id = ?1 AND name = ?2 AND id <> ?3)",
        params![project_id, name, id],
        |row| row.get(0),
    )?;
    if taken {
        return Err(TaskError::new("This template name is already in use", 409).into());
    }
    Ok(())
}

pub fn create(
    database: &mut SuplexDatabase,
    user_id: &str,
    project_id: &str,
    input: Map<String, Value>,
) -> Result<TemplateResponse, Box<dyn Error + Send + Sync>> {
    require_project(database, user_id, project_id, true)?;
    let configuration = normalized(input)?;
    let id = random_hex_id("template")?;
    let stamp = now_millis_rfc3339();
    let configuration_json = serde_json::to_string(&configuration)?;
    database.transaction(false, |database| {
        assert_name(database, project_id, &configuration.name, "")?;
        database.connection().execute(
            "INSERT INTO suplex_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, project_id, configuration.name, configuration_json, stamp],
        )?;
        Ok(())
    })?;
    Ok(TemplateResponse {
        configuration,
        id,
        project_id: project_id.to_owned(),
        created_at: stamp.clone(),
        updated_at: stamp,
    })
}

pub fn create_from_task(
    database: &mut SuplexDatabase,
    user_id: &str,
    task_id: &str,
    name: &str,
) -> Result<TemplateResponse, Box<dyn Error + Send + Sync>> {
    let company_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    companies::require_company_edit(
        database,
        user_id,
        &company_id.ok_or_else(TaskError::not_found)?,
    )?;
    let task =
        serde_json::to_value(response::get(database, task_id)?.ok_or_else(TaskError::not_found)?)?;
    let advisor_profile_ids = task["advisorProfiles"]
        .as_object()
        .map(|profiles| {
            profiles
                .iter()
                .map(|(role, profile)| (role.clone(), profile["profileId"].clone()))
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    let Value::Object(input) = json!({
        "name": name,
        "description": task["description"],
        "rootProfileId": task["rootProfile"]["profileId"],
        "workerProfileId": task["workerProfile"]["profileId"],
        "deliveryTarget": task["deliveryTarget"],
        "runProjectTests": task["configuration"]["runProjectTests"],
        "visualEvidence": task["configuration"]["visualEvidence"],
        "workflow": task["workflow"],
        "advisorProfileIds": advisor_profile_ids,
    }) else {
        unreachable!("template input is an object");
    };
    let project_id = task["projectId"].as_str().unwrap_or_default().to_owned();
    create(database, user_id, &project_id, input)
}

fn get(
    database: &SuplexDatabase,
    user_id: &str,
    template_id: &str,
) -> Result<TemplateResponse, Box<dyn Error + Send + Sync>> {
    let stored = database
        .connection()
        .query_row(&format!("{COLUMNS} WHERE id = ?1"), [template_id], row)
        .optional()?
        .ok_or_else(TaskError::not_found)?;
    let current = template(stored)?;
    require_project(database, user_id, &current.project_id, true)?;
    Ok(current)
}

pub fn update(
    database: &mut SuplexDatabase,
    user_id: &str,
    template_id: &str,
    changes: Map<String, Value>,
) -> Result<TemplateResponse, Box<dyn Error + Send + Sync>> {
    let current = get(database, user_id, template_id)?;
    let Value::Object(mut values) = serde_json::to_value(&current.configuration)? else {
        unreachable!("a template configuration serializes as an object");
    };
    let workflow = changes.get("workflow").and_then(Value::as_str);
    // Switching to repair replaces the inherited target with merged; an explicit contradiction still fails.
    if workflow == Some("refine_pull_request")
        && current.configuration.workflow
            != crate::coordination::workflows::Workflow::RefinePullRequest
    {
        values.insert("deliveryTarget".into(), json!("merged"));
    }
    if workflow.is_some_and(|workflow| workflow != current.configuration.workflow.as_str())
        && !changes.contains_key("advisorProfileIds")
    {
        values.insert("advisorProfileIds".into(), json!({}));
    }
    values.extend(changes);
    for key in ["rootProfileId", "workerProfileId"] {
        if values.get(key).is_some_and(Value::is_null) {
            values.remove(key);
        }
    }
    let configuration = normalized(values)?;
    let updated_at = now_millis_rfc3339();
    let configuration_json = serde_json::to_string(&configuration)?;
    database.transaction(false, |database| {
        assert_name(
            database,
            &current.project_id,
            &configuration.name,
            template_id,
        )?;
        database.connection().execute(
            "UPDATE suplex_task_templates SET name = ?1, configuration_json = ?2, updated_at = ?3 WHERE id = ?4",
            params![configuration.name, configuration_json, updated_at, template_id],
        )?;
        Ok(())
    })?;
    Ok(TemplateResponse {
        configuration,
        id: current.id,
        project_id: current.project_id,
        created_at: current.created_at,
        updated_at,
    })
}

pub fn delete(
    database: &mut SuplexDatabase,
    user_id: &str,
    template_id: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    get(database, user_id, template_id)?;
    database.transaction(false, |database| {
        database.connection().execute(
            "DELETE FROM suplex_task_templates WHERE id = ?1",
            [template_id],
        )?;
        Ok(())
    })
}
