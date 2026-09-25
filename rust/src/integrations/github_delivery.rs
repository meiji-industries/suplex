//! GitHub pull request delivery through the REST and GraphQL APIs.
//! Ports `integrations/github/{delivery,failure,issues,pull-request-states}.ts`.
//! GitHub is observed through `octocrab`; Git through `git2`.

use std::{error::Error, fmt, path::Path, sync::LazyLock, time::Duration};

use chrono::{DateTime, SecondsFormat, Utc};
use git2::{PushOptions, Repository};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};

use super::github::Access;
use crate::{
    platform::redaction,
    tasks::worktree::{self, LocalRevisionObservation},
};

static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40,64}$").unwrap());
static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9][a-z0-9_.-]{0,99}$").unwrap()
});
static PROVIDER_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,})\b").unwrap()
});
static RATE_LIMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)rate limit|secondary rate|abuse").unwrap());

pub fn valid_sha(value: &str) -> bool {
    SHA.is_match(value)
}

/// TypeScript `GithubReleaseFailure`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubFailure {
    pub code: &'static str,
    pub summary: String,
    pub retry_at: Option<String>,
}

impl fmt::Display for GithubFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.summary)
    }
}

impl Error for GithubFailure {}

pub type GithubResult<T> = Result<T, GithubFailure>;

pub fn failure(code: &'static str, summary: impl Into<String>) -> GithubFailure {
    GithubFailure {
        code,
        summary: summary.into(),
        retry_at: None,
    }
}

fn redact_summary(summary: &str) -> String {
    let line = summary.lines().next().unwrap_or("");
    let line = line.chars().take(200).collect::<String>();
    PROVIDER_TOKEN
        .replace_all(&redaction::command_output(&line), "[redacted]")
        .into_owned()
}

fn normalize_repository(value: &str) -> GithubResult<String> {
    let value = value.trim().to_lowercase();
    if !REPOSITORY.is_match(&value) {
        return Err(failure("wrong-remote", "Repository identity is invalid"));
    }
    Ok(value)
}

/// Percent-encode each segment as a GitHub REST path.
fn route(segments: &[&str]) -> String {
    let mut url = url::Url::parse("https://api.github.com").expect("static URL");
    url.path_segments_mut().expect("base URL").extend(segments);
    url.path().to_owned()
}

fn repo_route(repository: &str, tail: &[&str]) -> String {
    let mut segments = vec!["repos"];
    segments.extend(repository.split('/'));
    segments.extend(tail);
    route(&segments)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub repository: String,
    pub head_branch: String,
    pub base_branch: String,
    pub head_sha: String,
    pub base_sha: String,
    pub is_draft: bool,
    pub state: String,
    pub merged_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_merge_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_cross_repository: Option<bool>,
    #[serde(skip)]
    pub node_id: Option<String>,
}

