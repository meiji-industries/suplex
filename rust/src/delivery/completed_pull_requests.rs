//! TypeScript `delivery/completed-pull-requests.ts`: refresh the pull request
//! state of delivered tasks from GitHub. A refresh never changes task status.

use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::params;
use serde_json::Value;

use crate::{
    integrations::github_delivery::Github,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
};

struct Candidate {
    task_id: String,
    pull_json: Option<String>,
    repository: String,
    number: u64,
    bitbucket: bool,
}

fn candidates(database: &SuplexDatabase) -> DatabaseResult<Vec<Candidate>> {
    let mut statement = database.connection().prepare(
        "SELECT c.task_id, c.pull_request_json, c.delivery_intent_json, json_extract(t.configuration_json, '$.integration.repository.kind')
         FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id
         WHERE c.status = 'delivered' AND t.archived_at IS NULL
           AND (json_extract(c.pull_request_json, '$.state') != 'merged'
             OR (c.pull_request_json IS NULL AND json_extract(c.delivery_intent_json, '$.pullRequestNumber') IS NOT NULL))",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for (task_id, pull_json, intent, kind) in rows {
        let pull: Value = pull_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or(Value::Null);
        let intent: Value = serde_json::from_str(&intent)?;
        let repository = pull["repository"]
            .as_str()
            .or_else(|| intent["repository"].as_str())
            .unwrap_or("")
            .to_owned();
        let Some(number) = pull["number"]
            .as_u64()
            .or_else(|| intent["pullRequestNumber"].as_u64())
        else {
            continue;
        };
        result.push(Candidate {
            task_id,
            pull_json,
            repository,
            number,
            bitbucket: kind.as_deref() == Some("bitbucket"),
        });
    }
    Ok(result)
}

/// One refresh pass. Bitbucket pull requests are left for the Bitbucket port.
pub async fn refresh(database_path: &Path, github: Option<&Github>) -> DatabaseResult<()> {
    let candidates = candidates(&SuplexDatabase::open(database_path, OpenMode::ReadOnly)?)?
        .into_iter()
        .filter(|candidate| !candidate.bitbucket)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(());
    }
    let loaded;
    let github = match github {
        Some(github) => github,
        None => {
            loaded = Github::load().await?;
            &loaded
        }
    };
    let identities = candidates
        .iter()
        .map(|candidate| (candidate.repository.clone(), candidate.number))
        .collect::<Vec<_>>();
    let observed = github.pull_request_states(&identities).await?;
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    database.transaction(true, |database| {
        for candidate in &candidates {
            let Some(pull) = observed.iter().find(|pull| {
                pull["repository"].as_str() == Some(candidate.repository.to_lowercase().as_str())
                    && pull["number"].as_u64() == Some(candidate.number)
            }) else {
                continue;
            };
            let value = crate::shared::js_json::stringify(pull);
            if candidate.pull_json.as_deref() == Some(value.as_str()) {
                continue;
            }
            database.connection().execute(
                "UPDATE suplex_task_controls SET pull_request_json = ?1, updated_at = ?2
                 WHERE task_id = ?3 AND status = 'delivered' AND pull_request_json IS ?4
                   AND EXISTS (SELECT 1 FROM suplex_tasks WHERE id = task_id AND archived_at IS NULL)",
                params![value, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true), candidate.task_id, candidate.pull_json],
            )?;
        }
        Ok(())
    })
}
