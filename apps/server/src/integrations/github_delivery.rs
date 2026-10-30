//! GitHub pull request delivery through the REST and GraphQL APIs.
//! Ports `integrations/github/{delivery,failure,issues,pull-request-states}.ts`.
//! GitHub is observed through `octocrab`; Git through `git2`.

use crate::shared::time::rfc3339_millis;
use std::{
    error::Error,
    fmt,
    path::Path,
    sync::{Arc, LazyLock},
    time::Duration,
};

use chrono::{DateTime, Utc};
use git2::{PushOptions, Repository};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    github::Access,
    github_rate_limit::{RateLimits, Resource},
    provider_http::{lenient, optional_metadata, present_string},
};
use crate::{
    platform::redaction,
    tasks::worktree::{self, LocalRevisionObservation},
};

static SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40,64}$").expect("valid regex"));
static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9][a-z0-9_.-]{0,99}$").expect("valid regex")
});
static PROVIDER_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,})\b")
        .expect("valid regex")
});
static RATE_LIMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)rate limit|secondary rate|abuse").expect("valid regex"));

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
    let line = summary.lines().next().unwrap_or_default();
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

/// GitHub reports `REVIEW_REQUIRED` or `CHANGES_REQUESTED` only when the repository
/// requires reviews. A null decision means GitHub requires none, not that it is pending.
pub fn review_blocks_merge(review_decision: Option<&str>) -> bool {
    matches!(
        review_decision,
        Some("REVIEW_REQUIRED") | Some("CHANGES_REQUESTED")
    )
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
    pub author: Option<ObservedAuthor>,
    pub changed_files: Option<u64>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub auto_merge_enabled: Option<bool>,
    pub review_decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// The pull request author in the `gh pr view` shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedAuthor {
    pub login: String,
    pub avatar_url: String,
}

impl Observation {
    pub fn absent() -> Self {
        Self::default()
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("observation serializes")
    }
}

crate::shared::wire_enum! {
    /// The state of a GitHub Actions workflow run.
    pub enum ActionsRunStatus {
        Queued = "queued",
        InProgress = "in_progress",
        Completed = "completed",
        Waiting = "waiting",
        Requested = "requested",
        Pending = "pending",
    }
}

#[derive(Deserialize)]
pub(crate) struct ActionsRun {
    pub id: u64,
    pub head_sha: String,
    pub head_branch: Option<String>,
    pub status: ActionsRunStatus,
    pub conclusion: Option<String>,
    repository: RunRepository,
    head_repository: Option<RunRepository>,
    pull_requests: Vec<RunPullRequest>,
}

#[derive(Deserialize)]
struct RunRepository {
    full_name: String,
}

#[derive(Deserialize)]
struct RunPullRequest {
    number: u64,
    head: RunHead,
}

#[derive(Deserialize)]
struct RunHead {
    sha: String,
}

impl ActionsRun {
    pub(crate) fn matches_pull(&self, pull: &PullRequest) -> bool {
        self.repository
            .full_name
            .eq_ignore_ascii_case(&pull.repository)
            && self
                .head_repository
                .as_ref()
                .is_some_and(|repo| repo.full_name.eq_ignore_ascii_case(&pull.repository))
            && self.head_branch.as_deref() == Some(pull.head_branch.as_str())
            && (self.head_sha == pull.head_sha
                || self
                    .pull_requests
                    .iter()
                    .any(|linked| linked.number == pull.number && linked.head.sha == pull.head_sha))
    }
}