impl PullRequest {
    /// TypeScript `pullReference`.
    pub fn reference(&self) -> Value {
        json!({
            "repository": self.repository, "number": self.number, "url": self.url,
            "headSha": self.head_sha, "state": self.state, "mergedAt": self.merged_at,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Checks {
    pub total: u64,
    pub pending: u64,
    pub failing: u64,
    pub successful: u64,
    pub runs: Vec<Value>,
}

/// TypeScript `GithubPullRequestObservation`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub exists: bool,
    pub number: Option<u64>,
    pub url: Option<String>,
    pub state: Option<String>,
    pub is_draft: Option<bool>,
    pub head_sha: Option<String>,
    pub base_sha: Option<String>,
    pub mergeable: Option<String>,
    pub merge_state_status: Option<String>,
    pub checks: Checks,
    pub author: Option<Value>,
    pub changed_files: Option<u64>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub auto_merge_enabled: Option<bool>,
    pub review_decision: Option<String>,
}

impl Observation {
    pub fn absent() -> Self {
        Self::default()
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("observation serializes")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeResult {
    Merged {
        sha: String,
    },
    NotMerged,
    Disposition {
        disposition: &'static str,
        message: String,
    },
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn nonempty_bounded(value: &Value, key: &str) -> Option<String> {
    string(value, key).filter(|text| (1..=256).contains(&text.chars().count()))
}

fn sha(value: &Value, key: &str) -> Option<String> {
    string(value, key).filter(|text| valid_sha(text))
}

fn web_url(value: &Value, key: &str) -> Option<String> {
    string(value, key).filter(|text| url::Url::parse(text).is_ok())
}

fn positive(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64).filter(|n| *n > 0)
}

fn iso_datetime(value: &Value, key: &str) -> Option<Option<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) if DateTime::parse_from_rfc3339(text).is_ok() => {
            Some(Some(text.clone()))
        }
        _ => None,
    }
}

/// TypeScript `normalizeGithubPull` for a REST pull request object.
pub fn normalize_pull(value: &Value) -> GithubResult<PullRequest> {
    let malformed = || {
        failure(
            "invalid-provider-response",
            "GitHub pull request response is malformed",
        )
    };
    let side = |key: &str| -> Option<(String, String, String)> {
        let side = value.get(key)?;
        let repository = side.get("repo")?.get("full_name")?.as_str()?;
        if !REPOSITORY.is_match(repository) {
            return None;
        }
        Some((
            nonempty_bounded(side, "ref")?,
            sha(side, "sha")?,
            repository.to_lowercase(),
        ))
    };
    let number = positive(value, "number").ok_or_else(malformed)?;
    let url = web_url(value, "html_url").ok_or_else(malformed)?;
    let state = string(value, "state")
        .filter(|state| state == "open" || state == "closed")
        .ok_or_else(malformed)?;
    let draft = value
        .get("draft")
        .and_then(Value::as_bool)
        .ok_or_else(malformed)?;
    let merged_at = iso_datetime(value, "merged_at").ok_or_else(malformed)?;
    let (head_branch, head_sha, head_repository) = side("head").ok_or_else(malformed)?;
    let (base_branch, base_sha, base_repository) = side("base").ok_or_else(malformed)?;
    if value.get("title").is_some_and(|title| !title.is_string())
        || value
            .get("body")
            .is_some_and(|body| !body.is_string() && !body.is_null())
    {
        return Err(malformed());
    }
    let state = if state == "closed" && merged_at.is_some() {
        "merged".to_owned()
    } else {
        state
    };
    Ok(PullRequest {
        number,
        url,
        is_cross_repository: Some(head_repository != base_repository),
        repository: head_repository,
        head_branch,
        base_branch,
        head_sha,
        base_sha,
        is_draft: draft,
        state,
        merged_at,
        auto_merge_enabled: value
            .get("auto_merge")
            .is_some_and(|auto| auto.is_object())
            .then_some(true),
        title: string(value, "title"),
        body: value
            .get("body")
            .map(|body| body.as_str().unwrap_or("").to_owned()),
        author: value
            .get("user")
            .and_then(|user| user.get("login"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        updated_at: string(value, "updated_at"),
        node_id: string(value, "node_id"),
    })
}

fn check_timestamp(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .filter(|time| time.timestamp_millis() > 0)
        .map_or(Value::Null, |time| {
            json!(
                time.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            )
        })
}

/// TypeScript `summarizeChecks`: the latest run per name, in first-seen order.
fn summarize_checks(checks: Option<&Vec<Value>>) -> Checks {
    let mut latest: Vec<(String, Value, Option<String>)> = Vec::new();
    for (index, check) in checks.into_iter().flatten().enumerate() {
        let name = string(check, "name")
            .or_else(|| string(check, "context"))
            .unwrap_or_else(|| index.to_string());
        let completed_at = string(check, "completedAt").or_else(|| string(check, "startedAt"));
        match latest.iter_mut().find(|(known, _, _)| *known == name) {
            None => latest.push((name, check.clone(), completed_at)),
            Some(previous) => {
                let newer = match (&completed_at, &previous.2) {
                    (Some(current), Some(before)) => current >= before,
                    (Some(_), None) => true,
                    (None, None) => true,
                    (None, Some(_)) => false,
                };
                if newer {
                    previous.1 = check.clone();
                    previous.2 = completed_at;
                }
            }
        }
    }
    let mut summary = Checks::default();
    for (name, check, _) in latest {
        summary.total += 1;
        let conclusion = string(&check, "conclusion");
        let status = match check.get("status") {
            None => match check.get("state").and_then(Value::as_str) {
                Some("SUCCESS") => "successful",
                Some("FAILURE" | "ERROR") => "failing",
                _ => "pending",
            },
            Some(status) if status != "COMPLETED" => "pending",
            _ if matches!(
                conclusion.as_deref(),
                Some("SUCCESS" | "NEUTRAL" | "SKIPPED")
            ) =>
            {
                "successful"
            }
            _ => "failing",
        };
        match status {
            "successful" => summary.successful += 1,
            "failing" => summary.failing += 1,
            _ => summary.pending += 1,
        }
        let link = check
            .get("detailsUrl")
            .filter(|value| !value.is_null())
            .or_else(|| check.get("targetUrl"))
            .and_then(Value::as_str)
            .filter(|text| url::Url::parse(text).is_ok());
        let mut run = serde_json::Map::new();
        run.insert("name".into(), json!(name));
        run.insert("status".into(), json!(status));
        run.insert("url".into(), json!(link));
        if let Some(conclusion) = conclusion.filter(|text| !text.is_empty()) {
            run.insert("conclusion".into(), json!(conclusion));
        }
        run.insert(
            "workflow".into(),
            json!(string(&check, "workflowName").filter(|text| !text.is_empty())),
        );
        run.insert(
            "startedAt".into(),
            check_timestamp(check.get("startedAt").unwrap_or(&Value::Null)),
        );
        run.insert(
            "completedAt".into(),
            check_timestamp(check.get("completedAt").unwrap_or(&Value::Null)),
        );
        summary.runs.push(Value::Object(run));
    }
    summary
}

/// TypeScript `mapGithubPullRequestObservation` for the `gh pr view` shape.
pub fn map_observation(value: &Value) -> GithubResult<Observation> {
    let malformed = || {
        failure(
            "invalid-provider-response",
            "GitHub pull request observation is malformed",
        )
    };
    let nullable_string = |key: &str| -> Option<Option<String>> {
        match value.get(key) {
            Some(Value::Null) => Some(None),
            Some(Value::String(text)) => Some(Some(text.clone())),
            _ => None,
        }
    };
    let count = |key: &str| value.get(key).and_then(Value::as_u64);
    let state = string(value, "state")
        .filter(|state| matches!(state.as_str(), "OPEN" | "CLOSED" | "MERGED"))
        .ok_or_else(malformed)?;
    let author = match value.get("author") {
        Some(Value::Null) => None,
        Some(author) => {
            let login = string(author, "login")
                .filter(|login| !login.is_empty())
                .ok_or_else(malformed)?;
            let avatar = string(author, "avatarUrl")
                .unwrap_or_else(|| format!("https://avatars.githubusercontent.com/{login}"));
            Some(json!({"login": login, "avatarUrl": avatar}))
        }
        None => return Err(malformed()),
    };
    let rollup = match value.get("statusCheckRollup") {
        Some(Value::Array(rows)) if rows.iter().all(Value::is_object) => Some(rows),
        Some(Value::Null) => None,
        _ => return Err(malformed()),
    };
    if !value
        .get("autoMergeRequest")
        .is_some_and(|auto| auto.is_null() || auto.is_object())
    {
        return Err(malformed());
    }
    let merge_state_status = match value.get("mergeStateStatus") {
        None => None,
        Some(_) => nullable_string("mergeStateStatus").ok_or_else(malformed)?,
    };
    Ok(Observation {
        exists: true,
        number: Some(positive(value, "number").ok_or_else(malformed)?),
        url: Some(web_url(value, "url").ok_or_else(malformed)?),
        state: Some(state.to_lowercase()),
        is_draft: Some(
            value
                .get("isDraft")
                .and_then(Value::as_bool)
                .ok_or_else(malformed)?,
        ),
        head_sha: Some(sha(value, "headRefOid").ok_or_else(malformed)?),
        base_sha: Some(sha(value, "baseRefOid").ok_or_else(malformed)?),
        mergeable: nullable_string("mergeable").ok_or_else(malformed)?,
        merge_state_status,
        checks: summarize_checks(rollup),
        author,
        changed_files: Some(count("changedFiles").ok_or_else(malformed)?),
        additions: Some(count("additions").ok_or_else(malformed)?),
        deletions: Some(count("deletions").ok_or_else(malformed)?),
        auto_merge_enabled: Some(!value["autoMergeRequest"].is_null()),
        review_decision: nullable_string("reviewDecision").ok_or_else(malformed)?,
    })
}

/// A pull request list row in the `gh pr list --json` shape.
fn list_row(repository: &str, row: &Value) -> Option<PullRequest> {
    let state = string(row, "state")
        .filter(|state| matches!(state.as_str(), "OPEN" | "CLOSED" | "MERGED"))?;
    let text_or_empty = |key: &str| match row.get(key) {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    };
    let updated_at = match row.get("updatedAt") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if DateTime::parse_from_rfc3339(text).is_ok() => {
            Some(text.clone())
        }
        _ => return None,
    };
    Some(PullRequest {
        number: positive(row, "number")?,
        url: web_url(row, "url")?,
        repository: repository.to_owned(),
        head_branch: nonempty_bounded(row, "headRefName")?,
        base_branch: nonempty_bounded(row, "baseRefName")?,
        head_sha: sha(row, "headRefOid")?,
        base_sha: sha(row, "baseRefOid")?,
        is_draft: row.get("isDraft")?.as_bool()?,
        state: state.to_lowercase(),
        merged_at: None,
        auto_merge_enabled: None,
        title: Some(text_or_empty("title")?),
        body: Some(text_or_empty("body")?),
        author: Some(
            row.get("author")
                .and_then(|author| author.get("login"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
        updated_at,
        is_cross_repository: Some(row.get("isCrossRepository")?.as_bool()?),
        node_id: None,
    })
}

const PULL_LIST_FIELDS: &str = "number url isDraft state headRefName headRefOid baseRefName baseRefOid title body author { login } updatedAt isCrossRepository";

/// The `gh pr view` observation fields, with the latest commit's check rollup.
const OBSERVATION_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url state isDraft headRefOid baseRefOid mergeable mergeStateStatus autoMergeRequest{enabledAt} reviewDecision author{login avatarUrl} changedFiles additions deletions title commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on StatusContext{context state targetUrl startedAt:createdAt} ...on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{workflowRun{workflow{name}}}}}}}}}}}}}";

