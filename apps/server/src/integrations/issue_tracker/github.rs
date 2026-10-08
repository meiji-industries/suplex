use super::{
    BeforeWrite, IssueRef, IssueTrackerScopeFailure, TrackerResult, cap_context, evidence_marker,
    fail, is_complete_evidence_comment, issue_text, valid_evidence_name,
};
use std::{
    error::Error,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    time::Duration,
};

use crate::{
    integrations::{
        github_delivery::Github,
        provider_http::{id_text, lenient, missing_id, optional_metadata, present},
    },
    shared::hash::sha256_hex,
    tasks::images::MAX_TASK_IMAGE_BYTES,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

#[derive(Deserialize)]
struct GithubAccount {
    #[serde(default, deserialize_with = "optional_metadata")]
    id: Option<u64>,
}
#[derive(Deserialize)]
struct Comment {
    #[serde(default = "missing_id", deserialize_with = "id_text")]
    id: String,
    #[serde(default)]
    body: Value,
    #[serde(default, deserialize_with = "optional_metadata")]
    user: Option<GithubAccount>,
}
impl Comment {
    fn owned(&self, actor: &str) -> bool {
        self.user
            .as_ref()
            .and_then(|user| user.id)
            .is_some_and(|id| id.to_string() == actor)
    }
}
#[derive(Deserialize)]
struct CommentId {
    #[serde(default = "missing_id", deserialize_with = "id_text")]
    id: String,
}
#[derive(Deserialize)]
struct GithubSearch {
    items: Vec<GithubIssue>,
}
#[derive(Default, Deserialize)]
struct GithubIssue {
    #[serde(default, deserialize_with = "optional_metadata")]
    id: Option<u64>,
    #[serde(default, deserialize_with = "optional_metadata")]
    number: Option<u64>,
    #[serde(default, deserialize_with = "optional_metadata")]
    title: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    html_url: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    body: String,
    #[serde(default, deserialize_with = "present")]
    pull_request: bool,
}

pub struct GithubTracker {
    repository: String,
    github: Option<Github>,
    gh_command: String,
}
impl GithubTracker {
    pub(super) fn new(connection: &Value, github: Option<Github>) -> Self {
        let connection: super::Connection =
            serde_json::from_value(connection.clone()).unwrap_or_default();
        Self {
            repository: connection.repository,
            github,
            gh_command: std::env::var("SUPLEX_GH_COMMAND").unwrap_or_else(|_| "gh".into()),
        }
    }
    async fn github_json(&self, path: &str, body: Option<(&str, &Value)>) -> TrackerResult<Value> {
        let github = self
            .github
            .as_ref()
            .ok_or_else(|| fail("The project does not use GitHub Issues"))?;
        let (method, body) = body.map_or(("GET", None), |(method, body)| (method, Some(body)));
        let path = if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("/{path}")
        };
        let (status, text) = github
            .raw(method, &path, body)
            .await
            .map_err(|_| fail("GitHub could not complete the issue request"))?;
        if matches!(status, 401 | 403 | 404) {
            return Err(super::ProviderHttpFailure { status }.into());
        }
        if !(200..300).contains(&status) {
            return Err(fail("GitHub could not complete the issue request"));
        }
        serde_json::from_str(&text).map_err(|_| fail("GitHub could not complete the issue request"))
    }
    async fn github_read<T: DeserializeOwned>(
        &self,
        path: &str,
        malformed: &str,
    ) -> TrackerResult<T> {
        serde_json::from_value(self.github_json(path, None).await?).map_err(|_| fail(malformed))
    }
    async fn actor(&self) -> TrackerResult<String> {
        self.github_read::<GithubAccount>("user", "GitHub account is malformed")
            .await?
            .id
            .map(|id| id.to_string())
            .ok_or_else(|| fail("GitHub account is malformed"))
    }
    pub(super) fn check(&self, issue: &Value) -> TrackerResult<IssueRef> {
        let issue = IssueRef::deserialize(issue).unwrap_or_default();
        self.in_scope(&issue)?;
        Ok(issue)
    }
    fn in_scope(&self, issue: &IssueRef) -> TrackerResult<()> {
        if issue.kind == "github"
            && issue.repository.to_lowercase() == self.repository.to_lowercase()
        {
            Ok(())
        } else {
            Err(Box::new(IssueTrackerScopeFailure))
        }
    }
    pub async fn search(&self, query: &str) -> TrackerResult<Vec<Value>> {
        let text = query.trim().chars().take(200).collect::<String>();
        let repository = &self.repository;
        let q = url::form_urlencoded::byte_serialize(
            format!("repo:{repository} is:issue {text}").as_bytes(),
        )
        .collect::<String>();
        let result: GithubSearch = self
            .github_read(
                &format!("search/issues?q={q}&per_page=30"),
                "GitHub search is malformed",
            )
            .await?;
        Ok(result.items.into_iter().filter(|row| !row.pull_request).filter_map(|row| { let number = row.number?; Some(json!({"kind":"github","repository":repository,"id":row.id?.to_string(),"number":number,"key":format!("#{number}"),"title":row.title?,"url":row.html_url?})) }).collect())
    }
    async fn comments(&self, issue: &IssueRef) -> TrackerResult<Vec<Comment>> {
        let mut result = Vec::new();
        for page in 0..100 {
            let rows: Vec<Comment> = self
                .github_read(
                    &format!(
                        "repos/{}/issues/{}/comments?per_page=100&page={}",
                        issue.repository,
                        issue.number,
                        page + 1
                    ),
                    "GitHub comments are malformed",
                )
                .await?;
            let last = rows.len() < 100;
            result.extend(rows);
            if last {
                return Ok(result);
            }
        }
        Err(fail("The issue has more comments than Suplex can load"))
    }
    pub async fn read(&self, issue: &Value) -> TrackerResult<Value> {
        let reference = self.check(issue)?;
        let comments = self.comments(&reference).await?;
        let row: GithubIssue = serde_json::from_value(
            self.github_json(
                &format!("repos/{}/issues/{}", reference.repository, reference.number),
                None,
            )
            .await?,
        )
        .unwrap_or_default();
        if row.pull_request {
            return Err(fail("Select an issue, not a pull request"));
        }
        let heading = format!(
            "{}: {}\n{}",
            reference.key,
            row.title.as_deref().unwrap_or_default(),
            row.html_url.as_deref().unwrap_or_default()
        );
        let mut current = issue.clone();
        current["id"] = json!(row.id.map(|id| id.to_string()));
        current["title"] = json!(row.title);
        current["url"] = json!(row.html_url);
        let text = cap_context(format!(
            "{heading}\n\n{}\n\nComments\n{}",
            row.body,
            comments
                .iter()
                .map(|row| issue_text(&row.body))
                .collect::<Vec<_>>()
                .join("\n\n")
        ));
        Ok(
            json!({"issue":current,"text":text,"capturedAt":crate::shared::time::now_millis_rfc3339()}),
        )
    }
    pub async fn upload(
        &self,
        issue: &Value,
        filename: &str,
        bytes: &[u8],
        _mime_type: &str,
        before_write: BeforeWrite<'_>,
    ) -> TrackerResult<String> {
        let issue = self.check(issue)?;
        let hash = sha256_hex(bytes);
        if !valid_evidence_name(filename, &hash)
            || bytes.is_empty()
            || bytes.len() > MAX_TASK_IMAGE_BYTES
        {
            return Err(fail("Invalid task evidence attachment"));
        }
        let actor = self.actor().await?;
        let marker = format!("[Suplex attachment {filename}]");
        let mut existing = self
            .comments(&issue)
            .await?
            .into_iter()
            .find(|row| row.owned(&actor) && issue_text(&row.body).contains(&marker));
        if existing.is_none() {
            upload_github_media(
                &self.gh_command,
                &issue.repository,
                &issue.number,
                filename,
                bytes,
                &marker,
                before_write,
            )
            .await?;
            existing = self
                .comments(&issue)
                .await?
                .into_iter()
                .find(|row| row.owned(&actor) && issue_text(&row.body).contains(&marker));
        }
        let Some(existing) = existing else {
            return Err(fail(
                "GitHub has not confirmed the uploaded evidence reference",
            ));
        };
        super::github_image_reference(&issue_text(&existing.body))
            .ok_or_else(|| fail("GitHub has not confirmed the uploaded evidence reference"))
    }
    async fn before_mutation(&self, before_write: BeforeWrite<'_>) -> TrackerResult<()> {
        before_write().await
    }
    pub async fn publish(
        &self,
        issue: &Value,
        task_id: &str,
        body: &str,
        before_write: BeforeWrite<'_>,
        known_comment_id: Option<&str>,
    ) -> TrackerResult<String> {
        let issue = self.check(issue)?;
        let marker = evidence_marker(task_id);
        let actor = self.actor().await?;
        let text = format!("{body}\n\n{marker}");
        let owned = self
            .comments(&issue)
            .await?
            .into_iter()
            .filter(|row| row.owned(&actor))
            .collect::<Vec<_>>();
        let existing = owned
            .iter()
            .find(|row| Some(row.id.as_str()) == known_comment_id)
            .or_else(|| {
                owned.iter().find(|row| {
                    let value = issue_text(&row.body);
                    value == text || is_complete_evidence_comment(&value, &marker)
                })
            });
        if let Some(existing) = existing
            && issue_text(&existing.body) == text
        {
            return Ok(existing.id.clone());
        }
        let existing = existing.map(|row| row.id.as_str());
        self.before_mutation(before_write).await?;
        let (path, method) = match existing {
            Some(id) => (
                format!("repos/{}/issues/comments/{id}", issue.repository),
                "PATCH",
            ),
            None => (
                format!(
                    "repos/{}/issues/{}/comments",
                    issue.repository, issue.number
                ),
                "POST",
            ),
        };
        let written = self
            .github_json(&path, Some((method, &json!({"body":text}))))
            .await?;
        let id = CommentId::deserialize(&written).map_or_else(|_| missing_id(), |row| row.id);
        let observed = self
            .comments(&issue)
            .await?
            .into_iter()
            .find(|row| row.id == id && row.owned(&actor));
        if observed.is_none_or(|row| issue_text(&row.body) != text) {
            return Err(fail(
                "The tracker has not confirmed the issue evidence comment",
            ));
        }
        Ok(id)
    }
    #[cfg(test)]
    pub(super) fn set_gh_command(&mut self, command: String) {
        self.gh_command = command;
    }
}

