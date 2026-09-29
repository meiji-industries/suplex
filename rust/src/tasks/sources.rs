//! TypeScript `tasks/sources.ts`: discover and pin issue, pull request, and
//! branch task sources. Git remote refs are read with `git2`; GitHub through
//! the delivery client.

use crate::projects::ProjectError;
use std::{error::Error, path::Path, sync::LazyLock};

use chrono::{DateTime, FixedOffset, TimeZone};
use git2::{AutotagOption, FetchOptions, Repository};
use regex::Regex;
use serde_json::{Value, json};

use crate::{
    integrations::{
        bitbucket::{BitbucketClient, ReleasePort},
        github_delivery::{self, Github},
        issue_tracker::IssueTracker,
    },
    projects::service::Project,
    tasks::{issue_context, repository::PreparedTask},
};

static BRANCH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._/-]{1,240}$").expect("valid regex"));

/// TypeScript `branchPattern` (the lookaheads are checked separately).
fn branch_pattern(branch: &str) -> bool {
    BRANCH.is_match(branch)
        && !branch.starts_with(['-', '.'])
        && !["..", "@{", "\\", "~", "^", ":", "?", "*", "["]
            .iter()
            .any(|part| branch.contains(part))
        && !branch.chars().any(char::is_whitespace)
}

fn failure(code: &'static str, message: &'static str, status: u16) -> Box<dyn Error> {
    super::TaskError::Source {
        status,
        code,
        message,
    }
    .into()
}

fn unavailable() -> Box<dyn Error> {
    failure(
        "source-provider-unavailable",
        "The repository source could not be read",
        503,
    )
}

fn safe_ref(branch: &str) -> Result<(), Box<dyn Error>> {
    if !branch_pattern(branch) {
        return Err(failure(
            "unsafe-branch",
            "The source branch name is unsafe",
            422,
        ));
    }
    Ok(())
}

fn safe_branch(project: &Project, branch: &str) -> Result<(), Box<dyn Error>> {
    safe_ref(branch)?;
    if branch == project.base_branch {
        return Err(failure(
            "source-base-branch",
            "The configured base branch cannot be used as a task source",
            422,
        ));
    }
    Ok(())
}

fn pinned_pull_request(
    repository: &str,
    base_branch: &str,
    pull: &github_delivery::PullRequest,
) -> Result<Value, Box<dyn Error>> {
    if pull.state != "open" {
        return Err(failure(
            "source-pull-request-closed",
            "The pull request is not open",
            422,
        ));
    }
    if pull.is_cross_repository == Some(true) || pull.repository != repository.to_lowercase() {
        return Err(failure(
            "source-unsupported-fork",
            "Fork pull requests cannot be used as task sources",
            422,
        ));
    }
    safe_ref(&pull.head_branch)?;
    if pull.head_branch == base_branch {
        return Err(failure(
            "source-base-branch",
            "The configured base branch cannot be used as a task source",
            422,
        ));
    }
    safe_ref(&pull.base_branch)?;
    Ok(
        json!({"kind": "pull_request", "number": pull.number, "url": pull.url, "headBranch": pull.head_branch, "baseBranch": pull.base_branch, "headSha": pull.head_sha, "baseSha": pull.base_sha}),
    )
}

/// Fetch origin refs with the same credential audience as other Git reads.
fn fetch(
    repository: &Repository,
    refspecs: &[&str],
    prune: bool,
    token: Option<&str>,
) -> Result<(), git2::Error> {
    if !crate::projects::git::libgit2_transport() {
        return crate::projects::git::system_fetch(repository, refspecs, prune);
    }
    let mut origin =
        crate::projects::git::origin_remote(repository, git2::Direction::Fetch, token)?;
    let callbacks = crate::projects::git::remote_callbacks(token);
    let mut options = FetchOptions::new();
    options
        .download_tags(AutotagOption::None)
        .prune(if prune {
            git2::FetchPrune::On
        } else {
            git2::FetchPrune::Off
        })
        .remote_callbacks(callbacks);
    origin.fetch(refspecs, Some(&mut options), None)
}

