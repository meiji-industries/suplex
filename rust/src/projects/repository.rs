use std::{
    ffi::CString,
    fs,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::LazyLock,
};

use regex::Regex;
use serde::Serialize;

use git2::{AutotagOption, Cred, CredentialType, FetchOptions, RemoteCallbacks, Repository};

use crate::integrations::github::{Access, AccessResult};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Finding {
    pub code: String,
    pub field: String,
    pub message: String,
}

fn finding(code: &str, field: &str, message: &str) -> Finding {
    Finding {
        code: code.to_owned(),
        field: field.to_owned(),
        message: message.to_owned(),
    }
}

/// How project inspection and provisioning reach GitHub. The default uses the
/// installed credential for github.com. Tests point both at local fixtures.
#[derive(Clone, Debug, Default)]
pub struct Github {
    /// API base URI and token that replace the installed credential.
    pub api: Option<(String, String)>,
    /// Git base URL that stands in for `https://github.com/`.
    pub git: Option<String>,
}

impl Github {
    pub(super) async fn access(&self) -> AccessResult<Access> {
        match &self.api {
            Some((base, token)) => Access::for_api(base, Some(token.clone())),
            None => Access::load().await,
        }
    }

    /// The token for Git and API requests. Without one, Git still tries the SSH
    /// agent and GitHub reports the missing authentication.
    pub(super) async fn token(&self) -> Option<String> {
        self.access()
            .await
            .ok()
            .and_then(|access| access.token().map(str::to_owned))
    }

    /// Route this repository's `https://github.com/` remotes to the Git fixture.
    pub(super) fn route_git(&self, repository: &Repository) -> Result<(), git2::Error> {
        if let Some(base) = &self.git {
            repository
                .config()?
                .set_str(&format!("url.{base}.insteadOf"), "https://github.com/")?;
        }
        Ok(())
    }
}

/// Git credentials: the GitHub token over HTTPS to github.com, else the SSH agent.
pub(super) fn remote_callbacks(token: Option<&str>) -> RemoteCallbacks<'_> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, username, allowed| {
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT)
            && let Some(token) = token
            && crate::tasks::worktree::token_audience_matches(url)
        {
            return Cred::userpass_plaintext("x-access-token", token);
        }
        if allowed.contains(CredentialType::SSH_KEY) {
            return Cred::ssh_key_from_agent(username.unwrap_or("git"));
        }
        Err(git2::Error::from_str("No credential for Git remote"))
    });
    callbacks
}

fn unavailable() -> Vec<Finding> {
    vec![finding(
        "repository-unavailable",
        "repositoryPath",
        "Git could not inspect the configured repository",
    )]
}

/// Check origin's identity, fetch the base branch from it, and return the
/// repository identity and fetched commit. Fetch refreshes Git's own
/// remote-tracking ref before it is read; a cached ref is not evidence of the
/// current branch head.
fn fetch_origin_branch(
    repository: &Repository,
    base_branch: &str,
    expected_host: &str,
    token: Option<&str>,
) -> Result<(String, String), Vec<Finding>> {
    let mut origin = repository
        .find_remote("origin")
        .map_err(|_| unavailable())?;
    // The configured value, not a URL rewritten by `insteadOf`.
    let remote_url = repository
        .config()
        .and_then(|config| config.get_string("remote.origin.url"))
        .map_err(|_| unavailable())?;
    static CREDENTIAL_URL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://[^/@\s]+@|(?:token|password|secret)=")
            .expect("credential URL pattern")
    });
    if CREDENTIAL_URL.is_match(&remote_url) {
        return Err(vec![finding(
            "credential-url",
            "repository",
            "Credential-bearing repository URLs are not accepted",
        )]);
    }
    let coordinate = repository_coordinate(&remote_url)
        .filter(|coordinate| coordinate.host == expected_host)
        .ok_or_else(|| {
            vec![finding(
                "repository-identity",
                "repository",
                "Origin must identify the configured repository host",
            )]
        })?;
    let mut options = FetchOptions::new();
    options
        .download_tags(AutotagOption::None)
        .remote_callbacks(remote_callbacks(token));
    let refspec = format!("refs/heads/{base_branch}:refs/remotes/origin/{base_branch}");
    origin
        .fetch(&[refspec.as_str()], Some(&mut options), None)
        .map_err(|_| unavailable())?;
    let commit = repository
        .find_reference(&format!("refs/remotes/origin/{base_branch}"))
        .and_then(|reference| reference.peel_to_commit())
        .map_err(|_| unavailable())?;
    Ok((coordinate.repository, commit.id().to_string()))
}

