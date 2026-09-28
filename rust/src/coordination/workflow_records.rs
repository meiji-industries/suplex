//! Workflow records: named, editable presets over one built-in engine.

use crate::identity::IdentityError;
use crate::shared::ids::random_hex_id;
use crate::shared::time::now_millis_rfc3339;
use crate::tasks::TaskError;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{
    coordination::workflows::{advisor_label, workflow_definition},
    http::contracts::typed::workflows as contracts,
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

/// TypeScript `normalizeWorkflowInput`: apply workflow defaults before schema
/// defaults can erase whether a caller supplied a field.
pub fn normalize_workflow_input(
    raw: &mut Map<String, Value>,
    require_source: bool,
) -> Result<(), String> {
    let workflow = raw
        .get("workflow")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!("standard"));
    let Some(definition) = workflow.as_str().and_then(workflow_definition) else {
        return Err("The selected workflow does not exist".into());
    };
    let advisors = raw
        .get("advisorProfileIds")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let valid = advisors.as_object().is_some_and(|ids| {
        ids.iter().all(|(role, id)| {
            ["reviewer", "planner_a", "planner_b", "rater"].contains(&role.as_str())
                && id
                    .as_str()
                    .is_some_and(|id| (1..=256).contains(&id.encode_utf16().count()))
        })
    });
    if !valid {
        return Err("The Advisor profile selection is not valid".into());
    }
    let extra = ["reviewer", "planner_a", "planner_b", "rater"]
        .into_iter()
        .filter(|role| advisors.get(role).is_some() && !definition.advisor_roles.contains(role))
        .map(advisor_label)
        .collect::<Vec<_>>();
    if !extra.is_empty() {
        return Err(format!(
            "The {} workflow has no {} Advisor",
            definition.name,
            extra.join(", ")
        ));
    }
    raw.insert("workflow".into(), json!(definition.id));
    raw.insert("advisorProfileIds".into(), advisors);
    if definition.id != "refine_pull_request" {
        return Ok(());
    }
    if raw
        .get("deliveryTarget")
        .is_some_and(|value| value != "merged")
    {
        return Err("Pull request repair always delivers a merged pull request".into());
    }
    if raw
        .get("runProjectTests")
        .is_some_and(|value| value != true)
    {
        return Err("Pull request repair always runs the project tests".into());
    }
    let source_kind = raw
        .get("source")
        .and_then(|source| source.get("kind"))
        .and_then(Value::as_str);
    if require_source && source_kind != Some("pull_request") {
        return Err("Select a pull request source for Pull request repair".into());
    }
    raw.insert("deliveryTarget".into(), json!("merged"));
    raw.insert("runProjectTests".into(), json!(true));
    Ok(())
}

