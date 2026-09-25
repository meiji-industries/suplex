//! TypeScript `delivery/issue-evidence.ts`: publish Worker delivery evidence
//! to the pull request and its linked issue for an issue-backed draft task.
//! The manifest and screenshot bytes are retained as task artifacts.

use std::{
    collections::HashMap,
    error::Error,
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, LazyLock, Mutex},
};

use chrono::Utc;
use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::operations::{DeliveryOperations, Recheck, delivery_failure};
use crate::{
    integrations::{github_delivery, issue_tracker::IssueTracker},
    platform::{
        artifacts::{self, ArtifactInput},
        database::{DatabaseResult, OpenMode, SuplexDatabase},
    },
    tasks::issue_context,
};

const LIMIT: u64 = 8 * 1024 * 1024;

type Failure = Box<dyn Error + Send + Sync>;

static MUTATIONS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_filename(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value).file_name().and_then(|name| name.to_str()) == Some(value)
        && value != "."
        && value != ".."
        && !value.contains('\\')
}

/// TypeScript `DeliveryEvidenceSchema` (strict, screenshots default to []).
pub fn parse_evidence(bytes: &[u8]) -> Result<Value, Failure> {
    let mut value: Value = serde_json::from_slice(bytes)?;
    let invalid = || -> Failure { "Delivery evidence is invalid".into() };
    let object = value.as_object().ok_or_else(invalid)?;
    let allowed = [
        "headSha",
        "summary",
        "before",
        "after",
        "howToVerify",
        "screenshots",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid());
    }
    let commands = |key: &str| {
        object[key].as_array().is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    item.as_object().is_some_and(|item| {
                        item.len() == 2
                            && item
                                .get("command")
                                .and_then(Value::as_str)
                                .is_some_and(|text| !text.is_empty())
                            && item.get("output").is_some_and(Value::is_string)
                    })
                })
        })
    };
    let screenshots = object.get("screenshots").cloned().unwrap_or(json!([]));
    let valid = object
        .get("headSha")
        .and_then(Value::as_str)
        .is_some_and(github_delivery::valid_sha)
        && object
            .get("summary")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
        && object.contains_key("before")
        && commands("before")
        && object.contains_key("after")
        && commands("after")
        && object
            .get("howToVerify")
            .and_then(Value::as_array)
            .is_some_and(|steps| {
                !steps.is_empty()
                    && steps
                        .iter()
                        .all(|step| step.as_str().is_some_and(|text| !text.is_empty()))
            })
        && screenshots.as_array().is_some_and(|items| {
            items.len() <= 20
                && items.iter().all(|item| {
                    item.as_object().is_some_and(|item| {
                        item.len() == 2
                            && item
                                .get("filename")
                                .and_then(Value::as_str)
                                .is_some_and(valid_filename)
                            && matches!(
                                item.get("phase").and_then(Value::as_str),
                                Some("before" | "after")
                            )
                    })
                })
        });
    if !valid {
        return Err(invalid());
    }
    value["screenshots"] = screenshots;
    Ok(value)
}

