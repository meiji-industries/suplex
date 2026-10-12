//! Protected paths and the GitHub pull request inspection port for triggers
//! (`src/integrations/github/trigger-paths.ts`, `trigger-inspection.ts`).

use std::{collections::HashSet, fmt, sync::LazyLock};

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use super::github_delivery::{Github, GithubFailure, GithubResult, failure};
use crate::shared::encode_uri_component;

static SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40,64}$").expect("valid regex"));
static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9][a-z0-9_.-]{0,99}$").expect("valid regex")
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubTriggerPathError(pub String);

impl fmt::Display for GithubTriggerPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for GithubTriggerPathError {}

fn repository_relative(value: &str, allow_directory_prefix: bool) -> bool {
    let bytes = value.as_bytes();
    if value.is_empty()
        || value.starts_with('/')
        || value.contains('\\')
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
    {
        return false;
    }
    let directory = value.ends_with('/');
    if directory && !allow_directory_prefix {
        return false;
    }
    let mut parts = value.split('/').collect::<Vec<_>>();
    if directory {
        parts.pop();
    }
    !parts.is_empty() && parts.iter().all(|part| !matches!(*part, "" | "." | ".."))
}

pub fn validate_repository_filename(value: &str) -> Result<&str, GithubTriggerPathError> {
    if !repository_relative(value, false) {
        return Err(GithubTriggerPathError(format!(
            "Repository filename is unsafe: {value}"
        )));
    }
    Ok(value)
}

pub fn validate_protected_paths(paths: &[String]) -> Result<(), GithubTriggerPathError> {
    for path in paths {
        if !repository_relative(path, true) || path.contains(['*', '?', '[', ']', '{', '}', '!']) {
            return Err(GithubTriggerPathError(format!(
                "Protected path is unsafe: {path}"
            )));
        }
    }
    Ok(())
}