crate::shared::wire_enum! {
    /// What GitHub did with a merge request that did not merge at once.
    pub enum MergeDisposition {
        Blocked = "blocked",
        Waiting = "waiting",
        Queued = "queued",
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeResult {
    Merged,
    NotMerged,
    Disposition {
        disposition: MergeDisposition,
        message: String,
    },
}

fn present_body<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
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
    #[serde(default, deserialize_with = "present_string")]
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
        let author = self.author.map(|author| ObservedAuthor {
            avatar_url: author.avatar_url.unwrap_or_else(|| {
                format!("https://avatars.githubusercontent.com/{}", author.login)
            }),
            login: author.login,
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRow {
    number: u64,
    url: String,
    state: String,
    is_draft: bool,
    head_ref_name: String,
    head_ref_oid: String,
    base_ref_name: String,
    base_ref_oid: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    author: Option<Login>,
    #[serde(default)]
    updated_at: Option<String>,
    is_cross_repository: bool,
}

impl ListRow {
    fn normalize(self, repository: &str) -> Option<PullRequest> {
        let bounded = |text: &str| (1..=256).contains(&text.chars().count());
        let valid = self.number > 0
            && url::Url::parse(&self.url).is_ok()
            && matches!(self.state.as_str(), "OPEN" | "CLOSED" | "MERGED")
            && bounded(&self.head_ref_name)
            && bounded(&self.base_ref_name)
            && valid_sha(&self.head_ref_oid)
            && valid_sha(&self.base_ref_oid)
            && self
                .updated_at
                .as_deref()
                .is_none_or(|time| DateTime::parse_from_rfc3339(time).is_ok());
        valid.then(|| PullRequest {
            number: self.number,
            url: self.url,
            repository: repository.to_owned(),
            head_branch: self.head_ref_name,
            base_branch: self.base_ref_name,
            head_sha: self.head_ref_oid,
            base_sha: self.base_ref_oid,
            is_draft: self.is_draft,
            state: self.state.to_lowercase(),
            merged_at: None,
            auto_merge_enabled: None,
            title: Some(self.title.unwrap_or_default()),
            body: Some(self.body.unwrap_or_default()),
            author: Some(self.author.map(|author| author.login).unwrap_or_default()),
            updated_at: self.updated_at,
            is_cross_repository: Some(self.is_cross_repository),
            node_id: None,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Login {
    login: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Label {
    name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Milestone {
    title: String,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

fn graph_nodes<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Nodes::deserialize(deserializer).map(|nodes| nodes.nodes)
}

/// One GitHub issue in the `gh issue view --json` shape. It decodes from
/// the GraphQL issue node, whose lists are `{nodes}` connections.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssue {
    number: u64,
    url: String,
    title: String,
    body: String,
    author: Option<Login>,
    state: String,
    #[serde(deserialize_with = "graph_nodes")]
    labels: Vec<Label>,
    #[serde(deserialize_with = "graph_nodes")]
    assignees: Vec<Login>,
    milestone: Option<Milestone>,
    updated_at: String,
    #[serde(default, skip_serializing)]
    comments: Vec<IssueComment>,
}

impl GithubIssue {
    fn valid(&self) -> bool {
        self.number > 0
            && url::Url::parse(&self.url).is_ok()
            && matches!(self.state.as_str(), "OPEN" | "CLOSED")
    }
}

/// A GitHub REST issue.
#[derive(Deserialize)]
struct RestIssue {
    number: u64,
    html_url: String,
    title: String,
    #[serde(default, deserialize_with = "lenient")]
    body: String,
    #[serde(default, deserialize_with = "optional_metadata")]
    user: Option<Login>,
    #[serde(default, deserialize_with = "lenient")]
    state: String,
    labels: Vec<Label>,
    assignees: Vec<Login>,
    #[serde(default, deserialize_with = "optional_metadata")]
    milestone: Option<Milestone>,
    updated_at: String,
}

impl From<RestIssue> for GithubIssue {
    fn from(row: RestIssue) -> Self {
        Self {
            number: row.number,
            url: row.html_url,
            title: row.title,
            body: row.body,
            author: row.user,
            state: row.state.to_uppercase(),
            labels: row.labels,
            assignees: row.assignees,
            milestone: row.milestone,
            updated_at: row.updated_at,
            comments: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct IssueComment {
    html_url: String,
    body: String,
    #[serde(default)]
    user: Option<Login>,
    created_at: String,
}

/// One `gh pr checks --required` row.
struct RequiredCheck {
    name: String,
    bucket: &'static str,
    state: String,
    link: Option<String>,
}

/// A status context or check run of the required-check rollup.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequiredContext {
    #[serde(default, deserialize_with = "lenient")]
    is_required: bool,
    #[serde(default, deserialize_with = "optional_metadata")]
    context: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    state: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    target_url: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    name: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    status: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    conclusion: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    details_url: Option<String>,
}

impl RequiredContext {
    fn check(self) -> RequiredCheck {
        let (name, state, link) = match self.context {
            Some(context) => (context, self.state.unwrap_or_default(), self.target_url),
            None => {
                let status = self.status.unwrap_or_default();
                let state = if status == "COMPLETED" {
                    self.conclusion.unwrap_or(status)
                } else {
                    status
                };
                (self.name.unwrap_or_default(), state, self.details_url)
            }
        };
        let bucket = match state.as_str() {
            "SUCCESS" | "NEUTRAL" => "pass",
            "SKIPPED" => "skipping",
            "CANCELLED" => "cancel",
            "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE" => {
                "fail"
            }
            _ => "pending",
        };
        RequiredCheck {
            name,
            bucket,
            state,
            link,
        }
    }
}

#[derive(Deserialize)]
struct BranchRule {
    r#type: String,
}

#[derive(Deserialize)]
struct BranchHead {
    commit: BranchCommit,
}

#[derive(Deserialize)]
struct BranchCommit {
    sha: String,
}

/// One aliased pull request of a batched state read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullState {
    #[serde(default, deserialize_with = "optional_metadata")]
    number: Option<u64>,
    #[serde(default, deserialize_with = "optional_metadata")]
    url: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    head_ref_oid: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    state: Option<String>,
    #[serde(default)]
    merged_at: Option<String>,
}

#[derive(Deserialize)]
struct Diagnostic {
    message: String,
}

const PULL_LIST_FIELDS: &str = "number url isDraft state headRefName headRefOid baseRefName baseRefOid title body author { login } updatedAt isCrossRepository";

/// The `gh pr view` observation fields, with the latest commit's check rollup.
const OBSERVATION_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url state isDraft headRefOid baseRefOid mergeable mergeStateStatus autoMergeRequest{enabledAt} reviewDecision author{login avatarUrl} changedFiles additions deletions title commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on StatusContext{context state targetUrl startedAt:createdAt} ...on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{workflowRun{workflow{name}}}}}}}}}}}}}";

struct Reply {
    status: u16,
    etag: String,
    body: String,
}

/// Read both REST diagnostics and GraphQL error envelopes. Rate-limit errors
/// can use HTTP 200; successful partial GraphQL data must remain available.
fn rate_limit_details(
    status: u16,
    graphql: bool,
    headers: &axum::http::HeaderMap,
    value: &Value,
    now: DateTime<Utc>,
) -> Option<(Resource, Option<DateTime<Utc>>, String)> {
    let message = value["message"].as_str().unwrap_or_default();
    let graph_error = graphql
        .then(|| value["errors"].as_array())
        .flatten()
        .and_then(|errors| {
            errors.iter().find(|error| {
                error["type"] == "RATE_LIMITED"
                    || error["extensions"]["code"] == "RATE_LIMITED"
                    || RATE_LIMIT.is_match(error["message"].as_str().unwrap_or_default())
            })
        });
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if status != 429
        && !(status == 403 && (remaining == Some(0) || RATE_LIMIT.is_match(message)))
        && graph_error.is_none()
    {
        return None;
    }
    let summary = redact_summary(
        graph_error
            .and_then(|error| error["message"].as_str())
            .unwrap_or(message),
    );
    let summary = if summary.is_empty() {
        "GitHub limited requests".to_owned()
    } else {
        summary
    };
    let after = headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .parse::<i64>()
                .ok()
                .filter(|seconds| *seconds >= 0)
                .and_then(chrono::Duration::try_seconds)
                .and_then(|duration| now.checked_add_signed(duration))
                .or_else(|| {
                    DateTime::parse_from_rfc2822(value)
                        .ok()
                        .map(|time| time.with_timezone(&Utc))
                })
        })
        .filter(|time| *time > now);
    // A rate-limit response can omit the remaining count. Keep its explicit
    // reset deadline; a positive remaining count identifies a secondary limit.
    let reset = (remaining.is_none() || remaining == Some(0))
        .then(|| headers.get("x-ratelimit-reset"))
        .flatten()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
        .filter(|time| *time > now);
    let scope = if (remaining == Some(0) || (remaining.is_none() && reset.is_some()))
        && !summary.to_lowercase().contains("secondary")
        && !summary.to_lowercase().contains("abuse")
    {
        if graphql {
            Resource::Graphql
        } else {
            Resource::Rest
        }
    } else {
        Resource::Secondary
    };
    Some((scope, after.into_iter().chain(reset).max(), summary))
}