/// Flatten GraphQL check contexts to the `gh pr view --json statusCheckRollup` shape.
fn flatten_rollup(pull: &mut Value) {
    let contexts = pull["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"]
        .as_array()
        .cloned();
    let rollup = contexts.map(|rows| {
        rows.into_iter()
            .map(|mut row| {
                if let Some(name) = row["checkSuite"]["workflowRun"]["workflow"]["name"].as_str() {
                    row["workflowName"] = json!(name);
                }
                if let Some(object) = row.as_object_mut() {
                    object.remove("checkSuite");
                    object.remove("__typename");
                }
                row
            })
            .collect::<Vec<_>>()
    });
    if let Some(object) = pull.as_object_mut() {
        object.remove("commits");
        object.insert(
            "statusCheckRollup".into(),
            rollup.map_or(Value::Array(Vec::new()), Value::Array),
        );
    }
}

struct Reply {
    status: u16,
    reset: Option<i64>,
    body: String,
}

enum Api {
    Value(Value),
    NotFound,
    Accepted { message: String },
}

fn parse_json(body: &str) -> GithubResult<Value> {
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(body)
        .map_err(|_| failure("invalid-provider-response", "GitHub returned invalid JSON"))
}

fn diagnostic(body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| string(&value, "message"))
        .unwrap_or_default();
    redact_summary(&message)
}

pub struct Github {
    access: Access,
    pub retry_pauses: Vec<Duration>,
}

impl Github {
    pub fn new(access: Access) -> Self {
        Self {
            access,
            retry_pauses: vec![Duration::from_secs(2), Duration::from_secs(6)],
        }
    }

    pub async fn load() -> GithubResult<Self> {
        let access = Access::load().await.map_err(|error| {
            failure(
                "authentication-required",
                format!(
                    "GitHub CLI authentication is unavailable: {}",
                    redact_summary(&error.to_string())
                ),
            )
        })?;
        Ok(Self::new(access))
    }

    pub fn token(&self) -> Option<&str> {
        self.access.token()
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        operation: &str,
    ) -> GithubResult<Reply> {
        let client = self.access.client();
        let response = match method {
            "POST" => client._post(path, body).await,
            "PATCH" => client._patch(path, body).await,
            "PUT" => client._put(path, body).await,
            _ => client._get(path).await,
        }
        .map_err(|error| {
            failure(
                "provider-unavailable",
                redact_summary(&format!("{operation} failed: {error}")),
            )
        })?;
        let status = response.status().as_u16();
        let reset = response
            .headers()
            .get("x-ratelimit-reset")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        let body = client.body_to_string(response).await.map_err(|error| {
            failure(
                "provider-unavailable",
                redact_summary(&format!("{operation} failed: {error}")),
            )
        })?;
        Ok(Reply {
            status,
            reset,
            body,
        })
    }

