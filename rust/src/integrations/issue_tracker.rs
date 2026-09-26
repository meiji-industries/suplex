//! TypeScript `IssueTracker`: GitHub Issues through the GitHub API and Jira
//! Cloud through its REST API. The connection comes from task or project
//! configuration; issue identities outside it are refused.

use crate::shared::hash::sha256_hex;
use crate::shared::time::now_millis_rfc3339;
use std::{
    error::Error,
    fmt,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    sync::LazyLock,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use super::{
    github_delivery::Github,
    provider_http::{self, id_text, lenient, missing_id, optional_metadata, present},
};
use crate::tasks::images::MAX_TASK_IMAGE_BYTES;

pub type TrackerResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

/// The caller's final check before each tracker write.
pub type BeforeWrite<'a> =
    &'a (dyn Fn() -> std::pin::Pin<Box<dyn Future<Output = TrackerResult<()>> + Send + 'a>> + Sync);

/// TypeScript `ProviderHttpFailure`: the provider refused with this status.
#[derive(Debug)]
pub struct ProviderHttpFailure {
    pub status: u16,
}

impl fmt::Display for ProviderHttpFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "The provider request failed ({})", self.status)
    }
}

impl Error for ProviderHttpFailure {}

/// TypeScript `IssueTrackerScopeFailure`.
#[derive(Debug)]
pub struct IssueTrackerScopeFailure;

impl fmt::Display for IssueTrackerScopeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("The issue does not belong to the configured tracker")
    }
}

impl Error for IssueTrackerScopeFailure {}

/// TypeScript `MissingIntegrationCredential`.
#[derive(Debug)]
pub struct MissingIntegrationCredential(pub String);

impl fmt::Display for MissingIntegrationCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "The credential reference {} is not available",
            self.0
        )
    }
}

impl Error for MissingIntegrationCredential {}

fn fail(message: &str) -> Box<dyn Error + Send + Sync> {
    message.into()
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

async fn upload_github_media(
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

pub fn environment_credential(name: &str) -> TrackerResult<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| MissingIntegrationCredential(name.to_owned()).into())
}

/// TypeScript `issueText`: the plain text of a string or Atlassian document.
pub fn issue_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Array(items) => items.iter().map(issue_text).collect::<Vec<_>>().join("\n"),
        Value::Object(node)
            if node.get("text").is_some_and(Value::is_string)
                || node.get("content").is_some_and(Value::is_array) =>
        {
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                return text.to_owned();
            }
            let separator = match node.get("type").and_then(Value::as_str) {
                Some("paragraph" | "heading") => "",
                _ => "\n",
            };
            node.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(issue_text)
                .collect::<Vec<_>>()
                .join(separator)
        }
        Value::Object(_) => crate::shared::js_json::stringify(value),
        other => other.to_string(),
    }
}

static HTTPS_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https://[^\s<>()]+").unwrap());
static IMAGE_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\((https://[^\s)]+)\)").unwrap());
static EVIDENCE_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\n\nSource: [a-f0-9]{40,64}\n\n## Before\n\n.*\n\n## After\n\n.*\n\n## How to verify\n\n").unwrap()
});

/// TypeScript `jiraEvidenceDocument`: one paragraph per line with linked URLs.
pub fn jira_evidence_document(text: &str) -> Value {
    let paragraphs = text
        .split('\n')
        .map(|line| {
            let mut parts = Vec::new();
            let mut last = 0;
            for found in HTTPS_LINK.find_iter(line) {
                if found.start() > last {
                    parts.push(json!({"type":"text","text":&line[last..found.start()]}));
                }
                let part = found.as_str();
                parts.push(match url::Url::parse(part) {
                    Ok(url) if url.username().is_empty() && url.password().is_none() => {
                        json!({"type":"text","text":part,"marks":[{"type":"link","attrs":{"href":url.as_str()}}]})
                    }
                    _ => json!({"type":"text","text":part}),
                });
                last = found.end();
            }
            if last < line.len() {
                parts.push(json!({"type":"text","text":&line[last..]}));
            }
            json!({"type":"paragraph","content":parts})
        })
        .collect::<Vec<_>>();
    json!({"type":"doc","version":1,"content":paragraphs})
}

fn origin(site: &str) -> TrackerResult<String> {
    let url = url::Url::parse(site)?;
    Ok(url.origin().ascii_serialization())
}

/// The tracker connection of a task or project configuration.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    #[serde(default, deserialize_with = "lenient")]
    kind: String,
    #[serde(default, deserialize_with = "lenient")]
    repository: String,
    #[serde(default, deserialize_with = "lenient")]
    site: String,
    #[serde(default, deserialize_with = "lenient")]
    project: String,
    #[serde(default, deserialize_with = "lenient")]
    email_environment: String,
    #[serde(default, deserialize_with = "lenient")]
    token_environment: String,
}

/// The identity fields of a stored issue association.
#[derive(Debug, Default, Deserialize)]
struct IssueRef {
    #[serde(default, deserialize_with = "lenient")]
    kind: String,
    #[serde(default, deserialize_with = "lenient")]
    repository: String,
    #[serde(default, deserialize_with = "lenient")]
    site: String,
    #[serde(default, deserialize_with = "lenient")]
    key: String,
    #[serde(default, deserialize_with = "lenient")]
    id: String,
    /// The JSON literal of the number, as the GitHub REST path takes it.
    #[serde(default = "missing_id", deserialize_with = "id_text")]
    number: String,
}

impl IssueRef {
    fn github(&self) -> bool {
        self.kind == "github"
    }
}

/// TypeScript `reference`: a validated Jira issue association.
#[derive(Serialize)]
struct JiraReference {
    kind: &'static str,
    site: String,
    id: String,
    key: String,
    title: String,
    url: String,
}

