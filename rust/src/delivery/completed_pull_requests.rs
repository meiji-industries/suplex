//! TypeScript `delivery/completed-pull-requests.ts`: refresh the pull request
//! state of delivered tasks from GitHub or Bitbucket. A refresh never changes task status.

use crate::shared::time::now_millis_rfc3339;
use std::path::Path;

use rusqlite::params;
use serde_json::{Value, json};

use crate::{
    integrations::{bitbucket::ReleasePort, github_delivery::Github},
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
};

struct Candidate {
    task_id: String,
    pull_json: Option<String>,
    repository: String,
    number: u64,
    connection: Value,
}

fn candidates(database: &SuplexDatabase) -> DatabaseResult<Vec<Candidate>> {
    let mut statement = database.connection().prepare(
        "SELECT c.task_id, c.pull_request_json, c.delivery_intent_json, json_extract(t.configuration_json, '$.integration.repository')
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
    for (task_id, pull_json, intent, connection) in rows {
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
            connection: connection
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?
                .unwrap_or(json!({"kind": "github"})),
        });
    }
    Ok(result)
}

/// One refresh pass: each repository connection reads its own provider.
pub async fn refresh(database_path: &Path, github: Option<&Github>) -> DatabaseResult<()> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let candidates = candidates(&database)?;
    let mut groups: Vec<(&Value, Vec<&Candidate>)> = Vec::new();
    for candidate in &candidates {
        match groups
            .iter_mut()
            .find(|(connection, _)| **connection == candidate.connection)
        {
            Some((_, group)) => group.push(candidate),
            None => groups.push((&candidate.connection, vec![candidate])),
        }
    }
    let mut loaded = None;
    for (connection, group) in groups {
        let bitbucket = ReleasePort::bitbucket(connection);
        if bitbucket.is_none() && github.is_none() && loaded.is_none() {
            loaded = Some(Github::load().await?);
        }
        let port = match bitbucket {
            Some(client) => ReleasePort::Bitbucket(client),
            None => ReleasePort::Github(github.or(loaded.as_ref()).expect("loaded GitHub")),
        };
        observe_group(&mut database, &port, &group).await?;
    }
    Ok(())
}