/// Caller logging is reserved for other failures; the shared cooldown reports
/// its own entry and recovery once, regardless of the number of observers.
pub(crate) fn is_rate_limited(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<GithubFailure>()
        .is_some_and(|failure| {
            failure.code == "provider-rate-limited" && failure.retry_at.is_some()
        })
}

/// How `api` treats a 404 and other statuses the caller handles itself.
#[derive(Default)]
struct StatusHandling<'a> {
    allow_not_found: bool,
    not_found_summary: Option<&'a str>,
    accepted: &'a [u16],
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
    let message = serde_json::from_str::<Diagnostic>(body)
        .map(|diagnostic| diagnostic.message)
        .unwrap_or_default();
    redact_summary(&message)
}

pub struct Github {
    access: Access,
    rate_limits: Arc<RateLimits>,
    pub retry_pauses: Vec<Duration>,
}

impl Github {
    pub fn new(access: Access) -> Self {
        Self {
            rate_limits: RateLimits::shared(access.request_identity()),
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
        #[derive(Deserialize)]
        struct Identity {
            id: u64,
        }
        let mut identities = Vec::new();
        for repository in [left, right] {
            let repository = normalize_repository(repository)?;
            let identity: Identity = decode_response(
                &self
                    .response_body(
                        "GET",
                        &repo_route(&repository, &[]),
                        None,
                        "repository identity",
                    )
                    .await?,
                "GitHub repository identity is malformed",
            )?;
            identities.push(identity.id);
        }
        Ok(identities[0] == identities[1])
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
        self.send_with_headers(method, path, body, operation, None)
            .await
    }

    async fn send_with_headers(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        operation: &str,
        headers: Option<axum::http::HeaderMap>,
    ) -> GithubResult<Reply> {
        let graphql = path == "/graphql";
        // Observation waits out a cooldown. A user or agent write still reaches
        // GitHub: the authoritative answer, not a local cooldown, decides it.
        let permit = if graphql || method == "GET" {
            let resource = if graphql {
                Resource::Graphql
            } else {
                Resource::Rest
            };
            Some(self.rate_limits.acquire(resource, Utc::now())?)
        } else {
            None
        };
        let client = self.access.client();
        let response = match method {
            "POST" => client._post(path, body).await,
            "PATCH" => client._patch(path, body).await,
            "PUT" => client._put(path, body).await,
            _ => client._get_with_headers(path, headers).await,
        }
        .map_err(|error| {
            failure(
                "provider-unavailable",
                redact_summary(&format!("{operation} failed: {error}")),
            )
        })?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let etag = headers
            .get(axum::http::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let body = client.body_to_string(response).await.map_err(|error| {
            failure(
                "provider-unavailable",
                redact_summary(&format!("{operation} failed: {error}")),
            )
        })?;
        let now = Utc::now();
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if let Some((resource, deadline, summary)) =
            rate_limit_details(status, graphql, &headers, &value, now)
        {
            let (error, started) = self.rate_limits.record(resource, deadline, summary, now);
            if started {
                eprintln!(
                    "GitHub requests delayed by a rate limit; retry at {}",
                    error.retry_at.as_deref().unwrap_or_default()
                );
            }
            // The batch reader and typed GraphQL reader retain partial data.
            let partial = (200..300).contains(&status)
                && graphql
                && value["data"]
                    .as_object()
                    .is_some_and(|data| data.values().any(|value| !value.is_null()));
            if !partial {
                return Err(error);
            }
        } else if permit
            .is_some_and(|permit| permit.finish((200..300).contains(&status) || status == 304, now))
        {
            eprintln!("GitHub requests resumed after a rate limit");
        }
        Ok(Reply { status, etag, body })
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

    /// One conditional GET: `None` when GitHub answers 304 for `etag`, else the new ETag.
    /// A 304 for an authenticated request does not count against the rate limit.
    pub(crate) async fn changed_since(
        &self,
        path: &str,
        etag: Option<&str>,
        operation: &str,
    ) -> GithubResult<Option<String>> {
        let unavailable = |error: &dyn std::fmt::Display| {
            failure(
                "provider-unavailable",
                redact_summary(&format!("{operation} failed: {error}")),
            )
        };
        let mut headers = axum::http::HeaderMap::new();
        if let Some(value) = etag.and_then(|etag| etag.parse().ok()) {
            headers.insert(axum::http::header::IF_NONE_MATCH, value);
        }
        let reply = self
            .send_with_headers("GET", path, None, operation, Some(headers))
            .await?;
        match reply.status {
            304 => Ok(None),
            200..300 => Ok(Some(reply.etag)),
            _ => Err(unavailable(&format!("HTTP {}", reply.status))),
        }
    }

    /// One GET with the `api` failure classes, for the trigger inspection port.
    pub(crate) async fn get_json(&self, path: &str, operation: &str) -> GithubResult<Value> {
        self.value("GET", path, None, operation).await
    }

    pub(crate) async fn get_optional_json(
        &self,
        path: &str,
        operation: &str,
    ) -> GithubResult<Option<Value>> {
        match self
            .api(
                "GET",
                path,
                None,
                operation,
                StatusHandling {
                    allow_not_found: true,
                    ..StatusHandling::default()
                },
            )
            .await?
        {
            Api::NotFound => Ok(None),
            Api::Json(body) => parse_json(&body).map(Some),
            Api::Accepted { .. } => unreachable!("no accepted statuses"),
        }
    }

    /// TypeScript `api`: one GitHub request with the source's failure classes.
    async fn api(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        operation: &str,
        handling: StatusHandling<'_>,
    ) -> GithubResult<Api> {
        let StatusHandling {
            allow_not_found,
            not_found_summary,
            accepted,
        } = handling;
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
        if reply.status == 401 {
            return Err(failure(
                "authentication-required",
                format!(
                    "GitHub CLI authentication is unavailable: {}",
                    or("sign in with gh auth login -s workflow".into())
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
            .api(method, path, body, operation, StatusHandling::default())
            .await?
        {
            Api::Json(body) => Ok(body),
            Api::NotFound | Api::Accepted { .. } => {
                Err(failure("provider-unavailable", operation.to_owned()))
            }
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
    pub(crate) async fn graphql<T: serde::de::DeserializeOwned>(
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
                redact_summary(
                    &Diagnostic::deserialize(&errors[0])
                        .map_or_else(|_| operation.to_owned(), |error| error.message),
                ),
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
            .api(
                "GET",
                &path,
                None,
                "branch observation",
                StatusHandling {
                    allow_not_found: true,
                    ..StatusHandling::default()
                },
            )
            .await?
        {
            Api::NotFound => Ok(None),
            Api::Json(body) => serde_json::from_str::<BranchHead>(&body)
                .ok()
                .map(|head| head.commit.sha)
                .filter(|sha| valid_sha(sha))
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

    pub(crate) async fn workflow_run(
        &self,
        repository: &str,
        run_id: u64,
    ) -> GithubResult<ActionsRun> {
        let path = repo_route(repository, &["actions", "runs", &run_id.to_string()]);
        decode_response(
            &self
                .response_body("GET", &path, None, "workflow run observation")
                .await?,
            "GitHub workflow run response is malformed",
        )
    }

    pub(crate) async fn rerun_failed_jobs(
        &self,
        repository: &str,
        run_id: u64,
    ) -> GithubResult<()> {
        let path = repo_route(
            repository,
            &["actions", "runs", &run_id.to_string(), "rerun-failed-jobs"],
        );
        self.response_body(
            "POST",
            &path,
            None,
            "rerun failed CI jobs",
        )
        .await
        .map_err(|mut error| {
            if error.code == "authentication-required" {
                error.summary.push_str(". CI reruns need Actions write permission, or repo scope for a classic/OAuth token.");
            }
            error
        })?;
        Ok(())
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
                StatusHandling {
                    not_found_summary: Some(&summary),
                    ..StatusHandling::default()
                },
            )
            .await?
        {
            Api::Json(body) => decode_response::<RestPullRequest>(
                &body,
                "GitHub pull request response is malformed",
            )?
            .normalize(),
            Api::NotFound | Api::Accepted { .. } => Err(failure("provider-unavailable", summary)),
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
        value
            .pointer("/data/repository/pullRequests/nodes")
            .and_then(Value::as_array)
            .and_then(|rows| {
                rows.iter()
                    .map(|row| ListRow::deserialize(row).ok()?.normalize(&repository))
                    .collect::<Option<Vec<_>>>()
            })
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
        self.graphql::<serde::de::IgnoredAny>(
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
    async fn required_checks(
        &self,
        repository: &str,
        number: u64,
    ) -> GithubResult<Vec<RequiredCheck>> {
        let (owner, name) = repository.split_once('/').expect("normalized repository");
        let value: Value = self
            .graphql(
                "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)} ...on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)}}}}}}}}}}",
                json!({"owner": owner, "name": name, "number": number}),
                "required pull request checks",
            )
            .await?;
        let nodes = value
            .pointer("/data/repository/pullRequest/commits/nodes/0/commit/statusCheckRollup/contexts/nodes")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        Ok(nodes
            .iter()
            .filter_map(|node| RequiredContext::deserialize(node).ok())
            .filter(|node| node.is_required)
            .map(RequiredContext::check)
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
                StatusHandling {
                    accepted: &[405],
                    ..StatusHandling::default()
                },
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
            disposition: MergeDisposition::Blocked,
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
                .filter(|check| bucket.contains(&check.bucket))
                .map(|check| {
                    let link = check
                        .link
                        .as_ref()
                        .map(|link| format!(", {link}"))
                        .unwrap_or_default();
                    format!("{} ({}{link})", check.name, check.state)
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
                disposition: MergeDisposition::Waiting,
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
                disposition: MergeDisposition::Waiting,
                message: format!("GitHub is still computing mergeability. {refused}"),
            });
        }
        let base = context.base_ref_name;
        let rules_path = repo_route(&repository, &["rules", "branches", &base]);
        // GitHub Free answers rulesets on a private repository with 403 ("Upgrade to
        // GitHub Pro"). That is not a token problem: the repository has no rules.
        let rules = self
            .retry_transient(|| async {
                match self
                    .api(
                        "GET",
                        &rules_path,
                        None,
                        "branch rules",
                        StatusHandling {
                            accepted: &[403],
                            ..StatusHandling::default()
                        },
                    )
                    .await?
                {
                    Api::Json(body) => decode_response::<Vec<BranchRule>>(
                        &body,
                        "GitHub branch rules are malformed",
                    ),
                    Api::Accepted { .. } => Ok(Vec::new()),
                    Api::NotFound => unreachable!("not found is a failure"),
                }
            })
            .await?;
        if rules.iter().any(|rule| rule.r#type == "merge_queue") {
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
            if value
                .pointer("/data/enqueuePullRequest/mergeQueueEntry/id")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(failure(
                    "invalid-provider-response",
                    "GitHub did not confirm the merge queue entry",
                ));
            }
            return Ok(MergeResult::Disposition {
                disposition: MergeDisposition::Queued,
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
            if !value.get("data").is_some_and(Value::is_object) {
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
                let Some(pull) = value
                    .pointer(&format!("/data/p{index}/pullRequest"))
                    .filter(|pull| !pull.is_null())
                else {
                    continue;
                };
                let malformed = || {
                    failure(
                        "invalid-provider-response",
                        "GitHub pull request states are malformed",
                    )
                };
                let pull = PullState::deserialize(pull).map_err(|_| malformed())?;
                let (Some(found), Some(url), Some(head), Some(state)) = (
                    pull.number.filter(|number| *number > 0),
                    pull.url.filter(|url| url::Url::parse(url).is_ok()),
                    pull.head_ref_oid.filter(|head| !head.is_empty()),
                    pull.state
                        .filter(|state| matches!(state.as_str(), "OPEN" | "CLOSED" | "MERGED")),
                ) else {
                    return Err(malformed());
                };
                let merged_at = pull.merged_at;
                if merged_at
                    .as_deref()
                    .is_some_and(|time| DateTime::parse_from_rfc3339(time).is_err())
                {
                    return Err(malformed());
                }
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
        let malformed = || {
            failure(
                "invalid-provider-response",
                "GitHub issue list is malformed",
            )
        };
        value
            .pointer("/data/repository/issues/nodes")
            .and_then(Value::as_array)
            .ok_or_else(malformed)?
            .iter()
            .map(|node| {
                GithubIssue::deserialize(node)
                    .ok()
                    .filter(GithubIssue::valid)
                    .map(|issue| json!(issue))
                    .ok_or_else(malformed)
            })
            .collect()
    }

    /// One issue with every comment page.
    pub async fn get_issue(&self, repository: &str, number: u64) -> GithubResult<GithubIssue> {
        let path = repo_route(repository, &["issues", &number.to_string()]);
        let mut issue = decode_response::<RestIssue>(
            &self
                .response_body("GET", &path, None, "issue observation")
                .await?,
            "GitHub issue is malformed",
        )
        .map(GithubIssue::from)
        .ok()
        .filter(GithubIssue::valid)
        .ok_or_else(|| failure("invalid-provider-response", "GitHub issue is malformed"))?;
        for page in 1.. {
            let path = format!("{path}/comments?per_page=100&page={page}");
            let rows = decode_response::<Vec<IssueComment>>(
                &self
                    .response_body("GET", &path, None, "issue comments")
                    .await?,
                "GitHub issue comments are malformed",
            )
            .ok()
            .filter(|rows| {
                rows.iter()
                    .all(|row| url::Url::parse(&row.html_url).is_ok())
            })
            .ok_or_else(|| {
                failure(
                    "invalid-provider-response",
                    "GitHub issue comments are malformed",
                )
            })?;
            let last = rows.len() < 100;
            issue.comments.extend(rows);
            if last {
                break;
            }
        }
        Ok(issue)
    }
}

/// TypeScript `issueContext`: the Markdown snapshot of one GitHub issue.
pub fn issue_context(issue: &GithubIssue) -> String {
    let login = |user: &Option<Login>| {
        user.as_ref()
            .map_or("deleted user", |user| user.login.as_str())
            .to_owned()
    };
    let list = |items: Vec<&str>| {
        let items = items.join(", ");
        if items.is_empty() {
            "None".into()
        } else {
            items
        }
    };
    let mut parts = vec![
        format!("## GitHub issue #{}: {}", issue.number, issue.title),
        issue.url.clone(),
        format!(
            "Author: {} | State: {} | Updated: {}",
            login(&issue.author),
            issue.state,
            issue.updated_at
        ),
        format!(
            "Labels: {}",
            list(
                issue
                    .labels
                    .iter()
                    .map(|label| label.name.as_str())
                    .collect()
            )
        ),
        format!(
            "Assignees: {}",
            list(
                issue
                    .assignees
                    .iter()
                    .map(|user| user.login.as_str())
                    .collect()
            )
        ),
        format!(
            "Milestone: {}",
            issue
                .milestone
                .as_ref()
                .map_or("None", |milestone| milestone.title.as_str())
        ),
        issue.body.clone(),
    ];
    for comment in &issue.comments {
        parts.push(format!(
            "### {} · {}\n{}\n\n{}",
            login(&comment.user),
            comment.created_at,
            comment.html_url,
            comment.body
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
    let unavailable = |error: git2::Error| push_failure(error.message());
    let repository = Repository::open(cwd).map_err(unavailable)?;
    if !crate::projects::git::libgit2_transport() {
        return crate::projects::git::system_push(
            &repository,
            &format!("{head_sha}:refs/heads/{branch}"),
        )
        .map_err(unavailable);
    }
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
        return Err(push_failure(&status));
    }
    Ok(())
}

/// GitHub refuses a push that changes `.github/workflows/*` when the token has
/// no `workflow` scope. Classify that rejection and say how to fix it. Every
/// other push failure stays `provider-unavailable`.
fn push_failure(message: &str) -> GithubFailure {
    if message.contains("`workflow` scope") {
        return failure(
            "authentication-required",
            "GitHub rejected the push because the token has no workflow scope. \
             Sign in to GitHub again in Suplex. \
             You can also run gh auth refresh -h github.com -s workflow.",
        );
    }
    failure(
        "provider-unavailable",
        redact_summary(&format!("normal push failed: {message}")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_workflow_scope_is_an_authentication_failure_with_a_fix() {
        let rejected = "refusing to allow an OAuth App to create or update workflow \
                        `.github/workflows/ci.yml` without `workflow` scope";
        for message in [rejected.to_owned(), format!("remote rejected: {rejected}")] {
            let error = push_failure(&message);
            assert_eq!(error.code, "authentication-required");
            assert!(
                error
                    .summary
                    .contains("gh auth refresh -h github.com -s workflow")
            );
            assert!(error.summary.contains("Sign in to GitHub again in Suplex"));
        }
        assert_eq!(
            push_failure("failed to push some refs").code,
            "provider-unavailable"
        );
    }

    #[test]
    fn rate_limit_headers_choose_the_later_deadline_and_ignore_invalid_dates() {
        let now = DateTime::from_timestamp(1_800_000_000, 0).unwrap();
        let body = &json!({"message":"API rate limit exceeded"});
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        headers.insert(
            "x-ratelimit-reset",
            (now.timestamp() + 120).to_string().parse().unwrap(),
        );
        headers.insert("retry-after", "240".parse().unwrap());
        let (scope, deadline, _) = rate_limit_details(403, false, &headers, body, now).unwrap();
        assert_eq!(scope, Resource::Rest);
        assert_eq!(deadline, Some(now + chrono::Duration::seconds(240)));
        headers.insert("retry-after", "60".parse().unwrap());
        assert_eq!(
            rate_limit_details(403, false, &headers, body, now)
                .unwrap()
                .1,
            Some(now + chrono::Duration::seconds(120))
        );
        headers.remove("x-ratelimit-remaining");
        let (scope, deadline, _) = rate_limit_details(429, false, &headers, body, now).unwrap();
        assert_eq!(scope, Resource::Rest);
        assert_eq!(deadline, Some(now + chrono::Duration::seconds(120)));
        // Malformed dates, negative values, and past resets
        // must never panic or cause an immediate retry loop.
        for after in ["broken", "-1", "9223372036854775807"] {
            headers.insert("retry-after", after.parse().unwrap());
            headers.insert("x-ratelimit-reset", "0".parse().unwrap());
            assert_eq!(
                rate_limit_details(403, false, &headers, body, now)
                    .unwrap()
                    .1,
                None
            );
        }
        let date = (now + chrono::Duration::seconds(300)).to_rfc2822();
        headers.insert("retry-after", date.parse().unwrap());
        assert_eq!(
            rate_limit_details(429, true, &headers, body, now)
                .unwrap()
                .1,
            Some(now + chrono::Duration::seconds(300))
        );
        assert!(
            rate_limit_details(
                403,
                false,
                &axum::http::HeaderMap::new(),
                &json!({"message":"Resource not accessible by integration"}),
                now
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn primary_limits_keep_rest_and_other_credentials_available() {
        use axum::{
            Json, Router,
            routing::{get, post},
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let app = Router::new().route("/graphql", post(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { ([("x-ratelimit-remaining", "0")], Json(json!({"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}))) }
        })).route("/repos/owner/repo/branches/main", get(|| async { Json(json!({"commit":{"sha":"a".repeat(40)}})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let github = Github::new(Access::for_api(&origin, Some("one".into())).unwrap());
        assert_eq!(
            github
                .pull_request_states(&[("owner/repo".into(), 7)])
                .await
                .unwrap_err()
                .code,
            "provider-rate-limited"
        );
        assert_eq!(
            github.get_branch_head("owner/repo", "main").await.unwrap(),
            Some("a".repeat(40))
        );
        let other = Github::new(Access::for_api(&origin, Some("two".into())).unwrap());
        assert!(
            other
                .pull_request_states(&[("owner/repo".into(), 7)])
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn partial_rate_limited_batches_keep_results_and_pause_later_requests() {
        let (github, server) = fake_api(vec![], vec![("query", json!({
            "data":{"p0":{"pullRequest":{"number":7,"url":"https://github.com/owner/repo/pull/7","headRefOid":"a".repeat(40),"state":"MERGED","mergedAt":"2026-09-10T02:32:47Z"}},"p1":null},
            "errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]
        }))]).await;
        let observed = github
            .pull_request_states(&[("owner/repo".into(), 7), ("missing/repo".into(), 8)])
            .await
            .unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0]["number"], 7);
        assert_eq!(
            github
                .get_branch_head("owner/repo", "main")
                .await
                .unwrap_err()
                .code,
            "provider-rate-limited"
        );
        server.abort();
    }

    #[tokio::test]
    async fn repository_identity_reads_compare_ids_through_the_shared_transport() {
        let (github, server) = fake_api(
            vec![
                ("/repos/owner/old", 200, json!({"id":7})),
                ("/repos/owner/renamed", 200, json!({"id":7})),
                ("/repos/owner/other", 200, json!({"id":8})),
            ],
            vec![],
        )
        .await;
        assert!(
            github
                .same_repository("owner/old", "owner/renamed")
                .await
                .unwrap()
        );
        assert!(
            !github
                .same_repository("owner/old", "owner/other")
                .await
                .unwrap()
        );
        server.abort();
    }

    #[tokio::test]
    async fn conditional_reads_share_secondary_cooldowns_with_graphql() {
        let (github, server) = fake_api(
            vec![(
                "/events",
                429,
                json!({"message":"secondary rate limit exceeded"}),
            )],
            vec![],
        )
        .await;
        let first = github
            .changed_since("/events", Some("etag"), "events")
            .await
            .unwrap_err();
        let next = github
            .pull_request_states(&[("owner/repo".into(), 7)])
            .await
            .unwrap_err();
        assert_eq!(first.code, "provider-rate-limited");
        assert_eq!(next, first);
        assert_eq!(
            github
                .same_repository("owner/repo", "owner/other")
                .await
                .unwrap_err(),
            first
        );
        server.abort();
    }

    #[tokio::test]
    async fn rate_limits_stop_observation_requests_from_recreated_clients() {
        use axum::{Json, Router};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        for (status, body) in [
            (
                200,
                json!({"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 566793."}]}),
            ),
            (429, json!({"message":"API rate limit exceeded"})),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let counted = calls.clone();
            let reset = Utc::now().timestamp() + 600;
            let app = Router::new().fallback(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                let body = body.clone();
                async move {
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        [
                            ("x-ratelimit-remaining", "0".to_owned()),
                            ("x-ratelimit-reset", reset.to_string()),
                        ],
                        Json(body),
                    )
                }
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let github = Github::new(Access::for_api(&origin, Some("fixture".into())).unwrap());
            let error = github
                .observe_pull_request("owner/repo", "task", Some(7))
                .await
                .unwrap_err();
            assert_eq!(error.code, "provider-rate-limited");
            assert_eq!(
                error.retry_at,
                Some(rfc3339_millis(DateTime::from_timestamp(reset, 0).unwrap()))
            );
            drop(github);
            for _ in 0..3 {
                let github = Github::new(Access::for_api(&origin, Some("fixture".into())).unwrap());
                assert_eq!(
                    github
                        .pull_request_states(&[("owner/repo".into(), 7)])
                        .await
                        .unwrap_err()
                        .code,
                    "provider-rate-limited"
                );
            }
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            server.abort();
        }
    }

    #[tokio::test]
    async fn writes_reach_github_during_an_observation_cooldown() {
        let (github, server) = fake_api(
            vec![
                (
                    "/repos/owner/repo/branches/main",
                    429,
                    json!({"message":"API rate limit exceeded"}),
                ),
                (
                    "/repos/owner/repo/pulls/7/merge",
                    200,
                    json!({"merged":true}),
                ),
            ],
            vec![],
        )
        .await;
        assert_eq!(
            github
                .get_branch_head("owner/repo", "main")
                .await
                .unwrap_err()
                .code,
            "provider-rate-limited"
        );
        let (status, _) = github
            .raw("PUT", "/repos/owner/repo/pulls/7/merge", Some(&json!({})))
            .await
            .unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            github
                .get_branch_head("owner/repo", "main")
                .await
                .unwrap_err()
                .code,
            "provider-rate-limited"
        );
        server.abort();
    }

    #[tokio::test]
    async fn batch_graphql_rate_limits_keep_provider_diagnostics() {
        let (github, server) = fake_api(vec![], vec![("query", json!({"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 566793."}]}))]).await;
        let error = github
            .pull_request_states(&[("owner/repo".into(), 7)])
            .await
            .unwrap_err();
        assert_eq!(error.code, "provider-rate-limited");
        assert!(error.summary.contains("rate limit already exceeded"));
        assert!(error.retry_at.is_some());
        server.abort();
    }

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
            observed.author.unwrap().avatar_url,
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
        let issue: GithubIssue = serde_json::from_value(json!({"number":42,"url":"https://github.com/owner/repo/issues/42","title":"Search","body":"","author":null,"state":"OPEN","labels":{"nodes":[]},"assignees":{"nodes":[]},"milestone":null,"updatedAt":"2026-09-07",
            "comments":[{"html_url":"https://github.com/owner/repo/issues/42#issuecomment-1","body":"Detail","user":null,"created_at":"2026-09-07"}]})).unwrap();
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

    /// A loopback GitHub answering REST paths from `rest` and GraphQL queries
    /// by the first `graph` entry whose marker the query contains.
    async fn fake_api(
        rest: Vec<(&'static str, u16, Value)>,
        graph: Vec<(&'static str, Value)>,
    ) -> (Github, tokio::task::JoinHandle<()>) {
        use axum::{
            Json, Router,
            http::{StatusCode, Uri},
            response::IntoResponse,
            routing::post,
        };
        let graph = std::sync::Arc::new(graph);
        let rest = std::sync::Arc::new(rest);
        let app = Router::new()
            .route(
                "/graphql",
                post(move |Json(body): Json<Value>| {
                    let graph = graph.clone();
                    async move {
                        let query = body["query"].as_str().unwrap_or_default().to_owned();
                        let reply = graph
                            .iter()
                            .find(|(marker, _)| query.contains(marker))
                            .map(|(_, reply)| reply.clone())
                            .unwrap_or(Value::Null);
                        Json(reply)
                    }
                }),
            )
            .fallback(move |uri: Uri| {
                let rest = rest.clone();
                async move {
                    let key = uri.path_and_query().map_or("", |value| value.as_str());
                    match rest.iter().find(|(path, _, _)| *path == key) {
                        Some((_, status, body)) => {
                            (StatusCode::from_u16(*status).unwrap(), Json(body.clone()))
                                .into_response()
                        }
                        None => {
                            (StatusCode::NOT_FOUND, Json(json!({"message": key}))).into_response()
                        }
                    }
                }
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut github = Github::new(Access::for_api(&base, None).unwrap());
        github.retry_pauses.clear();
        (github, server)
    }

    #[tokio::test]
    async fn issue_reads_keep_the_gh_issue_shape_and_context_text() {
        let (github, server) = fake_api(
            vec![
                (
                    "/repos/owner/repo/issues/42",
                    200,
                    json!({"number": 42, "html_url": "https://github.com/owner/repo/issues/42", "title": "Search", "body": null,
                        "user": {"login": "octo", "id": 1}, "state": "open", "labels": [{"name": "bug", "color": "f00"}, {"name": ""}],
                        "assignees": [{"login": "dev", "id": 2}], "milestone": {"title": "M1"}, "updated_at": "2026-09-07T00:00:00Z"}),
                ),
                (
                    "/repos/owner/repo/issues/42/comments?per_page=100&page=1",
                    200,
                    json!([{"html_url": "https://github.com/owner/repo/issues/42#issuecomment-1", "body": "Detail", "user": null, "created_at": "2026-09-08T00:00:00Z"},
                        {"html_url": "https://github.com/owner/repo/issues/42#issuecomment-2", "body": "More", "user": {"login": "dev"}, "created_at": "2026-09-09T00:00:00Z"}]),
                ),
            ],
            vec![(
                "issues(first",
                json!({"data": {"repository": {"issues": {"nodes": [
                    {"number": 3, "url": "https://github.com/owner/repo/issues/3", "title": "T", "body": "B", "author": {"login": "octo"}, "state": "OPEN",
                        "labels": {"nodes": [{"name": "bug"}]}, "assignees": {"nodes": [{"login": "dev"}]}, "milestone": null, "updatedAt": "2026-09-07T00:00:00Z"},
                    {"number": 4, "url": "https://github.com/owner/repo/issues/4", "title": "U", "body": "", "author": null, "state": "CLOSED",
                        "labels": {"nodes": []}, "assignees": {"nodes": []}, "milestone": {"title": "M1"}, "updatedAt": "2026-09-08T00:00:00Z"}
                ]}}}}),
            )],
        )
        .await;
        let issues = github.list_open_issues("owner/repo", 100).await.unwrap();
        assert_eq!(
            Value::Array(issues).to_string(),
            json!([
                {"number": 3, "url": "https://github.com/owner/repo/issues/3", "title": "T", "body": "B", "author": {"login": "octo"}, "state": "OPEN",
                    "labels": [{"name": "bug"}], "assignees": [{"login": "dev"}], "milestone": null, "updatedAt": "2026-09-07T00:00:00Z"},
                {"number": 4, "url": "https://github.com/owner/repo/issues/4", "title": "U", "body": "", "author": null, "state": "CLOSED",
                    "labels": [], "assignees": [], "milestone": {"title": "M1"}, "updatedAt": "2026-09-08T00:00:00Z"}
            ])
            .to_string()
        );
        let issue = github.get_issue("owner/repo", 42).await.unwrap();
        assert_eq!(
            issue_context(&issue),
            "## GitHub issue #42: Search\n\nhttps://github.com/owner/repo/issues/42\n\nAuthor: octo | State: OPEN | Updated: 2026-09-07T00:00:00Z\n\nLabels: bug, \n\nAssignees: dev\n\nMilestone: M1\n\n\n\n### deleted user · 2026-09-08T00:00:00Z\nhttps://github.com/owner/repo/issues/42#issuecomment-1\n\nDetail\n\n### dev · 2026-09-09T00:00:00Z\nhttps://github.com/owner/repo/issues/42#issuecomment-2\n\nMore"
        );
        assert_eq!(
            github.get_issue("owner/repo", 43).await.unwrap_err().code,
            "provider-unavailable"
        );
        server.abort();
    }

    #[tokio::test]
    async fn batched_states_and_required_checks_read_typed_graphql_rows() {
        let head = "a".repeat(40);
        let (github, server) = fake_api(
            vec![
                (
                    "/repos/owner/repo",
                    200,
                    json!({"allow_squash_merge": true, "allow_merge_commit": false, "allow_rebase_merge": false}),
                ),
                (
                    "/repos/owner/repo/pulls/7/merge",
                    405,
                    json!({"message": "Required status check \"unit\" is failing."}),
                ),
            ],
            vec![
                (
                    "p0: repository",
                    json!({"data": {
                        "p0": {"pullRequest": {"number": 7, "url": "https://github.com/owner/repo/pull/7", "headRefOid": head, "state": "MERGED", "mergedAt": "2026-09-01T00:00:00Z"}},
                        "p1": {"pullRequest": null}
                    }}),
                ),
                (
                    "isRequired",
                    json!({"data": {"repository": {"pullRequest": {"commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
                        {"__typename": "CheckRun", "name": "unit", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://github.com/owner/repo/actions/runs/1", "isRequired": true},
                        {"__typename": "StatusContext", "context": "deploy", "state": "ERROR", "targetUrl": null, "isRequired": true},
                        {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "FAILURE", "isRequired": false},
                        null
                    ]}}}}]}}}}}),
                ),
                (
                    "mergeStateStatus",
                    json!({"data": {"repository": {"pullRequest": {"id": "PR_7", "headRefOid": head, "baseRefName": "main", "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED"}}}}),
                ),
            ],
        )
        .await;
        let states = github
            .pull_request_states(&[("Owner/Repo".into(), 7), ("owner/repo".into(), 8)])
            .await
            .unwrap();
        assert_eq!(
            Value::Array(states).to_string(),
            json!([{"repository": "owner/repo", "number": 7, "url": "https://github.com/owner/repo/pull/7", "headSha": head, "state": "merged", "mergedAt": "2026-09-01T00:00:00Z"}]).to_string()
        );
        assert_eq!(
            github
                .merge_conditionally("owner/repo", 7, &head, false)
                .await
                .unwrap(),
            MergeResult::Disposition {
                disposition: MergeDisposition::Blocked,
                message: "GitHub refused the merge because required checks failed: unit (FAILURE, https://github.com/owner/repo/actions/runs/1), deploy (ERROR). Required status check \"unit\" is failing.".into(),
            }
        );
        server.abort();
    }

    #[tokio::test]
    async fn exact_head_merge_queue_requires_explicit_permission_and_preserves_reviewed_head() {
        let head = "a".repeat(40);
        let (github, server) = fake_api(
            vec![
                ("/repos/owner/repo", 200, json!({"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false})),
                ("/repos/owner/repo/pulls/7/merge", 405, json!({"message":"Merge queue required"})),
                ("/repos/owner/repo/rules/branches/main", 200, json!([{"type":"merge_queue"}])),
            ],
            vec![
                ("mergeStateStatus", json!({"data":{"repository":{"pullRequest":{"id":"PR_7","headRefOid":head,"baseRefName":"main","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED"}}}})),
                ("isRequired", json!({"data": {"repository": {"pullRequest": {"commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": []}}}}]}}}}})),
                ("enqueuePullRequest", json!({"data":{"enqueuePullRequest":{"mergeQueueEntry":{"id":"MQE_1"}}}})),
            ],
        ).await;
        let direct = github
            .merge_conditionally("owner/repo", 7, &head, false)
            .await
            .unwrap();
        assert!(
            matches!(direct, MergeResult::Disposition { disposition: MergeDisposition::Blocked, message } if message.contains("direct trigger merges cannot enter the queue"))
        );
        assert_eq!(
            github
                .merge_conditionally("owner/repo", 7, &head, true)
                .await
                .unwrap(),
            MergeResult::Disposition {
                disposition: MergeDisposition::Queued,
                message: format!("GitHub added pull request 7 at {head} to the merge queue."),
            }
        );
        server.abort();
    }

    #[tokio::test]
    async fn transient_observations_retry_to_the_third_attempt_and_then_stop() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let mut github = Github::new(Access::for_api("http://127.0.0.1:1", None).unwrap());
        github.retry_pauses = vec![std::time::Duration::ZERO, std::time::Duration::ZERO];
        let attempts = Arc::new(AtomicUsize::new(0));
        let recovered = github
            .retry_transient(|| {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                async move {
                    if attempt < 3 {
                        Err(failure("provider-unavailable", "offline"))
                    } else {
                        Ok("observed")
                    }
                }
            })
            .await
            .unwrap();
        assert_eq!(recovered, "observed");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);

        github.retry_pauses.truncate(1);
        attempts.store(0, Ordering::SeqCst);
        assert_eq!(
            github
                .retry_transient(|| {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    async { Err::<(), _>(failure("provider-unavailable", "offline")) }
                })
                .await
                .unwrap_err()
                .code,
            "provider-unavailable"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn branch_absence_requires_an_explicit_not_found_response() {
        for (status, expected) in [(404, None), (503, Some("provider-unavailable"))] {
            let (github, server) = fake_api(
                vec![(
                    "/repos/owner/repo/branches/task",
                    status,
                    json!({"message": "branch unavailable"}),
                )],
                vec![],
            )
            .await;
            let result = github.get_branch_head("owner/repo", "task").await;
            match expected {
                None => assert_eq!(result.unwrap(), None),
                Some(code) => assert_eq!(result.unwrap_err().code, code),
            }
            server.abort();
        }
    }
}