impl From<&JiraReference> for IssueRef {
    fn from(reference: &JiraReference) -> Self {
        Self {
            kind: reference.kind.into(),
            site: reference.site.clone(),
            key: reference.key.clone(),
            id: reference.id.clone(),
            ..Self::default()
        }
    }
}

/// A Jira issue. `fields` keeps every field in provider order for the text snapshot.
#[derive(Default, Deserialize)]
struct JiraIssue {
    #[serde(default, deserialize_with = "optional_metadata")]
    id: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    key: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    fields: Map<String, Value>,
    #[serde(default, deserialize_with = "lenient")]
    names: Map<String, Value>,
}

impl JiraIssue {
    fn text(&self, field: &str) -> String {
        issue_text(self.fields.get(field).unwrap_or(&Value::Null))
    }

    fn field<T: DeserializeOwned + Default>(&self, field: &str) -> T {
        self.fields
            .get(field)
            .and_then(|value| T::deserialize(value).ok())
            .unwrap_or_default()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    #[serde(default = "missing_id", deserialize_with = "id_text")]
    id: String,
    #[serde(default, deserialize_with = "lenient")]
    filename: String,
    #[serde(default, deserialize_with = "lenient")]
    size: u64,
    #[serde(default, deserialize_with = "lenient")]
    mime_type: String,
    #[serde(default, deserialize_with = "optional_metadata")]
    author: Option<JiraAccount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueLink {
    #[serde(default, deserialize_with = "optional_metadata")]
    inward_issue: Option<LinkedIssue>,
    #[serde(default, deserialize_with = "optional_metadata")]
    outward_issue: Option<LinkedIssue>,
}

#[derive(Deserialize)]
struct LinkedIssue {
    #[serde(default, deserialize_with = "optional_metadata")]
    id: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraAccount {
    #[serde(default, deserialize_with = "optional_metadata")]
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct GithubAccount {
    #[serde(default, deserialize_with = "optional_metadata")]
    id: Option<u64>,
}

/// A GitHub or Jira issue comment.
#[derive(Deserialize)]
struct Comment {
    #[serde(default = "missing_id", deserialize_with = "id_text")]
    id: String,
    #[serde(default)]
    body: Value,
    #[serde(default, deserialize_with = "optional_metadata")]
    author: Option<JiraAccount>,
    #[serde(default, deserialize_with = "optional_metadata")]
    user: Option<GithubAccount>,
}

impl Comment {
    fn owned(&self, actor: &str) -> bool {
        self.author
            .as_ref()
            .and_then(|author| author.account_id.as_deref())
            == Some(actor)
            || self
                .user
                .as_ref()
                .and_then(|user| user.id)
                .is_some_and(|id| id.to_string() == actor)
    }
}

#[derive(Deserialize)]
struct JiraComments {
    comments: Vec<Comment>,
    total: u64,
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

#[derive(Deserialize)]
struct JiraSearch {
    issues: Vec<JiraIssue>,
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

pub struct IssueTracker {
    connection: Connection,
    github: Option<Github>,
    http: reqwest::Client,
    gh_command: String,
}

pub struct IssueImages {
    pub images: Vec<(String, String, Vec<u8>)>,
    pub notes: Vec<String>,
}

impl IssueTracker {
    pub async fn new(connection: &Value) -> TrackerResult<Self> {
        let mut tracker = Self::with_github(connection, None);
        if tracker.connection.kind == "github" {
            tracker.github = Some(Github::load().await?);
        }
        Ok(tracker)
    }

    pub fn with_github(connection: &Value, github: Option<Github>) -> Self {
        Self {
            connection: Connection::deserialize(connection).unwrap_or_default(),
            github,
            http: provider_http::client(),
            gh_command: std::env::var("SUPLEX_GH_COMMAND").unwrap_or_else(|_| "gh".into()),
        }
    }

    fn jira(&self) -> bool {
        self.connection.kind == "jira"
    }

    fn jira_credentials(&self) -> TrackerResult<(String, String)> {
        if !self.jira() {
            return Err(fail("The project does not use Jira"));
        }
        let email = environment_credential(&self.connection.email_environment)?;
        let token = environment_credential(&self.connection.token_environment)?;
        Ok((
            origin(&self.connection.site)?,
            format!("Basic {}", STANDARD.encode(format!("{email}:{token}"))),
        ))
    }

    /// TypeScript `providerBytes`: same-origin, no redirects, bounded body.
    async fn provider_bytes(
        &self,
        path: &str,
        method: reqwest::Method,
        body: Option<reqwest::Body>,
        headers: &[(&str, &str)],
        maximum: usize,
    ) -> TrackerResult<Vec<u8>> {
        let (origin, authorization) = self.jira_credentials()?;
        let url = url::Url::parse(&origin)?.join(path)?;
        if url.origin().ascii_serialization() != origin
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(fail("The provider returned an unsafe URL"));
        }
        let mut request = self
            .http
            .request(method, url)
            .header("Accept", "application/json")
            .header("Authorization", authorization);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        provider_http::bounded_response(request.send().await?, maximum).await
    }

    async fn attachment(&self, id: &str, maximum: usize) -> TrackerResult<Vec<u8>> {
        self.provider_bytes(
            &format!("/rest/api/3/attachment/content/{id}?redirect=false"),
            reqwest::Method::GET,
            None,
            &[],
            maximum,
        )
        .await
    }

    async fn jira_json(&self, path: &str, body: Option<(&str, &Value)>) -> TrackerResult<Value> {
        let (method, request) = match body {
            None => (reqwest::Method::GET, None),
            Some((method, body)) => (
                method.parse()?,
                Some(reqwest::Body::from(crate::shared::js_json::stringify(body))),
            ),
        };
        let headers: &[(&str, &str)] = if request.is_some() {
            &[("Content-Type", "application/json")]
        } else {
            &[]
        };
        let bytes = self
            .provider_bytes(path, method, request, headers, 8 * 1024 * 1024)
            .await?;
        Ok(if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)?
        })
    }

    /// One Jira read decoded as `T`; a response of another shape is `malformed`.
    async fn jira_read<T: DeserializeOwned>(
        &self,
        path: &str,
        malformed: &str,
    ) -> TrackerResult<T> {
        serde_json::from_value(self.jira_json(path, None).await?).map_err(|_| fail(malformed))
    }

    /// One Jira issue read, validated as a reference in the configured tracker.
    async fn jira_issue(&self, id: &str, query: &str) -> TrackerResult<(JiraIssue, JiraReference)> {
        let row: JiraIssue = self
            .jira_read(
                &format!("/rest/api/3/issue/{id}?{query}"),
                "Jira issue is malformed",
            )
            .await?;
        let current = self.reference(&row)?;
        self.in_scope(&IssueRef::from(&current))?;
        Ok((row, current))
    }

    /// TypeScript `gh api <path>` for the GitHub tracker.
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
            return Err(ProviderHttpFailure { status }.into());
        }
        if !(200..300).contains(&status) {
            return Err(fail("GitHub could not complete the issue request"));
        }
        serde_json::from_str(&text).map_err(|_| fail("GitHub could not complete the issue request"))
    }

    /// One GitHub read decoded as `T`; a response of another shape is `malformed`.
    async fn github_read<T: DeserializeOwned>(
        &self,
        path: &str,
        malformed: &str,
    ) -> TrackerResult<T> {
        serde_json::from_value(self.github_json(path, None).await?).map_err(|_| fail(malformed))
    }

    async fn actor(&self) -> TrackerResult<String> {
        if self.jira() {
            let myself: JiraAccount = self
                .jira_read("/rest/api/3/myself", "Jira account is malformed")
                .await?;
            return myself
                .account_id
                .ok_or_else(|| fail("Jira account is malformed"));
        }
        let user: GithubAccount = self
            .github_read("user", "GitHub account is malformed")
            .await?;
        user.id
            .map(|id| id.to_string())
            .ok_or_else(|| fail("GitHub account is malformed"))
    }

    /// TypeScript `reference`: a validated Jira issue association.
    fn reference(&self, row: &JiraIssue) -> TrackerResult<JiraReference> {
        if !self.jira() {
            return Err(fail("The project does not use Jira"));
        }
        let site = origin(&self.connection.site)?;
        let (Some(id), Some(key)) = (&row.id, &row.key) else {
            return Err(fail("Jira issue is malformed"));
        };
        let valid_key = key.split_once('-').is_some_and(|(project, number)| {
            project.starts_with(|c: char| c.is_ascii_uppercase())
                && project
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                && !number.is_empty()
                && number.bytes().all(|b| b.is_ascii_digit())
        });
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) || !valid_key {
            return Err(fail("Jira issue is malformed"));
        }
        let encoded = url::form_urlencoded::byte_serialize(key.as_bytes()).collect::<String>();
        Ok(JiraReference {
            kind: "jira",
            url: format!("{site}/browse/{encoded}"),
            site,
            id: id.clone(),
            key: key.clone(),
            title: row.text("summary"),
        })
    }