async fn github_cli(command: &str, args: &[&str]) -> TrackerResult<String> {
    let mut process = tokio::process::Command::new(command);
    process.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), process.output())
        .await
        .map_err(|_| fail("GitHub CLI timed out"))??;
    if output.stdout.len() > 8 * 1024 * 1024 || output.stderr.len() > 8 * 1024 * 1024 {
        return Err(fail("GitHub CLI output is too large"));
    }
    if !output.status.success() {
        return Err(fail("GitHub could not upload issue evidence"));
    }
    Ok(String::from_utf8(output.stdout)?)
}

pub(super) async fn upload_github_media(
    command: &str,
    repository: &str,
    number: &str,
    filename: &str,
    bytes: &[u8],
    marker: &str,
    before_write: BeforeWrite<'_>,
) -> TrackerResult<()> {
    if !github_cli(command, &["issue", "comment", "--help"])
        .await?
        .contains("--attach")
    {
        return Err(fail(
            "Update GitHub CLI to a version supporting issue comment --attach",
        ));
    }
    let directory =
        std::env::temp_dir().join(format!("suplex-evidence-upload-{}", uuid::Uuid::new_v4()));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let result = async {
        let attachment = directory.join(filename);
        let body = directory.join("body.md");
        for (path, contents) in [(&attachment, bytes), (&body, marker.as_bytes())] {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(contents)?;
        }
        before_write().await?;
        github_cli(
            command,
            &[
                "issue",
                "comment",
                number,
                "--repo",
                repository,
                "--body-file",
                body.to_str()
                    .ok_or_else(|| fail("Evidence path is invalid"))?,
                "--attach",
                attachment
                    .to_str()
                    .ok_or_else(|| fail("Evidence path is invalid"))?,
            ],
        )
        .await?;
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }
    .await;
    let _ = std::fs::remove_dir_all(directory);
    result
}

