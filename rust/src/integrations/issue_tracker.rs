//! TypeScript `IssueTracker`: GitHub Issues through the GitHub API and Jira
//! Cloud through its REST API. The connection comes from task or project
//! configuration; issue identities outside it are refused.

use std::{error::Error, fmt, sync::LazyLock};

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::github_delivery::Github;
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
            node["content"]
                .as_array()
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

pub struct IssueTracker {
    connection: Value,
    github: Option<Github>,
    http: reqwest::Client,
}

pub struct IssueImages {
    pub images: Vec<(String, String, Vec<u8>)>,
    pub notes: Vec<String>,
}

impl IssueTracker {
    pub async fn new(connection: &Value) -> TrackerResult<Self> {
        let github = if connection["kind"] == "github" {
            Some(Github::load().await?)
        } else {
            None
        };
        Ok(Self::with_github(connection, github))
    }

    pub fn with_github(connection: &Value, github: Option<Github>) -> Self {
        Self {
            connection: connection.clone(),
            github,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("HTTP client"),
        }
    }

    fn jira(&self) -> bool {
        self.connection["kind"] == "jira"
    }

    fn jira_credentials(&self) -> TrackerResult<(String, String)> {
        if !self.jira() {
            return Err(fail("The project does not use Jira"));
        }
        let email =
            environment_credential(self.connection["emailEnvironment"].as_str().unwrap_or(""))?;
        let token =
            environment_credential(self.connection["tokenEnvironment"].as_str().unwrap_or(""))?;
        Ok((
            origin(self.connection["site"].as_str().unwrap_or(""))?,
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
        let mut response = request.send().await?;
        if !response.status().is_success() {
            return Err(ProviderHttpFailure {
                status: response.status().as_u16(),
            }
            .into());
        }
        if response
            .content_length()
            .is_some_and(|length| length as usize > maximum)
        {
            return Err(fail("The provider response is too large"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > maximum {
                return Err(fail("The provider response is too large"));
            }
        }
        Ok(bytes)
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

    async fn actor(&self) -> TrackerResult<String> {
        if self.jira() {
            let myself = self.jira_json("/rest/api/3/myself", None).await?;
            return myself["accountId"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| fail("Jira account is malformed"));
        }
        let user = self.github_json("user", None).await?;
        user["id"]
            .as_u64()
            .map(|id| id.to_string())
            .ok_or_else(|| fail("GitHub account is malformed"))
    }

    fn owned(row: &Value, actor: &str) -> bool {
        row["author"]["accountId"].as_str() == Some(actor)
            || row["user"]["id"]
                .as_u64()
                .is_some_and(|id| id.to_string() == actor)
    }

    /// TypeScript `reference`: a validated Jira issue association.
    fn reference(&self, row: &Value) -> TrackerResult<Value> {
        if !self.jira() {
            return Err(fail("The project does not use Jira"));
        }
        let site = origin(self.connection["site"].as_str().unwrap_or(""))?;
        let (Some(id), Some(key)) = (row["id"].as_str(), row["key"].as_str()) else {
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
        Ok(json!({
            "kind": "jira", "site": site, "id": id, "key": key,
            "title": issue_text(&row["fields"]["summary"]), "url": format!("{site}/browse/{encoded}"),
        }))
    }

    /// TypeScript `check`: the issue must belong to the configured tracker.
    fn check(&self, issue: &Value) -> TrackerResult<()> {
        let same_github = issue["kind"] == "github"
            && self.connection["kind"] == "github"
            && issue["repository"].as_str().map(str::to_lowercase)
                == self.connection["repository"]
                    .as_str()
                    .map(str::to_lowercase);
        let same_jira = issue["kind"] == "jira"
            && self.jira()
            && origin(issue["site"].as_str().unwrap_or("")).ok()
                == origin(self.connection["site"].as_str().unwrap_or("")).ok()
            && issue["key"].as_str().is_some_and(|key| {
                key.starts_with(&format!(
                    "{}-",
                    self.connection["project"].as_str().unwrap_or("")
                ))
            });
        if same_github || same_jira {
            Ok(())
        } else {
            Err(Box::new(IssueTrackerScopeFailure))
        }
    }

    pub async fn search(&self, query: &str) -> TrackerResult<Vec<Value>> {
        let text = query.trim().chars().take(200).collect::<String>();
        if !self.jira() {
            let repository = self.connection["repository"].as_str().unwrap_or("");
            let q = url::form_urlencoded::byte_serialize(
                format!("repo:{repository} is:issue {text}").as_bytes(),
            )
            .collect::<String>();
            let result = self
                .github_json(&format!("search/issues?q={q}&per_page=30"), None)
                .await?;
            let items = result["items"]
                .as_array()
                .ok_or_else(|| fail("GitHub search is malformed"))?;
            return Ok(items
                .iter()
                .filter(|row| row.get("pull_request").is_none())
                .filter_map(|row| {
                    let number = row["number"].as_u64()?;
                    Some(json!({
                        "kind": "github", "repository": repository, "id": row["id"].as_u64()?.to_string(),
                        "number": number, "key": format!("#{number}"), "title": row["title"].as_str()?,
                        "url": row["html_url"].as_str()?,
                    }))
                })
                .collect());
        }
        let project = self.connection["project"].as_str().unwrap_or("");
        let is_key = text
            .to_uppercase()
            .strip_prefix(&format!("{project}-"))
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()));
        if is_key {
            let encoded = url::form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>();
            let row = self
                .jira_json(&format!("/rest/api/3/issue/{encoded}?fields=summary"), None)
                .await?;
            return Ok(vec![self.reference(&row)?]);
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
        let page = self
            .jira_json(&format!("/rest/api/3/search/jql?{query}"), None)
            .await?;
        page["issues"]
            .as_array()
            .ok_or_else(|| fail("Jira search is malformed"))?
            .iter()
            .map(|row| self.reference(row))
            .collect()
    }

    async fn comments(&self, issue: &Value) -> TrackerResult<Vec<Value>> {
        self.check(issue)?;
        let mut result = Vec::new();
        for page in 0..100 {
            if issue["kind"] == "github" {
                let rows = self
                    .github_json(
                        &format!(
                            "repos/{}/issues/{}/comments?per_page=100&page={}",
                            issue["repository"].as_str().unwrap_or(""),
                            issue["number"],
                            page + 1
                        ),
                        None,
                    )
                    .await?;
                let rows = rows
                    .as_array()
                    .ok_or_else(|| fail("GitHub comments are malformed"))?;
                result.extend(rows.iter().cloned());
                if rows.len() < 100 {
                    return Ok(result);
                }
            } else {
                let rows = self
                    .jira_json(
                        &format!(
                            "/rest/api/3/issue/{}/comment?maxResults=100&startAt={}",
                            issue["id"].as_str().unwrap_or(""),
                            result.len()
                        ),
                        None,
                    )
                    .await?;
                let (Some(comments), Some(total)) =
                    (rows["comments"].as_array(), rows["total"].as_u64())
                else {
                    return Err(fail("Jira comments are malformed"));
                };
                result.extend(comments.iter().cloned());
                if result.len() as u64 >= total {
                    return Ok(result);
                }
                if comments.is_empty() {
                    return Err(fail("Jira returned an incomplete comment page"));
                }
            }
        }
        Err(fail("The issue has more comments than Suplex can load"))
    }

    /// TypeScript `read`: the current issue identity and a bounded text snapshot.
    pub async fn read(&self, issue: &Value) -> TrackerResult<Value> {
        self.check(issue)?;
        let comments = self.comments(issue).await?;
        let (current, detail) = if issue["kind"] == "github" {
            let row = self
                .github_json(
                    &format!(
                        "repos/{}/issues/{}",
                        issue["repository"].as_str().unwrap_or(""),
                        issue["number"]
                    ),
                    None,
                )
                .await?;
            if row.get("pull_request").is_some() {
                return Err(fail("Select an issue, not a pull request"));
            }
            let mut current = issue.clone();
            current["id"] = json!(row["id"].as_u64().map(|id| id.to_string()));
            current["title"] = row["title"].clone();
            current["url"] = row["html_url"].clone();
            (current, row["body"].as_str().unwrap_or("").to_owned())
        } else {
            self.read_jira(issue).await?
        };
        let text = format!(
            "{}: {}\n{}\n\n{}\n\nComments\n{}",
            current["key"].as_str().unwrap_or(""),
            current["title"].as_str().unwrap_or(""),
            current["url"].as_str().unwrap_or(""),
            detail,
            comments
                .iter()
                .map(|row| issue_text(&row["body"]))
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
            "capturedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        }))
    }

    async fn read_jira(&self, issue: &Value) -> TrackerResult<(Value, String)> {
        let row = self
            .jira_json(
                &format!(
                    "/rest/api/3/issue/{}?expand=names,schema",
                    issue["id"].as_str().unwrap_or("")
                ),
                None,
            )
            .await?;
        let current = self.reference(&row)?;
        self.check(&current)?;
        let fields = row["fields"].as_object().cloned().unwrap_or_default();
        let mut detail = fields
            .iter()
            .filter(|(key, value)| {
                !matches!(key.as_str(), "comment" | "attachment" | "issuelinks") && !value.is_null()
            })
            .map(|(key, value)| {
                format!(
                    "{}: {}",
                    row["names"][key].as_str().unwrap_or(key),
                    issue_text(value)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let (site, _) = self.jira_credentials()?;
        let attachments = row["fields"]["attachment"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for file in attachments.iter().take(10) {
            let id = attachment_id(file);
            let name = file["filename"].as_str().unwrap_or("");
            let size = file["size"].as_u64().unwrap_or(0);
            detail += &format!("\n\nAttachment: {name} ({size} bytes)");
            let mime = file["mimeType"].as_str().unwrap_or("");
            if size > 256 * 1024 || !(mime.starts_with("text/") || mime == "application/json") {
                let encoded =
                    url::form_urlencoded::byte_serialize(name.as_bytes()).collect::<String>();
                detail += &format!(
                    "\nContent not loaded: binary or larger than 256 KiB. Review through {site}/secure/attachment/{id}/{encoded}."
                );
                continue;
            }
            match self
                .provider_bytes(
                    &format!("/rest/api/3/attachment/content/{id}?redirect=false"),
                    reqwest::Method::GET,
                    None,
                    &[],
                    256 * 1024,
                )
                .await
            {
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
        let linked = row["fields"]["issuelinks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|link| {
                let other = link
                    .get("inwardIssue")
                    .or_else(|| link.get("outwardIssue"))?;
                Some((
                    other["id"].as_str()?.to_owned(),
                    other["key"].as_str()?.to_owned(),
                ))
            })
            .collect::<Vec<_>>();
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
                    let description = issue_text(&related["fields"]["description"]);
                    let limited = description.encode_utf16().take(20_000).collect::<Vec<_>>();
                    detail += &format!(
                        "\n\nLinked issue {}: {}\n{}",
                        related["key"].as_str().unwrap_or(key),
                        issue_text(&related["fields"]["summary"]),
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
        Ok((current, detail))
    }

    /// TypeScript `images`: up to eight Jira image attachments for task intake.
    pub async fn images(&self, issue: &Value, limit: usize) -> TrackerResult<IssueImages> {
        self.check(issue)?;
        let mut result = IssueImages {
            images: Vec::new(),
            notes: Vec::new(),
        };
        if issue["kind"] != "jira" {
            return Ok(result);
        }
        let current = self
            .jira_json(
                &format!(
                    "/rest/api/3/issue/{}?fields=summary,attachment",
                    issue["id"].as_str().unwrap_or("")
                ),
                None,
            )
            .await?;
        self.check(&self.reference(&current)?)?;
        let rows = current["fields"]["attachment"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for file in rows.iter().take(10) {
            let mime = file["mimeType"].as_str().unwrap_or("");
            if !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ) {
                continue;
            }
            let name = file["filename"].as_str().unwrap_or("");
            if result.images.len() >= limit.min(8)
                || file["size"].as_u64().unwrap_or(0) as usize > MAX_TASK_IMAGE_BYTES
            {
                result.notes.push(format!(
                    "Image {name} was not loaded: task image count or 8 MiB limit reached."
                ));
                continue;
            }
            let id = attachment_id(file);
            let loaded = self
                .provider_bytes(
                    &format!("/rest/api/3/attachment/content/{id}?redirect=false"),
                    reqwest::Method::GET,
                    None,
                    &[],
                    MAX_TASK_IMAGE_BYTES,
                )
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
    /// media needs the GitHub CLI `--attach` upload, which Rust does not run.
    pub async fn upload(
        &self,
        issue: &Value,
        filename: &str,
        bytes: &[u8],
        mime_type: &str,
        before_write: BeforeWrite<'_>,
    ) -> TrackerResult<String> {
        self.check(issue)?;
        let hash = format!("{:x}", Sha256::digest(bytes));
        let valid_name = filename
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
            });
        if !valid_name || bytes.is_empty() || bytes.len() > MAX_TASK_IMAGE_BYTES {
            return Err(fail("Invalid task evidence attachment"));
        }
        let actor = self.actor().await?;
        if issue["kind"] != "jira" {
            // A response lost after an earlier upload is recovered from the
            // owned marker comment. A new GitHub media upload needs the CLI.
            let marker = format!("[Suplex attachment {filename}]");
            let existing =
                self.comments(issue).await?.into_iter().find(|row| {
                    Self::owned(row, &actor) && issue_text(&row["body"]).contains(&marker)
                });
            let Some(existing) = existing else {
                return Err(fail(
                    "Update GitHub CLI to a version supporting issue comment --attach",
                ));
            };
            return github_image_reference(&issue_text(&existing["body"]))
                .ok_or_else(|| fail("GitHub has not confirmed the uploaded evidence reference"));
        }
        let (site, _) = self.jira_credentials()?;
        let attachments_path = format!(
            "/rest/api/3/issue/{}?fields=attachment",
            issue["id"].as_str().unwrap_or("")
        );
        let find = |value: &Value| {
            value["fields"]["attachment"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|row| {
                    row["filename"] == filename && row["author"]["accountId"] == actor.as_str()
                })
                .map(attachment_id)
        };
        let mut existing = find(&self.jira_json(&attachments_path, None).await?);
        if existing.is_none() {
            // The file name was validated above, so it needs no quoting.
            let boundary = format!("suplex-{}", uuid::Uuid::new_v4().simple());
            let mut form = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime_type}\r\n\r\n").into_bytes();
            form.extend_from_slice(bytes);
            form.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
            self.before_mutation(issue, before_write).await?;
            let (origin, authorization) = self.jira_credentials()?;
            let response = self
                .http
                .post(url::Url::parse(&origin)?.join(&format!(
                    "/rest/api/3/issue/{}/attachments",
                    issue["id"].as_str().unwrap_or("")
                ))?)
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
            existing = find(&self.jira_json(&attachments_path, None).await?);
        }
        let id = existing.ok_or_else(|| fail("Jira has not confirmed the evidence attachment"))?;
        let uploaded = self
            .provider_bytes(
                &format!("/rest/api/3/attachment/content/{id}?redirect=false"),
                reqwest::Method::GET,
                None,
                &[],
                MAX_TASK_IMAGE_BYTES,
            )
            .await?;
        if format!("{:x}", Sha256::digest(&uploaded)) != hash {
            return Err(fail("The Jira attachment does not match the task evidence"));
        }
        let encoded = url::form_urlencoded::byte_serialize(filename.as_bytes()).collect::<String>();
        Ok(format!("{site}/secure/attachment/{id}/{encoded}"))
    }

    async fn before_mutation(
        &self,
        issue: &Value,
        before_write: BeforeWrite<'_>,
    ) -> TrackerResult<()> {
        if issue["kind"] == "jira" {
            let current = self
                .jira_json(
                    &format!(
                        "/rest/api/3/issue/{}?fields=summary",
                        issue["id"].as_str().unwrap_or("")
                    ),
                    None,
                )
                .await?;
            self.check(&self.reference(&current)?)?;
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
        self.check(issue)?;
        let marker = format!("[Suplex task {task_id}]");
        let actor = self.actor().await?;
        let text = format!("{body}\n\n{marker}");
        let id_text = |row: &Value| match &row["id"] {
            Value::String(id) => id.clone(),
            other => other.to_string(),
        };
        let owned = self
            .comments(issue)
            .await?
            .into_iter()
            .filter(|row| Self::owned(row, &actor))
            .collect::<Vec<_>>();
        let existing = owned
            .iter()
            .find(|row| Some(id_text(row).as_str()) == known_comment_id)
            .or_else(|| {
                owned.iter().find(|row| {
                    let value = issue_text(&row["body"]);
                    value == text
                        || (value.starts_with("## What changed\n\n")
                            && value.ends_with(&format!("\n\n{marker}"))
                            && EVIDENCE_SHAPE.is_match(&value))
                })
            });
        if let Some(existing) = existing
            && issue_text(&existing["body"]) == text
        {
            return Ok(id_text(existing));
        }
        let id = if issue["kind"] == "github" {
            let repository = issue["repository"].as_str().unwrap_or("");
            let (path, method) = match existing {
                Some(existing) => (
                    format!("repos/{repository}/issues/comments/{}", id_text(existing)),
                    "PATCH",
                ),
                None => (
                    format!("repos/{repository}/issues/{}/comments", issue["number"]),
                    "POST",
                ),
            };
            self.before_mutation(issue, before_write).await?;
            id_text(
                &self
                    .github_json(&path, Some((method, &json!({"body": text}))))
                    .await?,
            )
        } else {
            let path = format!(
                "/rest/api/3/issue/{}/comment{}",
                issue["id"].as_str().unwrap_or(""),
                existing
                    .map(|row| format!("/{}", id_text(row)))
                    .unwrap_or_default()
            );
            self.before_mutation(issue, before_write).await?;
            let method = if existing.is_some() { "PUT" } else { "POST" };
            id_text(
                &self
                    .jira_json(
                        &path,
                        Some((method, &json!({"body": jira_evidence_document(&text)}))),
                    )
                    .await?,
            )
        };
        let observed = self
            .comments(issue)
            .await?
            .into_iter()
            .find(|row| id_text(row) == id && Self::owned(row, &actor));
        if observed.is_none_or(|row| issue_text(&row["body"]) != text) {
            return Err(fail(
                "The tracker has not confirmed the issue evidence comment",
            ));
        }
        Ok(id)
    }
}

fn attachment_id(file: &Value) -> String {
    match &file["id"] {
        Value::String(id) => id.clone(),
        other => other.to_string(),
    }
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
}
