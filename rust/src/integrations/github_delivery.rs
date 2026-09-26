//! GitHub pull request delivery through the REST and GraphQL APIs.
//! Ports `integrations/github/{delivery,failure,issues,pull-request-states}.ts`.
//! GitHub is observed through `octocrab`; Git through `git2`.

use crate::shared::time::rfc3339_millis;
use std::{error::Error, fmt, path::Path, sync::LazyLock, time::Duration};

use chrono::{DateTime, Utc};
use git2::{PushOptions, Repository};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{github::Access, provider_http::optional_metadata};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
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
    Merged,
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

fn present_body<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

fn present_title<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn object_present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(deserializer)?.is_object())
}

#[derive(Deserialize)]
struct RestPullRequest {
    number: u64,
    html_url: String,
    state: String,
    draft: bool,
    merged_at: Option<String>,
    head: RestPullSide,
    base: RestPullSide,
    #[serde(default, deserialize_with = "object_present")]
    auto_merge: bool,
    #[serde(default, deserialize_with = "present_title")]
    title: Option<String>,
    #[serde(default, deserialize_with = "present_body")]
    body: Option<Option<String>>,
    #[serde(default, deserialize_with = "optional_metadata")]
    user: Option<RestAuthor>,
    #[serde(default, deserialize_with = "optional_metadata")]
    updated_at: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    node_id: Option<String>,
}

#[derive(Deserialize)]
struct RestAuthor {
    login: String,
}

#[derive(Deserialize)]
struct RestPullSide {
    r#ref: String,
    sha: String,
    repo: RestRepository,
}

#[derive(Deserialize)]
struct RestRepository {
    full_name: String,
}