    /// TypeScript `check`: the issue must belong to the configured tracker.
    fn check(&self, issue: &Value) -> TrackerResult<IssueRef> {
        let issue = IssueRef::deserialize(issue).unwrap_or_default();
        self.in_scope(&issue)?;
        Ok(issue)
    }

    fn in_scope(&self, issue: &IssueRef) -> TrackerResult<()> {
        let connection = &self.connection;
        let same_github = issue.github()
            && connection.kind == "github"
            && issue.repository.to_lowercase() == connection.repository.to_lowercase();
        let same_jira = issue.kind == "jira"
            && self.jira()
            && origin(&issue.site).ok() == origin(&connection.site).ok()
            && issue.key.starts_with(&format!("{}-", connection.project));
        if same_github || same_jira {
            Ok(())
        } else {
            Err(Box::new(IssueTrackerScopeFailure))
        }
    }

    pub async fn search(&self, query: &str) -> TrackerResult<Vec<Value>> {
        let text = query.trim().chars().take(200).collect::<String>();
        if !self.jira() {
            let repository = &self.connection.repository;
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
            return Ok(result
                .items
                .into_iter()
                .filter(|row| !row.pull_request)
                .filter_map(|row| {
                    let number = row.number?;
                    Some(json!({
                        "kind": "github", "repository": repository, "id": row.id?.to_string(),
                        "number": number, "key": format!("#{number}"), "title": row.title?,
                        "url": row.html_url?,
                    }))
                })
                .collect());
        }
        let project = &self.connection.project;
        let is_key = text
            .to_uppercase()
            .strip_prefix(&format!("{project}-"))
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()));
        if is_key {
            let encoded = url::form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>();
            let row: JiraIssue = self
                .jira_read(
                    &format!("/rest/api/3/issue/{encoded}?fields=summary"),
                    "Jira issue is malformed",
                )
                .await?;
            return Ok(vec![json!(self.reference(&row)?)]);
        }
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        let jql = format!(
            "project = \"{project}\"{} ORDER BY updated DESC",
            if escaped.is_empty() {
                String::new()
            } else {
                format!(" AND text ~ \"{escaped}\"")
            }
        );
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("jql", &jql)
            .append_pair("fields", "summary")
            .append_pair("maxResults", "30")
            .finish();
        let page: JiraSearch = self
            .jira_read(
                &format!("/rest/api/3/search/jql?{query}"),
                "Jira search is malformed",
            )
            .await?;
        page.issues
            .iter()
            .map(|row| Ok(json!(self.reference(row)?)))
            .collect()
    }

    async fn comments(&self, issue: &IssueRef) -> TrackerResult<Vec<Comment>> {
        let mut result = Vec::new();
        for page in 0..100 {
            if issue.github() {
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
            } else {
                let rows: JiraComments = self
                    .jira_read(
                        &format!(
                            "/rest/api/3/issue/{}/comment?maxResults=100&startAt={}",
                            issue.id,
                            result.len()
                        ),
                        "Jira comments are malformed",
                    )
                    .await?;
                let empty = rows.comments.is_empty();
                result.extend(rows.comments);
                if result.len() as u64 >= rows.total {
                    return Ok(result);
                }
                if empty {
                    return Err(fail("Jira returned an incomplete comment page"));
                }
            }
        }
        Err(fail("The issue has more comments than Suplex can load"))
    }

    /// TypeScript `read`: the current issue identity and a bounded text snapshot.
    pub async fn read(&self, issue: &Value) -> TrackerResult<Value> {
        let reference = self.check(issue)?;
        let comments = self.comments(&reference).await?;
        let (current, heading, detail) = if reference.github() {
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
            (current, heading, row.body)
        } else {
            let (current, detail) = self.read_jira(&reference).await?;
            let heading = format!("{}: {}\n{}", current.key, current.title, current.url);
            (json!(current), heading, detail)
        };
        let text = format!(
            "{heading}\n\n{detail}\n\nComments\n{}",
            comments
                .iter()
                .map(|row| issue_text(&row.body))
                .collect::<Vec<_>>()
                .join("\n\n")
        );
        let limit = 500_000;
        let text = if text.encode_utf16().count() > limit {
            let units = text.encode_utf16().take(limit).collect::<Vec<_>>();
            format!(
                "{}\n\nContext intake limit reached: additional content was not loaded. Inspect the linked issue before relying on this incomplete snapshot.",
                String::from_utf16_lossy(&units)
            )
        } else {
            text
        };
        Ok(json!({
            "issue": current, "text": text,
            "capturedAt": now_millis_rfc3339(),
        }))
    }

    async fn read_jira(&self, issue: &IssueRef) -> TrackerResult<(JiraReference, String)> {
        let (row, current) = self.jira_issue(&issue.id, "expand=names,schema").await?;
        let mut detail = row
            .fields
            .iter()
            .filter(|(key, value)| {
                !matches!(key.as_str(), "comment" | "attachment" | "issuelinks") && !value.is_null()
            })
            .map(|(key, value)| {
                let name = row.names.get(key).and_then(Value::as_str).unwrap_or(key);
                format!("{name}: {}", issue_text(value))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let (site, _) = self.jira_credentials()?;
        detail += &self
            .attachment_text(&site, &row.field::<Vec<_>>("attachment"))
            .await;
        detail += &self.linked_text(&row.field::<Vec<_>>("issuelinks")).await;
        Ok((current, detail))
    }

    /// The text of up to ten Jira attachments.
    async fn attachment_text(&self, site: &str, attachments: &[Attachment]) -> String {
        let mut detail = String::new();
        for file in attachments.iter().take(10) {
            let (id, name, size) = (&file.id, &file.filename, file.size);
            detail += &format!("\n\nAttachment: {name} ({size} bytes)");
            let mime = file.mime_type.as_str();
            if size > 256 * 1024 || !(mime.starts_with("text/") || mime == "application/json") {
                let encoded =
                    url::form_urlencoded::byte_serialize(name.as_bytes()).collect::<String>();
                detail += &format!(
                    "\nContent not loaded: binary or larger than 256 KiB. Review through {site}/secure/attachment/{id}/{encoded}."
                );
                continue;
            }
            match self.attachment(id, 256 * 1024).await {
                Ok(bytes) => detail += &format!("\n{}", String::from_utf8_lossy(&bytes)),
                Err(_) => detail += "\nContent could not be read with this tracker connection.",
            }
        }
        if attachments.len() > 10 {
            detail += &format!(
                "\n{} additional attachments were not loaded (10 attachment intake limit).",
                attachments.len() - 10
            );
        }
        detail
    }

    /// The summary and description of up to five linked Jira issues.
    async fn linked_text(&self, links: &[IssueLink]) -> String {
        let linked = links
            .iter()
            .filter_map(|link| {
                let other = link.inward_issue.as_ref().or(link.outward_issue.as_ref())?;
                Some((other.id.as_deref()?, other.key.as_deref()?))
            })
            .collect::<Vec<_>>();
        let mut detail = String::new();
        for (id, key) in linked.iter().take(5) {
            let encoded = url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>();
            match self
                .jira_json(
                    &format!("/rest/api/3/issue/{encoded}?fields=summary,description"),
                    None,
                )
                .await
            {
                Ok(related) => {
                    let related: JiraIssue = serde_json::from_value(related).unwrap_or_default();
                    let description = related.text("description");
                    let limited = description.encode_utf16().take(20_000).collect::<Vec<_>>();
                    detail += &format!(
                        "\n\nLinked issue {}: {}\n{}",
                        related.key.as_deref().unwrap_or(key),
                        related.text("summary"),
                        String::from_utf16_lossy(&limited)
                    );
                    if description.encode_utf16().count() > 20_000 {
                        detail += "\nLinked description limited to 20000 characters.";
                    }
                }
                Err(_) => {
                    detail += &format!(
                        "\nLinked issue {key} could not be read with this tracker connection."
                    )
                }
            }
        }
        if linked.len() > 5 {
            detail += &format!(
                "\n{} linked issues were not loaded (5 linked issue intake limit).",
                linked.len() - 5
            );
        }
        detail
    }

    /// TypeScript `images`: up to eight Jira image attachments for task intake.
    pub async fn images(&self, issue: &Value, limit: usize) -> TrackerResult<IssueImages> {
        let issue = self.check(issue)?;
        let mut result = IssueImages {
            images: Vec::new(),
            notes: Vec::new(),
        };
        if issue.kind != "jira" {
            return Ok(result);
        }
        let (current, _) = self
            .jira_issue(&issue.id, "fields=summary,attachment")
            .await?;
        let rows: Vec<Attachment> = current.field("attachment");
        for file in rows.iter().take(10) {
            let mime = file.mime_type.as_str();
            if !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ) {
                continue;
            }
            let name = &file.filename;
            if result.images.len() >= limit.min(8) || file.size as usize > MAX_TASK_IMAGE_BYTES {
                result.notes.push(format!(
                    "Image {name} was not loaded: task image count or 8 MiB limit reached."
                ));
                continue;
            }
            let id = &file.id;
            let loaded = self
                .attachment(id, MAX_TASK_IMAGE_BYTES)
                .await
                .ok()
                .filter(|bytes| {
                    crate::tasks::images::decode_task_image(
                        &crate::http::contracts::typed::tasks::TaskImage {
                            filename: name.to_owned(),
                            mime_type: mime.to_owned(),
                            base64: STANDARD.encode(bytes),
                        },
                    )
                    .is_ok()
                });
            match loaded {
                Some(bytes) => {
                    let filename = name.replace(['\\', '/'], "_");
                    let filename = if filename.is_empty() {
                        format!("attachment-{id}")
                    } else {
                        filename
                    };
                    result.images.push((filename, mime.to_owned(), bytes));
                }
                None => result.notes.push(format!(
                    "Image {name} could not be loaded. Review it in Jira."
                )),
            }
        }
        if rows.len() > 10 {
            result.notes.push(format!(
                "{} additional attachments were not inspected for images. Review them in Jira.",
                rows.len() - 10
            ));
        }
        Ok(result)
    }

    /// TypeScript `upload`: a hash-named evidence file on the tracker. GitHub
    /// media uses the GitHub CLI `--attach` upload and verifies the owned comment.
    pub async fn upload(
        &self,
        issue: &Value,
        filename: &str,
        bytes: &[u8],
        mime_type: &str,
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
        if issue.kind != "jira" {
            // A response lost after an earlier upload is recovered from the
            // owned marker comment. A new GitHub media upload needs the CLI.
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
            return github_image_reference(&issue_text(&existing.body))
                .ok_or_else(|| fail("GitHub has not confirmed the uploaded evidence reference"));
        }
        let (site, _) = self.jira_credentials()?;
        let mut existing = self.owned_attachment(&issue, filename, &actor).await?;
        if existing.is_none() {
            self.before_mutation(&issue, before_write).await?;
            self.post_attachment(&issue, filename, bytes, mime_type)
                .await?;
            existing = self.owned_attachment(&issue, filename, &actor).await?;
        }
        let id = existing.ok_or_else(|| fail("Jira has not confirmed the evidence attachment"))?;
        let uploaded = self.attachment(&id, MAX_TASK_IMAGE_BYTES).await?;
        if sha256_hex(&uploaded) != hash {
            return Err(fail("The Jira attachment does not match the task evidence"));
        }
        let encoded = url::form_urlencoded::byte_serialize(filename.as_bytes()).collect::<String>();
        Ok(format!("{site}/secure/attachment/{id}/{encoded}"))
    }

    /// The id of the actor's Jira attachment with this file name.
    async fn owned_attachment(
        &self,
        issue: &IssueRef,
        filename: &str,
        actor: &str,
    ) -> TrackerResult<Option<String>> {
        let row: JiraIssue = serde_json::from_value(
            self.jira_json(
                &format!("/rest/api/3/issue/{}?fields=attachment", issue.id),
                None,
            )
            .await?,
        )
        .unwrap_or_default();
        Ok(row
            .field::<Vec<Attachment>>("attachment")
            .into_iter()
            .find(|row| {
                row.filename == filename
                    && row
                        .author
                        .as_ref()
                        .and_then(|author| author.account_id.as_deref())
                        == Some(actor)
            })
            .map(|row| row.id))
    }

    async fn post_attachment(
        &self,
        issue: &IssueRef,
        filename: &str,
        bytes: &[u8],
        mime_type: &str,
    ) -> TrackerResult<()> {
        // The file name was validated by the caller, so it needs no quoting.
        let boundary = format!("suplex-{}", uuid::Uuid::new_v4().simple());
        let mut form = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime_type}\r\n\r\n").into_bytes();
        form.extend_from_slice(bytes);
        form.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let (origin, authorization) = self.jira_credentials()?;
        let response = self
            .http
            .post(
                url::Url::parse(&origin)?
                    .join(&format!("/rest/api/3/issue/{}/attachments", issue.id))?,
            )
            .header("Accept", "application/json")
            .header("Authorization", authorization)
            .header("X-Atlassian-Token", "no-check")
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(form)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(ProviderHttpFailure {
                status: response.status().as_u16(),
            }
            .into());
        }
        Ok(())
    }

    async fn before_mutation(
        &self,
        issue: &IssueRef,
        before_write: BeforeWrite<'_>,
    ) -> TrackerResult<()> {
        if issue.kind == "jira" {
            self.jira_issue(&issue.id, "fields=summary").await?;
        }
        before_write().await
    }

    /// TypeScript `publish`: create or update the one owned evidence comment.
    pub async fn publish(
        &self,
        issue: &Value,
        task_id: &str,
        body: &str,
        before_write: BeforeWrite<'_>,
        known_comment_id: Option<&str>,
    ) -> TrackerResult<String> {
        let issue = self.check(issue)?;
        let marker = format!("[Suplex task {task_id}]");
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
                    value == text
                        || (value.starts_with("## What changed\n\n")
                            && value.ends_with(&format!("\n\n{marker}"))
                            && EVIDENCE_SHAPE.is_match(&value))
                })
            });
        if let Some(existing) = existing
            && issue_text(&existing.body) == text
        {
            return Ok(existing.id.clone());
        }
        let existing = existing.map(|row| row.id.as_str());
        self.before_mutation(&issue, before_write).await?;
        let written = if issue.github() {
            let repository = &issue.repository;
            let (path, method) = match existing {
                Some(id) => (format!("repos/{repository}/issues/comments/{id}"), "PATCH"),
                None => (
                    format!("repos/{repository}/issues/{}/comments", issue.number),
                    "POST",
                ),
            };
            self.github_json(&path, Some((method, &json!({"body": text}))))
                .await?
        } else {
            let path = format!(
                "/rest/api/3/issue/{}/comment{}",
                issue.id,
                existing.map(|id| format!("/{id}")).unwrap_or_default()
            );
            let method = if existing.is_some() { "PUT" } else { "POST" };
            self.jira_json(
                &path,
                Some((method, &json!({"body": jira_evidence_document(&text)}))),
            )
            .await?
        };
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
}