pub fn github_image_reference(body: &str) -> Option<String> {
    static IMAGE_REFERENCE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"!\[[^\]]*\]\((https://[^\s)]+)\)").expect("valid regex")
    });
    let reference = IMAGE_REFERENCE.captures(body)?.get(1)?.as_str();
    let url = url::Url::parse(reference).ok()?;
    let host = url.host_str()?;
    ([
        "github.com",
        "user-images.githubusercontent.com",
        "private-user-images.githubusercontent.com",
    ]
    .contains(&host)
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::*;
    #[tokio::test]
    async fn github_media_uses_supported_cli_with_private_files_and_cleans_after_lost_response() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let root = std::env::temp_dir().join(format!("suplex-gh-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let command = root.join("gh");
        let log = root.join("paths");
        let old_command = root.join("old-gh");
        std::fs::write(&old_command, "#!/bin/sh\necho '--body-file file'\n").unwrap();
        std::fs::set_permissions(&old_command, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            &command,
            format!(
                r#"#!/bin/sh
if [ "$3" = "--help" ]; then echo '--attach file'; exit 0; fi
body=''; attachment=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --body-file) shift; body="$1" ;;
    --attach) shift; attachment="$1" ;;
  esac
  shift
done
test "$(cat "$body")" = '[Suplex attachment suplex-task.png]' || exit 24
test "$(cat "$attachment")" = 'image' || exit 25
printf '%s\n%s\n' "$body" "$attachment" > '{}'
exit 1
"#,
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
        let checks = AtomicUsize::new(0);
        let before: BeforeWrite<'_> = &|| {
            checks.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        };
        assert_eq!(
            upload_github_media(
                old_command.to_str().unwrap(),
                "owner/repo",
                "42",
                "suplex-task.png",
                b"image",
                "[Suplex attachment suplex-task.png]",
                before
            )
            .await
            .unwrap_err()
            .to_string(),
            "Update GitHub CLI to a version supporting issue comment --attach"
        );
        assert_eq!(checks.load(Ordering::SeqCst), 0);
        let failed = upload_github_media(
            command.to_str().unwrap(),
            "owner/repo",
            "42",
            "suplex-task.png",
            b"image",
            "[Suplex attachment suplex-task.png]",
            before,
        )
        .await
        .unwrap_err();
        assert_eq!(failed.to_string(), "GitHub could not upload issue evidence");
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        let paths = std::fs::read_to_string(&log).unwrap();
        for path in paths.lines() {
            assert!(!std::path::Path::new(path).exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn github_media_recovers_the_owned_comment_after_cli_response_loss() {
        use axum::http::{StatusCode, Uri};
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("suplex-gh-media-retry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let row_path = root.join("comment.json");
        let writes = root.join("writes");
        let command = root.join("gh");
        let bytes = b"fixture-image";
        let filename = format!("suplex-task_one-{}.png", sha256_hex(bytes));
        let marker = format!("[Suplex attachment {filename}]");
        let body = format!(
            "{marker}\n\n![{filename}](https://github.com/user-attachments/assets/fixture)"
        );
        let row = json!({"id":9,"body":body,"user":{"id":4}});
        std::fs::write(
            &command,
            format!(
                r#"#!/bin/sh
if [ "$3" = "--help" ]; then echo '--attach file'; exit 0; fi
body=''; attachment=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --body-file) shift; body="$1" ;;
    --attach) shift; attachment="$1" ;;
  esac
  shift
done
test "$(cat "$body")" = '{marker}' || exit 24
test "$(cat "$attachment")" = 'fixture-image' || exit 25
printf '%s' '{}' > '{}'
echo write >> '{}'
exit 1
"#,
                row,
                row_path.display(),
                writes.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
        let app = axum::Router::new().fallback({
            let row_path = row_path.clone();
            move |uri: Uri| {
                let row_path = row_path.clone();
                async move {
                    let path = uri.path_and_query().map_or("", |part| part.as_str());
                    if path == "/user" {
                        return (StatusCode::OK, json!({"id":4}).to_string());
                    }
                    if path == "/repos/owner/repo/issues/42/comments?per_page=100&page=1" {
                        let rows: Vec<Value> = std::fs::read_to_string(row_path)
                            .ok()
                            .and_then(|bytes| serde_json::from_str(&bytes).ok())
                            .into_iter()
                            .collect();
                        return (StatusCode::OK, json!(rows).to_string());
                    }
                    (StatusCode::NOT_FOUND, String::new())
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&base, Some("fixture".into())).unwrap();
        let mut tracker = IssueTracker::with_github(
            &json!({"kind":"github","repository":"owner/repo"}),
            Some(Github::new(access)),
        );
        tracker.set_gh_command(command.to_string_lossy().into_owned());
        let issue =
            json!({"kind":"github","repository":"owner/repo","id":"42","number":42,"key":"#42"});
        let allow: BeforeWrite<'_> = &|| Box::pin(async { Ok(()) });
        assert_eq!(
            tracker
                .upload(&issue, &filename, bytes, "image/png", allow)
                .await
                .unwrap_err()
                .to_string(),
            "GitHub could not upload issue evidence"
        );
        assert_eq!(
            tracker
                .upload(&issue, &filename, bytes, "image/png", allow)
                .await
                .unwrap(),
            "https://github.com/user-attachments/assets/fixture"
        );
        assert_eq!(std::fs::read_to_string(&writes).unwrap().lines().count(), 1);
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn github_publication_ignores_foreign_markers_and_recovers_a_known_comment() {
        use axum::{
            body::Bytes,
            http::{Method, StatusCode, Uri},
        };
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };
        let comments = Arc::new(Mutex::new(vec![
            json!({"id":8,"body":"Other author's work\n\n[Suplex task task_one]","user":{"id":5}}),
            json!({"id":7,"body":"My note quotes [Suplex task task_one] but is not evidence","user":{"id":4}}),
        ]));
        let writes = Arc::new(AtomicUsize::new(0));
        let lose_patch = Arc::new(AtomicBool::new(true));
        let app = axum::Router::new().fallback({
            let comments = comments.clone();
            let writes = writes.clone();
            let lose_patch = lose_patch.clone();
            move |method: Method, uri: Uri, bytes: Bytes| {
                let comments = comments.clone();
                let writes = writes.clone();
                let lose_patch = lose_patch.clone();
                async move {
                    let path = uri.path_and_query().map_or("", |part| part.as_str());
                    if path == "/user" {
                        return (StatusCode::OK, json!({"id":4}).to_string());
                    }
                    if path == "/repos/owner/repo/issues/42/comments?per_page=100&page=1" {
                        return (
                            StatusCode::OK,
                            json!(comments.lock().unwrap().clone()).to_string(),
                        );
                    }
                    if (method == Method::POST && path == "/repos/owner/repo/issues/42/comments")
                        || (method == Method::PATCH
                            && path == "/repos/owner/repo/issues/comments/9")
                    {
                        let input: Value = serde_json::from_slice(&bytes).unwrap();
                        let row = json!({"id":9,"body":input["body"],"user":{"id":4}});
                        let mut rows = comments.lock().unwrap();
                        if let Some(index) = rows.iter().position(|value| value["id"] == 9) {
                            rows[index] = row.clone();
                        } else {
                            rows.push(row.clone());
                        }
                        writes.fetch_add(1, Ordering::SeqCst);
                        if method == Method::PATCH && lose_patch.swap(false, Ordering::SeqCst) {
                            return (StatusCode::INTERNAL_SERVER_ERROR, String::new());
                        }
                        return (StatusCode::OK, row.to_string());
                    }
                    (StatusCode::NOT_FOUND, String::new())
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&base, Some("fixture".into())).unwrap();
        let tracker = IssueTracker::with_github(
            &json!({"kind":"github","repository":"owner/repo"}),
            Some(Github::new(access)),
        );
        let issue =
            json!({"kind":"github","repository":"owner/repo","id":"42","number":42,"key":"#42"});
        let allow: BeforeWrite<'_> = &|| Box::pin(async { Ok(()) });
        assert_eq!(
            tracker
                .publish(&issue, "task_one", "Evidence", allow, None)
                .await
                .unwrap(),
            "9"
        );
        assert_eq!(
            tracker
                .publish(&issue, "task_one", "Evidence", allow, Some("9"))
                .await
                .unwrap(),
            "9"
        );
        assert_eq!(
            tracker
                .publish(&issue, "task_one", "Evidence", allow, Some("missing"))
                .await
                .unwrap(),
            "9"
        );
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        comments.lock().unwrap().insert(2, json!({
            "id":6,
            "body":"## What changed\n\nOlder evidence\n\n## Before\n\nold\n\n## After\n\nold\n\n## How to verify\n\nold\n\n[Suplex task task_one]",
            "user":{"id":4}
        }));
        assert!(
            tracker
                .publish(&issue, "task_one", "New evidence", allow, Some("9"))
                .await
                .is_err()
        );
        assert_eq!(
            tracker
                .publish(&issue, "task_one", "New evidence", allow, Some("9"))
                .await
                .unwrap(),
            "9"
        );
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        assert_eq!(comments.lock().unwrap()[0]["id"], 8);
        assert_eq!(comments.lock().unwrap()[1]["id"], 7);
        assert_eq!(comments.lock().unwrap()[2]["id"], 6);
        server.abort();
    }
    #[test]
    fn scope_check_refuses_issues_from_another_repository() {
        let tracker =
            IssueTracker::with_github(&json!({"kind":"github","repository":"Owner/Repo"}), None);
        assert!(
            tracker
                .check(&json!({"kind":"github","repository":"owner/repo"}))
                .is_ok()
        );
        assert!(
            tracker
                .check(&json!({"kind":"github","repository":"other/repo"}))
                .unwrap_err()
                .is::<IssueTrackerScopeFailure>()
        );
        assert_eq!(
            github_image_reference("![a](https://evil.example/x.png)"),
            None
        );
    }
}