async fn observe_group(
    database: &mut SuplexDatabase,
    port: &ReleasePort<'_>,
    candidates: &[&Candidate],
) -> DatabaseResult<()> {
    let identities = candidates
        .iter()
        .map(|candidate| (candidate.repository.clone(), candidate.number))
        .collect::<Vec<_>>();
    let observed = port.pull_request_states(&identities).await?;
    database.transaction(true, |database| {
        for candidate in candidates {
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
                params![value, now_millis_rfc3339(), candidate.task_id, candidate.pull_json],
            )?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::{bitbucket::BitbucketClient, github::Access};
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn batched_partial_observations_keep_identical_coordinates_on_distinct_hosts_separate() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let app = Router::new()
            .route("/graphql", post(move |Json(body): Json<Value>| {
                counted.fetch_add(1, Ordering::SeqCst);
                async move {
                    let query = body["query"].as_str().unwrap();
                    let pattern = regex::Regex::new(r#"p(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)"#).unwrap();
                    let data = pattern.captures_iter(query).map(|capture| {
                        let number: u64 = capture[4].parse().unwrap();
                        let value = if &capture[2] == "missing" { Value::Null } else {
                            json!({"pullRequest":{"number":number,"url":format!("https://github.com/{}/{}/pull/{number}", &capture[2], &capture[3]),"headRefOid":"a".repeat(40),"state":"MERGED","mergedAt":"2026-09-10T02:32:47Z"}})
                        };
                        (format!("p{}", &capture[1]), value)
                    }).collect::<serde_json::Map<String, Value>>();
                    Json(json!({"data":data,"errors":[{"message":"A repository is unavailable"}]}))
                }
            }))
            .route("/2.0/repositories/owner/repo/pullrequests/42", get(|| async {
                let end = |branch| json!({"branch":{"name":branch},"commit":{"hash":"b".repeat(40)},"repository":{"full_name":"owner/repo"}});
                Json(json!({"id":42,"title":"Review","state":"DECLINED","draft":false,"source":end("task"),"destination":end("main"),"links":{"html":{"href":"https://bitbucket.org/owner/repo/pull-requests/42"}}}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let github = Github::new(Access::for_api(&origin, None).unwrap());
        let mut identities = (1..=51)
            .map(|number| {
                (
                    format!("owner/{}", if number % 2 == 0 { "one" } else { "two" }),
                    number,
                )
            })
            .collect::<Vec<_>>();
        identities.push(("OWNER/TWO".into(), 1));
        let observed = github.pull_request_states(&identities).await.unwrap();
        assert_eq!((observed.len(), calls.load(Ordering::SeqCst)), (51, 2));
        assert!(observed.iter().any(|pull| pull["repository"] == "owner/two"
            && pull["number"] == 1
            && pull["state"] == "merged"));
        assert!(github.pull_request_states(&[]).await.unwrap().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let partial = github
            .pull_request_states(&[("missing/repo".into(), 1), ("owner/repo".into(), 2)])
            .await
            .unwrap();
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0]["number"], 2);

        let root =
            std::env::temp_dir().join(format!("suplex-completed-hosts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("suplex.sqlite");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/parity/task-agents-native/database.sqlite"),
            &path,
        )
        .unwrap();
        let mut database = SuplexDatabase::open(&path, OpenMode::ReadWrite).unwrap();
        database
            .connection()
            .execute("UPDATE suplex_task_controls SET status='cancelled'", [])
            .unwrap();
        let github_id = "task_1bfa5d693de94807ba20b6dd0f5218e5";
        let bitbucket_id = "task_db685ad6da4d48309e3f7cce3127578b";
        // SAFETY: this credential name belongs only to this test.
        unsafe {
            std::env::set_var("SUPLEX_TEST_COMPLETED_BITBUCKET_TOKEN", "fixture");
        }
        let bitbucket_connection =
            json!({"kind":"bitbucket","tokenEnvironment":"SUPLEX_TEST_COMPLETED_BITBUCKET_TOKEN"});
        for (task, host, connection) in [
            (github_id, "github.com", json!({"kind":"github"})),
            (bitbucket_id, "bitbucket.org", bitbucket_connection.clone()),
        ] {
            database.connection().execute("UPDATE suplex_tasks SET configuration_json=json_set(configuration_json, '$.integration.repository', json(?1)) WHERE id=?2", params![connection.to_string(),task]).unwrap();
            let pull = json!({"repository":"owner/repo","number":42,"url":format!("https://{host}/owner/repo/pull/42"),"headSha":"a".repeat(40),"state":"open","mergedAt":null});
            database.connection().execute("UPDATE suplex_task_controls SET status='delivered',pull_request_json=?1 WHERE task_id=?2", params![pull.to_string(),task]).unwrap();
        }
        let candidates = candidates(&database).unwrap();
        assert_eq!(candidates.len(), 2);
        for candidate in &candidates {
            let port = if candidate.connection["kind"] == "bitbucket" {
                ReleasePort::Bitbucket(BitbucketClient::with_origin(&candidate.connection, &origin))
            } else {
                ReleasePort::Github(&github)
            };
            observe_group(&mut database, &port, &[candidate])
                .await
                .unwrap();
        }
        for (task, host, expected) in [
            (github_id, "github.com", "merged"),
            (bitbucket_id, "bitbucket.org", "closed"),
        ] {
            let (status, raw): (String, String) = database
                .connection()
                .query_row(
                    "SELECT status,pull_request_json FROM suplex_task_controls WHERE task_id=?1",
                    [task],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let pull: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                (status.as_str(), pull["state"].as_str().unwrap()),
                ("delivered", expected)
            );
            assert!(
                pull["url"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("https://{host}/"))
            );
        }
        drop(database);
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
