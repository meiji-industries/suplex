use super::*;
use crate::integrations::provider_http::{self, id_text, lenient, missing_id, optional_metadata};
use crate::shared::hash::sha256_hex;
use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

static HTTPS_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"https://[^\s<>()]+").expect("valid regex"));

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

/// A Jira issue comment.
#[derive(Deserialize)]
struct Comment {
    #[serde(default = "missing_id", deserialize_with = "id_text")]
    id: String,
    #[serde(default)]
    body: Value,
    #[serde(default, deserialize_with = "optional_metadata")]
    author: Option<JiraAccount>,
}

impl Comment {
    fn owned(&self, actor: &str) -> bool {
        self.author
            .as_ref()
            .and_then(|author| author.account_id.as_deref())
            == Some(actor)
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
struct JiraSearch {
    issues: Vec<JiraIssue>,
}

pub struct JiraTracker {
    site: String,
    project: String,
    email_environment: String,
    token_environment: String,
    http: reqwest::Client,
}

impl JiraTracker {
    pub(super) fn new(connection: &Value) -> Self {
        let connection: super::Connection =
            serde_json::from_value(connection.clone()).unwrap_or_default();
        Self {
            site: connection.site,
            project: connection.project,
            email_environment: connection.email_environment,
            token_environment: connection.token_environment,
            http: provider_http::client(),
        }
    }

    fn jira_credentials(&self) -> TrackerResult<(String, String)> {
        let email = environment_credential(&self.email_environment)?;
        let token = environment_credential(&self.token_environment)?;
        Ok((
            origin(&self.site)?,
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

    /// The authenticated Jira account.
    async fn actor(&self) -> TrackerResult<String> {
        let myself: JiraAccount = self
            .jira_read("/rest/api/3/myself", "Jira account is malformed")
            .await?;
        myself
            .account_id
            .ok_or_else(|| fail("Jira account is malformed"))
    }

    /// TypeScript `reference`: a validated Jira issue association.
    fn reference(&self, row: &JiraIssue) -> TrackerResult<JiraReference> {
        let site = origin(&self.site)?;
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
    pub(super) fn check(&self, issue: &Value) -> TrackerResult<IssueRef> {
        let issue = IssueRef::deserialize(issue).unwrap_or_default();
        self.in_scope(&issue)?;
        Ok(issue)
    }

    fn in_scope(&self, issue: &IssueRef) -> TrackerResult<()> {
        if issue.kind == "jira"
            && origin(&issue.site).ok() == origin(&self.site).ok()
            && issue.key.starts_with(&format!("{}-", self.project))
        {
            Ok(())
        } else {
            Err(Box::new(IssueTrackerScopeFailure))
        }
    }

    pub async fn search(&self, query: &str) -> TrackerResult<Vec<Value>> {
        let text = query.trim().chars().take(200).collect::<String>();
        let project = &self.project;
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
        for _ in 0..100 {
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
        Err(fail("The issue has more comments than Suplex can load"))
    }

    /// TypeScript `read`: the current issue identity and a bounded text snapshot.
    pub async fn read(&self, issue: &Value) -> TrackerResult<Value> {
        let reference = self.check(issue)?;
        let comments = self.comments(&reference).await?;
        let (current, detail) = self.read_jira(&reference).await?;
        let heading = format!("{}: {}\n{}", current.key, current.title, current.url);
        let text = cap_context(format!(
            "{heading}\n\n{detail}\n\nComments\n{}",
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
                    );
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

    /// TypeScript `upload`: a hash-named evidence file on the tracker.
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
        self.jira_issue(&issue.id, "fields=summary").await?;
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
        self.before_mutation(&issue, before_write).await?;
        let path = format!(
            "/rest/api/3/issue/{}/comment{}",
            issue.id,
            existing.map(|id| format!("/{id}")).unwrap_or_default()
        );
        let method = if existing.is_some() { "PUT" } else { "POST" };
        let written = self
            .jira_json(
                &path,
                Some((method, &json!({"body":jira_evidence_document(&text)}))),
            )
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
}

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

#[cfg(test)]
mod tests {
    use super::super::*;
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