/// Capture the base commit from Git's origin, as task creation does in the
/// TypeScript service.
pub fn capture_local_task_heads(
    repository_path: &Path,
    base_branch: &str,
    expected_host: &str,
) -> Result<String, Vec<Finding>> {
    if !repository_path.is_dir() {
        return Err(vec![finding(
            "repository-path-missing",
            "repositoryPath",
            "The repository path does not exist on this host",
        )]);
    }
    let repository = Repository::open(repository_path).map_err(|_| unavailable())?;
    repository.workdir().ok_or_else(unavailable)?;
    repository.statuses(None).map_err(|_| unavailable())?;
    fetch_origin_branch(&repository, base_branch, expected_host, None).map(|(_, sha)| sha)
}

fn resolve(path: &Path) -> std::io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

pub fn within_root(candidate: &Path, root: &Path) -> bool {
    candidate.starts_with(root)
}

fn contains_symlink(root: &Path, candidate: &Path) -> std::io::Result<bool> {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return Ok(false);
    };
    let mut current = root.to_path_buf();
    for segment in relative.components() {
        current.push(segment);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn accessible(path: &Path, mode: libc::c_int) -> bool {
    CString::new(path.as_os_str().as_bytes())
        .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), mode) == 0 })
}

pub fn canonical_directory(
    raw: &str,
    root_raw: &Path,
    field: &str,
) -> Result<PathBuf, Vec<Finding>> {
    let trimmed = crate::identity::auth::js_trim(raw);
    if trimmed.is_empty() || trimmed.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(vec![finding(
            "path-traversal",
            field,
            "Path must be an existing canonical directory inside the configured root",
        )]);
    }
    let result = (|| -> std::io::Result<(PathBuf, PathBuf, bool)> {
        let absolute = resolve(Path::new(trimmed))?;
        let root_absolute = resolve(root_raw)?;
        let root = fs::canonicalize(&root_absolute)?;
        let canonical = fs::canonicalize(&absolute)?;
        let symlinked = contains_symlink(&root_absolute, &absolute)?;
        Ok((root, canonical, symlinked))
    })();
    let Ok((root, canonical, symlinked)) = result else {
        return Err(vec![finding(
            "path-unavailable",
            field,
            "Path or configured root is unavailable",
        )]);
    };
    let mut findings = Vec::new();
    if symlinked {
        findings.push(finding(
            "symlink-ambiguous",
            field,
            "Symlinked paths are not accepted",
        ));
    }
    if !within_root(&canonical, &root) {
        findings.push(finding(
            "path-outside-root",
            field,
            "Path is outside the configured root",
        ));
    }
    if !accessible(&canonical, libc::R_OK) {
        findings.push(finding(
            "path-unavailable",
            field,
            "Path or configured root is unavailable",
        ));
    }
    if findings.is_empty() {
        Ok(canonical)
    } else {
        Err(findings)
    }
}

pub fn writable(path: &Path) -> bool {
    accessible(path, libc::W_OK)
}

pub struct LocalProjectInput<'a> {
    pub name: &'a str,
    pub repository_path: &'a str,
    pub worktree_root: &'a str,
    pub repository: &'a str,
    pub base_branch: &'a str,
    pub setup_command: &'a str,
    pub verification_command: &'a str,
}

