use std::{
    ffi::CString,
    fs,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::LazyLock,
    time::Duration,
};

use regex::Regex;
use serde::Serialize;
use tokio::{io::AsyncReadExt, process::Command};

use git2::{AutotagOption, FetchOptions, Repository};

const GIT_OUTPUT_LIMIT: usize = 16 * 1024;
const GH_OUTPUT_LIMIT: usize = 64 * 1024 * 1024;

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

/// Capture the base commit from Git's origin, as task creation does in the
/// TypeScript service. Fetch refreshes Git's own remote-tracking ref before it
/// is read; a cached ref is not evidence of the current branch head.
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
    let unavailable = || {
        vec![finding(
            "repository-unavailable",
            "repositoryPath",
            "Git could not inspect the configured repository",
        )]
    };
    let repository = Repository::open(repository_path).map_err(|_| unavailable())?;
    repository.workdir().ok_or_else(unavailable)?;
    repository.statuses(None).map_err(|_| unavailable())?;
    let mut origin = repository
        .find_remote("origin")
        .map_err(|_| unavailable())?;
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
    if repository_coordinate(&remote_url).is_none_or(|coordinate| coordinate.host != expected_host)
    {
        return Err(vec![finding(
            "repository-identity",
            "repository",
            "Origin must identify the configured repository host",
        )]);
    }
    let mut options = FetchOptions::new();
    options.download_tags(AutotagOption::None);
    let refspec = format!("refs/heads/{base_branch}:refs/remotes/origin/{base_branch}");
    origin
        .fetch(&[refspec.as_str()], Some(&mut options), None)
        .map_err(|_| unavailable())?;
    let reference = repository
        .find_reference(&format!("refs/remotes/origin/{base_branch}"))
        .map_err(|_| unavailable())?;
    let commit = reference.peel_to_commit().map_err(|_| unavailable())?;
    Ok(commit.id().to_string())
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
    commands: &Commands,
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
    let inspection = inspect(commands, &repository_path, base_branch, "github").await?;
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
    verify_github(commands, &repository_path, &repository)
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
    pub clean: bool,
    pub base_sha: String,
}

#[derive(Clone, Debug)]
pub struct Commands {
    pub git: PathBuf,
    pub gh: PathBuf,
}

impl Default for Commands {
    fn default() -> Self {
        Self {
            git: PathBuf::from("git"),
            gh: std::env::var_os("SUPLEX_GH_COMMAND")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("gh")),
        }
    }
}

async fn bounded_output(
    reader: impl tokio::io::AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    reader
        .take((maximum + 1) as u64)
        .read_to_end(&mut output)
        .await
        .map_err(|error| error.to_string())?;
    if output.len() > maximum {
        return Err("subprocess output exceeded its limit".to_owned());
    }
    Ok(output)
}