fn active_role(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<Option<String>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [user_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn require_admin(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<()> {
    if active_role(database, user_id)?.as_deref() != Some("admin") {
        return Err(
            IdentityError::auth("Administrator access required", 403, "auth_failure").into(),
        );
    }
    Ok(())
}

/// Check live user authority and return workflow records in name order.
pub fn list(
    database: &SuplexDatabase,
    user_id: &str,
    include_archived: bool,
) -> DatabaseResult<Vec<WorkflowRecord>> {
    if active_role(database, user_id)?.is_none() {
        return Err(IdentityError::auth("Authentication required", 401, "auth_failure").into());
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

fn read(database: &SuplexDatabase, id: &str) -> DatabaseResult<WorkflowRecord> {
    database
        .connection()
        .query_row("SELECT * FROM suplex_workflows WHERE id = ?1", [id], record)
        .optional()?
        .ok_or_else(|| IdentityError::not_found().into())
}

fn assert_name(database: &SuplexDatabase, name: &str, id: &str) -> DatabaseResult<()> {
    let taken: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_workflows WHERE name = ?1 AND id <> ?2)",
        params![name, id],
        |row| row.get(0),
    )?;
    if taken {
        return Err(IdentityError::auth(
            "This workflow name is already in use",
            409,
            "auth_failure",
        )
        .into());
    }
    Ok(())
}

/// Advisor roles must belong to the engine, repair keeps its forced delivery,
/// and every profile must exist with the right role.
fn validate(database: &SuplexDatabase, values: &Map<String, Value>) -> DatabaseResult<()> {
    let mut input = Map::new();
    for (from, to) in [
        ("engine", "workflow"),
        ("advisorProfileIds", "advisorProfileIds"),
        ("deliveryTarget", "deliveryTarget"),
        ("runProjectTests", "runProjectTests"),
    ] {
        if let Some(value) = values.get(from) {
            input.insert(to.into(), value.clone());
        }
    }
    normalize_workflow_input(&mut input, false).map_err(|message| TaskError::new(message, 422))?;
    let engine = values["engine"].as_str().unwrap_or_default();
    let mut checks = vec![
        (values.get("rootProfileId"), "root", "Coordinator"),
        (values.get("workerProfileId"), "worker", "Worker"),
    ];
    for role in workflow_definition(engine).map_or(&[][..], |definition| definition.advisor_roles) {
        checks.push((values["advisorProfileIds"].get(*role), "root", "Advisor"));
    }
    for (profile_id, role, label) in checks {
        let Some(profile_id) = profile_id
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let exists: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_profiles WHERE id = ?1 AND role = ?2)",
            params![profile_id, role],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(
                TaskError::new(format!("The selected {label} agent does not exist"), 422).into(),
            );
        }
    }
    Ok(())
}

/// The stored configuration is the input without name, description, and engine.
fn configuration_json(values: &Map<String, Value>) -> String {
    let mut configuration = values.clone();
    for key in ["name", "description", "engine"] {
        configuration.remove(key);
    }
    crate::shared::js_json::stringify(&Value::Object(configuration))
}

fn audit(database: &SuplexDatabase, user_id: &str, action: &str, id: &str) -> DatabaseResult<()> {
    crate::http::routes::admin_platform::record_audit(
        database,
        Some(user_id),
        action,
        json!({ "workflowId": id }),
    )
}

pub fn create(
    database: &mut SuplexDatabase,
    user_id: &str,
    values: Map<String, Value>,
) -> DatabaseResult<WorkflowRecord> {
    require_admin(database, user_id)?;
    validate(database, &values)?;
    let id = random_hex_id("workflow")?;
    let stamp = now_millis_rfc3339();
    database.transaction(false, |database| {
        let name = values["name"].as_str().unwrap_or_default();
        assert_name(database, name, "")?;
        database.connection().execute(
            "INSERT INTO suplex_workflows (id, name, description, engine, configuration_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, values["description"].as_str().unwrap_or_default(), values["engine"].as_str().unwrap_or_default(), configuration_json(&values), stamp],
        )?;
        audit(database, user_id, "workflow_created", &id)
    })?;
    read(database, &id)
}

pub fn update(
    database: &mut SuplexDatabase,
    user_id: &str,
    id: &str,
    mut changes: Map<String, Value>,
) -> DatabaseResult<WorkflowRecord> {
    require_admin(database, user_id)?;
    let archived = changes.remove("archived").and_then(|value| value.as_bool());
    database.transaction(false, |database| {
        let current = read(database, id)?;
        let Value::Object(mut merged) = serde_json::to_value(&current)? else {
            unreachable!("a workflow record serializes as an object");
        };
        // A new engine drops Advisor choices the caller did not restate; other defaults carry over.
        let engine_changed = changes
            .get("engine")
            .is_some_and(|engine| engine.as_str() != Some(current.engine.as_str()));
        let advisors_sent = changes.contains_key("advisorProfileIds");
        merged.extend(changes);
        if engine_changed && !advisors_sent {
            merged.insert("advisorProfileIds".into(), json!({}));
        }
        for key in [
            "rootProfileId",
            "workerProfileId",
            "deliveryTarget",
            "runProjectTests",
            "visualEvidence",
        ] {
            if merged.get(key).is_some_and(Value::is_null) {
                merged.remove(key);
            }
        }
        let values = contracts::strip_input(&merged)
            .map_err(|_| "Stored workflow record is not a valid workflow input")?;
        validate(database, &values)?;
        assert_name(database, values["name"].as_str().unwrap_or_default(), id)?;
        let stamp = now_millis_rfc3339();
        let archived_at = match archived {
            None => current.archived_at.clone(),
            Some(true) => Some(stamp.clone()),
            Some(false) => None,
        };
        database.connection().execute(
            "UPDATE suplex_workflows SET name = ?1, description = ?2, engine = ?3, configuration_json = ?4, archived_at = ?5, updated_at = ?6 WHERE id = ?7",
            params![values["name"].as_str(), values["description"].as_str(), values["engine"].as_str(), configuration_json(&values), archived_at, stamp, id],
        )?;
        audit(database, user_id, "workflow_updated", id)?;
        read(database, id)
    })
}

pub fn duplicate(
    database: &mut SuplexDatabase,
    user_id: &str,
    id: &str,
) -> DatabaseResult<WorkflowRecord> {
    require_admin(database, user_id)?;
    let source = read(database, id)?;
    let names = list(database, user_id, true)?
        .into_iter()
        .map(|workflow| workflow.name)
        .collect::<std::collections::HashSet<_>>();
    let base = source.name.chars().take(65).collect::<String>();
    let mut name = format!("{base} (copy)");
    let mut copy = 2;
    while names.contains(&name) {
        name = format!("{base} (copy {copy})");
        copy += 1;
    }
    let Value::Object(mut values) = serde_json::to_value(&source)? else {
        unreachable!("a workflow record serializes as an object");
    };
    values.insert("name".into(), json!(name));
    let values = contracts::strip_input(&values)
        .map_err(|_| "Stored workflow record is not a valid workflow input")?;
    create(database, user_id, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_input_normalization_matches_typescript_messages() {
        let normalized = |value: Value, require_source: bool| {
            let Value::Object(mut raw) = value else {
                unreachable!()
            };
            normalize_workflow_input(&mut raw, require_source).map(|()| Value::Object(raw))
        };
        assert_eq!(
            normalized(json!({}), false).unwrap(),
            json!({"workflow":"standard","advisorProfileIds":{}})
        );
        assert_eq!(
            normalized(json!({"workflow":"other"}), false).unwrap_err(),
            "The selected workflow does not exist"
        );
        assert_eq!(
            normalized(json!({"advisorProfileIds":{"extra":"x"}}), false).unwrap_err(),
            "The Advisor profile selection is not valid"
        );
        assert_eq!(
            normalized(
                json!({"workflow":"direct_build","advisorProfileIds":{"reviewer":"a","rater":"b"}}),
                false
            )
            .unwrap_err(),
            "The Simple task workflow has no Reviewer, Rater Advisor"
        );
        assert_eq!(
            normalized(
                json!({"workflow":"refine_pull_request","deliveryTarget":"local_worktree"}),
                false
            )
            .unwrap_err(),
            "Pull request repair always delivers a merged pull request"
        );
        assert_eq!(
            normalized(
                json!({"workflow":"refine_pull_request","runProjectTests":false}),
                false
            )
            .unwrap_err(),
            "Pull request repair always runs the project tests"
        );
        assert_eq!(
            normalized(json!({"workflow":"refine_pull_request"}), true).unwrap_err(),
            "Select a pull request source for Pull request repair"
        );
        assert_eq!(
            normalized(json!({"workflow":"refine_pull_request"}), false).unwrap(),
            json!({"workflow":"refine_pull_request","advisorProfileIds":{},"deliveryTarget":"merged","runProjectTests":true})
        );
    }
}
