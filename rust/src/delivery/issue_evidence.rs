//! TypeScript `delivery/issue-evidence.ts`: publish Worker delivery evidence
//! to the pull request and its linked issue for an issue-backed draft task.
//! The manifest and screenshot bytes are retained as task artifacts.

use crate::shared::hash::sha256_hex;
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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::operations::{DeliveryOperations, Recheck, delivery_failure};
use crate::{
    integrations::{
        bitbucket::ReleasePort,
        github_delivery::{self, PullRequest},
        issue_tracker::{BeforeWrite, IssueTracker},
    },
    platform::{
        artifacts::{self, ArtifactInput},
        database::{DatabaseResult, OpenMode, SuplexDatabase},
    },
    tasks::{
        control::{DeliveryTarget, TaskControlRow, TaskStatus},
        issue_context,
    },
};

const LIMIT: u64 = 8 * 1024 * 1024;

type Failure = Box<dyn Error + Send + Sync>;

static MUTATIONS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

fn hash(bytes: &[u8]) -> String {
    sha256_hex(bytes)
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
    file.by_ref()
        .take(metadata.len() + 1)
        .read_to_end(&mut bytes)?;
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

fn retained(database: &SuplexDatabase, task_id: &str, name: &str) -> DatabaseResult<Vec<Retained>> {
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
    database: &mut SuplexDatabase,
    root: &Path,
    task_id: &str,
    name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> DatabaseResult<()> {
    if let Some(media_type) = crate::tasks::artifacts::MediaType::from_mime_type(mime_type) {
        crate::tasks::artifacts::store_media(
            database,
            root,
            task_id,
            name,
            media_type,
            bytes,
            Utc::now(),
        )?;
        return Ok(());
    }
    if retained(database, task_id, name)?
        .iter()
        .any(|item| item.sha256 == hash(bytes))
    {
        return Ok(());
    }
    let kind = if mime_type.starts_with("image/") {
        "delivery-image"
    } else {
        "delivery-evidence"
    };
    database.transaction(false, |database| {
        let company: String = database.connection().query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        artifacts::put_in_transaction(
            database,
            root,
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
    let bytes = artifacts::read(
        operations.artifact_root(),
        &item.company_id,
        &item.storage_path,
    )
    .map_err(|error| error.to_string())?;
    if hash(&bytes) != item.sha256 {
        return Err("Stored delivery evidence is corrupt".into());
    }
    Ok(bytes)
}

fn manifest(
    operations: &DeliveryOperations,
    database: &mut SuplexDatabase,
    task_id: &str,
    head_sha: &str,
) -> Result<Value, Failure> {
    let name = format!("{head_sha}-delivery-evidence.json");
    let bytes = match read_generated(
        operations.database_path(),
        task_id,
        "delivery-evidence.json",
    ) {
        Ok(bytes) => bytes,
        Err(error) => {
            for item in retained(database, task_id, &name).map_err(|e| e.to_string())? {
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
    retain(
        database,
        operations.artifact_root(),
        task_id,
        &name,
        "application/json",
        &bytes,
    )
    .map_err(|error| error.to_string())?;
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
        .entry(key.clone())
        .or_default()
        .clone();
    let published = {
        let _guard = lock.lock().await;
        publish(operations, task_id, number, head_sha, recheck).await
    };
    // Clones happen under the map lock, so no other caller waits on this entry.
    let mut locks = MUTATIONS.lock().expect("evidence locks");
    if Arc::strong_count(&lock) == 2 {
        locks.remove(&key);
    }
    published
}

/// TypeScript `publicationSchema`: the evidence one delivery publishes on its
/// issue, kept so a retry resumes instead of posting twice.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Publication {
    issue: Value,
    tracker: Value,
    head_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evidence_body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comment_id: Option<String>,
}

fn save(database: &SuplexDatabase, task_id: &str, publication: &Publication) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_tasks SET issue_publication_json = ?1 WHERE id = ?2",
        params![
            crate::shared::js_json::stringify(&serde_json::to_value(publication)?),
            task_id
        ],
    )?;
    Ok(())
}

fn recheck_now(
    operations: &DeliveryOperations,
    recheck: Option<&Recheck<'_>>,
) -> DatabaseResult<()> {
    match recheck {
        Some(recheck) => operations.recheck(recheck),
        None => Ok(()),
    }
}

/// The publication this delivery resumes or starts, with the task
/// configuration. None when the task has no issue or is not an issue-backed
/// draft delivery.
fn pending_publication(
    database: &SuplexDatabase,
    task_id: &str,
    head_sha: &str,
) -> DatabaseResult<Option<(Publication, Value)>> {
    let (issue_json, publication_json, configuration): (Option<String>, Option<String>, String) =
        database
            .connection()
            .query_row(
                "SELECT issue_json, issue_publication_json, configuration_json FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
    if issue_json.is_none() && publication_json.is_none() {
        return Ok(None);
    }
    let configuration: Value = serde_json::from_str(&configuration)?;
    // Issue-backed draft delivery is opt-in; ready and merge targets keep their completion semantics.
    if control_now(database, task_id)?.delivery_target != DeliveryTarget::PullRequestDraft {
        return Ok(None);
    }
    let publication = match publication_json {
        Some(raw) => serde_json::from_str::<Publication>(&raw)?,
        None => Publication {
            issue: serde_json::from_str(issue_json.as_deref().unwrap_or("null"))?,
            tracker: issue_context::task_tracker(&configuration)?,
            head_sha: head_sha.to_owned(),
            evidence_body: None,
            body: None,
            comment_id: None,
        },
    };
    if publication.head_sha == head_sha {
        return Ok(Some((publication, configuration)));
    }
    // A new reviewed head renders new evidence; the issue comment is edited in place.
    let publication = Publication {
        head_sha: head_sha.to_owned(),
        evidence_body: None,
        body: None,
        ..publication
    };
    Ok(Some((publication, configuration)))
}

/// The task is active and its workflow accepted delivery of this head.
fn require_authorized(current: &TaskControlRow, head_sha: &str) -> DatabaseResult<()> {
    if current.status != TaskStatus::Active {
        return Err(delivery_failure(
            "workflow_review_required",
            "Resume the task before publishing issue evidence.",
        ));
    }
    if !accepted_head(current, head_sha) {
        return Err(delivery_failure(
            "delivery_review_required",
            "Review the current source before publishing issue evidence.",
        ));
    }
    Ok(())
}

fn screenshot_mime(extension: &str) -> Result<&'static str, Failure> {
    crate::tasks::artifacts::MediaType::from_extension(extension)
        .filter(|media_type| media_type.is_image())
        .map(crate::tasks::artifacts::MediaType::mime_type)
        .ok_or_else(|| "Evidence screenshots must be PNG, JPEG, WebP or GIF".into())
}

/// Replace this task's marked evidence block in the pull request body, or
/// append one.
fn splice_evidence(existing: &str, task_id: &str, rendered: &str) -> String {
    let marker = format!("<!-- suplex-evidence:{task_id} -->");
    let end_marker = format!("<!-- /suplex-evidence:{task_id} -->");
    let block = format!("{marker}\n{rendered}\n{end_marker}");
    match existing.find(&marker).and_then(|start| {
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
    }
}

/// One evidence publication for an authorized, reviewed pull request head.
struct Publisher<'a> {
    operations: &'a DeliveryOperations,
    task_id: &'a str,
    number: u64,
    head_sha: &'a str,
    recheck: Option<&'a Recheck<'a>>,
    repository: String,
    configuration: Value,
    github: ReleasePort<'a>,
    /// The publication's one connection; locked only between awaits.
    database: Mutex<SuplexDatabase>,
}

impl Publisher<'_> {
    fn database(&self) -> std::sync::MutexGuard<'_, SuplexDatabase> {
        self.database
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn recheck_now(&self) -> Result<(), String> {
        recheck_now(self.operations, self.recheck).map_err(|error| error.to_string())
    }

    /// Observe the pull request, the clean local branch, and the task
    /// authorization again before each write.
    async fn inspect_before_write(&self) -> Result<PullRequest, String> {
        let text = |error: Box<dyn Error>| error.to_string();
        let (task_id, head_sha, repository) = (self.task_id, self.head_sha, &self.repository);
        let control = control_now(&self.database(), task_id).map_err(text)?;
        let path = control
            .worktree_path()
            .ok_or("The task worktree is unavailable")?
            .to_owned();
        let local = github_delivery::inspect_local_revision(Path::new(&path))
            .map_err(|error| error.to_string())?;
        let remote = self
            .github
            .get_pull_request(repository, self.number)
            .await
            .map_err(|error| error.to_string())?;
        if remote.head_sha != head_sha
            || remote.repository != *repository
            || remote.number != self.number
        {
            return Err("The pull request changed before evidence publication".into());
        }
        let latest = control_now(&self.database(), task_id).map_err(text)?;
        if latest.status != TaskStatus::Active || !accepted_head(&latest, head_sha) {
            return Err("Task authorization changed before evidence publication".into());
        }
        if local.head_sha != head_sha
            || latest.delivery_intent.head_branch != local.branch
            || !local.clean
        {
            return Err("Review the clean task branch before publishing evidence".into());
        }
        self.recheck_now()?;
        Ok(remote)
    }

    /// Worker screenshot bytes, or the copy retained for this head.
    fn screenshot_bytes(&self, filename: &str, retained_name: &str) -> Result<Vec<u8>, Failure> {
        let database_path = self.operations.database_path();
        match read_generated(database_path, self.task_id, filename) {
            Ok(bytes) => Ok(bytes),
            Err(error) => {
                let database = self.database();
                let item = retained(&database, self.task_id, retained_name)
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .next()
                    .or_else(|| {
                        retained(&database, self.task_id, filename)
                            .ok()
                            .and_then(|items| items.into_iter().next())
                    })
                    .ok_or(error)?;
                Ok(retained_bytes(self.operations, &item)
                    .map_err(|_| "Stored screenshot is corrupt")?)
            }
        }
    }

    /// Upload one screenshot to the repository host or issue tracker and
    /// return its evidence links.
    async fn upload_screenshot(
        &self,
        tracker: &IssueTracker,
        issue: &Value,
        screenshot: &Value,
        before_write: BeforeWrite<'_>,
    ) -> Result<Vec<String>, Failure> {
        let (task_id, head_sha) = (self.task_id, self.head_sha);
        let filename = screenshot["filename"].as_str().unwrap_or("");
        let extension = filename.rsplit('.').next().unwrap_or("").to_lowercase();
        let mime = screenshot_mime(&extension)?;
        let retained_name = format!("{head_sha}-{filename}");
        let bytes = self.screenshot_bytes(filename, &retained_name)?;
        retain(
            &mut self.database(),
            self.operations.artifact_root(),
            task_id,
            &retained_name,
            mime,
            &bytes,
        )
        .map_err(|error| error.to_string())?;
        let name = format!("suplex-{task_id}-{}.{extension}", hash(&bytes));
        self.recheck_now()?;
        let phase = screenshot["phase"].as_str().unwrap_or("");
        let connection = &self.configuration["integration"]["repository"];
        let url = match ReleasePort::bitbucket(connection) {
            Some(client) => {
                client
                    .upload(&self.repository, &name, &bytes, mime, before_write)
                    .await?
            }
            None => {
                tracker
                    .upload(issue, &name, &bytes, mime, before_write)
                    .await?
            }
        };
        let mut links = vec![format!("[{phase}: {filename}]({url})")];
        if connection["kind"] == "bitbucket" && tracker.hosts_evidence_screenshots() {
            self.recheck_now()?;
            let issue_url = tracker
                .upload(issue, &name, &bytes, mime, before_write)
                .await?;
            links.push(format!(
                "[{phase}: {filename} ({})]({issue_url})",
                tracker.evidence_label()
            ));
        }
        Ok(links)
    }

    /// Render the evidence for this head, uploading its screenshots, unless a
    /// retry already rendered it.
    async fn write_evidence(
        &self,
        tracker: &IssueTracker,
        publication: &Publication,
        before_write: BeforeWrite<'_>,
    ) -> Result<String, Failure> {
        if let Some(rendered) = &publication.evidence_body {
            return Ok(rendered.clone());
        }
        let evidence = manifest(
            self.operations,
            &mut self.database(),
            self.task_id,
            self.head_sha,
        )?;
        let mut links = Vec::new();
        for screenshot in evidence["screenshots"].as_array().into_iter().flatten() {
            links.extend(
                self.upload_screenshot(tracker, &publication.issue, screenshot, before_write)
                    .await?,
            );
        }
        Ok(render_delivery_evidence(&evidence, &links))
    }

    /// Write the evidence block into the pull request body and return the
    /// pull request once the repository confirms body and head.
    async fn splice_pull_request(&self, rendered: &str) -> Result<PullRequest, Failure> {
        let (repository, number, head_sha) = (&self.repository, self.number, self.head_sha);
        let pull = self.inspect_before_write().await?;
        if pull.head_sha != head_sha {
            return Err("The pull request source changed before evidence publication".into());
        }
        let (Some(title), Some(existing)) = (&pull.title, &pull.body) else {
            return Err("The repository did not return the pull request title and body".into());
        };
        let body = splice_evidence(existing, self.task_id, rendered);
        if *existing != body {
            self.github
                .update_draft_pull_request(repository, number, title, &body)
                .await
                .map_err(|error| error.to_string())?;
        }
        let observed = self
            .github
            .get_pull_request(repository, number)
            .await
            .map_err(|error| error.to_string())?;
        if observed.head_sha != head_sha || observed.body.as_deref() != Some(body.as_str()) {
            return Err("The repository has not confirmed the evidence and reviewed source".into());
        }
        Ok(observed)
    }

    /// Save the rendered evidence, publish the issue comment, and record its id.
    async fn record(
        &self,
        tracker: &IssueTracker,
        publication: &mut Publication,
        rendered: String,
        pull_request_url: &str,
        before_write: BeforeWrite<'_>,
    ) -> Result<(), Failure> {
        let save_now = |publication: &Publication| {
            save(&self.database(), self.task_id, publication).map_err(|error| error.to_string())
        };
        let comment = format!("{rendered}\n\nPull request: {pull_request_url}");
        publication.evidence_body = Some(rendered);
        publication.body = Some(comment.clone());
        save_now(publication)?;
        self.recheck_now()?;
        let comment_id = tracker
            .publish(
                &publication.issue,
                self.task_id,
                &comment,
                before_write,
                publication.comment_id.as_deref(),
            )
            .await?;
        publication.comment_id = Some(comment_id);
        save_now(publication)?;
        self.inspect_before_write().await?;
        Ok(())
    }

    async fn attempt(&self, publication: &mut Publication) -> Result<(), Failure> {
        let before_write = || -> Pin<Box<dyn Future<Output = Result<(), Failure>> + Send + '_>> {
            Box::pin(async {
                self.inspect_before_write()
                    .await
                    .map(|_| ())
                    .map_err(Into::into)
            })
        };
        let tracker = IssueTracker::new(&publication.tracker).await?;
        let rendered = self
            .write_evidence(&tracker, publication, &before_write)
            .await?;
        let observed = self.splice_pull_request(&rendered).await?;
        self.record(
            &tracker,
            publication,
            rendered,
            &observed.url,
            &before_write,
        )
        .await
    }
}

async fn publish(
    operations: &DeliveryOperations,
    task_id: &str,
    number: u64,
    head_sha: &str,
    recheck: Option<&Recheck<'_>>,
) -> DatabaseResult<()> {
    let database = SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite)?;
    let Some((mut publication, configuration)) = pending_publication(&database, task_id, head_sha)?
    else {
        return Ok(());
    };
    recheck_now(operations, recheck)?;
    require_authorized(&control_now(&database, task_id)?, head_sha)?;
    let publisher = Publisher {
        operations,
        task_id,
        number,
        head_sha,
        recheck,
        repository: configuration["repository"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        github: operations.for_task(task_id).await?,
        configuration,
        database: Mutex::new(database),
    };
    save(&publisher.database(), task_id, &publication)?;
    publisher.attempt(&mut publication).await.map_err(|error| {
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

/// The workflow accepted delivery of exactly this head.
fn accepted_head(control: &TaskControlRow, head_sha: &str) -> bool {
    control
        .workflow_state
        .accepted_delivery
        .as_ref()
        .is_some_and(|accepted| accepted.head_sha == head_sha)
}

fn control_now(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<TaskControlRow> {
    Ok(crate::coordination::root_session_store::root_observation_rows(database, task_id)?.control)
}

#[cfg(test)]
mod tests {
    use super::*;

    include!("../../tests/delivery/issue_evidence_artifacts.rs");

    #[test]
    fn retained_manifest_survives_missing_generated_file_and_publication_keeps_captured_issue() {
        let (directory, operations, task_id, head) =
            crate::delivery::operations::tests::workflow_task("standard");
        let generated = evidence_root(operations.database_path())
            .join(&task_id)
            .join("generated");
        fs::create_dir_all(&generated).unwrap();
        let evidence = json!({
            "headSha":head,"summary":"Fix the button",
            "before":[{"command":"test","output":"failed"}],
            "after":[{"command":"test","output":"passed"}],
            "howToVerify":["Click the button"]
        });
        let source = generated.join("delivery-evidence.json");
        fs::write(&source, evidence.to_string()).unwrap();
        let mut database =
            SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite).unwrap();
        assert_eq!(
            manifest(&operations, &mut database, &task_id, &head).unwrap(),
            parse_evidence(evidence.to_string().as_bytes()).unwrap()
        );
        let count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_artifacts WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        fs::remove_file(&source).unwrap();
        assert_eq!(
            manifest(&operations, &mut database, &task_id, &head).unwrap(),
            parse_evidence(evidence.to_string().as_bytes()).unwrap()
        );
        assert_eq!(
            database
                .connection()
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM suplex_artifacts WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0)
                )
                .unwrap(),
            1
        );

        let issue =
            json!({"kind":"jira","site":"https://example.atlassian.net","id":"42","key":"APP-42"});
        let tracker = json!({"kind":"jira","site":"https://example.atlassian.net","project":"APP","emailEnvironment":"TEST_EMAIL","tokenEnvironment":"TEST_TOKEN"});
        database.connection().execute(
            "UPDATE suplex_task_controls SET delivery_target = 'pull_request_draft' WHERE task_id = ?1", [&task_id]
        ).unwrap();
        database.connection().execute(
            "UPDATE suplex_tasks SET issue_json = ?1, configuration_json = json_set(configuration_json, '$.integration', json(?2)) WHERE id = ?3",
            params![issue.to_string(), json!({"repository":{"kind":"github"},"tracker":tracker}).to_string(), task_id]
        ).unwrap();
        let (captured, _) = pending_publication(&database, &task_id, &head)
            .unwrap()
            .unwrap();
        assert_eq!(captured.issue, issue);
        save(&database, &task_id, &captured).unwrap();
        database.connection().execute(
            "UPDATE suplex_tasks SET issue_json = ?1 WHERE id = ?2",
            params![json!({"kind":"jira","site":"https://example.atlassian.net","id":"99","key":"APP-99"}).to_string(), task_id]
        ).unwrap();
        let (retry, _) = pending_publication(&database, &task_id, &head)
            .unwrap()
            .unwrap();
        assert_eq!(retry.issue, issue);
        assert_eq!(retry.head_sha, head);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn pull_evidence_uses_live_title_and_preserves_human_body_edits_on_retry() {
        use axum::{
            body::Bytes,
            http::{Method, StatusCode, Uri},
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (directory, operations, task_id, head) =
            crate::delivery::operations::tests::workflow_task("standard");
        let database =
            SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite).unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'active', delivery_target = 'pull_request_draft', workflow_state_json = json_set(workflow_state_json, '$.acceptedDelivery', json(?1)) WHERE task_id = ?2",
            params![json!({"baseSha":head,"headSha":head,"files":[],"commits":[]}).to_string(), task_id]
        ).unwrap();
        let pull = Arc::new(Mutex::new(json!({
            "number":7,"html_url":"https://github.com/owner/repo/pull/7","state":"open",
            "draft":true,"merged_at":null,"title":"Human title","body":"Human body added during inspection",
            "head":{"ref":"task-flow","sha":head,"repo":{"full_name":"owner/repo"}},
            "base":{"ref":"main","sha":head,"repo":{"full_name":"owner/repo"}}
        })));
        let patches = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new().fallback({
            let pull = pull.clone();
            let patches = patches.clone();
            move |method: Method, uri: Uri, bytes: Bytes| {
                let pull = pull.clone();
                let patches = patches.clone();
                async move {
                    if uri.path() != "/repos/owner/repo/pulls/7" {
                        return (StatusCode::NOT_FOUND, String::new());
                    }
                    if method == Method::PATCH {
                        let input: Value = serde_json::from_slice(&bytes).unwrap();
                        let mut stored = pull.lock().unwrap();
                        stored["title"] = input["title"].clone();
                        stored["body"] = input["body"].clone();
                        patches.fetch_add(1, Ordering::SeqCst);
                        return (StatusCode::OK, stored.to_string());
                    }
                    (StatusCode::OK, pull.lock().unwrap().to_string())
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&base, Some("fixture".into())).unwrap();
        let github = github_delivery::Github::new(access);
        let publisher = Publisher {
            operations: &operations,
            task_id: &task_id,
            number: 7,
            head_sha: &head,
            recheck: None,
            repository: "owner/repo".into(),
            configuration: json!({}),
            github: ReleasePort::Github(&github),
            database: Mutex::new(database),
        };
        let first = publisher
            .splice_pull_request("Native evidence")
            .await
            .unwrap();
        assert_eq!(first.title.as_deref(), Some("Human title"));
        assert!(
            first
                .body
                .as_deref()
                .unwrap()
                .starts_with("Human body added during inspection")
        );
        assert_eq!(patches.load(Ordering::SeqCst), 1);
        pull.lock().unwrap()["body"] = json!(format!(
            "{}\n\nHuman follow-up",
            first.body.as_deref().unwrap()
        ));
        let second = publisher
            .splice_pull_request("Native evidence")
            .await
            .unwrap();
        assert!(second.body.as_deref().unwrap().ends_with("Human follow-up"));
        assert_eq!(patches.load(Ordering::SeqCst), 1);
        publisher
            .database()
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'cancelled' WHERE task_id = ?1",
                [&task_id],
            )
            .unwrap();
        assert!(
            publisher
                .splice_pull_request("Another update")
                .await
                .unwrap_err()
                .to_string()
                .contains("authorization changed")
        );
        assert_eq!(patches.load(Ordering::SeqCst), 1);
        publisher
            .database()
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                [&task_id],
            )
            .unwrap();
        pull.lock().unwrap()["head"]["sha"] = json!("b".repeat(40));
        assert!(
            publisher
                .splice_pull_request("Another update")
                .await
                .unwrap_err()
                .to_string()
                .contains("pull request changed")
        );
        assert_eq!(patches.load(Ordering::SeqCst), 1);
        drop(publisher);
        server.abort();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn generated_evidence_reads_current_bytes_but_never_follows_a_replaced_symlink() {
        let root =
            std::env::temp_dir().join(format!("suplex-evidence-read-{}", uuid::Uuid::new_v4()));
        let database = root.join("suplex.sqlite");
        let generated = evidence_root(&database).join("task_one/generated");
        fs::create_dir_all(&generated).unwrap();
        fs::write(generated.join("manifest.json"), b"retained source").unwrap();
        assert_eq!(
            read_generated(&database, "task_one", "manifest.json").unwrap(),
            b"retained source"
        );

        let outside = root.join("outside.json");
        fs::write(&outside, b"changed source").unwrap();
        fs::remove_file(generated.join("manifest.json")).unwrap();
        std::os::unix::fs::symlink(&outside, generated.join("manifest.json")).unwrap();
        assert!(read_generated(&database, "task_one", "manifest.json").is_err());
        assert!(read_generated(&database, "task_one", "../outside.json").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_saved_publication_round_trips_unchanged() {
        let saved = r#"{"issue":{"kind":"github","number":3},"tracker":{"kind":"github"},"headSha":"h","evidenceBody":"e","body":"b","commentId":"c"}"#;
        let publication: Publication = serde_json::from_str(saved).unwrap();
        assert_eq!(
            crate::shared::js_json::stringify(&serde_json::to_value(&publication).unwrap()),
            saved
        );
        assert!(serde_json::from_str::<Publication>(r#"{"issue":{},"tracker":{}}"#).is_err());
    }

    #[tokio::test]
    async fn a_finished_publication_releases_its_task_lock() {
        let directory =
            std::env::temp_dir().join(format!("suplex-evidence-lock-{}", uuid::Uuid::new_v4()));
        let operations = DeliveryOperations::new(
            &directory.join("suplex.sqlite"),
            &directory.join("artifacts"),
        );
        let key = format!("{}:task_lock", operations.database_path().display());
        // The task does not exist, so the publication fails; its lock goes away all the same.
        assert!(
            complete(&operations, "task_lock", 1, &"a".repeat(40), None)
                .await
                .is_err()
        );
        assert!(!MUTATIONS.lock().unwrap().contains_key(&key));
    }

    #[test]
    fn evidence_block_replaces_its_marked_block_or_appends_one() {
        let block = "<!-- suplex-evidence:t -->\nnew\n<!-- /suplex-evidence:t -->";
        assert_eq!(
            splice_evidence(" Body \n", "t", "new"),
            format!("Body\n\n{block}")
        );
        let existing = "Intro\n<!-- suplex-evidence:t -->\nold\n<!-- /suplex-evidence:t -->\nTail";
        assert_eq!(
            splice_evidence(existing, "t", "new"),
            format!("Intro\n{block}\nTail")
        );
    }

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