impl RestPullRequest {
    fn normalize(self) -> GithubResult<PullRequest> {
        let side_valid = |side: &RestPullSide| {
            (1..=256).contains(&side.r#ref.chars().count())
                && valid_sha(&side.sha)
                && REPOSITORY.is_match(&side.repo.full_name)
        };
        if self.number == 0
            || url::Url::parse(&self.html_url).is_err()
            || !matches!(self.state.as_str(), "open" | "closed")
            || !side_valid(&self.head)
            || !side_valid(&self.base)
            || self
                .merged_at
                .as_ref()
                .is_some_and(|time| DateTime::parse_from_rfc3339(time).is_err())
        {
            return Err(failure(
                "invalid-provider-response",
                "GitHub pull request response is malformed",
            ));
        }
        let head_repository = self.head.repo.full_name.to_lowercase();
        let base_repository = self.base.repo.full_name.to_lowercase();
        Ok(PullRequest {
            number: self.number,
            url: self.html_url,
            is_cross_repository: Some(head_repository != base_repository),
            repository: head_repository,
            head_branch: self.head.r#ref,
            base_branch: self.base.r#ref,
            head_sha: self.head.sha,
            base_sha: self.base.sha,
            is_draft: self.draft,
            state: if self.state == "closed" && self.merged_at.is_some() {
                "merged".into()
            } else {
                self.state
            },
            merged_at: self.merged_at,
            auto_merge_enabled: self.auto_merge.then_some(true),
            title: self.title,
            body: self.body.map(Option::unwrap_or_default),
            author: self.user.map(|user| user.login),
            updated_at: self.updated_at,
            node_id: self.node_id,
        })
    }
}

#[derive(Deserialize)]
struct GraphObservation<T = PullRequestObservation> {
    data: Option<GraphRepository<T>>,
}
#[derive(Deserialize)]
struct GraphRepository<T> {
    repository: Option<GraphPull<T>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphPull<T> {
    pull_request: Option<T>,
}

impl<T> GraphObservation<T> {
    fn pull(self) -> Option<T> {
        self.data
            .and_then(|data| data.repository)
            .and_then(|repo| repo.pull_request)
    }
}

#[derive(Deserialize)]
struct MergeSettings {
    allow_squash_merge: bool,
    allow_merge_commit: bool,
    allow_rebase_merge: bool,
}
#[derive(Deserialize)]
struct ConditionalMerge {
    merged: bool,
    message: String,
    #[serde(default, deserialize_with = "optional_metadata")]
    sha: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeContext {
    id: String,
    head_ref_oid: String,
    base_ref_name: String,
    #[serde(default, deserialize_with = "optional_metadata")]
    mergeable: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    merge_state_status: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestObservation {
    number: u64,
    url: String,
    state: String,
    is_draft: bool,
    head_ref_oid: String,
    base_ref_oid: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    mergeable: Option<String>,
    merge_state_status: Option<String>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    auto_merge_request: Option<serde_json::Map<String, Value>>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    review_decision: Option<String>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    author: Option<GraphAuthor>,
    changed_files: u64,
    additions: u64,
    deletions: u64,
    #[serde(default, deserialize_with = "optional_metadata")]
    title: Option<String>,
    #[serde(default, rename = "commits", deserialize_with = "commit_checks")]
    checks: Vec<CheckContext>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphAuthor {
    login: String,
    #[serde(default, deserialize_with = "optional_metadata")]
    avatar_url: Option<String>,
}
fn commit_checks<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<CheckContext>, D::Error> {
    let commits = Value::deserialize(deserializer)?;
    match commits
        .pointer("/nodes/0/commit/statusCheckRollup/contexts/nodes")
        .and_then(Value::as_array)
    {
        Some(nodes) if nodes.iter().all(Value::is_object) => nodes
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()
            .map_err(serde::de::Error::custom),
        Some(_) => Err(serde::de::Error::custom("Invalid check context")),
        None => Ok(Vec::new()),
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckContext {
    #[serde(default, deserialize_with = "optional_metadata")]
    name: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    context: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    conclusion: Option<String>,
    #[serde(default, deserialize_with = "check_status")]
    status: Option<Option<String>>,
    #[serde(default, deserialize_with = "optional_metadata")]
    state: Option<String>,
    #[serde(default, deserialize_with = "check_link")]
    details_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "optional_metadata")]
    target_url: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    started_at: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    completed_at: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    check_suite: Option<CheckSuite>,
    #[serde(default, deserialize_with = "optional_metadata")]
    workflow_name: Option<String>,
}
fn check_status<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    optional_metadata(deserializer).map(Some)
}
fn check_link<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok((!value.is_null()).then(|| value.as_str().map(str::to_owned)))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckSuite {
    workflow_run: Option<WorkflowRun>,
}
#[derive(Clone, Deserialize)]
struct WorkflowRun {
    workflow: Option<WorkflowName>,
}
#[derive(Clone, Deserialize)]
struct WorkflowName {
    name: String,
}

fn check_timestamp(value: Option<&str>) -> Value {
    value
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .filter(|time| time.timestamp_millis() > 0)
        .map_or(Value::Null, |time| {
            json!(rfc3339_millis(time.with_timezone(&Utc)))
        })
}

/// TypeScript `summarizeChecks`: the latest run per name, in first-seen order.
fn summarize_checks(checks: &[CheckContext]) -> Checks {
    let mut latest: Vec<(String, &CheckContext, Option<&str>)> = Vec::new();
    for (index, check) in checks.iter().enumerate() {
        let name = check
            .name
            .clone()
            .or_else(|| check.context.clone())
            .unwrap_or_else(|| index.to_string());
        let completed_at = check
            .completed_at
            .as_deref()
            .or(check.started_at.as_deref());
        match latest.iter_mut().find(|(known, _, _)| *known == name) {
            None => latest.push((name, check, completed_at)),
            Some(previous) => {
                let newer = match (&completed_at, &previous.2) {
                    (Some(current), Some(before)) => current >= before,
                    (Some(_), None) => true,
                    (None, None) => true,
                    (None, Some(_)) => false,
                };
                if newer {
                    previous.1 = check;
                    previous.2 = completed_at;
                }
            }
        }
    }
    let mut summary = Checks::default();
    for (name, check, _) in latest {
        summary.total += 1;
        let conclusion = check.conclusion.as_deref();
        let status = match &check.status {
            None => match check.state.as_deref() {
                Some("SUCCESS") => "successful",
                Some("FAILURE" | "ERROR") => "failing",
                _ => "pending",
            },
            Some(status) if status.as_deref() != Some("COMPLETED") => "pending",
            _ if matches!(conclusion, Some("SUCCESS" | "NEUTRAL" | "SKIPPED")) => "successful",
            _ => "failing",
        };
        match status {
            "successful" => summary.successful += 1,
            "failing" => summary.failing += 1,
            _ => summary.pending += 1,
        }
        let link = check
            .details_url
            .as_ref()
            .map_or(check.target_url.as_deref(), |link| link.as_deref())
            .filter(|text| url::Url::parse(text).is_ok());
        let workflow = check
            .check_suite
            .as_ref()
            .and_then(|suite| suite.workflow_run.as_ref())
            .and_then(|run| run.workflow.as_ref())
            .map(|workflow| workflow.name.as_str())
            .or(check.workflow_name.as_deref());
        let mut run = serde_json::Map::new();
        run.insert("name".into(), json!(name));
        run.insert("status".into(), json!(status));
        run.insert("url".into(), json!(link));
        if let Some(conclusion) = conclusion.filter(|text| !text.is_empty()) {
            run.insert("conclusion".into(), json!(conclusion));
        }
        run.insert(
            "workflow".into(),
            json!(workflow.filter(|text| !text.is_empty())),
        );
        run.insert(
            "startedAt".into(),
            check_timestamp(check.started_at.as_deref()),
        );
        run.insert(
            "completedAt".into(),
            check_timestamp(check.completed_at.as_deref()),
        );
        summary.runs.push(Value::Object(run));
    }
    summary
}

impl PullRequestObservation {
    fn normalize(self) -> GithubResult<Observation> {
        if self.number == 0
            || url::Url::parse(&self.url).is_err()
            || !matches!(self.state.as_str(), "OPEN" | "CLOSED" | "MERGED")
            || !valid_sha(&self.head_ref_oid)
            || !valid_sha(&self.base_ref_oid)
            || self
                .author
                .as_ref()
                .is_some_and(|author| author.login.is_empty())
        {
            return Err(failure(
                "invalid-provider-response",
                "GitHub pull request observation is malformed",
            ));
        }
        let checks = summarize_checks(&self.checks);
        let author = self.author.map(|author| {
            let avatar = author.avatar_url.unwrap_or_else(|| {
                format!("https://avatars.githubusercontent.com/{}", author.login)
            });
            json!({"login": author.login, "avatarUrl": avatar})
        });
        Ok(Observation {
            exists: true,
            number: Some(self.number),
            url: Some(self.url),
            state: Some(self.state.to_lowercase()),
            is_draft: Some(self.is_draft),
            head_sha: Some(self.head_ref_oid),
            base_sha: Some(self.base_ref_oid),
            mergeable: self.mergeable,
            merge_state_status: self.merge_state_status,
            checks,
            author,
            changed_files: Some(self.changed_files),
            additions: Some(self.additions),
            deletions: Some(self.deletions),
            auto_merge_enabled: Some(self.auto_merge_request.is_some()),
            review_decision: self.review_decision,
            title: self.title,
        })
    }
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

struct Reply {
    status: u16,
    reset: Option<i64>,
    body: String,
}

enum Api {
    Json(String),
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

fn decode_response<T: serde::de::DeserializeOwned>(body: &str, message: &str) -> GithubResult<T> {
    serde_json::from_str(body).map_err(|_| failure("invalid-provider-response", message))
}

#[cfg(test)]
fn decode<T: serde::de::DeserializeOwned>(value: Value, message: &str) -> GithubResult<T> {
    serde_json::from_value(value).map_err(|_| failure("invalid-provider-response", message))
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

    pub async fn same_repository(&self, left: &str, right: &str) -> GithubResult<bool> {
        crate::projects::connection::same_repository(&self.access, left, right)
            .await
            .map_err(|error| failure("provider-unavailable", redact_summary(&error.to_string())))
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
            let body = if reply.body.trim().is_empty() {
                "null".to_owned()
            } else {
                reply.body
            };
            serde_json::from_str::<serde::de::IgnoredAny>(&body).map_err(|_| {
                failure("invalid-provider-response", "GitHub returned invalid JSON")
            })?;
            return Ok(Api::Json(body));
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
                .map(rfc3339_millis);
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

    async fn response_body(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        operation: &str,
    ) -> GithubResult<String> {
        match self
            .api(method, path, body, operation, false, None, &[])
            .await?
        {
            Api::Json(body) => Ok(body),
            _ => Err(failure("provider-unavailable", operation.to_owned())),
        }
    }

    async fn value(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        operation: &str,
    ) -> GithubResult<Value> {
        parse_json(&self.response_body(method, path, body, operation).await?)
    }

    /// POST one GraphQL document. A response with errors and no data fails.
    async fn graphql<T: serde::de::DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
        operation: &str,
    ) -> GithubResult<T> {
        let body = json!({"query": query, "variables": variables});
        let response = self
            .response_body("POST", "/graphql", Some(&body), operation)
            .await?;
        // Check errors without parsing the successful response into an untyped document.
        #[derive(Deserialize)]
        struct Errors {
            #[serde(default, deserialize_with = "optional_metadata")]
            errors: Option<Vec<Value>>,
            data: Option<serde::de::IgnoredAny>,
        }
        let envelope: Errors = decode_response(&response, "GitHub returned invalid JSON")?;
        if let Some(errors) = envelope.errors.filter(|errors| !errors.is_empty())
            && envelope.data.is_none()
        {
            return Err(failure(
                "provider-unavailable",
                redact_summary(errors[0]["message"].as_str().unwrap_or(operation)),
            ));
        }
        decode_response(&response, &format!("GitHub {operation} is malformed"))
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
            Api::Json(body) => sha(&parse_json(&body)?["commit"], "sha")
                .map(Some)
                .ok_or_else(|| {
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
        decode_response::<RestPullRequest>(
            &self
                .response_body("GET", &path, None, "pull request observation")
                .await?,
            "GitHub pull request response is malformed",
        )?
        .normalize()
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
            Api::Json(body) => decode_response::<RestPullRequest>(
                &body,
                "GitHub pull request response is malformed",
            )?
            .normalize(),
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
        let response = self
            .response_body(
                "PATCH",
                &repo_route(repository, &["pulls", &number.to_string()]),
                Some(&json!({"title": title, "body": body})),
                "draft pull request metadata update",
            )
            .await?;
        let pull = decode_response::<RestPullRequest>(
            &response,
            "GitHub pull request response is malformed",
        )
        .and_then(|pull| {
            if pull.title.as_deref() != Some(title)
                || pull.body.as_ref().and_then(|body| body.as_deref()) != Some(body)
            {
                return Err(failure(
                    "invalid-provider-response",
                    "GitHub did not confirm the updated pull request metadata",
                ));
            }
            pull.normalize()
        });
        match pull {
            Ok(pull) => Ok(pull),
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
        let value: Value = self.graphql(&query, variables, "pull request list").await?;
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
            .graphql::<GraphObservation>(
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
        let response = value;
        match response.pull() {
            Some(pull) => pull.normalize(),
            None => Ok(Observation::absent()),
        }
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
        self.graphql::<Value>(
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
            json!({"id": id}),
            "mark ready for review",
        )
        .await?;
        Ok(())
    }

    async fn merge_context(&self, repository: &str, number: u64) -> GithubResult<MergeContext> {
        let (owner, name) = repository.split_once('/').expect("normalized repository");
        let value: GraphObservation<MergeContext> = self
            .graphql(
                "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid baseRefName mergeable mergeStateStatus}}}",
                json!({"owner": owner, "name": name, "number": number}),
                "pull request merge observation",
            )
            .await?;
        let malformed = || {
            failure(
                "invalid-provider-response",
                "GitHub pull request merge observation is malformed",
            )
        };
        let context = value.pull().ok_or_else(malformed)?;
        if context.id.is_empty()
            || !valid_sha(&context.head_ref_oid)
            || context.base_ref_name.is_empty()
        {
            return Err(malformed());
        }
        Ok(context)
    }

    /// `gh pr checks --required`: required checks of the head commit in gh buckets.
    async fn required_checks(&self, repository: &str, number: u64) -> GithubResult<Vec<Value>> {
        let (owner, name) = repository.split_once('/').expect("normalized repository");
        let value: Value = self
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
        let settings: MergeSettings = decode_response(
            &self
                .response_body(
                    "GET",
                    &repo_route(&repository, &[]),
                    None,
                    "repository settings",
                )
                .await?,
            "GitHub repository settings are malformed",
        )?;
        let method = if settings.allow_squash_merge {
            "squash"
        } else if settings.allow_merge_commit {
            "merge"
        } else if settings.allow_rebase_merge {
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
            Api::Json(body) => {
                let result: ConditionalMerge =
                    decode_response(&body, "GitHub did not confirm the conditional merge result")?;
                let ConditionalMerge {
                    merged,
                    sha,
                    message: _message,
                } = result;
                return if !merged {
                    Ok(MergeResult::NotMerged)
                } else if sha.as_deref().is_some_and(valid_sha) {
                    Ok(MergeResult::Merged)
                } else {
                    Err(failure(
                        "invalid-provider-response",
                        "GitHub did not confirm the conditional merge result",
                    ))
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
        let head = context.head_ref_oid.as_str();
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
        let mergeable = context.mergeable.as_deref();
        let merge_state = context.merge_state_status.as_deref();
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
        let base = context.base_ref_name;
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
            let value: Value = self
                .graphql(
                    "mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid}){mergeQueueEntry{id}}}",
                    json!({"pullRequestId": context.id, "expectedHeadOid": head_sha}),
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
        let value: Value = self
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
    let mut origin = crate::projects::git::origin_remote(&repository, git2::Direction::Push, token)
        .map_err(unavailable)?;
    let rejected = std::cell::RefCell::new(None::<String>);
    let mut callbacks = crate::projects::git::remote_callbacks(token);
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
    fn graphql_observation_reads_native_checks_and_preserves_missing_rollups() {
        let mut pull = json!({"number": 7, "url":"https://github.com/owner/repo/pull/7", "state":"OPEN", "isDraft":false,
        "headRefOid":"a".repeat(40), "baseRefOid":"b".repeat(40), "mergeable":null,
        "autoMergeRequest":{}, "reviewDecision":null, "author":{"login":"octo"}, "changedFiles":1, "additions":1,"deletions":0,
        "commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
            {"name":"unit","status":"COMPLETED","conclusion":"FAILURE","completedAt":"2026-09-01T00:00:00Z"},
            {"context":"deploy","state":"PENDING","targetUrl":"https://example.com/deploy"},
            {"name":"unit","status":"COMPLETED","conclusion":"SUCCESS","completedAt":"2026-09-02T00:00:00Z","checkSuite":{"workflowRun":{"workflow":{"name":"CI"}}}}
        ]}}}}]}});
        let read = |pull: &Value| {
            decode_response::<GraphObservation>(
                &json!({"data":{"repository":{"pullRequest":pull}}}).to_string(),
                "GitHub pull request observation is malformed",
            )?
            .pull()
            .unwrap()
            .normalize()
        };
        let observed = read(&pull).unwrap();
        assert_eq!(
            (
                observed.checks.total,
                observed.checks.successful,
                observed.checks.pending,
                observed.checks.failing
            ),
            (2, 1, 1, 0)
        );
        assert_eq!(observed.checks.runs[0]["name"], "unit");
        assert_eq!(observed.checks.runs[0]["workflow"], "CI");
        assert_eq!(observed.checks.runs[1]["url"], "https://example.com/deploy");
        assert_eq!(
            observed.author.unwrap()["avatarUrl"],
            "https://avatars.githubusercontent.com/octo"
        );
        assert_eq!(observed.auto_merge_enabled, Some(true));
        pull["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"] =
            json!([null]);
        assert_eq!(read(&pull).unwrap_err().code, "invalid-provider-response");
        pull.as_object_mut().unwrap().remove("commits");
        assert_eq!(read(&pull).unwrap().checks, Checks::default());
        pull.as_object_mut().unwrap().remove("mergeable");
        assert_eq!(
            read(&pull).unwrap_err().summary,
            "GitHub pull request observation is malformed"
        );
    }

    #[test]
    fn rest_optional_metadata_preserves_absence_null_and_invalid_values() {
        let mut pull = json!({"number":3,"html_url":"https://github.com/a/b/pull/3","state":"open","draft":false,
            "head":{"ref":"task","sha":"a".repeat(40),"repo":{"full_name":"a/b"}},
            "base":{"ref":"main","sha":"b".repeat(40),"repo":{"full_name":"a/b"}}});
        assert_eq!(normalize_pull(&pull).unwrap().body, None);
        pull["body"] = Value::Null;
        pull["auto_merge"] = json!(false);
        pull["user"] = json!({"login":42});
        let normalized = normalize_pull(&pull).unwrap();
        assert_eq!(normalized.body.as_deref(), Some(""));
        assert_eq!(normalized.author, None);
        assert_eq!(normalized.auto_merge_enabled, None);
        pull["title"] = Value::Null;
        assert_eq!(
            normalize_pull(&pull).unwrap_err().code,
            "invalid-provider-response"
        );
    }

    fn normalize_pull(value: &Value) -> GithubResult<PullRequest> {
        decode::<RestPullRequest>(value.clone(), "GitHub pull request response is malformed")?
            .normalize()
    }

    fn map_observation(value: &Value) -> GithubResult<Observation> {
        let mut observation = decode::<PullRequestObservation>(
            value.clone(),
            "GitHub pull request observation is malformed",
        )?
        .normalize()?;
        let checks: Vec<CheckContext> =
            decode(value["statusCheckRollup"].clone(), "Invalid checks")?;
        observation.checks = summarize_checks(&checks);
        Ok(observation)
    }

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