pub fn matches_protected_paths(
    paths: &[String],
    filename: &str,
    previous_filename: Option<&str>,
) -> Result<bool, GithubTriggerPathError> {
    validate_protected_paths(paths)?;
    let names = std::iter::once(filename)
        .chain(previous_filename)
        .collect::<Vec<_>>();
    for name in &names {
        validate_repository_filename(name)?;
    }
    Ok(names.iter().any(|name| {
        paths.iter().any(|path| {
            if path.ends_with('/') {
                name.starts_with(path.as_str())
            } else {
                name == path
            }
        })
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repository {
    pub id: i64,
    pub full_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerFile {
    pub filename: String,
    pub previous_filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestInspection {
    pub number: i64,
    pub url: String,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub labels: Vec<String>,
    pub head_sha: String,
    pub head_branch: String,
    pub base_sha: String,
    pub base_branch: String,
    pub head_repository: Option<Repository>,
    pub base_repository: Repository,
    pub is_cross_repository: bool,
    pub files: Vec<TriggerFile>,
}

impl PullRequestInspection {
    /// Every current or previous filename that a protected path covers.
    pub fn matching_paths(&self, protected: &[String]) -> Vec<String> {
        self.files
            .iter()
            .flat_map(|file| std::iter::once(&file.filename).chain(&file.previous_filename))
            .filter(|path| matches_protected_paths(protected, path, None).unwrap_or(false))
            .cloned()
            .collect()
    }
}

fn invalid(message: &str) -> GithubFailure {
    failure(
        "invalid-provider-response",
        format!("GitHub trigger response is malformed: {message}"),
    )
}

fn repository(value: &str) -> GithubResult<String> {
    if REPOSITORY.is_match(value) {
        Ok(value.to_lowercase())
    } else {
        Err(invalid("repository"))
    }
}

#[derive(Deserialize)]
struct RepoRef {
    id: i64,
    full_name: String,
}

#[derive(Deserialize)]
struct Side {
    #[serde(rename = "ref")]
    reference: String,
    sha: String,
    repo: Option<RepoRef>,
}

#[derive(Deserialize)]
struct Label {
    name: String,
}

#[derive(Deserialize)]
struct PullDetail {
    number: i64,
    html_url: String,
    state: String,
    draft: bool,
    changed_files: i64,
    labels: Vec<Label>,
    title: String,
    head: Side,
    base: Side,
}

fn pull(value: Value) -> GithubResult<PullDetail> {
    let mut detail: PullDetail =
        serde_json::from_value(value).map_err(|_| invalid("pull request"))?;
    let side_valid = |side: &Side| {
        !side.reference.is_empty()
            && SHA.is_match(&side.sha)
            && side
                .repo
                .as_ref()
                .is_none_or(|repo| repo.id > 0 && REPOSITORY.is_match(&repo.full_name))
    };
    if detail.number <= 0
        || url::Url::parse(&detail.html_url).is_err()
        || !matches!(detail.state.as_str(), "open" | "closed")
        || detail.labels.iter().any(|label| label.name.is_empty())
        || !side_valid(&detail.head)
        || !side_valid(&detail.base)
        || detail.base.repo.is_none()
    {
        return Err(invalid("pull request"));
    }
    for side in [&mut detail.head, &mut detail.base] {
        if let Some(repo) = &mut side.repo {
            repo.full_name = repo.full_name.to_lowercase();
        }
    }
    if detail.changed_files > 3000 {
        return Err(invalid("pull request has more than 3000 changed files"));
    }
    Ok(detail)
}

fn stable(a: &PullDetail, b: &PullDetail) -> bool {
    let (a_base, b_base) = (a.base.repo.as_ref(), b.base.repo.as_ref());
    a.number == b.number
        && a_base.map(|repo| &repo.full_name) == b_base.map(|repo| &repo.full_name)
        && a.head.sha == b.head.sha
        && a.base.sha == b.base.sha
        && a.changed_files == b.changed_files
        && a.head.reference == b.head.reference
        && a.base.reference == b.base.reference
        && a.head.repo.as_ref().map(|repo| repo.id) == b.head.repo.as_ref().map(|repo| repo.id)
        && a_base.map(|repo| repo.id) == b_base.map(|repo| repo.id)
}

const FILE_STATUSES: &[&str] = &[
    "added",
    "modified",
    "removed",
    "renamed",
    "copied",
    "changed",
    "unchanged",
];

fn file(value: &Value) -> GithubResult<TriggerFile> {
    let text = |name: &str| value.get(name).and_then(Value::as_str);
    let count = |name: &str| value.get(name).and_then(Value::as_u64);
    let url = |name: &str| text(name).is_some_and(|value| url::Url::parse(value).is_ok());
    let previous = match value.get("previous_filename") {
        None => None,
        Some(Value::String(name)) if !name.is_empty() => Some(name.clone()),
        Some(_) => return Err(invalid("pull request file")),
    };
    let (Some(filename), Some(status)) = (text("filename"), text("status")) else {
        return Err(invalid("pull request file"));
    };
    if text("sha").is_none_or(str::is_empty)
        || filename.is_empty()
        || !FILE_STATUSES.contains(&status)
        || ["additions", "deletions", "changes"]
            .iter()
            .any(|name| count(name).is_none())
        || !["blob_url", "raw_url", "contents_url"]
            .iter()
            .all(|name| url(name))
    {
        return Err(invalid("pull request file"));
    }
    validate_repository_filename(filename).map_err(|_| invalid("pull request filename"))?;
    if (status == "renamed") != previous.is_some() {
        return Err(invalid("pull request rename metadata"));
    }
    if let Some(previous) = &previous {
        validate_repository_filename(previous)
            .map_err(|_| invalid("previous pull request filename"))?;
    }
    Ok(TriggerFile {
        filename: filename.to_owned(),
        previous_filename: previous,
    })
}

fn label_valid(label: &str) -> GithubResult<()> {
    if label.is_empty() || label.encode_utf16().count() > 100 {
        return Err(invalid("label"));
    }
    Ok(())
}

/// TypeScript `createGithubTriggerPort` over the authenticated GitHub REST client.
pub async fn observe_repository(github: &Github, name: &str) -> GithubResult<Repository> {
    let value = github
        .get_json(
            &format!("/repos/{}", repository(name)?),
            "repository trigger observation",
        )
        .await?;
    let parsed: RepoRef =
        serde_json::from_value(value).map_err(|_| invalid("repository identity"))?;
    if parsed.id <= 0 || !REPOSITORY.is_match(&parsed.full_name) {
        return Err(invalid("repository identity"));
    }
    Ok(Repository {
        id: parsed.id,
        full_name: parsed.full_name.to_lowercase(),
    })
}

pub async fn validate_label(github: &Github, name: &str, label: &str) -> GithubResult<bool> {
    label_valid(label)?;
    let Some(value) = github
        .get_optional_json(
            &format!(
                "/repos/{}/labels/{}",
                repository(name)?,
                encode_uri_component(label)
            ),
            "repository label validation",
        )
        .await?
    else {
        return Ok(false);
    };
    match value.get("name").and_then(Value::as_str) {
        Some(found) if !found.is_empty() && found == label => Ok(true),
        _ => Err(invalid("repository label")),
    }
}

pub async fn list_repository_labels(
    github: &Github,
    name: &str,
) -> GithubResult<Vec<crate::http::contracts::typed::github_triggers::GithubRepositoryLabel>> {
    let repo = repository(name)?;
    let mut labels = Vec::new();
    for page in 1.. {
        let value = github
            .get_json(
                &format!("/repos/{repo}/labels?per_page=100&page={page}"),
                "repository label enumeration",
            )
            .await?;
        let rows: Vec<crate::http::contracts::typed::github_triggers::GithubRepositoryLabel> =
            serde_json::from_value(value).map_err(|_| invalid("repository labels"))?;
        if rows.len() > 100
            || rows.iter().any(|label| {
                label_valid(&label.name).is_err()
                    || label.color.len() != 6
                    || !label.color.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(invalid("repository labels"));
        }
        let last = rows.len() < 100;
        labels.extend(rows);
        if last {
            break;
        }
    }
    Ok(labels)
}

crate::shared::wire_enum! {
    /// The order in which a trigger admits its labelled pull requests.
    pub enum TriggerSortOrder {
        CreatedAsc = "created_asc",
        CreatedDesc = "created_desc",
        LabeledAsc = "labeled_asc",
        LabeledDesc = "labeled_desc",
    }
}

const LABELLED_PULL_REQUESTS: &str = "query($owner:String!,$name:String!,$label:String!,$after:String,$direction:OrderDirection!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,labels:[$label],first:100,after:$after,orderBy:{field:CREATED_AT,direction:$direction}){pageInfo{hasNextPage endCursor}nodes{number url baseRefName isDraft isCrossRepository createdAt timelineItems(itemTypes:LABELED_EVENT,last:100){nodes{...on LabeledEvent{createdAt label{name}}}}}}}}";

#[derive(Deserialize)]
struct LabelledPage {
    data: LabelledData,
}

#[derive(Deserialize)]
struct LabelledData {
    repository: Option<LabelledRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelledRepository {
    pull_requests: LabelledConnection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelledConnection {
    page_info: PageInfo,
    nodes: Vec<LabelledPullRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelledPullRequest {
    number: i64,
    created_at: String,
    timeline_items: LabelEvents,
    // The enumeration carries enough to exclude most candidates without a REST inspection.
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    base_ref_name: Option<String>,
    #[serde(default)]
    is_draft: Option<bool>,
    #[serde(default)]
    is_cross_repository: Option<bool>,
}

#[derive(Deserialize)]
struct LabelEvents {
    nodes: Vec<LabelEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelEvent {
    created_at: String,
    label: LabelName,
}

#[derive(Deserialize)]
struct LabelName {
    name: String,
}

/// The most recently updated open issue with `label`. Labelling a pull request
/// updates it, so this page's ETag changes whenever a candidate may have appeared.
pub fn labelled_change_path(name: &str, label: &str) -> GithubResult<String> {
    label_valid(label)?;
    Ok(format!(
        "/repos/{}/issues?state=open&labels={}&sort=updated&direction=desc&per_page=1",
        repository(name)?,
        encode_uri_component(label)
    ))
}

/// Open pull requests with `label`, in admission order.
pub async fn list_open_pull_requests_by_label(
    github: &Github,
    name: &str,
    label: &str,
    order: TriggerSortOrder,
) -> GithubResult<Vec<i64>> {
    Ok(list_labelled_candidates(github, name, label, order)
        .await?
        .into_iter()
        .map(|pull| pull.number)
        .collect())
}

/// What the labelled enumeration knows about one pull request. A `None`
/// field was not in the response and needs the REST inspection.
#[derive(Debug, Clone, PartialEq)]
pub struct LabelledCandidate {
    pub number: i64,
    pub url: Option<String>,
    pub base_branch: Option<String>,
    pub is_draft: Option<bool>,
    pub is_cross_repository: Option<bool>,
}

/// Open pull requests with `label`, in admission order, with the enumeration fields.
pub async fn list_labelled_candidates(
    github: &Github,
    name: &str,
    label: &str,
    order: TriggerSortOrder,
) -> GithubResult<Vec<LabelledCandidate>> {
    label_valid(label)?;
    let repo = repository(name)?;
    let (owner, name) = repo.split_once('/').ok_or_else(|| invalid("repository"))?;
    let direction = if order == TriggerSortOrder::CreatedDesc {
        "DESC"
    } else {
        "ASC"
    };
    let mut pulls = Vec::new();
    let mut seen = HashSet::new();
    let mut after = None;
    loop {
        let page: LabelledPage = github
            .graphql(
                LABELLED_PULL_REQUESTS,
                serde_json::json!({"owner": owner, "name": name, "label": label, "after": after, "direction": direction}),
                "labelled pull request enumeration",
            )
            .await?;
        let connection = page
            .data
            .repository
            .ok_or_else(|| invalid("labelled pull request page"))?
            .pull_requests;
        if connection.nodes.len() > 100 {
            return Err(invalid("labelled pull request page"));
        }
        for pull in connection.nodes {
            let pull =
                candidate(pull, label).ok_or_else(|| invalid("labelled pull request page"))?;
            if !seen.insert(pull.number) {
                return Err(invalid("duplicate labelled pull request page"));
            }
            pulls.push(pull);
        }
        match (
            connection.page_info.has_next_page,
            connection.page_info.end_cursor,
        ) {
            (true, Some(cursor)) => after = Some(cursor),
            (true, None) => return Err(invalid("labelled pull request page")),
            (false, _) => break,
        }
    }
    Ok(order_candidates(pulls, order))
}

type Time = chrono::DateTime<chrono::FixedOffset>;

/// A labelled pull request with its creation time and the latest time its label was applied.
#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    number: i64,
    created: Time,
    labelled: Time,
    url: Option<String>,
    base_branch: Option<String>,
    is_draft: Option<bool>,
    is_cross_repository: Option<bool>,
}

fn candidate(pull: LabelledPullRequest, label: &str) -> Option<Candidate> {
    let time = |text: &str| chrono::DateTime::parse_from_rfc3339(text).ok();
    let created = time(&pull.created_at)?;
    let mut labelled = None;
    for event in pull.timeline_items.nodes {
        if event.label.name.eq_ignore_ascii_case(label) {
            labelled = labelled.max(Some(time(&event.created_at)?));
        }
    }
    (pull.number > 0).then_some(Candidate {
        number: pull.number,
        created,
        labelled: labelled.unwrap_or(created),
        url: pull.url,
        base_branch: pull.base_ref_name,
        is_draft: pull.is_draft,
        is_cross_repository: pull.is_cross_repository,
    })
}

fn order_candidates(mut pulls: Vec<Candidate>, order: TriggerSortOrder) -> Vec<LabelledCandidate> {
    use std::cmp::Reverse;
    match order {
        TriggerSortOrder::CreatedAsc => pulls.sort_by_key(|pull| (pull.created, pull.number)),
        TriggerSortOrder::CreatedDesc => {
            pulls.sort_by_key(|pull| (Reverse(pull.created), pull.number));
        }
        TriggerSortOrder::LabeledAsc => pulls.sort_by_key(|pull| (pull.labelled, pull.number)),
        TriggerSortOrder::LabeledDesc => {
            pulls.sort_by_key(|pull| (Reverse(pull.labelled), pull.number));
        }
    }
    pulls
        .into_iter()
        .map(|pull| LabelledCandidate {
            number: pull.number,
            url: pull.url,
            base_branch: pull.base_branch,
            is_draft: pull.is_draft,
            is_cross_repository: pull.is_cross_repository,
        })
        .collect()
}

pub async fn inspect_pull_request(
    github: &Github,
    name: &str,
    number: i64,
) -> GithubResult<PullRequestInspection> {
    let repo = repository(name)?;
    if number <= 0 || number > 9_007_199_254_740_991 {
        return Err(invalid("pull request number"));
    }
    let detail = |operation: &'static str| {
        let path = format!("/repos/{repo}/pulls/{number}");
        let repo = repo.clone();
        async move {
            let value = pull(github.get_json(&path, operation).await?)?;
            if value.number != number
                || value.base.repo.as_ref().map(|repo| repo.full_name.as_str())
                    != Some(repo.as_str())
            {
                return Err(invalid("pull request identity"));
            }
            Ok(value)
        }
    };
    let before = detail("pull request trigger inspection").await?;
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for page in 1.. {
        let value = github
            .get_json(
                &format!("/repos/{repo}/pulls/{number}/files?per_page=100&page={page}"),
                "pull request file inspection",
            )
            .await?;
        let rows = value
            .as_array()
            .filter(|rows| rows.len() <= 100)
            .ok_or_else(|| invalid("pull request file page"))?;
        for row in rows {
            let inspected = file(row)?;
            if !seen.insert(inspected.filename.clone()) {
                return Err(invalid("duplicate pull request filename"));
            }
            files.push(inspected);
            if files.len() as i64 > before.changed_files {
                return Err(invalid("pull request file count"));
            }
        }
        if files.len() as i64 == before.changed_files || rows.len() < 100 {
            break;
        }
    }
    if files.len() as i64 != before.changed_files {
        return Err(invalid("incomplete pull request file list"));
    }
    let after = detail("pull request trigger recheck").await?;
    if !stable(&before, &after) {
        return Err(failure(
            "inspection-changed",
            "Pull request changed while its files were inspected",
        ));
    }
    let head_repository = after.head.repo.map(|repo| Repository {
        id: repo.id,
        full_name: repo.full_name,
    });
    let base = after.base.repo.expect("validated base repository");
    let base_repository = Repository {
        id: base.id,
        full_name: base.full_name,
    };
    Ok(PullRequestInspection {
        number: after.number,
        url: after.html_url,
        title: after.title,
        state: after.state,
        is_draft: after.draft,
        labels: after.labels.into_iter().map(|label| label.name).collect(),
        head_sha: after.head.sha,
        head_branch: after.head.reference,
        base_sha: after.base.sha,
        base_branch: after.base.reference,
        is_cross_repository: head_repository
            .as_ref()
            .is_none_or(|head| head.id != base_repository.id),
        head_repository,
        base_repository,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn candidates_sort_by_creation_or_by_the_latest_time_the_label_was_applied() {
        let pull = |number: i64, created: &str, events: Value| {
            let pull: LabelledPullRequest = serde_json::from_value(json!({
                "number": number, "createdAt": created, "timelineItems": {"nodes": events},
            }))
            .unwrap();
            candidate(pull, "ready").unwrap()
        };
        let event = |label: &str, at: &str| json!({"createdAt": at, "label": {"name": label}});
        let pulls = vec![
            pull(
                1,
                "2026-01-01T00:00:00Z",
                json!([event("Ready", "2026-03-01T00:00:00Z")]),
            ),
            pull(
                2,
                "2026-01-02T00:00:00Z",
                json!([
                    event("ready", "2026-01-05T00:00:00Z"),
                    event("other", "2026-09-01T00:00:00Z"),
                    event("ready", "2026-04-01T00:00:00Z"),
                ]),
            ),
            pull(3, "2026-01-03T00:00:00Z", json!([])),
            pull(4, "2026-01-03T00:00:00Z", json!([])),
        ];
        let order = |order| {
            order_candidates(pulls.clone(), order)
                .into_iter()
                .map(|pull| pull.number)
                .collect::<Vec<_>>()
        };
        assert_eq!(order(TriggerSortOrder::CreatedAsc), [1, 2, 3, 4]);
        assert_eq!(order(TriggerSortOrder::CreatedDesc), [3, 4, 2, 1]);
        assert_eq!(order(TriggerSortOrder::LabeledAsc), [3, 4, 1, 2]);
        assert_eq!(order(TriggerSortOrder::LabeledDesc), [2, 1, 3, 4]);
        let bad: LabelledPullRequest = serde_json::from_value(json!({
            "number": 5, "createdAt": "yesterday", "timelineItems": {"nodes": []},
        }))
        .unwrap();
        assert_eq!(candidate(bad, "ready"), None);
    }

    #[test]
    fn protected_paths_are_exact_files_or_directory_prefixes() {
        let protected = paths(&["migrations/", "package.json"]);
        assert!(matches_protected_paths(&protected, "migrations/001.sql", None).unwrap());
        assert!(matches_protected_paths(&protected, "package.json", None).unwrap());
        assert!(!matches_protected_paths(&protected, "src/package.json", None).unwrap());
        assert!(!matches_protected_paths(&protected, "migrationsx/a", None).unwrap());
        assert!(matches_protected_paths(&protected, "src/new.json", Some("package.json")).unwrap());
    }

    #[test]
    fn unsafe_protected_paths_and_filenames_are_rejected() {
        for unsafe_path in [
            "", "/abs", "a\\b", "C:/x", "a/../b", "./a", "a//b", "src/*", "a?", "[x]", "{a}", "!a",
            "a\u{7}",
        ] {
            assert!(
                validate_protected_paths(&paths(&[unsafe_path])).is_err(),
                "{unsafe_path:?}"
            );
        }
        assert_eq!(
            validate_protected_paths(&paths(&["src/*"]))
                .unwrap_err()
                .to_string(),
            "Protected path is unsafe: src/*"
        );
        assert!(validate_repository_filename("dir/").is_err());
        assert!(validate_repository_filename("dir/file.rs").is_ok());
        assert!(matches_protected_paths(&paths(&["a"]), "../a", None).is_err());
    }

    #[test]
    fn pull_recheck_uses_immutable_identity_and_revision_but_returns_current_metadata() {
        let base = json!({
            "number":7,"html_url":"https://github.com/owner/repo/pull/7","state":"open","draft":false,
            "changed_files":1,"labels":[{"name":"ready"}],"title":"Before",
            "head":{"ref":"feature","sha":"a".repeat(40),"repo":{"id":9,"full_name":"owner/repo"}},
            "base":{"ref":"main","sha":"b".repeat(40),"repo":{"id":9,"full_name":"owner/repo"}}
        });
        let before = pull(base.clone()).unwrap();
        for (field, value) in [
            ("number", json!(8)),
            ("changed_files", json!(2)),
            ("head.sha", json!("c".repeat(40))),
            ("base.sha", json!("d".repeat(40))),
            ("head.ref", json!("other")),
            ("base.ref", json!("release")),
            ("head.repo.id", json!(10)),
            ("base.repo.full_name", json!("other/repo")),
        ] {
            let mut changed = base.clone();
            let mut target = &mut changed;
            for part in field.split('.') {
                target = &mut target[part];
            }
            *target = value;
            assert!(!stable(&before, &pull(changed).unwrap()), "{field}");
        }
        let mut metadata = base;
        metadata["state"] = json!("closed");
        metadata["draft"] = json!(true);
        metadata["labels"] = json!([]);
        metadata["title"] = json!("Closed now");
        assert!(stable(&before, &pull(metadata).unwrap()));
    }
}