#[derive(Clone, Debug)]
pub struct PreparedLocalProject {
    pub(super) name: String,
    pub(super) repository_path: PathBuf,
    pub(super) worktree_root: PathBuf,
    pub(super) repository: String,
    pub(super) base_branch: String,
    pub(super) setup_command: String,
    pub(super) verification_command: String,
}

pub(crate) fn valid_name(name: &str) -> bool {
    static NAME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[\p{L}\p{N}](?:[\p{L}\p{N} ._'-]{0,78}[\p{L}\p{N}])?$")
            .expect("project name pattern")
    });
    NAME.is_match(name)
}

pub(crate) fn valid_repository(repository: &str) -> bool {
    static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
            .expect("project repository pattern")
    });
    REPOSITORY.is_match(repository)
}

pub(crate) fn valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with(['.', '/'])
        && !branch.contains("..")
        && !branch.ends_with('.')
        && !branch.ends_with(".lock")
        && !branch.contains("//")
        && branch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

pub(crate) fn valid_command(command: &str) -> bool {
    let trimmed = crate::identity::auth::js_trim(command);
    !trimmed.is_empty()
        && trimmed.encode_utf16().count() <= 500
        && !command.contains(['\r', '\n'])
        && !secret_shaped(command)
}

pub async fn prepare_local_project(
    github: &Github,
    repository_root: &Path,
    worktree_root: &Path,
    input: &LocalProjectInput<'_>,
) -> Result<PreparedLocalProject, Vec<Finding>> {
    let repository_path =
        canonical_directory(input.repository_path, repository_root, "repositoryPath");
    let worktree_path = canonical_directory(input.worktree_root, worktree_root, "worktreeRoot");
    let mut findings = Vec::new();
    if let Err(errors) = &repository_path {
        findings.extend(errors.clone());
    }
    if let Err(errors) = &worktree_path {
        findings.extend(errors.clone());
    }
    if let (Ok(repository_path), Ok(worktree_path)) = (&repository_path, &worktree_path)
        && (within_root(repository_path, worktree_path)
            || within_root(worktree_path, repository_path))
    {
        findings.push(finding(
            "worktree-separation",
            "worktreeRoot",
            "Worktree root must be separate from the repository",
        ));
    }
    let name = crate::identity::auth::js_trim(input.name);
    let repository = crate::identity::auth::js_trim(input.repository).to_ascii_lowercase();
    let base_branch = crate::identity::auth::js_trim(input.base_branch);
    if !valid_name(name) {
        findings.push(finding("invalid-name", "name", "Project name is invalid"));
    }
    if !valid_repository(&repository) {
        findings.push(finding(
            "repository-identity",
            "repository",
            "Repository must use owner/name identity without credentials",
        ));
    }
    if !valid_branch(base_branch) {
        findings.push(finding(
            "unsafe-branch",
            "baseBranch",
            "Base branch is unsafe",
        ));
    }
    if !valid_command(input.setup_command) {
        findings.push(finding(
            "unapproved-command",
            "setupCommand",
            "Command must be a single non-empty line without secrets",
        ));
    }
    if !valid_command(input.verification_command) {
        findings.push(finding(
            "unapproved-command",
            "verificationCommand",
            "Command must be a single non-empty line without secrets",
        ));
    }
    if secret_shaped(input.repository) || secret_shaped(input.base_branch) {
        findings.push(finding(
            "secret-shaped-value",
            "configuration",
            "Secret-shaped configuration values are not accepted",
        ));
    }
    if let Ok(worktree_path) = &worktree_path
        && !writable(worktree_path)
    {
        findings.push(finding(
            "worktree-unwritable",
            "worktreeRoot",
            "Worktree root must be writable",
        ));
    }
    if !findings.is_empty() {
        return Err(findings);
    }
    let repository_path = repository_path.expect("checked repository path");
    let worktree_path = worktree_path.expect("checked worktree path");
    // A failed credential load leaves Git to try the SSH agent; GitHub
    // verification then reports the missing authentication.
    let access = github.access().await.ok();
    let token = access
        .as_ref()
        .and_then(|access| access.token().map(str::to_owned));
    let (path, branch) = (repository_path.clone(), base_branch.to_owned());
    let inspection =
        tokio::task::spawn_blocking(move || inspect(&path, &branch, "github", token.as_deref()))
            .await
            .map_err(|_| unavailable())??;
    if inspection.canonical_path != repository_path {
        findings.push(finding(
            "repository-path-mismatch",
            "repositoryPath",
            "Repository path is not canonical",
        ));
    }
    if inspection.base_sha.is_empty() {
        findings.push(finding(
            "branch-unavailable",
            "baseBranch",
            "Configured branches must resolve to commits",
        ));
    }
    if inspection.remote_repository != repository {
        findings.push(finding(
            "repository-mismatch",
            "repository",
            "Local origin does not match configured repository identity",
        ));
    }
    if !findings.is_empty() {
        return Err(findings);
    }
    verify_github(access.as_ref(), &repository)
        .await
        .map_err(|error| vec![error])?;
    Ok(PreparedLocalProject {
        name: name.to_owned(),
        repository_path,
        worktree_root: worktree_path,
        repository,
        base_branch: base_branch.to_owned(),
        setup_command: crate::identity::auth::js_trim(input.setup_command).to_owned(),
        verification_command: crate::identity::auth::js_trim(input.verification_command).to_owned(),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Coordinate {
    pub host: String,
    pub repository: String,
    pub name: String,
    pub clone_url: String,
}

pub(crate) fn secret_shaped(value: &str) -> bool {
    static SECRET: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(?:gh[pousr]_|github_pat_|token\s*=|password\s*=|secret\s*=|BEGIN [A-Z ]+ PRIVATE KEY|sk-[A-Za-z0-9])")
            .expect("project secret pattern")
    });
    SECRET.is_match(value)
}

fn coordinate_parts(host: &str, path: &str, https: bool) -> Option<Coordinate> {
    let path = if https { path.strip_prefix('/')? } else { path };
    let path = if https {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    };
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let mut name = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    name = name.strip_suffix(".git").unwrap_or(name);
    let valid = |part: &str| {
        !part.is_empty()
            && ![".", ".."].contains(&part)
            && !part.starts_with('-')
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    };
    if !valid(owner) || !valid(name) {
        return None;
    }
    let kind = match host {
        "github.com" => "github".to_owned(),
        "bitbucket.org" => "bitbucket".to_owned(),
        _ => return None,
    };
    let repository = format!("{owner}/{name}").to_ascii_lowercase();
    let clone_url = if https {
        format!("https://{host}/{repository}.git")
    } else {
        format!("git@{host}:{repository}.git")
    };
    Some(Coordinate {
        host: kind,
        repository,
        name: name.to_owned(),
        clone_url,
    })
}

pub fn repository_coordinate(raw: &str) -> Option<Coordinate> {
    let raw = crate::identity::auth::js_trim(raw);
    if secret_shaped(raw) {
        return None;
    }
    if let Some(ssh) = raw.strip_prefix("git@") {
        let (host, path) = ssh.split_once(':')?;
        return coordinate_parts(host, path, false);
    }
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    coordinate_parts(url.host_str()?, url.path(), true)
}

#[derive(Clone, Debug)]
pub struct Inspection {
    pub canonical_path: PathBuf,
    pub remote_repository: String,
    pub base_sha: String,
}

/// Inspect the checkout that contains `repository_path` and fetch its origin
/// base branch.
pub fn inspect(
    repository_path: &Path,
    base_branch: &str,
    expected_host: &str,
    token: Option<&str>,
) -> Result<Inspection, Vec<Finding>> {
    let repository = Repository::discover(repository_path).map_err(|_| unavailable())?;
    let canonical_path = repository
        .workdir()
        .and_then(|path| fs::canonicalize(path).ok())
        .ok_or_else(unavailable)?;
    let (remote_repository, base_sha) =
        fetch_origin_branch(&repository, base_branch, expected_host, token)?;
    Ok(Inspection {
        canonical_path,
        remote_repository,
        base_sha,
    })
}

/// GitHub's status for a failed request, when GitHub answered.
pub(super) fn github_status(error: &octocrab::Error) -> Option<u16> {
    match error {
        octocrab::Error::GitHub { source, .. } => Some(source.status_code.as_u16()),
        _ => None,
    }
}

pub async fn verify_github(access: Option<&Access>, repository: &str) -> Result<(), Finding> {
    let failure = |code| {
        finding(
            code,
            "repository",
            "GitHub repository identity could not be verified",
        )
    };
    let access = access
        .filter(|access| access.token().is_some())
        .ok_or_else(|| failure("github-auth-unavailable"))?;
    access
        .current_user_login()
        .await
        .map_err(|_| failure("github-auth-unavailable"))?;
    let value: serde_json::Value = access
        .client()
        .get(format!("/repos/{repository}"), None::<&()>)
        .await
        .map_err(|error| {
            failure(if github_status(&error) == Some(401) {
                "github-auth-unavailable"
            } else {
                "github-repository-unavailable"
            })
        })?;
    let actual = value["full_name"].as_str().unwrap_or_default();
    let url = value["html_url"].as_str().unwrap_or_default();
    let normalized_actual = actual.trim();
    let normalized_actual = normalized_actual
        .strip_suffix(".git")
        .unwrap_or(normalized_actual);
    if normalized_actual.to_ascii_lowercase() != repository {
        return Err(failure("github-repository-unavailable"));
    }
    if actual.to_ascii_lowercase() != repository {
        return Err(finding(
            "provider-mismatch",
            "repository",
            "GitHub repository identity does not match configuration",
        ));
    }
    let parsed = url::Url::parse(url).ok();
    if parsed
        .as_ref()
        .is_none_or(|url| url.scheme() != "https" || url.host_str() != Some("github.com"))
    {
        return Err(finding(
            "provider-host",
            "repository",
            "GitHub provider returned a URL outside github.com",
        ));
    }
    let parsed = parsed.expect("checked provider URL");
    let provider_path = parsed.path().strip_prefix('/').unwrap_or(parsed.path());
    let provider_path = provider_path.strip_suffix('/').unwrap_or(provider_path);
    let provider_path = provider_path.strip_suffix(".git").unwrap_or(provider_path);
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || provider_path.to_ascii_lowercase() != repository
    {
        return Err(finding(
            "provider-path",
            "repository",
            "GitHub provider URL does not match configured repository identity",
        ));
    }
    Ok(())
}

/// Git and GitHub stand-ins for project tests, built with `git2` and a
/// loopback HTTP server instead of the `git` and `gh` executables.
#[cfg(test)]
pub(crate) mod fixtures {
    use std::path::{Path, PathBuf};

    use git2::{Repository, RepositoryInitOptions, Signature};

    pub fn init(path: &Path, bare: bool) -> Repository {
        let mut options = RepositoryInitOptions::new();
        options.bare(bare).initial_head("main");
        Repository::init_opts(path, &options).unwrap()
    }

    /// Record an empty commit on HEAD.
    pub fn commit(repository: &Repository, message: &str) -> git2::Oid {
        let signature = Signature::now("Probe", "probe@example.invalid").unwrap();
        let tree = repository
            .find_tree(repository.index().unwrap().write_tree().unwrap())
            .unwrap();
        let parent = repository
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok());
        let parents = parent.iter().collect::<Vec<_>>();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &parents,
            )
            .unwrap()
    }

    pub fn push_main(repository: &Repository, bare: &Path) {
        repository
            .remote_anonymous(bare.to_str().unwrap())
            .unwrap()
            .push(&["refs/heads/main:refs/heads/main"], None)
            .unwrap();
    }

    /// A checkout whose origin is `https://github.com/<repository>.git`, served
    /// from a local bare repository through `insteadOf`.
    pub fn github_checkout(local: &Path, bare: &Path, repository: &str) -> Repository {
        init(bare, true);
        let checkout = init(local, false);
        commit(&checkout, "initial");
        push_main(&checkout, bare);
        let url = format!("https://github.com/{repository}.git");
        checkout.remote("origin", &url).unwrap();
        checkout
            .config()
            .unwrap()
            .set_str(&format!("url.file://{}.insteadOf", bare.display()), &url)
            .unwrap();
        checkout
    }

    /// Serve `router` on loopback and return its base URI.
    pub async fn github_api(router: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        base
    }

    pub fn temporary(prefix: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::canonicalize(root).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{Json, Router, routing::get};
    use serde_json::{Value, json};

    use super::{fixtures::*, *};

    #[test]
    fn task_capture_refreshes_the_origin_branch_before_returning_its_commit() {
        let root = temporary("suplex-task-capture");
        let bare = root.join("origin.git");
        let local = root.join("repo");
        let checkout = github_checkout(&local, &bare, "acme/repo");
        let first = capture_local_task_heads(&local, "main", "github").unwrap();
        assert_eq!(first.len(), 40);

        let second = commit(&checkout, "two");
        push_main(&checkout, &bare);
        checkout
            .reference(
                "refs/remotes/origin/main",
                git2::Oid::from_str(&first).unwrap(),
                true,
                "stale observation",
            )
            .unwrap();
        assert_eq!(
            capture_local_task_heads(&local, "main", "github").unwrap(),
            second.to_string()
        );
        assert_eq!(
            capture_local_task_heads(&local, "main", "bitbucket").unwrap_err()[0].code,
            "repository-identity"
        );
        assert_eq!(
            capture_local_task_heads(&root.join("missing"), "main", "github").unwrap_err()[0].code,
            "repository-path-missing"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_path_guard_matches_local_project_boundaries() {
        let root = temporary("suplex-project-path");
        let repository = root.join("repositories/owner/project");
        let outside = root.join("outside");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            canonical_directory(
                repository.to_str().unwrap(),
                &root.join("repositories"),
                "repositoryPath"
            )
            .unwrap(),
            fs::canonicalize(&repository).unwrap()
        );
        assert_eq!(
            canonical_directory("../outside", &root.join("repositories"), "repositoryPath")
                .unwrap_err()[0]
                .code,
            "path-traversal"
        );
        assert_eq!(
            canonical_directory(
                outside.to_str().unwrap(),
                &root.join("repositories"),
                "repositoryPath"
            )
            .unwrap_err()[0]
                .code,
            "path-outside-root"
        );
        std::os::unix::fs::symlink(&repository, root.join("repositories/link")).unwrap();
        assert_eq!(
            canonical_directory(
                root.join("repositories/link").to_str().unwrap(),
                &root.join("repositories"),
                "repositoryPath"
            )
            .unwrap_err()[0]
                .code,
            "symlink-ambiguous"
        );
        assert!(writable(&repository));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn repository_coordinates_preserve_host_and_reject_credentials() {
        for value in [
            "https://github.com/meiji-industries/sampler",
            "https://github.com/meiji-industries/sampler.git",
            "git@github.com:meiji-industries/sampler.git",
        ] {
            let coordinate = repository_coordinate(value).unwrap();
            assert_eq!(coordinate.host, "github");
            assert_eq!(coordinate.repository, "meiji-industries/sampler");
            assert_eq!(coordinate.name, "sampler");
        }
        assert_eq!(
            repository_coordinate("git@github.com:meiji-industries/sampler.git")
                .unwrap()
                .clone_url,
            "git@github.com:meiji-industries/sampler.git"
        );
        assert_eq!(
            repository_coordinate("https://github.com/Owner/Repo.git/").unwrap(),
            Coordinate {
                host: "github".to_owned(),
                repository: "owner/repo".to_owned(),
                name: "Repo".to_owned(),
                clone_url: "https://github.com/owner/repo.git".to_owned(),
            }
        );
        assert_eq!(
            repository_coordinate("git@bitbucket.org:Team/Repo.git").unwrap(),
            Coordinate {
                host: "bitbucket".to_owned(),
                repository: "team/repo".to_owned(),
                name: "Repo".to_owned(),
                clone_url: "git@bitbucket.org:team/repo.git".to_owned(),
            }
        );
        for value in [
            "https://github.com/owner/repo//",
            "https://github.com/owner/repo?token=value",
            "https://user:secret@github.com/owner/repo",
            "https://token@github.com/meiji-industries/sampler.git",
            "https://gitlab.com/meiji-industries/sampler.git",
            "https://github.com/-owner/repo",
            "https://github.com/owner/../repo",
        ] {
            assert!(repository_coordinate(value).is_none(), "{value}");
        }
    }

    /// GitHub's `/user` and `/repos/{owner}/{name}` answering with `repository`.
    async fn github_with(repository: Arc<Mutex<Value>>) -> String {
        github_api(
            Router::new()
                .route("/user", get(|| async { Json(json!({"login": "acme"})) }))
                .route(
                    "/repos/{owner}/{name}",
                    get(move || {
                        let repository = repository.clone();
                        async move { Json(repository.lock().unwrap().clone()) }
                    }),
                ),
        )
        .await
    }

    #[tokio::test]
    async fn local_inspection_fetches_origin_and_checks_github_identity() {
        let root = temporary("suplex-project-inspect");
        let local = root.join("repo");
        github_checkout(&local, &root.join("bare"), "acme/repo");
        let answer = Arc::new(Mutex::new(
            json!({"full_name": "acme/repo", "html_url": "https://github.com/acme/repo"}),
        ));
        let base = github_with(answer.clone()).await;
        let github = Github {
            api: Some((base.clone(), "fixture-token".to_owned())),
            git: None,
        };

        let inspected = inspect(&local, "main", "github", None).unwrap();
        assert_eq!(inspected.remote_repository, "acme/repo");
        assert_eq!(inspected.base_sha.len(), 40);
        assert_eq!(inspected.canonical_path, local);
        assert_eq!(
            inspect(&local.join(".git"), "main", "github", None)
                .unwrap()
                .canonical_path,
            local
        );
        let access = github.access().await.unwrap();
        verify_github(Some(&access), "acme/repo").await.unwrap();

        let worktrees = root.join("worktrees");
        fs::create_dir_all(&worktrees).unwrap();
        let input = LocalProjectInput {
            name: " Local project ",
            repository_path: local.to_str().unwrap(),
            worktree_root: worktrees.to_str().unwrap(),
            repository: "ACME/REPO",
            base_branch: "main",
            setup_command: " pnpm install ",
            verification_command: " pnpm test ",
        };
        let prepared = prepare_local_project(&github, &root, &root, &input)
            .await
            .unwrap();
        assert_eq!(prepared.name, "Local project");
        assert_eq!(prepared.repository, "acme/repo");
        assert_eq!(prepared.setup_command, "pnpm install");
        let mut database = crate::platform::database::SuplexDatabase::open(
            &root.join("service.sqlite"),
            crate::platform::database::OpenMode::Migrate,
        )
        .unwrap();
        let now = chrono::Utc::now();
        let admin = crate::identity::auth::development_sign_in(&mut database, now)
            .unwrap()
            .user;
        let company = crate::identity::companies::create_company(
            &mut database,
            &admin.id,
            "Repository integration",
            now,
        )
        .unwrap();
        let created = crate::projects::service::create_local_default(
            &mut database,
            &admin.id,
            &company.id,
            &prepared,
            "profile_native_root",
            "profile_native_worker",
            now,
        )
        .unwrap();
        assert_eq!(created.repository.as_deref(), Some("acme/repo"));
        assert_eq!(Path::new(&created.repository_path), local);
        drop(database);

        let mismatch = LocalProjectInput {
            repository: "other/repository",
            ..input
        };
        assert_eq!(
            prepare_local_project(&github, &root, &root, &mismatch)
                .await
                .unwrap_err()[0]
                .code,
            "repository-mismatch"
        );
        assert_eq!(
            inspect(&local, "main", "bitbucket", None).unwrap_err()[0].code,
            "repository-identity"
        );
        assert_eq!(
            inspect(&local, "missing", "github", None).unwrap_err()[0].code,
            "repository-unavailable"
        );
        let anonymous = crate::integrations::github::Access::for_api(&base, None).unwrap();
        assert_eq!(
            verify_github(Some(&anonymous), "acme/repo")
                .await
                .unwrap_err()
                .code,
            "github-auth-unavailable"
        );
        assert_eq!(
            verify_github(None, "acme/repo").await.unwrap_err().code,
            "github-auth-unavailable"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn github_verification_rejects_other_repositories_hosts_and_paths() {
        let answer = Arc::new(Mutex::new(Value::Null));
        let base = github_with(answer.clone()).await;
        let access =
            crate::integrations::github::Access::for_api(&base, Some("fixture".into())).unwrap();
        for (full_name, url, code) in [
            (
                "other/repo",
                "https://github.com/other/repo",
                "github-repository-unavailable",
            ),
            (
                "acme/repo.git",
                "https://github.com/acme/repo",
                "provider-mismatch",
            ),
            (
                "acme/repo",
                "https://notgithub.com/acme/repo",
                "provider-host",
            ),
            (
                "acme/repo",
                "https://github.com/other/repo",
                "provider-path",
            ),
        ] {
            *answer.lock().unwrap() = json!({"full_name": full_name, "html_url": url});
            assert_eq!(
                verify_github(Some(&access), "acme/repo")
                    .await
                    .unwrap_err()
                    .code,
                code,
                "{full_name} {url}"
            );
        }
        let missing = github_api(
            Router::new()
                .route("/user", get(|| async { Json(json!({"login": "acme"})) }))
                .route(
                    "/repos/{owner}/{name}",
                    get(|| async {
                        (
                            axum::http::StatusCode::NOT_FOUND,
                            Json(json!({"message": "Not Found"})),
                        )
                    }),
                ),
        )
        .await;
        let access =
            crate::integrations::github::Access::for_api(&missing, Some("fixture".into())).unwrap();
        assert_eq!(
            verify_github(Some(&access), "acme/repo")
                .await
                .unwrap_err()
                .code,
            "github-repository-unavailable"
        );
    }

    #[test]
    fn project_fields_match_save_time_boundaries() {
        for value in ["", " leading", "trailing ", "x".repeat(81).as_str()] {
            assert!(!valid_name(value), "{value}");
        }
        assert!(valid_name("Équipe 2"));
        assert!(valid_name("Project"));
        assert!(!valid_repository("owner/-repo"));
        assert!(valid_repository("owner/repo"));
        for value in [
            "/main",
            ".branch",
            "a..b",
            "feature..token",
            "branch.lock",
            "a//b",
            "space here",
            "@bad",
        ] {
            assert!(!valid_branch(value), "{value}");
        }
        assert!(valid_branch("feature/local-project"));
        assert!(valid_command("pnpm test"));
        assert!(!valid_command("echo token =secret"));
        assert!(!valid_command("echo one\necho two"));
    }
}
