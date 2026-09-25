//! TypeScript `tasks/issue-context.ts`: capture the linked issue once, before
//! native work starts, together with its image attachments.

use std::path::Path;

use chrono::Utc;
use rusqlite::params;
use serde_json::{Value, json};

use crate::{
    integrations::issue_tracker::{IssueTracker, TrackerResult},
    platform::{
        artifacts::{self, ArtifactInput, StoredArtifact},
        database::{DatabaseResult, OpenMode, SuplexDatabase},
    },
    tasks::images::MAX_TASK_IMAGES,
};

/// TypeScript `taskTracker`: the configured tracker, else the task repository's GitHub Issues.
pub fn task_tracker(configuration: &Value) -> Result<Value, &'static str> {
    let integration = &configuration["integration"];
    if integration["tracker"].is_object() {
        return Ok(integration["tracker"].clone());
    }
    if integration.is_object() {
        return Err("Configure an issue tracker for this project");
    }
    Ok(json!({"kind": "github", "repository": configuration["repository"]}))
}

pub fn has_started_native_work(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions WHERE task_id = ?1 AND native_session_id IS NOT NULL UNION ALL SELECT 1 FROM suplex_task_turns WHERE task_id = ?1 AND status IN ('prompted', 'unknown', 'completed'))",
        [task_id],
        |row| row.get(0),
    )?)
}

fn image_count(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<usize> {
    Ok(database.connection().query_row(
        "SELECT COUNT(*) FROM suplex_artifacts WHERE task_id = ?1 AND kind = 'task-image'",
        [task_id],
        |row| row.get::<_, i64>(0),
    )? as usize)
}

/// TypeScript `prepareIssueContext`.
pub async fn prepare_issue_context(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
) -> TrackerResult<()> {
    let row = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)
            .map_err(|error| error.to_string())?;
        let row = database
            .connection()
            .query_row(
                "SELECT configuration_json, issue_json, issue_context_json FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?)),
            )
            .map_err(|error| error.to_string())?;
        if row.1.is_none()
            || row.2.is_some()
            || has_started_native_work(&database, task_id).map_err(|error| error.to_string())?
        {
            return Ok(());
        }
        row
    };
    let (configuration, Some(issue_json), _) = row else {
        return Ok(());
    };
    let configuration: Value = serde_json::from_str(&configuration)?;
    let issue: Value = serde_json::from_str(&issue_json)?;
    let tracker = IssueTracker::new(&task_tracker(&configuration)?).await?;
    let mut context = tracker.read(&issue).await?;
    let count = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)
            .map_err(|error| error.to_string())?;
        image_count(&database, task_id).map_err(|error| error.to_string())?
    };
    let intake = tracker
        .images(&context["issue"], MAX_TASK_IMAGES.saturating_sub(count))
        .await?;
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)
        .map_err(|error| error.to_string())?;
    let mut written: Vec<StoredArtifact> = Vec::new();
    let result = database.transaction(true, |database| {
        if has_started_native_work(database, task_id)? {
            return Ok(());
        }
        let (company_id, current_issue, current_context): (String, Option<String>, Option<String>) =
            database.connection().query_row(
                "SELECT company_id, issue_json, issue_context_json FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        if current_issue.as_deref() != Some(issue_json.as_str()) {
            return Err("The issue changed before context capture. Retry preparation.".into());
        }
        if current_context.is_some() {
            return Ok(());
        }
        let available = MAX_TASK_IMAGES.saturating_sub(image_count(database, task_id)?);
        let mut text = context["text"].as_str().unwrap_or("").to_owned();
        for (filename, mime_type, bytes) in intake.images.iter().take(available) {
            let artifact = artifacts::put_in_transaction(
                database,
                artifact_root,
                &company_id,
                "task-image",
                &ArtifactInput {
                    filename,
                    mime_type,
                    bytes,
                    task_id,
                },
                Utc::now(),
            )?;
            text += &format!(
                "\n\nIssue image: {}, task artifact {}. Use the task image reader to inspect it.",
                artifact.filename, artifact.id
            );
            written.push(artifact);
        }
        if !intake.notes.is_empty() {
            text += &format!("\n\n{}", intake.notes.join("\n"));
        }
        context["text"] = json!(text);
        let updated = database.connection().execute(
            "UPDATE suplex_tasks SET issue_context_json = COALESCE(issue_context_json, ?1) WHERE id = ?2 AND issue_json = ?3",
            params![crate::shared::js_json::stringify(&context), task_id, issue_json],
        )?;
        if updated == 0 {
            return Err("The issue changed before context capture. Retry preparation.".into());
        }
        Ok(())
    });
    if let Err(error) = result {
        for artifact in &written {
            artifacts::remove_written(artifact_root, artifact);
        }
        return Err(error.to_string().into());
    }
    Ok(())
}

/// TypeScript `TaskHost.recoverOne` issue intake: an access failure asks the
/// human; any other failure retries in 15 seconds. Returns whether to continue.
pub async fn prepare_for_host(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
) -> DatabaseResult<bool> {
    {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        if has_started_native_work(&database, task_id)? {
            return Ok(true);
        }
    }
    let Err(error) = prepare_issue_context(database_path, artifact_root, task_id).await else {
        return Ok(true);
    };
    use crate::integrations::issue_tracker::{
        IssueTrackerScopeFailure, MissingIntegrationCredential, ProviderHttpFailure,
    };
    let access = error.is::<MissingIntegrationCredential>()
        || error.is::<IssueTrackerScopeFailure>()
        || error
            .downcast_ref::<ProviderHttpFailure>()
            .is_some_and(|failure| matches!(failure.status, 401 | 403 | 404));
    let now = Utc::now();
    let time = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    if access {
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = ?1, human_question_options_json = '[]', human_question_id = ?2, limit_pause_json = NULL, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?3 WHERE task_id = ?4 AND status = 'active'",
            params![format!("Suplex cannot read the linked issue. {error}. Check the issue and tracker access, then answer to retry."), uuid::Uuid::new_v4().to_string(), time, task_id],
        )?;
    } else {
        eprintln!("Issue context intake will be retried for {task_id}: {error}");
        database.connection().execute(
            "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![
                (now + chrono::Duration::seconds(15))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                time,
                task_id
            ],
        )?;
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_defaults_to_task_repository_issues_only_without_integration() {
        assert_eq!(
            task_tracker(&json!({"repository":"owner/repo"})).unwrap(),
            json!({"kind":"github","repository":"owner/repo"})
        );
        assert!(task_tracker(&json!({"repository":"o/r","integration":{"repository":{"kind":"github"},"tracker":null}})).is_err());
        let jira = json!({"kind":"jira","site":"https://a.atlassian.net/","project":"A","emailEnvironment":"E","tokenEnvironment":"T"});
        assert_eq!(
            task_tracker(&json!({"repository":"o/r","integration":{"tracker":jira}})).unwrap(),
            jira
        );
    }
}