pub(super) async fn run(
    command: &Path,
    args: &[&str],
    cwd: &Path,
    seconds: u64,
    maximum: usize,
) -> Result<String, String> {
    let mut process = Command::new(command);
    process
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    tokio::time::timeout(Duration::from_secs(seconds), async move {
        let (stdout, stderr) = tokio::try_join!(
            bounded_output(stdout, maximum),
            bounded_output(stderr, maximum)
        )?;
        let status = child.wait().await.map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(String::from_utf8_lossy(&stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&stdout).trim().to_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn inspect(
    commands: &Commands,
    repository_path: &Path,
    base_branch: &str,
    expected_host: &str,
) -> Result<Inspection, Vec<Finding>> {
    let unavailable = || {
        vec![finding(
            "repository-unavailable",
            "repositoryPath",
            "Git could not inspect the configured repository",
        )]
    };
    let canonical_path = run(
        &commands.git,
        &["rev-parse", "--show-toplevel"],
        repository_path,
        8,
        GIT_OUTPUT_LIMIT,
    )
    .await
    .map_err(|_| unavailable())?;
    let status = run(
        &commands.git,
        &["status", "--porcelain", "--untracked-files=all"],
        repository_path,
        8,
        GIT_OUTPUT_LIMIT,
    )
    .await
    .map_err(|_| unavailable())?;
    let remote = run(
        &commands.git,
        &["config", "--get", "remote.origin.url"],
        repository_path,
        8,
        GIT_OUTPUT_LIMIT,
    )
    .await
    .map_err(|_| unavailable())?;
    static CREDENTIAL_URL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://[^/@\s]+@|(?:token|password|secret)=")
            .expect("credential URL pattern")
    });
    if CREDENTIAL_URL.is_match(&remote) {
        return Err(vec![finding(
            "credential-url",
            "repository",
            "Credential-bearing repository URLs are not accepted",
        )]);
    }
    let coordinate = repository_coordinate(&remote)
        .filter(|coordinate| coordinate.host == expected_host)
        .ok_or_else(|| {
            vec![finding(
                "repository-identity",
                "repository",
                "Origin must identify the configured repository host",
            )]
        })?;
    let refspec = format!("refs/heads/{base_branch}:refs/remotes/origin/{base_branch}");
    run(
        &commands.git,
        &["fetch", "--no-tags", "origin", &refspec],
        repository_path,
        30,
        GIT_OUTPUT_LIMIT,
    )
    .await
    .map_err(|_| unavailable())?;
    let base_sha = run(
        &commands.git,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/remotes/origin/{base_branch}"),
        ],
        repository_path,
        8,
        GIT_OUTPUT_LIMIT,
    )
    .await
    .map_err(|_| unavailable())?;
    Ok(Inspection {
        canonical_path: PathBuf::from(canonical_path),
        remote_repository: coordinate.repository,
        clean: status.is_empty(),
        base_sha,
    })
}

pub async fn verify_github(
    commands: &Commands,
    repository_path: &Path,
    repository: &str,
) -> Result<(), Finding> {
    let gh_failure = |message: &str| {
        static AUTH_ERROR: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new("(?i)auth|not logged in|login required|oauth|credential")
                .expect("GitHub authentication error pattern")
        });
        finding(
            if AUTH_ERROR.is_match(message) {
                "github-auth-unavailable"
            } else {
                "github-repository-unavailable"
            },
            "repository",
            "GitHub repository identity could not be verified",
        )
    };
    run(
        &commands.gh,
        &["auth", "status", "--hostname", "github.com"],
        repository_path,
        30,
        GH_OUTPUT_LIMIT,
    )
    .await
    .map_err(|_| {
        finding(
            "github-auth-unavailable",
            "repository",
            "GitHub repository identity could not be verified",
        )
    })?;
    let response = run(
        &commands.gh,
        &["repo", "view", repository, "--json", "nameWithOwner,url"],
        repository_path,
        30,
        GH_OUTPUT_LIMIT,
    )
    .await
    .map_err(|error| gh_failure(&error))?;
    let value: serde_json::Value = serde_json::from_str(&response).map_err(|_| {
        finding(
            "github-repository-unavailable",
            "repository",
            "GitHub repository identity could not be verified",
        )
    })?;
    let actual = value["nameWithOwner"].as_str().unwrap_or_default();
    let url = value["url"].as_str().unwrap_or_default();
    let normalized_actual = actual.trim();
    let normalized_actual = normalized_actual
        .strip_suffix(".git")
        .unwrap_or(normalized_actual);
    if normalized_actual.to_ascii_lowercase() != repository {
        return Err(finding(
            "github-repository-unavailable",
            "repository",
            "GitHub repository identity could not be verified",
        ));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn git(args: &[&str], cwd: &Path) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn task_capture_refreshes_the_origin_branch_before_returning_its_commit() {
        let root =
            std::env::temp_dir().join(format!("suplex-task-capture-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bare = root.join("origin.git");
        let local = root.join("repo");
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            &root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            &root,
        );
        git(&["remote", "add", "origin", bare.to_str().unwrap()], &local);
        git(
            &[
                "-c",
                "user.name=Probe",
                "-c",
                "user.email=probe@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "one",
            ],
            &local,
        );
        git(&["push", "--quiet", "origin", "main"], &local);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/repo.git",
            ],
            &local,
        );
        let rewrite = format!("url.file://{}.insteadOf", bare.display());
        git(
            &[
                "config",
                "--local",
                &rewrite,
                "https://github.com/acme/repo.git",
            ],
            &local,
        );
        let first = capture_local_task_heads(&local, "main", "github").unwrap();
        assert_eq!(first.len(), 40);

        git(
            &[
                "-c",
                "user.name=Probe",
                "-c",
                "user.email=probe@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "two",
            ],
            &local,
        );
        let second = Repository::open(&local)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap()
            .to_string();
        git(&["push", "--quiet", "origin", "main"], &local);
        git(&["update-ref", "refs/remotes/origin/main", &first], &local);
        assert_eq!(
            capture_local_task_heads(&local, "main", "github").unwrap(),
            second
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
        let root = std::env::temp_dir().join(format!(
            "suplex-project-path-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
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
            "https://github.com/-owner/repo",
            "https://github.com/owner/../repo",
        ] {
            assert!(repository_coordinate(value).is_none(), "{value}");
        }
    }

    #[tokio::test]
    async fn local_inspection_fetches_origin_and_checks_github_identity() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "suplex-project-inspect-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let bare = root.join("bare");
        let local = root.join("repo");
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            &root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            &root,
        );
        git(
            &[
                "-c",
                "user.name=Probe",
                "-c",
                "user.email=probe@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "initial",
            ],
            &local,
        );
        git(&["remote", "add", "origin", bare.to_str().unwrap()], &local);
        git(&["push", "--quiet", "origin", "main"], &local);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/repo.git",
            ],
            &local,
        );
        let rewrite = format!("url.file://{}.insteadOf", bare.display());
        git(
            &[
                "config",
                "--local",
                &rewrite,
                "https://github.com/acme/repo.git",
            ],
            &local,
        );

        let gh = root.join("gh-fixture");
        fs::write(&gh, "#!/bin/sh\nif [ \"$1\" = auth ]; then exit 0; fi\nif [ \"$1\" = repo ]; then printf '{\"nameWithOwner\":\"acme/repo\",\"url\":\"https://github.com/acme/repo\"}'; exit 0; fi\nexit 1\n").unwrap();
        let mut permissions = fs::metadata(&gh).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&gh, permissions).unwrap();
        let commands = Commands {
            git: "git".into(),
            gh,
        };
        let inspected = inspect(&commands, &local, "main", "github").await.unwrap();
        assert_eq!(inspected.remote_repository, "acme/repo");
        assert_eq!(inspected.base_sha.len(), 40);
        assert!(inspected.clean);
        assert_eq!(
            fs::canonicalize(inspected.canonical_path).unwrap(),
            fs::canonicalize(&local).unwrap()
        );
        verify_github(&commands, &local, "acme/repo").await.unwrap();
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
        let prepared = prepare_local_project(&commands, &root, &root, &input)
            .await
            .unwrap();
        assert_eq!(prepared.name, "Local project");
        assert_eq!(prepared.repository, "acme/repo");
        assert_eq!(prepared.setup_command, "pnpm install");
        assert_eq!(inspected.base_sha.len(), 40);
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
        assert_eq!(
            Path::new(&created.repository_path),
            fs::canonicalize(&local).unwrap()
        );
        drop(database);
        let mismatch = LocalProjectInput {
            repository: "other/repository",
            ..input
        };
        assert_eq!(
            prepare_local_project(&commands, &root, &root, &mismatch)
                .await
                .unwrap_err()[0]
                .code,
            "repository-mismatch"
        );
        assert_eq!(
            inspect(&commands, &local, "main", "bitbucket")
                .await
                .unwrap_err()[0]
                .code,
            "repository-identity"
        );
        fs::write(
            &commands.gh,
            "#!/bin/sh\nif [ \"$1\" = auth ]; then exit 0; fi\nif [ \"$1\" = repo ]; then printf '{\"nameWithOwner\":\"other/repo\",\"url\":\"https://github.com/other/repo\"}'; exit 0; fi\nexit 1\n",
        )
        .unwrap();
        assert_eq!(
            verify_github(&commands, &local, "acme/repo")
                .await
                .unwrap_err()
                .code,
            "github-repository-unavailable"
        );
        let _ = fs::remove_dir_all(root);
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

    #[tokio::test]
    async fn subprocess_output_and_timeout_match_git_adapter_limits() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "suplex-project-command-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let command = root.join("command");
        fs::write(&command, "#!/bin/sh\nhead -c 16385 /dev/zero\n").unwrap();
        let mut permissions = fs::metadata(&command).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&command, permissions).unwrap();
        assert!(
            run(&command, &[], &root, 8, GIT_OUTPUT_LIMIT)
                .await
                .unwrap_err()
                .contains("output exceeded")
        );
        assert_eq!(
            run(&command, &[], &root, 8, GH_OUTPUT_LIMIT)
                .await
                .unwrap()
                .len(),
            GIT_OUTPUT_LIMIT + 1
        );
        fs::write(&command, "#!/bin/sh\nhead -c 16385 /dev/zero >&2\n").unwrap();
        assert!(
            run(&command, &[], &root, 8, GIT_OUTPUT_LIMIT)
                .await
                .unwrap_err()
                .contains("output exceeded")
        );
        fs::write(&command, "#!/bin/sh\nsleep 2\n").unwrap();
        assert!(
            run(&command, &[], &root, 1, GIT_OUTPUT_LIMIT)
                .await
                .unwrap_err()
                .contains("deadline")
        );
        let _ = fs::remove_dir_all(root);
    }
}