/// TypeScript `renderDeliveryEvidence`: command output cannot close its fence.
pub fn render_delivery_evidence(value: &Value, links: &[String]) -> String {
    let commands = |key: &str| {
        value[key]
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| {
                let output = item["output"].as_str().unwrap_or("");
                let mut longest = 0;
                let mut run = 0;
                for ch in output.chars() {
                    run = if ch == '`' { run + 1 } else { 0 };
                    longest = longest.max(run);
                }
                let fence = "`".repeat(3.max(longest + 1));
                format!(
                    "{}\n\n{fence}text\n{output}\n{fence}",
                    item["command"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let steps = value["howToVerify"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|step| format!("- {}", step.as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "## What changed\n\n{}\n\nSource: {}\n\n## Before\n\n{}\n\n## After\n\n{}\n\n## How to verify\n\n{steps}\n\n{}",
        value["summary"].as_str().unwrap_or(""),
        value["headSha"].as_str().unwrap_or(""),
        commands("before"),
        commands("after"),
        links.join("\n")
    )
    .trim()
    .to_owned()
}

fn evidence_root(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .unwrap_or(Path::new(""))
        .join("runtime")
        .join("task-evidence")
}

/// Read Worker-owned evidence without following a symbolic link.
fn read_generated(database_path: &Path, task_id: &str, name: &str) -> Result<Vec<u8>, Failure> {
    if !valid_filename(name) {
        return Err("Evidence filename is invalid".into());
    }
    let root = evidence_root(database_path);
    let directory = root.join(task_id).join("generated");
    if fs::canonicalize(&directory)? != fs::canonicalize(&root)?.join(task_id).join("generated") {
        return Err("Evidence directory must not be a symbolic link".into());
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join(name))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > LIMIT {
        return Err("Evidence must be a regular file of at most 8 MiB".into());
    }
    let mut bytes = Vec::new();
    file.by_ref().take(metadata.len() + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.len() {
        return Err("Evidence changed while Suplex read it".into());
    }
    Ok(bytes)
}

struct Retained {
    company_id: String,
    storage_path: String,
    sha256: String,
}

fn retained(database_path: &Path, task_id: &str, name: &str) -> DatabaseResult<Vec<Retained>> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let mut statement = database.connection().prepare(
        "SELECT company_id, storage_path, sha256 FROM suplex_artifacts WHERE task_id = ?1 AND filename = ?2 AND kind LIKE 'delivery-%' ORDER BY created_at DESC",
    )?;
    let rows = statement
        .query_map(params![task_id, name], |row| {
            Ok(Retained {
                company_id: row.get(0)?,
                storage_path: row.get(1)?,
                sha256: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn retain(
    operations: &DeliveryOperations,
    task_id: &str,
    name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> DatabaseResult<()> {
    if retained(operations.database_path(), task_id, name)?
        .iter()
        .any(|item| item.sha256 == hash(bytes))
    {
        return Ok(());
    }
    let mut database = SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite)?;
    let kind = if mime_type.starts_with("image/") {
        "delivery-image"
    } else {
        "delivery-evidence"
    };
    let root = operations.artifact_root().to_owned();
    database.transaction(false, |database| {
        let company: String = database.connection().query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        artifacts::put_in_transaction(
            database,
            &root,
            &company,
            kind,
            &ArtifactInput {
                filename: name,
                mime_type,
                bytes,
                task_id,
            },
            Utc::now(),
        )?;
        Ok(())
    })
}

fn retained_bytes(operations: &DeliveryOperations, item: &Retained) -> Result<Vec<u8>, Failure> {
    let bytes = artifacts::read(operations.artifact_root(), &item.company_id, &item.storage_path)
        .map_err(|error| error.to_string())?;
    if hash(&bytes) != item.sha256 {
        return Err("Stored delivery evidence is corrupt".into());
    }
    Ok(bytes)
}

fn manifest(operations: &DeliveryOperations, task_id: &str, head_sha: &str) -> Result<Value, Failure> {
    let name = format!("{head_sha}-delivery-evidence.json");
    let bytes = match read_generated(operations.database_path(), task_id, "delivery-evidence.json") {
        Ok(bytes) => bytes,
        Err(error) => {
            for item in retained(operations.database_path(), task_id, &name).map_err(|e| e.to_string())? {
                let parsed = parse_evidence(&retained_bytes(operations, &item)?)?;
                if parsed["headSha"] == head_sha {
                    return Ok(parsed);
                }
            }
            return Err(error);
        }
    };
    let value = parse_evidence(&bytes)?;
    if value["headSha"] != head_sha {
        return Err("Delivery evidence is not for the reviewed source".into());
    }
    retain(operations, task_id, &name, "application/json", &bytes).map_err(|error| error.to_string())?;
    Ok(value)
}

/// TypeScript `IssueEvidence.complete`: one publication per task at a time.
pub async fn complete(
    operations: &DeliveryOperations,
    task_id: &str,
    number: u64,
    head_sha: &str,
    recheck: Option<&Recheck<'_>>,
) -> DatabaseResult<()> {
    let key = format!("{}:{task_id}", operations.database_path().display());
    let lock = MUTATIONS
        .lock()
        .expect("evidence locks")
        .entry(key)
        .or_default()
        .clone();
    let _guard = lock.lock().await;
    publish(operations, task_id, number, head_sha, recheck).await
}

fn save(operations: &DeliveryOperations, task_id: &str, publication: &Value) -> DatabaseResult<()> {
    SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite)?
        .connection()
        .execute(
            "UPDATE suplex_tasks SET issue_publication_json = ?1 WHERE id = ?2",
            params![crate::shared::js_json::stringify(publication), task_id],
        )?;
    Ok(())
}

async fn publish(
    operations: &DeliveryOperations,
    task_id: &str,
    number: u64,
    head_sha: &str,
    recheck: Option<&Recheck<'_>>,
) -> DatabaseResult<()> {
    let (issue_json, publication_json, configuration): (Option<String>, Option<String>, String) =
        SuplexDatabase::open(operations.database_path(), OpenMode::ReadOnly)?
            .connection()
            .query_row(
                "SELECT issue_json, issue_publication_json, configuration_json FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
    if issue_json.is_none() && publication_json.is_none() {
        return Ok(());
    }
    let configuration: Value = serde_json::from_str(&configuration)?;
    // Issue-backed draft delivery is opt-in; ready and merge targets keep their completion semantics.
    if control_now(operations, task_id)?["deliveryTarget"] != "pull_request_draft" {
        return Ok(());
    }
    let mut publication = match publication_json {
        Some(raw) => serde_json::from_str::<Value>(&raw)?,
        None => json!({
            "issue": serde_json::from_str::<Value>(issue_json.as_deref().unwrap_or("null"))?,
            "tracker": issue_context::task_tracker(&configuration)?,
            "headSha": head_sha,
        }),
    };
    if publication["headSha"] != head_sha {
        let mut fresh = json!({"issue": publication["issue"], "tracker": publication["tracker"], "headSha": head_sha});
        if publication["commentId"].is_string() {
            fresh["commentId"] = publication["commentId"].clone();
        }
        publication = fresh;
    }
    let recheck_now = || -> DatabaseResult<()> {
        match recheck {
            Some(recheck) => operations.recheck(recheck),
            None => Ok(()),
        }
    };
    recheck_now()?;
    let current = control_now(operations, task_id)?;
    if current["status"] != "active" {
        return Err(delivery_failure(
            "workflow_review_required",
            "Resume the task before publishing issue evidence.",
        ));
    }
    if current["workflowState"]["acceptedDelivery"]["headSha"] != head_sha {
        return Err(delivery_failure(
            "delivery_review_required",
            "Review the current source before publishing issue evidence.",
        ));
    }
    let repository = configuration["repository"].as_str().unwrap_or("").to_owned();
    let github = operations.github(task_id).await?;
    let text = |error: Box<dyn Error>| error.to_string();
    let inspect_before_write = || async {
        let control = control_now(operations, task_id).map_err(text)?;
        let path = control["worktree"]["path"]
            .as_str()
            .ok_or("The task worktree is unavailable")?
            .to_owned();
        let local = github_delivery::inspect_local_revision(Path::new(&path))
            .map_err(|error| error.to_string())?;
        let remote = github
            .get_pull_request(&repository, number)
            .await
            .map_err(|error| error.to_string())?;
        if remote.head_sha != head_sha || remote.repository != repository || remote.number != number
        {
            return Err::<_, String>("The pull request changed before evidence publication".into());
        }
        let latest = control_now(operations, task_id).map_err(text)?;
        if latest["status"] != "active"
            || latest["workflowState"]["acceptedDelivery"]["headSha"] != head_sha
        {
            return Err("Task authorization changed before evidence publication".into());
        }
        if local.head_sha != head_sha
            || latest["deliveryIntent"]["headBranch"] != local.branch.as_str()
            || !local.clean
        {
            return Err("Review the clean task branch before publishing evidence".into());
        }
        recheck_now().map_err(text)?;
        Ok(remote)
    };
    let before_write = || -> Pin<Box<dyn Future<Output = Result<(), Failure>> + Send + '_>> {
        Box::pin(async { inspect_before_write().await.map(|_| ()).map_err(Into::into) })
    };
    save(operations, task_id, &publication)?;
    let attempt = async {
        let tracker = IssueTracker::new(&publication["tracker"]).await?;
        let rendered = match publication["evidenceBody"].as_str() {
            Some(rendered) => rendered.to_owned(),
            None => {
                let evidence = manifest(operations, task_id, head_sha)?;
                let mut links = Vec::new();
                for screenshot in evidence["screenshots"].as_array().into_iter().flatten() {
                    let filename = screenshot["filename"].as_str().unwrap_or("");
                    let extension = filename.rsplit('.').next().unwrap_or("").to_lowercase();
                    let mime = match extension.as_str() {
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "webp" => "image/webp",
                        _ => return Err::<(), Failure>("Evidence screenshots must be PNG, JPEG or WebP".into()),
                    };
                    let retained_name = format!("{head_sha}-{filename}");
                    let bytes = match read_generated(operations.database_path(), task_id, filename) {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            let item = retained(operations.database_path(), task_id, &retained_name)
                                .map_err(|error| error.to_string())?
                                .into_iter()
                                .next()
                                .ok_or(error)?;
                            retained_bytes(operations, &item)
                                .map_err(|_| "Stored screenshot is corrupt")?
                        }
                    };
                    retain(operations, task_id, &retained_name, mime, &bytes).map_err(|error| error.to_string())?;
                    let name = format!("suplex-{task_id}-{}.{extension}", hash(&bytes));
                    recheck_now().map_err(|error| error.to_string())?;
                    if configuration["integration"]["repository"]["kind"] == "bitbucket" {
                        return Err("Bitbucket evidence upload is not ported".into());
                    }
                    let url = tracker
                        .upload(&publication["issue"], &name, &bytes, mime, &before_write)
                        .await?;
                    links.push(format!("[{}: {filename}]({url})", screenshot["phase"].as_str().unwrap_or("")));
                }
                render_delivery_evidence(&evidence, &links)
            }
        };
        let pull = inspect_before_write().await?;
        if pull.head_sha != head_sha {
            return Err("The pull request source changed before evidence publication".into());
        }
        let marker = format!("<!-- suplex-evidence:{task_id} -->");
        let end_marker = format!("<!-- /suplex-evidence:{task_id} -->");
        let (Some(title), Some(existing)) = (&pull.title, &pull.body) else {
            return Err("The repository did not return the pull request title and body".into());
        };
        let block = format!("{marker}\n{rendered}\n{end_marker}");
        let body = match existing.find(&marker).and_then(|start| {
            existing[start + marker.len()..]
                .find(&end_marker)
                .map(|end| (start, start + marker.len() + end))
        }) {
            Some((start, end)) => format!(
                "{}{block}{}",
                &existing[..start],
                &existing[end + end_marker.len()..]
            ),
            None => format!("{}\n\n{block}", crate::identity::auth::js_trim(existing)),
        };
        if *existing != body {
            github.update_draft_pull_request(&repository, number, title, &body).await?;
        }
        let observed = github.get_pull_request(&repository, number).await?;
        if observed.head_sha != head_sha || observed.body.as_deref() != Some(body.as_str()) {
            return Err("The repository has not confirmed the evidence and reviewed source".into());
        }
        publication["evidenceBody"] = json!(rendered);
        publication["body"] = json!(format!("{rendered}\n\nPull request: {}", observed.url));
        save(operations, task_id, &publication).map_err(|error| error.to_string())?;
        recheck_now().map_err(|error| error.to_string())?;
        let comment_id = tracker
            .publish(
                &publication["issue"],
                task_id,
                publication["body"].as_str().unwrap_or(""),
                &before_write,
                publication["commentId"].as_str(),
            )
            .await?;
        publication["commentId"] = json!(comment_id);
        save(operations, task_id, &publication).map_err(|error| error.to_string())?;
        inspect_before_write().await?;
        Ok(())
    };
    attempt.await.map_err(|error| {
        let file = evidence_root(operations.database_path())
            .join(task_id)
            .join("generated")
            .join("delivery-evidence.json");
        delivery_failure(
            "workflow_review_required",
            format!(
                "Complete {} for reviewed head {head_sha}, then retry publication. Include summary, before/after arrays of {{command, output}}, howToVerify steps, and optional screenshots [{{filename, phase: \"before\"|\"after\"}}]. Preserve real evidence; do not invent Before output. {error}",
                file.display()
            ),
        )
    })
}

fn control_now(operations: &DeliveryOperations, task_id: &str) -> DatabaseResult<Value> {
    let database = SuplexDatabase::open(operations.database_path(), OpenMode::ReadOnly)?;
    Ok(crate::coordination::root_session_store::root_observation_rows(&database, task_id)?.control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_command_output_cannot_terminate_its_markdown_fence() {
        let value = json!({
            "headSha": "a".repeat(40), "summary": "Fixed",
            "before": [{"command": "run", "output": "x ```` y"}],
            "after": [{"command": "run", "output": "ok"}],
            "howToVerify": ["Run it"], "screenshots": [],
        });
        let rendered = render_delivery_evidence(&value, &[]);
        assert!(rendered.contains("run\n\n`````text\nx ```` y\n`````"));
        assert!(rendered.contains("run\n\n```text\nok\n```"));
        assert!(rendered.ends_with("## How to verify\n\n- Run it"));
    }

    #[test]
    fn evidence_manifest_is_strict_and_defaults_screenshots() {
        let valid = json!({"headSha":"a".repeat(40),"summary":"s","before":[{"command":"c","output":""}],"after":[{"command":"c","output":""}],"howToVerify":["v"]});
        assert_eq!(
            parse_evidence(valid.to_string().as_bytes()).unwrap()["screenshots"],
            json!([])
        );
        let mut extra = valid.clone();
        extra["other"] = json!(1);
        assert!(parse_evidence(extra.to_string().as_bytes()).is_err());
        let mut traversal = valid;
        traversal["screenshots"] = json!([{"filename":"../x.png","phase":"after"}]);
        assert!(parse_evidence(traversal.to_string().as_bytes()).is_err());
    }
}