    /// One GitHub REST request with its HTTP status, for callers that own status handling.
    pub(crate) async fn raw(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> GithubResult<(u16, String)> {
        let reply = self.send(method, path, body, "GitHub request").await?;
        Ok((reply.status, reply.body))
    }

    /// One GET with the `api` failure classes, for the trigger inspection port.
    pub(crate) async fn get_json(&self, path: &str, operation: &str) -> GithubResult<Value> {
        self.value("GET", path, None, operation).await
    }

    /// TypeScript `api`: one GitHub request with the source's failure classes.
    #[allow(clippy::too_many_arguments)]
    async fn api(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        operation: &str,
        allow_not_found: bool,
        not_found_summary: Option<&str>,
        accepted: &[u16],
    ) -> GithubResult<Api> {
        let reply = self.send(method, path, body, operation).await?;
        if (200..300).contains(&reply.status) {
            return parse_json(&reply.body).map(Api::Value);
        }
        let diagnostic = diagnostic(&reply.body);
        if accepted.contains(&reply.status) {
            return Ok(Api::Accepted {
                message: if diagnostic.is_empty() {
                    format!("GitHub refused the request with HTTP {}", reply.status)
                } else {
                    diagnostic
                },
            });
        }
        if reply.status == 404 {
            if allow_not_found {
                return Ok(Api::NotFound);
            }
            return Err(failure(
                "provider-unavailable",
                not_found_summary.unwrap_or("GitHub resource was not found or is inaccessible"),
            ));
        }
        let or = |fallback: String| {
            if diagnostic.is_empty() {
                fallback
            } else {
                diagnostic.clone()
            }
        };
        if reply.status == 429 || (reply.status == 403 && RATE_LIMIT.is_match(&reply.body)) {
            let retry_at = reply
                .reset
                .and_then(|reset| DateTime::from_timestamp(reset, 0))
                .filter(|time| *time > Utc::now())
                .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true));
            return Err(GithubFailure {
                code: "provider-rate-limited",
                summary: or("GitHub limited requests".into()),
                retry_at,
            });
        }
        if reply.status == 401 {
            return Err(failure(
                "authentication-required",
                format!(
                    "GitHub CLI authentication is unavailable: {}",
                    or("sign in with gh auth login".into())
                ),
            ));
        }
        if reply.status == 403 {
            return Err(failure(
                "authentication-required",
                format!(
                    "GitHub denied access to this repository or token permission: {}",
                    or("HTTP 403".into())
                ),
            ));
        }
        Err(failure(
            "provider-unavailable",
            or(format!("{operation} failed: HTTP {}", reply.status)),
        ))
    }

    async fn value(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        operation: &str,
    ) -> GithubResult<Value> {
        match self
            .api(method, path, body, operation, false, None, &[])
            .await?
        {
            Api::Value(value) => Ok(value),
            _ => Err(failure("provider-unavailable", operation.to_owned())),
        }
    }

    /// POST one GraphQL document. A response with errors and no data fails.
    async fn graphql(&self, query: &str, variables: Value, operation: &str) -> GithubResult<Value> {
        let body = json!({"query": query, "variables": variables});
        let value = self
            .value("POST", "/graphql", Some(&body), operation)
            .await?;
        let errors = value["errors"]
            .as_array()
            .filter(|errors| !errors.is_empty());
        if let Some(errors) = errors
            && value["data"].is_null()
        {
            return Err(failure(
                "provider-unavailable",
                redact_summary(errors[0]["message"].as_str().unwrap_or(operation)),
            ));
        }
        Ok(value)
    }

    async fn retry_transient<T, F, Fut>(&self, mut observe: F) -> GithubResult<T>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = GithubResult<T>>,
    {
        let mut attempt = 0;
        loop {
            match observe().await {
                Err(error) if error.code == "provider-unavailable" => {
                    let Some(pause) = self.retry_pauses.get(attempt) else {
                        return Err(error);
                    };
                    tokio::time::sleep(*pause).await;
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    pub async fn get_branch_head(
        &self,
        repository: &str,
        branch: &str,
    ) -> GithubResult<Option<String>> {
        let path = repo_route(repository, &["branches", branch]);
        match self
            .api("GET", &path, None, "branch observation", true, None, &[])
            .await?
        {
            Api::NotFound => Ok(None),
            Api::Value(value) => sha(&value["commit"], "sha").map(Some).ok_or_else(|| {
                failure(
                    "invalid-provider-response",
                    "GitHub branch response is malformed",
                )
            }),
            Api::Accepted { .. } => unreachable!("no accepted statuses"),
        }
    }

    pub async fn get_pull_request(
        &self,
        repository: &str,
        number: u64,
    ) -> GithubResult<PullRequest> {
        let path = repo_route(repository, &["pulls", &number.to_string()]);
        normalize_pull(
            &self
                .value("GET", &path, None, "pull request observation")
                .await?,
        )
    }

    pub async fn create_draft_pull_request(
        &self,
        repository: &str,
        head_branch: &str,
        base_branch: &str,
        title: &str,
        body: &str,
    ) -> GithubResult<PullRequest> {
        let request = json!({"title": title, "head": head_branch, "base": base_branch, "body": body, "draft": true});
        let summary = format!("Branch {head_branch} is not on GitHub yet");
        match self
            .api(
                "POST",
                &repo_route(repository, &["pulls"]),
                Some(&request),
                "draft pull request creation",
                false,
                Some(&summary),
                &[],
            )
            .await?
        {
            Api::Value(value) => normalize_pull(&value),
            _ => Err(failure("provider-unavailable", summary)),
        }
    }

    pub async fn update_draft_pull_request(
        &self,
        repository: &str,
        number: u64,
        title: &str,
        body: &str,
    ) -> GithubResult<PullRequest> {
        let value = self
            .value(
                "PATCH",
                &repo_route(repository, &["pulls", &number.to_string()]),
                Some(&json!({"title": title, "body": body})),
                "draft pull request metadata update",
            )
            .await?;
        let pull = normalize_pull(&value);
        match pull {
            Ok(pull)
                if value["title"].as_str() == Some(title)
                    && value["body"].as_str() == Some(body) =>
            {
                Ok(pull)
            }
            _ => Err(failure(
                "invalid-provider-response",
                "GitHub did not confirm the updated pull request metadata",
            )),
        }
    }

    async fn pull_list(
        &self,
        repository: &str,
        filter: &str,
        variables: Value,
    ) -> GithubResult<Vec<PullRequest>> {
        let repository = normalize_repository(repository)?;
        let (owner, name) = repository.split_once('/').expect("normalized repository");
        let query = format!(
            "query($owner:String!,$name:String!{}){{repository(owner:$owner,name:$name){{pullRequests({filter}){{nodes{{{PULL_LIST_FIELDS}}}}}}}}}",
            if filter.contains("$head") {
                ",$head:String!,$first:Int!"
            } else {
                ",$first:Int!"
            }
        );
        let mut variables = variables;
        variables["owner"] = json!(owner);
        variables["name"] = json!(name);
        let value = self.graphql(&query, variables, "pull request list").await?;
        let rows = value["data"]["repository"]["pullRequests"]["nodes"]
            .as_array()
            .ok_or_else(|| {
                failure(
                    "invalid-provider-response",
                    "GitHub pull request list could not be parsed",
                )
            })?;
        rows.iter()
            .map(|row| list_row(&repository, row))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                failure(
                    "invalid-provider-response",
                    "GitHub pull request list could not be parsed",
                )
            })
    }

    /// TypeScript `listPullRequests` (`gh pr list --head <branch> --state all`).
    pub async fn list_pull_requests(
        &self,
        repository: &str,
        head_branch: &str,
    ) -> GithubResult<Vec<PullRequest>> {
        self.pull_list(
            repository,
            "headRefName:$head,states:[OPEN,CLOSED,MERGED],first:$first,orderBy:{field:CREATED_AT,direction:DESC}",
            json!({"head": head_branch, "first": 100}),
        )
        .await
    }

    pub async fn list_open_pull_requests(
        &self,
        repository: &str,
        limit: u64,
    ) -> GithubResult<Vec<PullRequest>> {
        self.pull_list(
            repository,
            "states:[OPEN],first:$first,orderBy:{field:CREATED_AT,direction:DESC}",
            json!({"first": limit.clamp(1, 100)}),
        )
        .await
    }

    /// TypeScript `observePullRequest` (`gh pr view --json ...`).
    pub async fn observe_pull_request(
        &self,
        repository: &str,
        branch: &str,
        number: Option<u64>,
    ) -> GithubResult<Observation> {
        let number = match number {
            Some(number) => number,
            None => match self.list_pull_requests(repository, branch).await?.first() {
                Some(pull) => pull.number,
                None => return Ok(Observation::absent()),
            },
        };
        let (owner, name) = repository
            .split_once('/')
            .ok_or_else(|| failure("wrong-remote", "Repository identity is invalid"))?;
        let value = self
            .graphql(
                OBSERVATION_QUERY,
                json!({"owner": owner, "name": name, "number": number}),
                "pull request observation",
            )
            .await;
        let value = match value {
            Ok(value) => value,
            Err(error) if error.summary.to_lowercase().contains("could not resolve") => {
                return Ok(Observation::absent());
            }
            Err(error) => return Err(error),
        };
        let mut pull = value["data"]["repository"]["pullRequest"].clone();
        if pull.is_null() {
            return Ok(Observation::absent());
        }
        flatten_rollup(&mut pull);
        map_observation(&pull)
    }

    pub async fn mark_ready_for_review(&self, repository: &str, number: u64) -> GithubResult<()> {
        let current = self.get_pull_request(repository, number).await?;
        if current.state != "open" {
            return Err(failure(
                "provider-unavailable",
                "Pull request is no longer open",
            ));
        }
        if !current.is_draft {
            return Ok(());
        }
        let id = current.node_id.ok_or_else(|| {
            failure(
                "invalid-provider-response",
                "GitHub pull request response is malformed",
            )
        })?;
        self.graphql(
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
            json!({"id": id}),
            "mark ready for review",
        )
        .await?;
        Ok(())
    }

    async fn merge_context(&self, repository: &str, number: u64) -> GithubResult<Value> {
        let (owner, name) = repository.split_once('/').expect("normalized repository");
        let value = self
            .graphql(
                "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid baseRefName mergeable mergeStateStatus}}}",
                json!({"owner": owner, "name": name, "number": number}),
                "pull request merge observation",
            )
            .await?;
        let context = value["data"]["repository"]["pullRequest"].clone();
        if string(&context, "id").is_none_or(|id| id.is_empty())
            || sha(&context, "headRefOid").is_none()
            || string(&context, "baseRefName").is_none_or(|name| name.is_empty())
        {
            return Err(failure(
                "invalid-provider-response",
                "GitHub pull request merge observation is malformed",
            ));
        }
        Ok(context)
    }

    /// `gh pr checks --required`: required checks of the head commit in gh buckets.
    async fn required_checks(&self, repository: &str, number: u64) -> GithubResult<Vec<Value>> {
        let (owner, name) = repository.split_once('/').expect("normalized repository");
        let value = self
            .graphql(
                "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)} ...on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)}}}}}}}}}}",
                json!({"owner": owner, "name": name, "number": number}),
                "required pull request checks",
            )
            .await?;
        let nodes = value["data"]["repository"]["pullRequest"]["commits"]["nodes"][0]["commit"]
            ["statusCheckRollup"]["contexts"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        Ok(nodes
            .into_iter()
            .filter(|node| node["isRequired"] == true)
            .map(|node| {
                let (name, state, link) = match node.get("context") {
                    Some(context) => (
                        context.as_str().unwrap_or("").to_owned(),
                        string(&node, "state").unwrap_or_default(),
                        string(&node, "targetUrl"),
                    ),
                    None => {
                        let status = string(&node, "status").unwrap_or_default();
                        let state = if status == "COMPLETED" {
                            string(&node, "conclusion").unwrap_or(status)
                        } else {
                            status
                        };
                        (
                            string(&node, "name").unwrap_or_default(),
                            state,
                            string(&node, "detailsUrl"),
                        )
                    }
                };
                let bucket = match state.as_str() {
                    "SUCCESS" | "NEUTRAL" => "pass",
                    "SKIPPED" => "skipping",
                    "CANCELLED" => "cancel",
                    "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
                    | "STALE" => "fail",
                    _ => "pending",
                };
                json!({"name": name, "bucket": bucket, "state": state, "link": link})
            })
            .collect())
    }

    /// TypeScript `mergeConditionally`: an exact-head REST merge, then evidence for a refusal.
    pub async fn merge_conditionally(
        &self,
        repository: &str,
        number: u64,
        head_sha: &str,
        allow_queue: bool,
    ) -> GithubResult<MergeResult> {
        if number < 1 || !valid_sha(head_sha) {
            return Err(failure(
                "invalid-provider-response",
                "The pull request merge input is invalid",
            ));
        }
        let repository = normalize_repository(repository)?;
        let settings = self
            .value(
                "GET",
                &repo_route(&repository, &[]),
                None,
                "repository settings",
            )
            .await?;
        let allowed = |key: &str| settings[key].as_bool();
        let (Some(squash), Some(merge), Some(rebase)) = (
            allowed("allow_squash_merge"),
            allowed("allow_merge_commit"),
            allowed("allow_rebase_merge"),
        ) else {
            return Err(failure(
                "invalid-provider-response",
                "GitHub repository settings are malformed",
            ));
        };
        let method = if squash {
            "squash"
        } else if merge {
            "merge"
        } else if rebase {
            "rebase"
        } else {
            return Err(failure(
                "provider-unavailable",
                "The repository does not allow a merge method",
            ));
        };
        let outcome = self
            .api(
                "PUT",
                &repo_route(&repository, &["pulls", &number.to_string(), "merge"]),
                Some(&json!({"sha": head_sha, "merge_method": method})),
                "conditional pull request merge",
                false,
                None,
                &[405],
            )
            .await?;
        let refused = match outcome {
            Api::Accepted { message } => message,
            Api::Value(value) => {
                let merged = value["merged"].as_bool();
                let sha = value["sha"].as_str().filter(|sha| valid_sha(sha));
                return match (merged, value["message"].is_string(), sha) {
                    (Some(true), true, Some(sha)) => Ok(MergeResult::Merged { sha: sha.into() }),
                    (Some(false), true, _) => Ok(MergeResult::NotMerged),
                    _ => Err(failure(
                        "invalid-provider-response",
                        "GitHub did not confirm the conditional merge result",
                    )),
                };
            }
            Api::NotFound => unreachable!("not found is a failure"),
        };
        let blocked = |message: String| MergeResult::Disposition {
            disposition: "blocked",
            message,
        };
        let context = self
            .retry_transient(|| self.merge_context(&repository, number))
            .await?;
        let head = context["headRefOid"].as_str().unwrap_or("");
        if head != head_sha {
            return Ok(blocked(format!(
                "GitHub refused the exact-head merge because the pull request head changed from {head_sha} to {head}. {refused}"
            )));
        }
        let checks = self
            .retry_transient(|| self.required_checks(&repository, number))
            .await?;
        let describe = |bucket: &[&str]| {
            checks
                .iter()
                .filter(|check| bucket.contains(&check["bucket"].as_str().unwrap_or("")))
                .map(|check| {
                    let link = check["link"]
                        .as_str()
                        .map(|link| format!(", {link}"))
                        .unwrap_or_default();
                    format!(
                        "{} ({}{link})",
                        check["name"].as_str().unwrap_or(""),
                        check["state"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
        };
        let failed = describe(&["fail", "cancel"]);
        if !failed.is_empty() {
            return Ok(blocked(format!(
                "GitHub refused the merge because required checks failed: {}. {refused}",
                failed.join(", ")
            )));
        }
        let pending = describe(&["pending"]);
        if !pending.is_empty() {
            return Ok(MergeResult::Disposition {
                disposition: "waiting",
                message: format!(
                    "GitHub is waiting for required checks: {}. {refused}",
                    pending.join(", ")
                ),
            });
        }
        let mergeable = context["mergeable"].as_str();
        let merge_state = context["mergeStateStatus"].as_str();
        if mergeable == Some("CONFLICTING") || merge_state == Some("DIRTY") {
            return Ok(blocked(format!(
                "GitHub refused the merge because the pull request has merge conflicts ({}/{}). {refused}",
                mergeable.unwrap_or("UNKNOWN"),
                merge_state.unwrap_or("UNKNOWN")
            )));
        }
        if mergeable == Some("UNKNOWN") {
            return Ok(MergeResult::Disposition {
                disposition: "waiting",
                message: format!("GitHub is still computing mergeability. {refused}"),
            });
        }
        let base = context["baseRefName"].as_str().unwrap_or("").to_owned();
        let rules_path = repo_route(&repository, &["rules", "branches", &base]);
        let rules = self
            .retry_transient(|| async {
                let value = self.value("GET", &rules_path, None, "branch rules").await?;
                value
                    .as_array()
                    .filter(|rules| rules.iter().all(|rule| rule["type"].is_string()))
                    .cloned()
                    .ok_or_else(|| {
                        failure(
                            "invalid-provider-response",
                            "GitHub branch rules are malformed",
                        )
                    })
            })
            .await?;
        if rules.iter().any(|rule| rule["type"] == "merge_queue") {
            if !allow_queue {
                return Ok(blocked(format!(
                    "GitHub requires a merge queue for {base}, but direct trigger merges cannot enter the queue."
                )));
            }
            let value = self
                .graphql(
                    "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid}){mergeQueueEntry{id}}}",
                    json!({"pullRequestId": context["id"], "expectedHeadOid": head_sha}),
                    "merge queue enqueue",
                )
                .await?;
            if value["data"]["enqueuePullRequest"]["mergeQueueEntry"]["id"]
                .as_str()
                .is_none_or(str::is_empty)
            {
                return Err(failure(
                    "invalid-provider-response",
                    "GitHub did not confirm the merge queue entry",
                ));
            }
            return Ok(MergeResult::Disposition {
                disposition: "queued",
                message: format!(
                    "GitHub added pull request {number} at {head_sha} to the merge queue."
                ),
            });
        }
        Ok(blocked(format!(
            "GitHub refused the merge with no pending required checks or merge queue: {refused}. Merge state is {}.",
            merge_state.unwrap_or("UNKNOWN")
        )))
    }

    /// TypeScript `readPullRequestStates`: batched GraphQL reads of 50 references.
    pub async fn pull_request_states(&self, inputs: &[(String, u64)]) -> GithubResult<Vec<Value>> {
        let mut unique: Vec<(String, u64)> = Vec::new();
        for (repository, number) in inputs {
            let valid = repository.split_once('/').is_some_and(|(owner, name)| {
                [owner, name].iter().all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
                })
            });
            if !valid || *number == 0 {
                return Err(failure(
                    "invalid-provider-response",
                    "Pull request identity is invalid",
                ));
            }
            let identity = (repository.to_lowercase(), *number);
            unique.retain(|known| *known != identity);
            unique.push(identity);
        }
        let mut result = Vec::new();
        for batch in unique.chunks(50) {
            let fields = batch
                .iter()
                .enumerate()
                .map(|(index, (repository, number))| {
                    let (owner, name) = repository.split_once('/').expect("validated");
                    format!(
                        "p{index}: repository(owner: {}, name: {}) {{ pullRequest(number: {number}) {{ number url headRefOid state mergedAt }} }}",
                        json!(owner),
                        json!(name)
                    )
                })
                .collect::<Vec<_>>()
                .join(" ");
            let body = json!({"query": format!("query {{ {fields} }}")});
            let reply = self
                .send(
                    "POST",
                    "/graphql",
                    Some(&body),
                    "pull request batch observation",
                )
                .await?;
            let value = parse_json(&reply.body)?;
            // A partial GraphQL error keeps every available observation.
            if !value["data"].is_object() {
                return Err(failure(
                    "provider-unavailable",
                    if diagnostic(&reply.body).is_empty() {
                        "pull request batch observation".to_owned()
                    } else {
                        diagnostic(&reply.body)
                    },
                ));
            }
            for (index, (repository, number)) in batch.iter().enumerate() {
                let pull = &value["data"][format!("p{index}")]["pullRequest"];
                if pull.is_null() {
                    continue;
                }
                let state = string(pull, "state")
                    .filter(|state| matches!(state.as_str(), "OPEN" | "CLOSED" | "MERGED"));
                let (Some(found), Some(url), Some(head), Some(state), Some(merged_at)) = (
                    positive(pull, "number"),
                    web_url(pull, "url"),
                    string(pull, "headRefOid").filter(|head| !head.is_empty()),
                    state,
                    iso_datetime(pull, "mergedAt"),
                ) else {
                    return Err(failure(
                        "invalid-provider-response",
                        "GitHub pull request states are malformed",
                    ));
                };
                if found != *number {
                    return Err(failure(
                        "invalid-provider-response",
                        "GitHub returned a different pull request number",
                    ));
                }
                result.push(json!({
                    "repository": repository, "number": found, "url": url,
                    "headSha": head, "state": state.to_lowercase(), "mergedAt": merged_at,
                }));
            }
        }
        Ok(result)
    }

    /// `gh issue list --state open --json number,url,title,body,author,state,labels,assignees,milestone,updatedAt`.
    pub async fn list_open_issues(&self, repository: &str, limit: u64) -> GithubResult<Vec<Value>> {
        let repository = normalize_repository(repository)?;
        let (owner, name) = repository.split_once('/').expect("normalized repository");
        let value = self
            .graphql(
                "query($owner:String!,$name:String!,$first:Int!){repository(owner:$owner,name:$name){issues(first:$first,states:[OPEN],orderBy:{field:CREATED_AT,direction:DESC}){nodes{number url title body author{login} state labels(first:100){nodes{name}} assignees(first:100){nodes{login}} milestone{title} updatedAt}}}}",
                json!({"owner": owner, "name": name, "first": limit.clamp(1, 100)}),
                "issue list",
            )
            .await?;
        value["data"]["repository"]["issues"]["nodes"]
            .as_array()
            .ok_or_else(|| {
                failure(
                    "invalid-provider-response",
                    "GitHub issue list is malformed",
                )
            })?
            .iter()
            .map(|node| {
                let mut issue = node.clone();
                issue["labels"] = node["labels"]["nodes"].clone();
                issue["assignees"] = node["assignees"]["nodes"].clone();
                valid_issue(&issue).then_some(issue).ok_or_else(|| {
                    failure(
                        "invalid-provider-response",
                        "GitHub issue list is malformed",
                    )
                })
            })
            .collect()
    }

    /// One issue with every comment page.
    pub async fn get_issue(&self, repository: &str, number: u64) -> GithubResult<Value> {
        let path = repo_route(repository, &["issues", &number.to_string()]);
        let row = self.value("GET", &path, None, "issue observation").await?;
        let text = |value: &Value| value.as_str().map(str::to_owned);
        let mut issue = json!({
            "number": row["number"], "url": row["html_url"], "title": row["title"],
            "body": text(&row["body"]).unwrap_or_default(),
            "author": row["user"]["login"].as_str().map(|login| json!({"login": login})),
            "state": row["state"].as_str().map(str::to_uppercase),
            "labels": row["labels"].as_array().map(|labels| labels.iter().map(|label| json!({"name": label["name"]})).collect::<Vec<_>>()),
            "assignees": row["assignees"].as_array().map(|users| users.iter().map(|user| json!({"login": user["login"]})).collect::<Vec<_>>()),
            "milestone": row["milestone"]["title"].as_str().map(|title| json!({"title": title})),
            "updatedAt": row["updated_at"],
        });
        if !valid_issue(&issue) {
            return Err(failure(
                "invalid-provider-response",
                "GitHub issue is malformed",
            ));
        }
        let mut comments = Vec::new();
        for page in 1.. {
            let path = format!("{path}/comments?per_page=100&page={page}");
            let rows = self.value("GET", &path, None, "issue comments").await?;
            let rows = rows
                .as_array()
                .filter(|rows| {
                    rows.iter().all(|row| {
                        web_url(row, "html_url").is_some()
                            && row["body"].is_string()
                            && (row["user"].is_null() || row["user"]["login"].is_string())
                            && row["created_at"].is_string()
                    })
                })
                .ok_or_else(|| {
                    failure(
                        "invalid-provider-response",
                        "GitHub issue comments are malformed",
                    )
                })?;
            comments.extend(rows.iter().map(|row| {
                json!({"html_url": row["html_url"], "body": row["body"], "user": if row["user"].is_null() { Value::Null } else { json!({"login": row["user"]["login"]}) }, "created_at": row["created_at"]})
            }));
            if rows.len() < 100 {
                break;
            }
        }
        issue["comments"] = Value::Array(comments);
        Ok(issue)
    }
}

fn valid_issue(issue: &Value) -> bool {
    positive(issue, "number").is_some()
        && web_url(issue, "url").is_some()
        && issue["title"].is_string()
        && issue["body"].is_string()
        && (issue["author"].is_null() || issue["author"]["login"].is_string())
        && matches!(issue["state"].as_str(), Some("OPEN" | "CLOSED"))
        && issue["labels"]
            .as_array()
            .is_some_and(|rows| rows.iter().all(|row| row["name"].is_string()))
        && issue["assignees"]
            .as_array()
            .is_some_and(|rows| rows.iter().all(|row| row["login"].is_string()))
        && (issue["milestone"].is_null() || issue["milestone"]["title"].is_string())
        && issue["updatedAt"].is_string()
}

/// TypeScript `issueContext`: the Markdown snapshot of one GitHub issue.
pub fn issue_context(issue: &Value) -> String {
    let login = |value: &Value| value["login"].as_str().unwrap_or("deleted user").to_owned();
    let list = |key: &str, field: &str| {
        let items = issue[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item[field].as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if items.is_empty() {
            "None".into()
        } else {
            items
        }
    };
    let mut parts = vec![
        format!(
            "## GitHub issue #{}: {}",
            issue["number"],
            issue["title"].as_str().unwrap_or("")
        ),
        issue["url"].as_str().unwrap_or("").to_owned(),
        format!(
            "Author: {} | State: {} | Updated: {}",
            login(&issue["author"]),
            issue["state"].as_str().unwrap_or(""),
            issue["updatedAt"].as_str().unwrap_or("")
        ),
        format!("Labels: {}", list("labels", "name")),
        format!("Assignees: {}", list("assignees", "login")),
        format!(
            "Milestone: {}",
            issue["milestone"]["title"].as_str().unwrap_or("None")
        ),
        issue["body"].as_str().unwrap_or("").to_owned(),
    ];
    for comment in issue["comments"].as_array().into_iter().flatten() {
        parts.push(format!(
            "### {} · {}\n{}\n\n{}",
            login(&comment["user"]),
            comment["created_at"].as_str().unwrap_or(""),
            comment["html_url"].as_str().unwrap_or(""),
            comment["body"].as_str().unwrap_or("")
        ));
    }
    parts.join("\n\n")
}

/// TypeScript `getRemoteRepository`: the configured origin identity. The
/// configured value is read, not a URL rewritten by `insteadOf`.
pub fn remote_repository(cwd: &Path) -> GithubResult<String> {
    let wrong = || failure("wrong-remote", "Git origin could not be inspected");
    let repository = Repository::open(cwd).map_err(|_| wrong())?;
    let config = repository.config().map_err(|_| wrong())?;
    let remote = config
        .get_string("remote.origin.url")
        .map_err(|_| wrong())?;
    let remote = remote.trim();
    let remote = remote.strip_suffix(".git").unwrap_or(remote);
    let lower = remote.to_ascii_lowercase();
    let path = ["git@github.com:", "https://github.com/"]
        .iter()
        .find_map(|prefix| lower.starts_with(prefix).then(|| &remote[prefix.len()..]))
        .filter(|path| {
            path.split_once('/').is_some_and(|(owner, name)| {
                !owner.is_empty() && !name.is_empty() && !name.contains('/')
            })
        })
        .ok_or_else(|| failure("wrong-remote", "Git origin is not a GitHub repository"))?;
    normalize_repository(path)
}

/// TypeScript `inspectLocalRevision`.
pub fn inspect_local_revision(cwd: &Path) -> GithubResult<LocalRevisionObservation> {
    worktree::observe_local_revision(cwd).map_err(|_| {
        failure(
            "local-revision-unavailable",
            "Local Git revision could not be inspected",
        )
    })
}

/// TypeScript `pushNormal`: a non-forced push of one commit to the task branch.
pub fn push_normal(
    cwd: &Path,
    branch: &str,
    head_sha: &str,
    token: Option<&str>,
) -> GithubResult<()> {
    if !valid_sha(head_sha) {
        return Err(failure(
            "invalid-provider-response",
            "The push commit is invalid",
        ));
    }
    let unavailable = |error: git2::Error| {
        failure(
            "provider-unavailable",
            redact_summary(&format!("normal push failed: {}", error.message())),
        )
    };
    let repository = Repository::open(cwd).map_err(unavailable)?;
    let mut origin =
        crate::projects::repository::origin_remote(&repository, git2::Direction::Push, token)
            .map_err(unavailable)?;
    let rejected = std::cell::RefCell::new(None::<String>);
    let mut callbacks = crate::projects::repository::remote_callbacks(token);
    callbacks.push_update_reference(|_reference, status| {
        if let Some(status) = status {
            *rejected.borrow_mut() = Some(status.to_owned());
        }
        Ok(())
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks);
    origin
        .push(
            &[format!("{head_sha}:refs/heads/{branch}")],
            Some(&mut options),
        )
        .map_err(unavailable)?;
    drop(options);
    if let Some(status) = rejected.into_inner() {
        return Err(failure(
            "provider-unavailable",
            redact_summary(&format!("normal push failed: {status}")),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_observations_retain_actionable_ci_names_and_log_links() {
        let observed = map_observation(&json!({
            "number": 7, "url": "https://github.com/owner/repo/pull/7", "state": "OPEN", "isDraft": false,
            "headRefOid": "a".repeat(40), "baseRefOid": "b".repeat(40), "mergeable": "MERGEABLE",
            "autoMergeRequest": null, "reviewDecision": null, "author": null, "changedFiles": 1,
            "additions": 1, "deletions": 0, "statusCheckRollup": [
                {"name":"unit","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/owner/repo/actions/runs/1","workflowName":"CI","startedAt":"2026-09-13T04:57:33Z","completedAt":"2026-09-13T04:58:33Z"},
                {"context":"deploy","state":"PENDING","targetUrl":"https://example.com/deploy"},
                {"name":"lint","status":"IN_PROGRESS","startedAt":"2026-09-13T04:57:33Z","completedAt":"0001-01-01T00:00:00Z"}
            ]
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&observed.checks).unwrap(),
            json!({"total":3,"pending":2,"failing":1,"successful":0,"runs":[
                {"name":"unit","status":"failing","url":"https://github.com/owner/repo/actions/runs/1","conclusion":"FAILURE","workflow":"CI","startedAt":"2026-09-13T04:57:33.000Z","completedAt":"2026-09-13T04:58:33.000Z"},
                {"name":"deploy","status":"pending","url":"https://example.com/deploy","workflow":null,"startedAt":null,"completedAt":null},
                {"name":"lint","status":"pending","url":null,"workflow":null,"startedAt":"2026-09-13T04:57:33.000Z","completedAt":null}
            ]})
        );
    }

    #[test]
    fn rest_pull_normalization_marks_merged_and_cross_repository() {
        let pull = normalize_pull(&json!({
            "number": 3, "html_url": "https://github.com/owner/repo/pull/3", "state": "closed", "draft": false,
            "merged_at": "2026-09-01T00:00:00Z", "auto_merge": null, "node_id": "PR_3",
            "head": {"ref":"task","sha":"a".repeat(40),"repo":{"full_name":"Fork/Repo"}},
            "base": {"ref":"main","sha":"b".repeat(40),"repo":{"full_name":"owner/repo"}},
            "title": "T", "body": null, "user": {"login":"octo"}
        }))
        .unwrap();
        assert_eq!(pull.state, "merged");
        assert_eq!(pull.repository, "fork/repo");
        assert_eq!(pull.is_cross_repository, Some(true));
        assert_eq!(pull.body.as_deref(), Some(""));
        assert_eq!(
            normalize_pull(&json!({"number": 3})).unwrap_err().code,
            "invalid-provider-response"
        );
    }

    #[test]
    fn issue_context_lists_every_comment() {
        let issue = json!({"number":42,"url":"https://github.com/owner/repo/issues/42","title":"Search","body":"","author":null,"state":"OPEN","labels":[],"assignees":[],"milestone":null,"updatedAt":"2026-09-07",
            "comments":[{"html_url":"https://github.com/owner/repo/issues/42#issuecomment-1","body":"Detail","user":null,"created_at":"2026-09-07"}]});
        let text = issue_context(&issue);
        assert!(text.starts_with("## GitHub issue #42: Search\n\nhttps://github.com/owner/repo/issues/42\n\nAuthor: deleted user | State: OPEN"));
        assert!(text.ends_with("### deleted user · 2026-09-07\nhttps://github.com/owner/repo/issues/42#issuecomment-1\n\nDetail"));
    }

    #[test]
    fn provider_summaries_never_carry_tokens() {
        assert_eq!(
            redact_summary("Bad ghp_ABCDEFGHIJ token\nsecond"),
            "Bad [redacted] token"
        );
    }
}