fn iso_strict(time: git2::Time) -> String {
    let offset = FixedOffset::east_opt(time.offset_minutes() * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC"));
    offset
        .timestamp_opt(time.seconds(), 0)
        .single()
        .map(|time: DateTime<FixedOffset>| time.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
        .unwrap_or_default()
}

/// `git for-each-ref --sort=-committerdate --count=200 refs/remotes/origin`.
fn remote_branches(
    path: &Path,
    base_branch: &str,
    token: Option<&str>,
) -> Result<Vec<Value>, Box<dyn Error>> {
    let repository = Repository::open(path).map_err(|_| unavailable())?;
    fetch(
        &repository,
        &["+refs/heads/*:refs/remotes/origin/*"],
        true,
        token,
    )
    .map_err(|_| unavailable())?;
    let mut rows = Vec::new();
    for reference in repository
        .references_glob("refs/remotes/origin/*")
        .map_err(|_| unavailable())?
        .flatten()
    {
        let Some(name) = reference
            .name()
            .ok()
            .and_then(|name| name.strip_prefix("refs/remotes/origin/"))
        else {
            continue;
        };
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        rows.push((
            commit.committer().when().seconds(),
            name.to_owned(),
            commit.id().to_string(),
            iso_strict(commit.committer().when()),
            commit.summary().ok().flatten().unwrap_or("").to_owned(),
            commit.author().name().unwrap_or("").to_owned(),
        ));
    }
    rows.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(rows
        .into_iter()
        .take(200)
        .filter(|row| row.1 != "HEAD" && row.1 != base_branch && branch_pattern(&row.1))
        .map(|(_, branch, head, updated, subject, author)| {
            json!({"kind": "branch", "branch": branch, "headSha": head, "updatedAt": updated, "subject": subject, "author": author})
        })
        .collect())
}

/// TypeScript `ProjectService`: a Bitbucket project reads sources through its own release port.
fn bitbucket(project: &Project) -> Result<Option<BitbucketClient>, Box<dyn Error>> {
    Ok(match &project.integration {
        Some(integration) => {
            ReleasePort::bitbucket(&serde_json::to_value(&integration.repository)?)
        }
        None => None,
    })
}

fn present_pull_requests(pulls: &[github_delivery::PullRequest], base_branch: &str) -> Value {
    json!({"available": true, "sources": pulls.iter().filter(|pull| pull.is_cross_repository != Some(true) && pull.state == "open" && pull.head_branch != base_branch).map(|pull| {
        let mut source = json!({
            "kind": "pull_request", "number": pull.number, "url": pull.url,
            "title": pull.title.clone().unwrap_or_else(|| format!("Pull request #{}", pull.number)),
            "body": pull.body.clone().unwrap_or_default(), "author": pull.author.clone().unwrap_or_default(),
            "headBranch": pull.head_branch, "baseBranch": pull.base_branch, "headSha": pull.head_sha,
        });
        if let Some(updated) = &pull.updated_at { source["updatedAt"] = json!(updated); }
        source["isDraft"] = json!(pull.is_draft);
        source
    }).collect::<Vec<_>>()})
}

async fn discover_pull_requests(
    repository: &str,
    base_branch: &str,
    port: &ReleasePort<'_>,
) -> Value {
    match port.list_open_pull_requests(repository, 100).await {
        Ok(pulls) => present_pull_requests(&pulls, base_branch),
        Err(_) => {
            json!({"available": false, "reason": "Pull requests are temporarily unavailable", "sources": []})
        }
    }
}

async fn resolve_pull_request(
    repository: &str,
    base_branch: &str,
    number: u64,
    port: &ReleasePort<'_>,
) -> Result<Value, Box<dyn Error>> {
    let pull = port
        .get_pull_request(repository, number)
        .await
        .map_err(|_| {
            failure(
                "source-provider-unavailable",
                "The pull request provider is temporarily unavailable",
                503,
            )
        })?;
    pinned_pull_request(repository, base_branch, &pull)
}

/// TypeScript `ProjectService.discoverTaskSources` and `TaskSourceService.discover`.
pub async fn discover(project: &Project, kind: &str) -> Result<Value, Box<dyn Error>> {
    let tracker = project
        .integration
        .as_ref()
        .map(|integration| serde_json::to_value(&integration.tracker))
        .transpose()?;
    if kind == "issue"
        && let Some(tracker) = &tracker
        && (tracker["kind"] != "github"
            || tracker["repository"].as_str().map(str::to_lowercase)
                != project.repository.as_deref().map(str::to_lowercase))
    {
        return Ok(
            json!({"available": false, "reason": "The source issue does not match the configured tracker.", "sources": []}),
        );
    }
    let bitbucket = bitbucket(project)?;
    let github = match bitbucket {
        Some(_) => None,
        None => Github::load().await.ok(),
    };
    let port = match bitbucket {
        Some(client) => Some(ReleasePort::Bitbucket(client)),
        None => github.as_ref().map(ReleasePort::Github),
    };
    match kind {
        "issue" => {
            let (Some(repository), Some(github)) = (&project.repository, &github) else {
                return Ok(json!({"available": false, "sources": []}));
            };
            match github.list_open_issues(repository, 100).await {
                Ok(issues) => Ok(
                    json!({"available": true, "sources": issues.iter().filter(|issue| issue["state"] == "OPEN").map(|issue| json!({
                    "kind": "issue", "number": issue["number"], "url": issue["url"], "title": issue["title"],
                    "body": issue["body"], "author": issue["author"]["login"].as_str().unwrap_or(""), "updatedAt": issue["updatedAt"],
                })).collect::<Vec<_>>()}),
                ),
                Err(_) => Ok(
                    json!({"available": false, "reason": "Issues are not available.", "sources": []}),
                ),
            }
        }
        "pull_request" => {
            let (Some(repository), Some(port)) = (&project.repository, &port) else {
                return Ok(
                    json!({"available": false, "reason": "Pull request provider unavailable", "sources": []}),
                );
            };
            Ok(discover_pull_requests(repository, &project.base_branch, port).await)
        }
        _ => {
            let path = project.repository_path.clone();
            let base = project.base_branch.clone();
            let token = github
                .as_ref()
                .and_then(|github| github.token().map(str::to_owned));
            let sources = tokio::task::spawn_blocking(move || {
                remote_branches(Path::new(&path), &base, token.as_deref())
                    .map_err(|error| error.to_string())
            })
            .await?
            .map_err(|_| unavailable())?;
            Ok(json!({"available": true, "sources": sources}))
        }
    }
}

/// TypeScript `ProjectService.resolveTaskSource` and `TaskSourceService.resolve`.
pub async fn resolve(project: &Project, selector: &Value) -> Result<Value, Box<dyn Error>> {
    if selector["kind"] == "issue"
        && let Some(integration) = &project.integration
    {
        let tracker = serde_json::to_value(&integration.tracker)?;
        if tracker["kind"] != "github"
            || tracker["repository"].as_str().map(str::to_lowercase)
                != project.repository.as_deref().map(str::to_lowercase)
        {
            return Err(ProjectError::new(
                "The source issue does not match the configured tracker.",
                422,
                Vec::new(),
            )
            .into());
        }
    }
    let bitbucket = bitbucket(project)?;
    let number = selector["number"].as_u64().unwrap_or(0);
    match selector["kind"].as_str() {
        Some("issue") => {
            let github = match bitbucket {
                Some(_) => None,
                None => Github::load().await.ok(),
            };
            let (Some(repository), Some(github)) = (&project.repository, github) else {
                return Err(failure(
                    "source-provider-unavailable",
                    "Issues are not available.",
                    503,
                ));
            };
            let issue = github.get_issue(repository, number).await.map_err(|_| {
                failure(
                    "source-provider-unavailable",
                    "The issue could not be read.",
                    503,
                )
            })?;
            Ok(json!({"kind": "issue", "context": github_delivery::issue_context(&issue)}))
        }
        Some("pull_request") => {
            let Some(repository) = &project.repository else {
                return Err(failure(
                    "source-provider-unavailable",
                    "Pull requests are unavailable",
                    503,
                ));
            };
            let github;
            let port = match bitbucket {
                Some(client) => ReleasePort::Bitbucket(client),
                None => {
                    github = Github::load().await.map_err(|_| {
                        failure(
                            "source-provider-unavailable",
                            "The pull request provider is temporarily unavailable",
                            503,
                        )
                    })?;
                    ReleasePort::Github(&github)
                }
            };
            resolve_pull_request(repository, &project.base_branch, number, &port).await
        }
        _ => {
            let branch = selector["branch"].as_str().unwrap_or("").to_owned();
            safe_branch(project, &branch)?;
            let token = match bitbucket {
                Some(_) => None,
                None => Github::load().await.ok(),
            }
            .and_then(|github| github.token().map(str::to_owned));
            let path = project.repository_path.clone();
            let fetched = branch.clone();
            let head = tokio::task::spawn_blocking(move || -> Result<String, git2::Error> {
                let repository = Repository::open(&path)?;
                fetch(
                    &repository,
                    &[&format!(
                        "refs/heads/{fetched}:refs/remotes/origin/{fetched}"
                    )],
                    true,
                    token.as_deref(),
                )?;
                Ok(repository
                    .revparse_single(&format!("refs/remotes/origin/{fetched}^{{commit}}"))?
                    .id()
                    .to_string())
            })
            .await?
            .map_err(|_| unavailable())?;
            Ok(json!({"kind": "branch", "branch": branch, "headSha": head}))
        }
    }
}

/// The task creation inputs TypeScript `createTask` derives from a source and issue.
pub struct CreationSource {
    pinned: Option<Value>,
    selector: Option<Value>,
    issue: Option<Value>,
    description: Option<String>,
}

#[cfg(test)]
pub(crate) fn captured_pull_request_for_test(
    number: i64,
    head_sha: &str,
    base_sha: &str,
) -> CreationSource {
    CreationSource {
        pinned: Some(
            json!({"kind":"pull_request","number":number,"url":format!("https://github.com/owner/repo/pull/{number}"),"headBranch":"feature","baseBranch":"main","headSha":head_sha,"baseSha":base_sha}),
        ),
        selector: Some(json!({"kind":"pull_request","number":number})),
        issue: None,
        description: None,
    }
}

/// Resolve the source selector and the linked issue before the task is written.
pub async fn creation_source(
    project: &Project,
    title: &str,
    description: &str,
    source: Option<&Value>,
    issue: Option<Option<&Value>>,
) -> Result<CreationSource, Box<dyn Error>> {
    let pinned = match source {
        Some(selector) => Some(resolve(project, selector).await?),
        None => None,
    };
    let repository = project.repository.clone().unwrap_or_default();
    let resolved_issue = match issue {
        Some(Some(issue)) => {
            let mut configuration = json!({"repository": repository});
            if let Some(integration) = &project.integration {
                configuration["integration"] = serde_json::to_value(integration)?;
            }
            let tracker = IssueTracker::new(&issue_context::task_tracker(&configuration)?)
                .await
                .map_err(|error| error.to_string())?;
            Some(
                tracker
                    .read(issue)
                    .await
                    .map_err(|error| error.to_string())?["issue"]
                    .clone(),
            )
        }
        None if source.is_some_and(|source| source["kind"] == "issue") => {
            let number = &source.expect("issue source")["number"];
            Some(
                json!({"kind": "github", "repository": repository, "number": number, "id": number.to_string(), "key": format!("#{number}"), "title": title, "url": format!("https://github.com/{repository}/issues/{number}")}),
            )
        }
        _ => None,
    };
    let description = match (&pinned, issue) {
        (Some(pinned), None) if pinned["kind"] == "issue" => {
            let context = pinned["context"].as_str().unwrap_or("");
            Some(if description.is_empty() {
                context.to_owned()
            } else {
                format!("{description}\n\n{context}")
            })
        }
        _ => None,
    };
    Ok(CreationSource {
        pinned,
        selector: source.cloned(),
        issue: resolved_issue,
        description,
    })
}

/// Apply a resolved source to the prepared task configuration and delivery intent.
pub fn apply(prepared: &mut PreparedTask, created: CreationSource) -> serde_json::Result<()> {
    if let Some(description) = created.description {
        prepared.description = description;
    }
    prepared.issue = created.issue;
    let configuration = &mut prepared.configuration;
    configuration["source"] = created.selector.unwrap_or(Value::Null);
    if let Some(pinned) = &created.pinned {
        match pinned["kind"].as_str() {
            Some("pull_request") => {
                configuration["branch"] = pinned["headBranch"].clone();
                configuration["baseBranch"] = pinned["baseBranch"].clone();
                configuration["baselineSha"] = pinned["baseSha"].clone();
                configuration["startingSha"] = pinned["headSha"].clone();
            }
            Some("branch") => {
                configuration["branch"] = pinned["branch"].clone();
                configuration["startingSha"] = pinned["headSha"].clone();
            }
            _ => {}
        }
    }
    prepared.delivery_intent = serde_json::from_value(json!({
        "repository": configuration["repository"], "headBranch": configuration["branch"],
        "baseBranch": configuration["baseBranch"], "baselineSha": configuration["baselineSha"],
        "pullRequestNumber": if configuration["source"]["kind"] == "pull_request" { configuration["source"]["number"].clone() } else { Value::Null },
    }))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_pull() -> github_delivery::PullRequest {
        github_delivery::PullRequest {
            number: 7,
            url: "https://github.com/owner/repo/pull/7".into(),
            repository: "owner/repo".into(),
            head_branch: "feature".into(),
            base_branch: "main".into(),
            head_sha: "b".repeat(40),
            base_sha: "a".repeat(40),
            is_draft: true,
            state: "open".into(),
            merged_at: None,
            auto_merge_enabled: None,
            title: None,
            body: None,
            author: None,
            updated_at: None,
            is_cross_repository: None,
            node_id: None,
        }
    }

    #[test]
    fn pull_request_discovery_shapes_open_same_repository_sources_only() {
        let mut fork = fixture_pull();
        fork.is_cross_repository = Some(true);
        let mut base = fixture_pull();
        base.head_branch = "main".into();
        let mut closed = fixture_pull();
        closed.state = "closed".into();
        let mut open = fixture_pull();
        open.title = Some("Feature".into());
        open.body = Some("Body".into());
        open.author = Some("octo".into());
        open.updated_at = Some("2026-09-26T00:00:00Z".into());
        assert_eq!(
            present_pull_requests(&[fork, base, closed, open], "main"),
            json!({
                "available": true,
                "sources": [{"kind":"pull_request","number":7,"url":"https://github.com/owner/repo/pull/7","title":"Feature","body":"Body","author":"octo","headBranch":"feature","baseBranch":"main","headSha":"b".repeat(40),"updatedAt":"2026-09-26T00:00:00Z","isDraft":true}]
            })
        );
    }

    #[tokio::test]
    async fn pull_request_provider_failures_do_not_expose_provider_text() {
        use axum::{Router, http::StatusCode};
        let app = Router::new()
            .fallback(|| async { (StatusCode::SERVICE_UNAVAILABLE, "token ghp_secret leaked") });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&base, Some("test-token".into())).unwrap();
        let mut github = Github::new(access);
        github.retry_pauses.clear();
        let port = ReleasePort::Github(&github);
        assert_eq!(
            discover_pull_requests("owner/repo", "main", &port).await,
            json!({"available":false,"reason":"Pull requests are temporarily unavailable","sources":[]})
        );
        let error = resolve_pull_request("owner/repo", "main", 7, &port)
            .await
            .unwrap_err();
        match error
            .downcast::<super::super::TaskError>()
            .unwrap()
            .as_ref()
        {
            super::super::TaskError::Source {
                code,
                message,
                status,
            } => {
                assert_eq!(
                    (*code, *message, *status),
                    (
                        "source-provider-unavailable",
                        "The pull request provider is temporarily unavailable",
                        503
                    )
                );
            }
            other => panic!("unexpected source error: {other:?}"),
        }
        server.abort();
    }

    #[test]
    fn repair_pull_request_rejects_closed_and_foreign_sources_and_pins_the_open_head() {
        let code = |error: Box<dyn Error>| match error
            .downcast::<super::super::TaskError>()
            .unwrap()
            .as_ref()
        {
            super::super::TaskError::Source { code, status, .. } => {
                assert_eq!(*status, 422);
                *code
            }
            other => panic!("unexpected source error: {other:?}"),
        };
        let pull = fixture_pull();
        let pinned = pinned_pull_request("owner/repo", "main", &pull).unwrap();
        assert_eq!(
            pinned,
            json!({
                "kind":"pull_request", "number":7, "url":"https://github.com/owner/repo/pull/7",
                "headBranch":"feature", "baseBranch":"main", "headSha":"b".repeat(40), "baseSha":"a".repeat(40)
            })
        );
        let mut closed = pull.clone();
        closed.state = "closed".into();
        assert_eq!(
            code(pinned_pull_request("owner/repo", "main", &closed).unwrap_err()),
            "source-pull-request-closed"
        );
        let mut fork = pull.clone();
        fork.is_cross_repository = Some(true);
        assert_eq!(
            code(pinned_pull_request("owner/repo", "main", &fork).unwrap_err()),
            "source-unsupported-fork"
        );
        let mut other_repository = pull.clone();
        other_repository.repository = "other/repo".into();
        assert_eq!(
            code(pinned_pull_request("owner/repo", "main", &other_repository).unwrap_err()),
            "source-unsupported-fork"
        );
        let mut base = pull.clone();
        base.head_branch = "main".into();
        assert_eq!(
            code(pinned_pull_request("owner/repo", "main", &base).unwrap_err()),
            "source-base-branch"
        );
    }

    #[test]
    fn branch_pattern_matches_the_source_rules() {
        for safe in ["feature/x", "a.b-c_d", "v1"] {
            assert!(branch_pattern(safe), "{safe}");
        }
        for unsafe_branch in [
            "-x", ".x", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a@{1}", "a\\b",
        ] {
            assert!(!branch_pattern(unsafe_branch), "{unsafe_branch}");
        }
    }

    #[tokio::test]
    async fn branch_discovery_reads_remote_refs_without_changing_the_checkout() {
        // The token and SSH-to-HTTPS rewrite belong to libgit2 transport.
        let _transport = crate::projects::git::fixtures::Libgit2Transport::on();
        let base = std::env::temp_dir().join(format!("suplex-sources-{}", uuid::Uuid::new_v4()));
        let origin = base.join("origin");
        let work = base.join("work");
        let signature = git2::Signature::now("Fixture", "fixture@example.invalid").unwrap();
        let upstream = Repository::init(&origin).unwrap();
        upstream.set_head("refs/heads/main").unwrap();
        let tree = upstream.treebuilder(None).unwrap().write().unwrap();
        let tree = upstream.find_tree(tree).unwrap();
        let main = upstream
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "Seed",
                &tree,
                &[],
            )
            .unwrap();
        let main = upstream.find_commit(main).unwrap();
        upstream
            .commit(
                Some("refs/heads/feature/one"),
                &signature,
                &signature,
                "Feature subject\n\nBody",
                &tree,
                &[&main],
            )
            .unwrap();
        let clone = Repository::clone(origin.to_str().unwrap(), &work).unwrap();
        let head = clone.head().unwrap().name().map(str::to_owned);
        let rows = remote_branches(&work, "main", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["branch"], "feature/one");
        assert_eq!(rows[0]["subject"], "Feature subject");
        assert_eq!(rows[0]["author"], "Fixture");
        let project = Project {
            integration: None,
            execution: None,
            id: "project".into(),
            company_id: "company".into(),
            name: "Project".into(),
            repository_path: work.to_string_lossy().into_owned(),
            worktree_root: base.join("worktrees").to_string_lossy().into_owned(),
            repository: Some("acme/repo".into()),
            base_branch: "main".into(),
            setup_command: String::new(),
            verification_command: String::new(),
            root_profile_id: "root".into(),
            worker_profile_id: "worker".into(),
            alt_profile_id: "alt".into(),
            agent_task_policy: serde_json::from_value(json!({
                "workflowIds": ["standard"], "defaultWorkflowId": "standard",
                "rootProfileIds": ["root"], "workerProfileIds": ["worker"]
            }))
            .unwrap(),
            provider_policy: None,
            created_at: "2026-09-26T00:00:00Z".into(),
            updated_at: "2026-09-26T00:00:00Z".into(),
        };
        assert_eq!(
            resolve(&project, &json!({"kind":"branch","branch":"feature/one"}))
                .await
                .unwrap()["headSha"],
            json!(rows[0]["headSha"])
        );
        let branch_head = upstream
            .find_commit(upstream.refname_to_id("refs/heads/feature/one").unwrap())
            .unwrap();
        let newer = upstream
            .commit(
                Some("refs/heads/feature/one"),
                &signature,
                &signature,
                "Updated feature",
                &tree,
                &[&branch_head],
            )
            .unwrap();
        assert_eq!(
            resolve(&project, &json!({"kind":"branch","branch":"feature/one"}))
                .await
                .unwrap(),
            json!({"kind":"branch","branch":"feature/one","headSha":newer.to_string()})
        );
        assert_eq!(clone.head().unwrap().name().map(str::to_owned), head);
        let code = |error: Box<dyn Error>| match error
            .downcast::<super::super::TaskError>()
            .unwrap()
            .as_ref()
        {
            super::super::TaskError::Source { code, .. } => *code,
            other => panic!("unexpected source error: {other:?}"),
        };
        assert_eq!(
            code(
                resolve(&project, &json!({"kind":"branch","branch":"main"}))
                    .await
                    .unwrap_err()
            ),
            "source-base-branch"
        );
        let updated_rows = remote_branches(&work, "main", None).unwrap();
        clone
            .remote_set_url("origin", "git@github.com:acme/repo.git")
            .unwrap();
        clone
            .config()
            .unwrap()
            .set_str(
                &format!("url.file://{}.insteadOf", origin.display()),
                "https://github.com/acme/repo.git",
            )
            .unwrap();
        assert_eq!(
            remote_branches(&work, "main", Some("fixture-token")).unwrap(),
            updated_rows
        );
        assert_eq!(clone.head().unwrap().name().map(str::to_owned), head);
        upstream
            .find_reference("refs/heads/feature/one")
            .unwrap()
            .delete()
            .unwrap();
        assert_eq!(
            code(
                resolve(&project, &json!({"kind":"branch","branch":"feature/one"}))
                    .await
                    .unwrap_err()
            ),
            "source-provider-unavailable"
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}
