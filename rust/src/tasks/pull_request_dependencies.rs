//! TypeScript `tasks/pull-request-dependencies.ts` and the pull request
//! observation of `TaskService.observePullRequestDependencies`: GitHub is the
//! authority for every pull request prerequisite before Suplex saves it.

use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::params;
use serde_json::{Value, json};

use crate::{
    integrations::github_delivery::Github,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
};

/// Why a requested pull request prerequisite was rejected.
#[derive(Debug, PartialEq, Eq)]
pub enum Rejection {
    /// GitHub could not answer.
    Unobservable(u64),
    /// GitHub answered without this pull request.
    NotFound(u64),
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Observe each distinct requested pull request, in first-request order.
pub async fn observe(repository: &str, numbers: &[u64]) -> Result<Vec<Value>, Rejection> {
    let mut unique = Vec::new();
    for number in numbers {
        if !unique.contains(number) {
            unique.push(*number);
        }
    }
    let Some(&first) = unique.first() else {
        return Ok(Vec::new());
    };
    let github = Github::load()
        .await
        .map_err(|_| Rejection::Unobservable(first))?;
    observe_with(&github, repository, &unique).await
}

async fn observe_with(
    github: &Github,
    repository: &str,
    unique: &[u64],
) -> Result<Vec<Value>, Rejection> {
    let mut observed = Vec::new();
    for &number in unique {
        let value = github
            .observe_pull_request(repository, "", Some(number))
            .await
            .map_err(|_| Rejection::Unobservable(number))?;
        let (true, Some(state), Some(url)) = (
            value.exists && value.number == Some(number),
            value.state,
            value.url,
        ) else {
            return Err(Rejection::NotFound(number));
        };
        observed.push(json!({
            "number": number, "state": state, "url": url, "observedAt": now(),
            "title": value.title.unwrap_or_else(|| format!("Pull request #{number}")),
        }));
    }
    Ok(observed)
}

/// `replacePullRequestDependenciesInTransaction`.
pub fn replace(
    database: &SuplexDatabase,
    task_id: &str,
    dependencies: &[Value],
) -> DatabaseResult<()> {
    database.connection().execute(
        "DELETE FROM suplex_task_pull_request_dependencies WHERE task_id = ?1",
        [task_id],
    )?;
    for dependency in dependencies {
        database.connection().execute(
            "INSERT INTO suplex_task_pull_request_dependencies (task_id, pull_request_number, state, title, url, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![task_id, dependency["number"].as_i64(), dependency["state"].as_str(), dependency["title"].as_str(), dependency["url"].as_str(), dependency["observedAt"].as_str()],
        )?;
    }
    Ok(())
}

/// TypeScript `TaskHost.refreshPullRequestPrerequisites`: re-observe the
/// pull request prerequisites of queued tasks. A failed observation is retried
/// on the next pass and never changes a stored prerequisite.
pub async fn refresh(database_path: &Path) -> DatabaseResult<()> {
    let rows = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        let mut statement = database.connection().prepare(
            "SELECT d.task_id, d.pull_request_number, d.title, json_extract(t.configuration_json, '$.repository') FROM suplex_task_pull_request_dependencies d JOIN suplex_tasks t ON t.id = d.task_id JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.archived_at IS NULL AND c.status = 'queued' ORDER BY d.task_id, d.pull_request_number",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if rows.is_empty() {
        return Ok(());
    }
    let github = Github::load().await?;
    for (task_id, number, title, repository) in rows {
        let observed = github
            .observe_pull_request(repository.as_deref().unwrap_or(""), "", Some(number as u64))
            .await;
        let observed = match observed {
            Ok(observed) => observed,
            Err(error) => {
                eprintln!(
                    "Pull request prerequisite observation will be retried for {task_id}: {error}"
                );
                continue;
            }
        };
        let (true, Some(state), Some(url)) = (observed.exists, observed.state, observed.url) else {
            continue;
        };
        SuplexDatabase::open(database_path, OpenMode::ReadWrite)?.connection().execute(
            "UPDATE suplex_task_pull_request_dependencies SET state = ?1, title = ?2, url = ?3, observed_at = ?4 WHERE task_id = ?5 AND pull_request_number = ?6",
            params![state, observed.title.unwrap_or(title), url, now(), task_id, number],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prerequisites_come_from_the_github_observation_of_each_number() {
        use axum::{Json, Router};
        assert_eq!(observe("owner/repo", &[]).await, Ok(Vec::new()));
        let pull = json!({"data": {"repository": {"pullRequest": {
            "number": 7, "url": "https://github.com/owner/repo/pull/7", "state": "MERGED", "isDraft": false,
            "headRefOid": "a".repeat(40), "baseRefOid": "b".repeat(40), "mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN",
            "autoMergeRequest": null, "reviewDecision": null, "author": {"login": "octo", "avatarUrl": "https://avatars.githubusercontent.com/octo"},
            "changedFiles": 1, "additions": 1, "deletions": 0, "title": "Blocker", "commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]},
        }}}});
        let app = Router::new().fallback(move || {
            let pull = pull.clone();
            async move { Json(pull) }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&base, Some("test-token".into())).unwrap();
        let mut github = Github::new(access);
        github.retry_pauses.clear();
        let observed = observe_with(&github, "owner/repo", &[7]).await.unwrap();
        assert_eq!(
            (
                &observed[0]["number"],
                &observed[0]["state"],
                &observed[0]["title"],
                &observed[0]["url"]
            ),
            (
                &json!(7),
                &json!("merged"),
                &json!("Blocker"),
                &json!("https://github.com/owner/repo/pull/7")
            )
        );
        // GitHub answered for another number: the requested one was not found.
        assert_eq!(
            observe_with(&github, "owner/repo", &[8]).await,
            Err(Rejection::NotFound(8))
        );
    }
}