/// `suplex-<name>-<sha256>.<ext>`: the evidence file name for these bytes.
fn valid_evidence_name(filename: &str, hash: &str) -> bool {
    filename
        .strip_prefix("suplex-")
        .and_then(|rest| rest.rsplit_once('.'))
        .is_some_and(|(stem, extension)| {
            stem.ends_with(&format!("-{hash}"))
                && stem.len() > hash.len() + 1
                && stem[..stem.len() - hash.len() - 1]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && !extension.is_empty()
                && extension
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// GitHub evidence image references must stay on GitHub hosts.
pub fn github_image_reference(body: &str) -> Option<String> {
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
        tracker.gh_command = command.to_string_lossy().into_owned();
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
    fn jira_evidence_links_stay_clickable_without_changing_read_back_text() {
        let text = "## What changed\n\nSee https://example.atlassian.net/browse/A-1 now";
        let document = jira_evidence_document(text);
        assert_eq!(issue_text(&document["content"]), text);
        assert_eq!(
            document["content"][2]["content"][1]["marks"][0]["attrs"]["href"],
            "https://example.atlassian.net/browse/A-1"
        );
    }

    #[test]
    fn issue_text_flattens_documents_and_stringifies_unknown_objects() {
        assert_eq!(
            issue_text(&json!({"type":"paragraph","content":[{"text":"a"},{"text":"b"}]})),
            "ab"
        );
        assert_eq!(issue_text(&json!({"x":1})), "{\"x\":1}");
        assert_eq!(issue_text(&json!(3)), "3");
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

    /// A loopback Jira answering each path and query from `replies`.
    async fn fake_jira(
        replies: Vec<(&'static str, String)>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let replies = std::sync::Arc::new(replies);
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let replies = replies.clone();
            async move {
                let key = uri.path_and_query().map_or("", |value| value.as_str());
                match replies.iter().find(|(path, _)| *path == key) {
                    Some((_, body)) => (axum::http::StatusCode::OK, body.clone()),
                    None => (axum::http::StatusCode::NOT_FOUND, String::new()),
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, server)
    }

    #[tokio::test]
    async fn jira_read_snapshots_fields_attachments_links_and_comments() {
        // SAFETY: the variables are unique to this test.
        unsafe {
            std::env::set_var("SUPLEX_TEST_JIRA_READ_EMAIL", "me@example.com");
            std::env::set_var("SUPLEX_TEST_JIRA_READ_TOKEN", "secret");
        }
        let (base, server) = fake_jira(vec![
            (
                "/rest/api/3/issue/10001/comment?maxResults=100&startAt=0",
                json!({"comments": [{"id": "5", "body": "First", "author": {"accountId": "me"}}], "total": 1}).to_string(),
            ),
            (
                "/rest/api/3/issue/10001?expand=names,schema",
                json!({"id": "10001", "key": "ABC-1", "names": {"summary": "Summary", "description": "Description"},
                    "fields": {"summary": "Title", "priority": null,
                        "description": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Body"}]}]},
                        "attachment": [{"id": 7, "filename": "notes.txt", "size": 5, "mimeType": "text/plain"},
                            {"id": "8", "filename": "shot.png", "size": 9, "mimeType": "image/png"}],
                        "issuelinks": [{"outwardIssue": {"id": "10002", "key": "ABC-2"}}]}}).to_string(),
            ),
            ("/rest/api/3/attachment/content/7?redirect=false", "hello".into()),
            (
                "/rest/api/3/issue/10002?fields=summary,description",
                json!({"key": "ABC-2", "fields": {"summary": "Other", "description": "Linked body"}}).to_string(),
            ),
        ])
        .await;
        let tracker = IssueTracker::with_github(
            &json!({"kind": "jira", "site": base, "project": "ABC",
                "emailEnvironment": "SUPLEX_TEST_JIRA_READ_EMAIL", "tokenEnvironment": "SUPLEX_TEST_JIRA_READ_TOKEN"}),
            None,
        );
        let snapshot = tracker
            .read(&json!({"kind": "jira", "site": base, "id": "10001", "key": "ABC-1"}))
            .await
            .unwrap();
        assert_eq!(
            snapshot["issue"].to_string(),
            json!({"kind": "jira", "site": base, "id": "10001", "key": "ABC-1", "title": "Title", "url": format!("{base}/browse/ABC-1")}).to_string()
        );
        assert_eq!(
            snapshot["text"],
            format!(
                "ABC-1: Title\n{base}/browse/ABC-1\n\nSummary: Title\n\nDescription: Body\n\nAttachment: notes.txt (5 bytes)\nhello\n\nAttachment: shot.png (9 bytes)\nContent not loaded: binary or larger than 256 KiB. Review through {base}/secure/attachment/8/shot.png.\n\nLinked issue ABC-2: Other\nLinked body\n\nComments\nFirst"
            )
        );
        server.abort();
    }

    #[tokio::test]
    async fn jira_evidence_upload_recovers_a_lost_response_only_after_hash_verification() {
        use axum::http::{Method, StatusCode, Uri};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };

        // SAFETY: these names are private to this fixture.
        unsafe {
            std::env::set_var("SUPLEX_TEST_JIRA_UPLOAD_EMAIL", "me@example.com");
            std::env::set_var("SUPLEX_TEST_JIRA_UPLOAD_TOKEN", "secret");
        }
        let bytes = b"fixture-image";
        let filename = format!("suplex-task_one-{}.png", sha256_hex(bytes));
        let uploaded = Arc::new(AtomicBool::new(false));
        let uploads = Arc::new(AtomicUsize::new(0));
        let altered = Arc::new(AtomicBool::new(false));
        let app = axum::Router::new().fallback({
            let uploaded = uploaded.clone();
            let uploads = uploads.clone();
            let altered = altered.clone();
            let filename = filename.clone();
            move |method: Method, uri: Uri| {
                let uploaded = uploaded.clone();
                let uploads = uploads.clone();
                let altered = altered.clone();
                let filename = filename.clone();
                async move {
                    let path = uri.path_and_query().map_or("", |part| part.as_str());
                    if path == "/rest/api/3/myself" {
                        return (StatusCode::OK, json!({"accountId":"me"}).to_string());
                    }
                    if path == "/rest/api/3/issue/42?fields=summary" {
                        return (StatusCode::OK, json!({"id":"42","key":"APP-42","fields":{"summary":"Fix"}}).to_string());
                    }
                    if path == "/rest/api/3/issue/42?fields=attachment" {
                        let rows = if uploaded.load(Ordering::SeqCst) {
                            json!([{"id":"7","filename":filename,"size":13,"author":{"accountId":"me"}}])
                        } else { json!([]) };
                        return (StatusCode::OK, json!({"fields":{"attachment":rows}}).to_string());
                    }
                    if path == "/rest/api/3/attachment/content/7?redirect=false" {
                        let body = if altered.load(Ordering::SeqCst) { "fixture-imago" } else { "fixture-image" };
                        return (StatusCode::OK, body.into());
                    }
                    if method == Method::POST && path == "/rest/api/3/issue/42/attachments" {
                        uploads.fetch_add(1, Ordering::SeqCst);
                        uploaded.store(true, Ordering::SeqCst);
                        return (StatusCode::INTERNAL_SERVER_ERROR, "response lost".into());
                    }
                    (StatusCode::NOT_FOUND, String::new())
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let tracker = IssueTracker::with_github(
            &json!({
                "kind":"jira", "site":base, "project":"APP",
                "emailEnvironment":"SUPLEX_TEST_JIRA_UPLOAD_EMAIL",
                "tokenEnvironment":"SUPLEX_TEST_JIRA_UPLOAD_TOKEN"
            }),
            None,
        );
        let issue = json!({"kind":"jira","site":base,"id":"42","key":"APP-42"});
        let allow = || Box::pin(async { Ok(()) }) as _;
        let deny = || Box::pin(async { Err("cancelled".into()) }) as _;
        assert_eq!(
            tracker
                .upload(&issue, &filename, bytes, "image/png", &deny)
                .await
                .unwrap_err()
                .to_string(),
            "cancelled"
        );
        assert_eq!(uploads.load(Ordering::SeqCst), 0);
        assert!(
            tracker
                .upload(&issue, &filename, bytes, "image/png", &allow)
                .await
                .is_err()
        );
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
        assert_eq!(
            tracker
                .upload(&issue, &filename, bytes, "image/png", &allow)
                .await
                .unwrap(),
            format!("{base}/secure/attachment/7/{filename}")
        );
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
        altered.store(true, Ordering::SeqCst);
        assert!(
            tracker
                .upload(&issue, &filename, bytes, "image/png", &allow)
                .await
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
        let foreign = json!({"kind":"jira","site":base,"id":"42","key":"OTHER-42"});
        assert!(
            tracker
                .upload(&foreign, &filename, bytes, "image/png", &allow)
                .await
                .unwrap_err()
                .is::<IssueTrackerScopeFailure>()
        );
        server.abort();
    }

    #[tokio::test]
    async fn jira_evidence_publication_rechecks_scope_and_confirms_owned_remote_text() {
        use axum::{
            body::Bytes,
            http::{Method, StatusCode, Uri},
        };
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };

        // SAFETY: private fixture credential names.
        unsafe {
            std::env::set_var("SUPLEX_TEST_JIRA_PUBLISH_EMAIL", "me@example.com");
            std::env::set_var("SUPLEX_TEST_JIRA_PUBLISH_TOKEN", "secret");
        }
        let moved = Arc::new(AtomicBool::new(false));
        let tampered_readback = Arc::new(AtomicBool::new(false));
        let writes = Arc::new(AtomicUsize::new(0));
        let comment = Arc::new(Mutex::new(None::<Value>));
        let app = axum::Router::new().fallback({
            let moved = moved.clone();
            let tampered_readback = tampered_readback.clone();
            let writes = writes.clone();
            let comment = comment.clone();
            move |method: Method, uri: Uri, body: Bytes| {
                let moved = moved.clone();
                let tampered_readback = tampered_readback.clone();
                let writes = writes.clone();
                let comment = comment.clone();
                async move {
                    let path = uri.path_and_query().map_or("", |part| part.as_str());
                    if path == "/rest/api/3/myself" {
                        return (StatusCode::OK, json!({"accountId":"me"}).to_string());
                    }
                    if path == "/rest/api/3/issue/42/comment?maxResults=100&startAt=0" {
                        let mut rows = comment
                            .lock()
                            .unwrap()
                            .clone()
                            .into_iter()
                            .collect::<Vec<_>>();
                        if tampered_readback.load(Ordering::SeqCst) && !rows.is_empty() {
                            rows[0]["body"] = json!("wrong remote text");
                        }
                        return (
                            StatusCode::OK,
                            json!({"comments":rows,"total":rows.len(),"startAt":0}).to_string(),
                        );
                    }
                    if path == "/rest/api/3/issue/42?fields=summary" {
                        let key = if moved.load(Ordering::SeqCst) {
                            "OTHER-42"
                        } else {
                            "APP-42"
                        };
                        return (
                            StatusCode::OK,
                            json!({"id":"42","key":key,"fields":{"summary":"Fix"}}).to_string(),
                        );
                    }
                    if (method == Method::POST && path == "/rest/api/3/issue/42/comment")
                        || (method == Method::PUT && path == "/rest/api/3/issue/42/comment/9")
                    {
                        writes.fetch_add(1, Ordering::SeqCst);
                        let input: Value = serde_json::from_slice(&body).unwrap();
                        let row =
                            json!({"id":"9","author":{"accountId":"me"},"body":input["body"]});
                        *comment.lock().unwrap() = Some(row);
                        return (StatusCode::OK, json!({"id":"9"}).to_string());
                    }
                    (StatusCode::NOT_FOUND, String::new())
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let tracker = IssueTracker::with_github(
            &json!({
                "kind":"jira","site":base,"project":"APP",
                "emailEnvironment":"SUPLEX_TEST_JIRA_PUBLISH_EMAIL",
                "tokenEnvironment":"SUPLEX_TEST_JIRA_PUBLISH_TOKEN"
            }),
            None,
        );
        let issue = json!({"kind":"jira","site":base,"id":"42","key":"APP-42"});
        let allow: BeforeWrite<'_> = &|| Box::pin(async { Ok(()) });
        let deny: BeforeWrite<'_> = &|| Box::pin(async { Err("cancelled".into()) });
        assert_eq!(
            tracker
                .publish(&issue, "task_one", "Evidence", deny, None)
                .await
                .unwrap_err()
                .to_string(),
            "cancelled"
        );
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        moved.store(true, Ordering::SeqCst);
        assert!(
            tracker
                .publish(&issue, "task_one", "Evidence", allow, None)
                .await
                .unwrap_err()
                .is::<IssueTrackerScopeFailure>()
        );
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        moved.store(false, Ordering::SeqCst);
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
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert_eq!(
            tracker
                .publish(&issue, "task_one", "New evidence", allow, Some("9"))
                .await
                .unwrap(),
            "9"
        );
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        tampered_readback.store(true, Ordering::SeqCst);
        assert!(
            tracker
                .publish(&issue, "task_one", "Third evidence", allow, Some("9"))
                .await
                .unwrap_err()
                .to_string()
                .contains("has not confirmed")
        );
        assert_eq!(writes.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn jira_image_intake_limits_and_verifies_downloads_before_import() {
        use axum::http::{StatusCode, Uri};
        // SAFETY: private fixture credential names.
        unsafe {
            std::env::set_var("SUPLEX_TEST_JIRA_IMAGES_EMAIL", "me@example.com");
            std::env::set_var("SUPLEX_TEST_JIRA_IMAGES_TOKEN", "secret");
        }
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let app = axum::Router::new().fallback(move |uri: Uri| async move {
            let path = uri.path_and_query().map_or("", |part| part.as_str());
            if path == "/rest/api/3/attachment/content/1?redirect=false" {
                return (StatusCode::OK, png.to_vec());
            }
            if path == "/rest/api/3/issue/42?fields=summary,attachment" {
                return (
                    StatusCode::OK,
                    json!({"id":"42","key":"APP-42","fields":{"summary":"Fix","attachment":[
                        {"id":"1","filename":"../before.png","size":8,"mimeType":"image/png"},
                        {"id":"2","filename":"after.png","size":8,"mimeType":"image/png"},
                        {"id":"3","filename":"details.pdf","size":8,"mimeType":"application/pdf"}
                    ]}})
                    .to_string()
                    .into_bytes(),
                );
            }
            (StatusCode::NOT_FOUND, Vec::new())
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let tracker = IssueTracker::with_github(
            &json!({
                "kind":"jira","site":base,"project":"APP",
                "emailEnvironment":"SUPLEX_TEST_JIRA_IMAGES_EMAIL",
                "tokenEnvironment":"SUPLEX_TEST_JIRA_IMAGES_TOKEN"
            }),
            None,
        );
        let issue = json!({"kind":"jira","site":base,"id":"42","key":"APP-42"});
        let images = tracker.images(&issue, 1).await.unwrap();
        assert_eq!(
            images.images,
            vec![(".._before.png".into(), "image/png".into(), png.to_vec())]
        );
        assert!(images.notes.join(" ").contains("after.png was not loaded"));
        server.abort();
    }
}
