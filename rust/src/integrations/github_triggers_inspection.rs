//! Protected paths and the GitHub pull request inspection port for triggers
//! (`src/integrations/github/trigger-paths.ts`, `trigger-inspection.ts`).

use std::{collections::HashSet, fmt, sync::LazyLock};

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use super::github_delivery::{Github, GithubFailure, GithubResult, failure};
use crate::shared::encode_uri_component;

static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40,64}$").unwrap());
static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9][a-z0-9_.-]{0,99}$").unwrap()
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

pub async fn validate_label(github: &Github, name: &str, label: &str) -> GithubResult<()> {
    label_valid(label)?;
    let value = github
        .get_json(
            &format!(
                "/repos/{}/labels/{}",
                repository(name)?,
                encode_uri_component(label)
            ),
            "repository label validation",
        )
        .await?;
    match value.get("name").and_then(Value::as_str) {
        Some(found) if !found.is_empty() && found == label => Ok(()),
        _ => Err(invalid("repository label")),
    }
}

pub async fn list_open_pull_requests_by_label(
    github: &Github,
    name: &str,
    label: &str,
) -> GithubResult<Vec<i64>> {
    label_valid(label)?;
    let repo = repository(name)?;
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for page in 1.. {
        let value = github
            .get_json(
                &format!(
                    "/repos/{repo}/issues?state=open&labels={}&per_page=100&page={page}",
                    encode_uri_component(label)
                ),
                "labelled pull request enumeration",
            )
            .await?;
        let issues = value
            .as_array()
            .filter(|issues| issues.len() <= 100)
            .ok_or_else(|| invalid("labelled issue page"))?;
        for issue in issues {
            let number = issue
                .get("number")
                .and_then(Value::as_i64)
                .filter(|number| *number > 0)
                .ok_or_else(|| invalid("labelled issue page"))?;
            if issue
                .get("pull_request")
                .is_some_and(|value| !value.is_object())
            {
                return Err(invalid("labelled issue page"));
            }
            if !seen.insert(number) {
                return Err(invalid("duplicate labelled issue page"));
            }
            if issue.get("pull_request").is_some() {
                candidates.push(number);
            }
        }
        if issues.len() < 100 {
            break;
        }
    }
    Ok(candidates)
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

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
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
}
