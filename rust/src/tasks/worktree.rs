//! Local Git worktree facts for task execution. Git remains the authority for
//! branch, repository, HEAD, and working-tree state.

use crate::http::AppState;
use crate::runtimes::task_display::{ShellPaneRequest, ensure_task_shell_pane};
use std::error::Error;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use ts_rs::TS;

use git2::{
    AutotagOption, BranchType, Diff, DiffFindOptions, DiffFormat, DiffOptions, FetchOptions,
    RemoteRedirect, Repository, StatusOptions, WorktreeAddOptions, WorktreePruneOptions,
};

pub type WorktreeResult<T> = Result<T, Box<dyn Error>>;

#[derive(Debug, Clone)]
pub struct TaskWorktreeIntent {
    pub task_id: String,
    pub repository_path: PathBuf,
    pub worktree_root: PathBuf,
    pub branch: String,
    pub starting_sha: String,
}

/// TypeScript `WorktreeReference`: the worktree Git last reported.
#[derive(Debug, Clone, Eq, PartialEq, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReference {
    pub path: PathBuf,
    pub branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WorktreeObservation {
    pub head_sha: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LocalRevisionObservation {
    pub branch: String,
    pub head_sha: String,
    pub tree_sha: String,
    pub clean: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum WorktreeCleanup {
    Cleaned,
    AlreadyAbsent,
    ConfirmationRequired { dirty_file_paths: Vec<String> },
}

/// Read delivery-time Git facts, including the actual branch. A detached HEAD
/// is unavailable for branch-bound local completion.
pub fn observe_local_revision(path: &Path) -> WorktreeResult<LocalRevisionObservation> {
    let repository = Repository::open(path)?;
    let head = repository.head()?;
    if !head.is_branch() {
        return Err(invalid("Local Git revision has no branch"));
    }
    let branch = head.shorthand()?;
    if branch.is_empty() {
        return Err(invalid("Local Git revision has no branch"));
    }
    let branch = branch.to_owned();
    let commit = head.peel_to_commit()?;
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let clean = repository.statuses(Some(&mut options))?.is_empty();
    Ok(LocalRevisionObservation {
        branch,
        head_sha: commit.id().to_string(),
        tree_sha: commit.tree_id().to_string(),
        clean,
    })
}

/// Read current Git facts without comparing them to a task's saved intent.
/// Callers can report an unavailable observation without blocking the task.
pub fn observe_worktree(path: &Path) -> WorktreeResult<WorktreeObservation> {
    let repository = Repository::open(path)?;
    let head_sha = repository.head()?.peel_to_commit()?.id().to_string();
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let dirty = !repository.statuses(Some(&mut options))?.is_empty();
    Ok(WorktreeObservation { head_sha, dirty })
}

/// Count tracked changes against the configured repository's current published
/// base. Local origin is used only to obtain that immutable commit when absent;
/// its URL and remote-tracking refs are not authority for the published head.
pub fn local_diff_file_count(
    path: &Path,
    published_sha: git2::Oid,
    github_token: Option<&str>,
) -> WorktreeResult<usize> {
    let repository = Repository::open(path)?;
    let published_sha = published_base_commit(&repository, published_sha, github_token)?;
    let head = repository.head()?.peel_to_commit()?.id();
    let base = repository.merge_base(published_sha, head)?;
    let tree = repository.find_commit(base)?.tree()?;
    let mut options = DiffOptions::new();
    let mut diff = repository.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut options))?;
    apply_diff_renames(&repository, &mut diff)?;
    Ok(diff.deltas().count())
}

/// Read the complete tracked patch against the live published base. The Git
/// index and workdir are observed together, as `git diff <merge-base> --` does.
pub fn local_diff_patch(
    path: &Path,
    published_sha: git2::Oid,
    github_token: Option<&str>,
) -> WorktreeResult<String> {
    let repository = Repository::open(path)?;
    let published_sha = published_base_commit(&repository, published_sha, github_token)?;
    let head = repository.head()?.peel_to_commit()?.id();
    let base = repository.merge_base(published_sha, head)?;
    let tree = repository.find_commit(base)?.tree()?;
    let config = repository.config()?;
    let mut options = DiffOptions::new();
    options.id_abbrev(
        config
            .get_i32("core.abbrev")
            .ok()
            .filter(|value| (4..=40).contains(value))
            .unwrap_or(7) as u16,
    );
    options.context_lines(
        config
            .get_i32("diff.context")
            .ok()
            .filter(|value| *value >= 0)
            .unwrap_or(3) as u32,
    );
    let mut diff = repository.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut options))?;
    apply_diff_renames(&repository, &mut diff)?;
    let mut patch_bytes = Vec::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch_bytes.push(line.origin() as u8);
        }
        patch_bytes.extend_from_slice(line.content());
        true
    })?;
    Ok(crate::platform::redaction::command_output(
        &String::from_utf8_lossy(&patch_bytes),
    ))
}

fn apply_diff_renames(repository: &Repository, diff: &mut Diff<'_>) -> WorktreeResult<()> {
    let config = repository.config()?;
    let (renames, copies) = match config.get_string("diff.renames") {
        Ok(value) if value.eq_ignore_ascii_case("copies") => (true, true),
        Ok(_) => (config.get_bool("diff.renames")?, false),
        Err(error) if error.code() == git2::ErrorCode::NotFound => (true, false),
        Err(error) => return Err(error.into()),
    };
    if copies {
        diff.find_similar(Some(DiffFindOptions::new().renames(true).copies(true)))?;
    } else if renames {
        diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
    }
    Ok(())
}

/// Ensure the GitHub API's authoritative immutable branch commit is available
/// locally without consulting mutable tracking refs or origin identity.
pub fn published_base_commit(
    repository: &Repository,
    published_sha: git2::Oid,
    github_token: Option<&str>,
) -> WorktreeResult<git2::Oid> {
    if repository.find_commit(published_sha).is_err() {
        if crate::projects::git::libgit2_transport() {
            let mut origin = crate::projects::git::origin_remote(
                repository,
                git2::Direction::Fetch,
                github_token,
            )?;
            let callbacks = crate::projects::git::remote_callbacks(github_token);
            let mut options = FetchOptions::new();
            options
                .download_tags(AutotagOption::None)
                .update_fetchhead(false)
                .follow_redirects(RemoteRedirect::None)
                .remote_callbacks(callbacks);
            origin.fetch(&[published_sha.to_string()], Some(&mut options), None)?;
        } else {
            crate::projects::git::system_fetch(repository, &[&published_sha.to_string()], false)?;
        }
        repository.find_commit(published_sha)?;
    }
    Ok(published_sha)
}

pub(crate) fn token_audience_matches(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// The pane id the task currently binds for `role`: the Shell binding, or the
/// current session of that kind.
pub(crate) fn bound_pane(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    role: &str,
) -> Result<Option<String>, Box<dyn Error>> {
    state.with_database(|database| super::repository::bound_pane(database, user_id, task_id, role))
}

/// Resolves the task's Shell pane from Herdr, rediscovering it when the
/// saved binding is stale. It never creates a workspace.
pub(crate) fn task_shell_pane(
    state: &AppState,
    user_id: &str,
    task_id: &str,
) -> Result<Option<String>, Box<dyn Error>> {
    let (shell, excluded, cwd) = state.with_database(|database| {
        super::repository::shell_pane_context(database, user_id, task_id)
    })?;
    let cwd = cwd.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let pane = ensure_task_shell_pane(
        &state.herdr,
        &ShellPaneRequest {
            task_id,
            cwd: &cwd,
            pane_id: shell.as_deref(),
            exclude_pane_ids: &excluded,
            create: false,
        },
        &mut |pane_id| {
            state.with_database(|database| {
                super::repository::save_shell_pane(database, task_id, pane_id)
            })?;
            Ok(())
        },
    );
    Ok(pane.ok().flatten().map(|pane| pane.pane_id))
}

#[cfg(test)]
mod github_credentials_tests {
    use super::token_audience_matches;

    #[test]
    fn git_token_is_only_for_https_github_authority() {
        assert!(token_audience_matches("https://github.com/owner/repo.git"));
        assert!(token_audience_matches(
            "https://github.com:443/renamed/repo.git"
        ));
        for remote in [
            "https://github.com.evil.test/owner/repo.git",
            "http://github.com/owner/repo.git",
            "https://github.com:444/owner/repo.git",
            "https://user@github.com/owner/repo.git",
            "https://127.0.0.1/owner/repo.git",
        ] {
            assert!(!token_audience_matches(remote));
        }
    }
}

fn invalid(message: &'static str) -> Box<dyn Error> {
    io::Error::new(io::ErrorKind::InvalidInput, message).into()
}

fn contains(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

fn valid_task_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn valid_starting_sha(sha: &str) -> bool {
    (40..=64).contains(&sha.len()) && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn observe(
    path: &Path,
    repository: &Repository,
    intent: &TaskWorktreeIntent,
) -> WorktreeResult<WorktreeReference> {
    let task_repository = Repository::open(path)?;
    let actual = fs::canonicalize(
        task_repository
            .workdir()
            .ok_or_else(|| invalid("Task worktree has no working directory"))?,
    )?;
    if actual != path
        || fs::canonicalize(task_repository.commondir())?
            != fs::canonicalize(repository.commondir())?
    {
        return Err(invalid("Task worktree does not match its repository"));
    }
    let WorktreeObservation { head_sha, dirty } = observe_worktree(path)?;
    Ok(WorktreeReference {
        path: path.to_path_buf(),
        branch: intent.branch.clone(),
        base_sha: intent.starting_sha.clone(),
        head_sha,
        dirty,
    })
}

/// Prepare the task worktree, fetching a missing starting commit from origin.
pub fn prepare_local_task_worktree(
    intent: &TaskWorktreeIntent,
    github_token: Option<&str>,
) -> WorktreeResult<WorktreeReference> {
    let task_path = intent.worktree_root.join(&intent.task_id);
    let initially_absent = fs::symlink_metadata(&task_path).is_err();
    for attempt in 0..20 {
        match prepare_local_task_worktree_once(intent, github_token) {
            Err(error)
                if initially_absent
                    && attempt < 19
                    // A concurrent preparation holds or just created the branch or worktree metadata.
                    && (error.downcast_ref::<git2::Error>().is_some_and(|git| {
                        matches!(git.code(), git2::ErrorCode::Locked | git2::ErrorCode::Exists)
                    })
                        || fs::symlink_metadata(&task_path).is_ok()) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            result => return result,
        }
    }
    unreachable!("the final attempt returns")
}

fn prepare_local_task_worktree_once(
    intent: &TaskWorktreeIntent,
    github_token: Option<&str>,
) -> WorktreeResult<WorktreeReference> {
    if !valid_task_id(&intent.task_id) || !valid_starting_sha(&intent.starting_sha) {
        return Err(invalid("Invalid task worktree identity"));
    }
    if !intent.repository_path.is_absolute() || !intent.worktree_root.is_absolute() {
        return Err(invalid("Task worktree roots must be absolute"));
    }
    let repository_path = fs::canonicalize(&intent.repository_path)?;
    let root = std::path::absolute(&intent.worktree_root)?;
    if contains(&repository_path, &root) || contains(&root, &repository_path) {
        return Err(invalid("Task worktree roots overlap"));
    }
    fs::create_dir_all(&root)?;
    let canonical_root = fs::canonicalize(root)?;
    if contains(&repository_path, &canonical_root) || contains(&canonical_root, &repository_path) {
        return Err(invalid("Task worktree roots overlap"));
    }
    let path = canonical_root.join(&intent.task_id);
    let repository = Repository::discover(repository_path)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(invalid("Task worktree path has a conflicting owner"));
            }
            return observe(&path, &repository, intent);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let reference_name = format!("refs/heads/{}", intent.branch);
    if !git2::Reference::is_valid_name(&reference_name) {
        return Err(invalid("Task branch is not a valid Git reference"));
    }
    let main_branch = repository
        .head()
        .ok()
        .and_then(|head| head.name().ok().map(str::to_owned));
    if main_branch.as_deref() == Some(&reference_name)
        && repository.workdir() != Some(path.as_path())
    {
        return Err(invalid("Task branch is checked out in another worktree"));
    }
    for name in repository.worktrees()?.iter().flatten().flatten() {
        let worktree = repository.find_worktree(name)?;
        if worktree.path() == path {
            let registered_head = fs::read_to_string(
                repository
                    .commondir()
                    .join("worktrees")
                    .join(name)
                    .join("HEAD"),
            )?;
            if registered_head.trim() != format!("ref: {reference_name}") {
                return Err(invalid("Task worktree registry has a conflicting owner"));
            }
            if worktree.is_prunable(None)? {
                worktree.prune(None)?;
                continue;
            }
            return Err(invalid("Task worktree registry has a conflicting owner"));
        }
        if let Ok(other) = Repository::open(worktree.path())
            && other.head().ok().as_ref().and_then(|head| head.name().ok())
                == Some(reference_name.as_str())
        {
            return Err(invalid("Task branch is checked out in another worktree"));
        }
    }

    let branch = match repository.find_branch(&intent.branch, BranchType::Local) {
        Ok(branch) => branch,
        Err(error) if error.code() == git2::ErrorCode::NotFound => {
            let oid = git2::Oid::from_str(&intent.starting_sha)?;
            if repository.find_commit(oid).is_err() {
                // A pull request source pins a commit that GitHub metadata alone does not make local.
                published_base_commit(&repository, oid, github_token)?;
            }
            let commit = repository.find_commit(oid)?;
            repository.branch(&intent.branch, &commit, false)?
        }
        Err(error) => return Err(error.into()),
    };
    let mut options = WorktreeAddOptions::new();
    options.reference(Some(branch.get()));
    if let Err(error) = repository.worktree(&intent.task_id, &path, Some(&options))
        && observe(&path, &repository, intent).is_err()
    {
        return Err(error.into());
    }
    observe(&path, &repository, intent)
}

fn canonical_or_absolute(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path).or_else(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            std::path::absolute(path)
        } else {
            Err(error)
        }
    })
}

/// The repository path and this task's worktree path under non-overlapping roots.
fn cleanup_paths(intent: &TaskWorktreeIntent) -> WorktreeResult<(PathBuf, PathBuf)> {
    if !valid_task_id(&intent.task_id)
        || !intent.repository_path.is_absolute()
        || !intent.worktree_root.is_absolute()
    {
        return Err(invalid("Invalid task worktree identity"));
    }
    let root = canonical_or_absolute(&intent.worktree_root)?;
    let repository_path = canonical_or_absolute(&intent.repository_path)?;
    if contains(&repository_path, &root) || contains(&root, &repository_path) {
        return Err(invalid("Task worktree roots overlap"));
    }
    let path = root.join(&intent.task_id);
    Ok((repository_path, path))
}

fn path_metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// The project repository. None when both it and the task worktree are gone.
fn open_cleanup_repository(
    repository_path: &Path,
    worktree_exists: bool,
) -> WorktreeResult<Option<Repository>> {
    match Repository::open(repository_path) {
        Ok(repository) => Ok(Some(repository)),
        Err(_) if !worktree_exists && !repository_path.exists() => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// The Git worktree registered at `path`, if any.
fn registered_worktree(
    repository: &Repository,
    path: &Path,
) -> WorktreeResult<Option<git2::Worktree>> {
    for name in repository.worktrees()?.iter().flatten().flatten() {
        let worktree = repository.find_worktree(name)?;
        if worktree.path() == path {
            return Ok(Some(worktree));
        }
    }
    Ok(None)
}

/// No Git worktree is registered here: stop leftover processes and report it absent.
fn stop_absent_worktree(
    path: &Path,
    authorize: impl Fn() -> WorktreeResult<()>,
) -> WorktreeResult<WorktreeCleanup> {
    authorize()?;
    crate::tasks::archive::processes::stop_worktree_processes(path)?;
    Ok(WorktreeCleanup::AlreadyAbsent)
}

/// Dirty files need the caller's confirmation before they are discarded.
fn dirty_confirmation(
    path: &Path,
    confirm_discard_dirty: bool,
) -> WorktreeResult<Option<WorktreeCleanup>> {
    let dirty_file_paths = dirty_file_paths(path)?;
    if !dirty_file_paths.is_empty() && !confirm_discard_dirty {
        return Ok(Some(WorktreeCleanup::ConfirmationRequired {
            dirty_file_paths,
        }));
    }
    Ok(None)
}

/// An existing worktree directory must be this task's checkout; dirty files
/// need confirmation before removal.
fn inspect_existing(
    metadata: &fs::Metadata,
    path: &Path,
    repository: &Repository,
    intent: &TaskWorktreeIntent,
    confirm_discard_dirty: bool,
) -> WorktreeResult<Option<WorktreeCleanup>> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid("Task worktree path has a conflicting owner"));
    }
    observe(path, repository, intent)?;
    dirty_confirmation(path, confirm_discard_dirty)
}

/// After the processes stopped, the worktree may not have become dirty and may
/// not hold populated submodules that pruning would discard.
fn recheck_before_prune(path: &Path) -> WorktreeResult<Option<WorktreeCleanup>> {
    if let Some(confirmation) = dirty_confirmation(path, false)? {
        return Ok(Some(confirmation));
    }
    if has_populated_submodules(path)? {
        return Err(invalid("Task worktree has populated submodules"));
    }
    Ok(None)
}

/// Prune the registered worktree and confirm Git removed both the directory
/// and its registration.
fn prune_registered(
    repository: &Repository,
    registered: &git2::Worktree,
    path: &Path,
) -> WorktreeResult<()> {
    let mut options = WorktreePruneOptions::new();
    options.valid(true).working_tree(true);
    registered.prune(Some(&mut options))?;
    let still_registered = repository
        .worktrees()?
        .iter()
        .flatten()
        .flatten()
        .any(|name| {
            repository
                .find_worktree(name)
                .is_ok_and(|worktree| worktree.path() == path)
        });
    if fs::symlink_metadata(path).is_ok() || still_registered {
        return Err(invalid("Git did not remove the task worktree"));
    }
    Ok(())
}

/// Remove only the Git worktree registered at this task's path.
/// A saved WorktreeReference is display state; live Git decides ownership.
pub fn remove_local_task_worktree(
    intent: &TaskWorktreeIntent,
    confirm_discard_dirty: bool,
    authorize: impl Fn() -> WorktreeResult<()>,
) -> WorktreeResult<WorktreeCleanup> {
    let (repository_path, path) = cleanup_paths(intent)?;
    let existing = path_metadata(&path)?;
    let Some(repository) = open_cleanup_repository(&repository_path, existing.is_some())? else {
        return stop_absent_worktree(&path, authorize);
    };
    let Some(registered) = registered_worktree(&repository, &path)? else {
        if existing.is_some() {
            return Err(invalid("Task worktree path has a conflicting owner"));
        }
        return stop_absent_worktree(&path, authorize);
    };
    if let Some(metadata) = &existing
        && let Some(confirmation) =
            inspect_existing(metadata, &path, &repository, intent, confirm_discard_dirty)?
    {
        return Ok(confirmation);
    }
    authorize()?;
    crate::tasks::archive::processes::stop_worktree_processes(&path)?;
    authorize()?;
    if existing.is_some()
        && !confirm_discard_dirty
        && let Some(confirmation) = recheck_before_prune(&path)?
    {
        return Ok(confirmation);
    }
    prune_registered(&repository, &registered, &path)?;
    Ok(if existing.is_some() {
        WorktreeCleanup::Cleaned
    } else {
        WorktreeCleanup::AlreadyAbsent
    })
}

fn dirty_file_paths(path: &Path) -> WorktreeResult<Vec<String>> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false);
    let repository = Repository::open(path)?;
    Ok(repository
        .statuses(Some(&mut options))?
        .iter()
        .map(|entry| entry.path().map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?)
}

fn has_populated_submodules(path: &Path) -> WorktreeResult<bool> {
    let repository = Repository::open(path)?;
    for entry in repository
        .index()?
        .iter()
        .filter(|entry| entry.mode == 0o160000)
    {
        let submodule_path = std::ffi::OsStr::from_bytes(&entry.path);
        let submodule_path = path.join(submodule_path);
        if let Ok(submodule) = Repository::open(&submodule_path)
            && let Some(workdir) = submodule.workdir()
            && fs::canonicalize(workdir)
                .ok()
                .zip(fs::canonicalize(&submodule_path).ok())
                .is_some_and(|(actual, expected)| actual == expected)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn required_path(
    value: &serde_json::Value,
    name: &str,
) -> crate::platform::database::DatabaseResult<PathBuf> {
    let raw = value[name]
        .as_str()
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| crate::tasks::TaskError::internal(format!("Task {name} is missing")))?;
    Ok(PathBuf::from(raw))
}

/// Reobserve the source Git repository and prepare the task worktree. The
/// caller persists the returned worktree only while the task remains active.
pub async fn prepare_task_worktree(
    database_path: &Path,
    task_id: &str,
) -> crate::platform::database::DatabaseResult<WorktreeReference> {
    let database = crate::platform::database::SuplexDatabase::open(
        database_path,
        crate::platform::database::OpenMode::ReadOnly,
    )?;
    let rows = crate::coordination::root_session_store::root_observation_rows(&database, task_id)?;
    let configuration = &rows.context["configuration"];
    let intent = TaskWorktreeIntent {
        task_id: task_id.to_owned(),
        repository_path: required_path(configuration, "repositoryPath")?,
        worktree_root: required_path(configuration, "worktreeRoot")?,
        branch: configuration["branch"]
            .as_str()
            .ok_or_else(|| crate::tasks::TaskError::internal("Task branch is missing"))?
            .to_owned(),
        starting_sha: configuration["startingSha"]
            .as_str()
            .ok_or_else(|| crate::tasks::TaskError::internal("Task starting SHA is missing"))?
            .to_owned(),
    };
    let token = crate::integrations::github::Access::load()
        .await
        .ok()
        .and_then(|access| access.token().map(str::to_owned));
    tokio::task::spawn_blocking(move || {
        prepare_local_task_worktree(&intent, token.as_deref()).map_err(|error| error.to_string())
    })
    .await?
    .map_err(|error| crate::tasks::TaskError::internal(error).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;
    use std::process::Command;

    #[test]
    fn prepares_and_reobserves_a_real_local_git_worktree() {
        let root = std::env::temp_dir().join(format!("suplex-worktree-{}", uuid::Uuid::new_v4()));
        let repository_path = root.join("repo");
        let worktree_root = root.join("worktrees");
        fs::create_dir_all(&repository_path).unwrap();
        let repository = Repository::init(&repository_path).unwrap();
        fs::write(repository_path.join("README.md"), "one\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("Suplex test", "suplex@example.test").unwrap();
        let commit = repository
            .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .unwrap();
        let intent = TaskWorktreeIntent {
            task_id: "task_one".into(),
            repository_path: repository_path.clone(),
            worktree_root: worktree_root.clone(),
            branch: "task-one".into(),
            starting_sha: commit.to_string(),
        };
        let created = prepare_local_task_worktree(&intent, None).unwrap();
        assert_eq!(
            created.path,
            fs::canonicalize(&worktree_root).unwrap().join("task_one")
        );
        assert_eq!(created.head_sha, commit.to_string());
        assert!(!created.dirty);
        let revision = observe_local_revision(&created.path).unwrap();
        assert_eq!(revision.branch, "task-one");
        assert_eq!(revision.head_sha, commit.to_string());
        assert_eq!(revision.tree_sha, tree.id().to_string());
        assert!(revision.clean);
        let listed = Command::new("git")
            .args([
                "-C",
                repository_path.to_str().unwrap(),
                "worktree",
                "list",
                "--porcelain",
                "-z",
            ])
            .output()
            .unwrap();
        assert!(listed.status.success());
        assert!(
            listed
                .stdout
                .windows(created.path.as_os_str().len())
                .any(|window| window == created.path.as_os_str().as_encoded_bytes())
        );
        fs::write(created.path.join("new.txt"), "untracked\n").unwrap();
        assert!(!observe_local_revision(&created.path).unwrap().clean);
        assert!(prepare_local_task_worktree(&intent, None).unwrap().dirty);
        assert_eq!(
            observe_worktree(&created.path).unwrap(),
            WorktreeObservation {
                head_sha: commit.to_string(),
                dirty: true,
            }
        );
        let switched = Command::new("git")
            .args([
                "-C",
                created.path.to_str().unwrap(),
                "switch",
                "-c",
                "wrong-branch",
            ])
            .output()
            .unwrap();
        assert!(switched.status.success());
        assert_eq!(
            observe_local_revision(&created.path).unwrap().branch,
            "wrong-branch"
        );
        let changed = prepare_local_task_worktree(&intent, None).unwrap();
        assert_eq!(changed.branch, intent.branch);
        assert_eq!(changed.head_sha, commit.to_string());
        let other_checkout = root.join("other-checkout");
        let occupied = Command::new("git")
            .args([
                "-C",
                repository_path.to_str().unwrap(),
                "worktree",
                "add",
                other_checkout.to_str().unwrap(),
                "task-one",
            ])
            .output()
            .unwrap();
        assert!(occupied.status.success(), "{occupied:?}");
        assert_eq!(prepare_local_task_worktree(&intent, None).unwrap(), changed);
        assert_eq!(
            observe_local_revision(&created.path).unwrap().branch,
            "wrong-branch"
        );
        let removed = Command::new("git")
            .args([
                "-C",
                repository_path.to_str().unwrap(),
                "worktree",
                "remove",
                other_checkout.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(removed.status.success(), "{removed:?}");
        let restored = Command::new("git")
            .args(["-C", created.path.to_str().unwrap(), "switch", "task-one"])
            .output()
            .unwrap();
        assert!(restored.status.success());
        fs::write(created.path.join("committed.txt"), "out-of-band commit\n").unwrap();
        let added = Command::new("git")
            .args(["-C", created.path.to_str().unwrap(), "add", "committed.txt"])
            .output()
            .unwrap();
        assert!(added.status.success());
        let committed = Command::new("git")
            .args([
                "-C",
                created.path.to_str().unwrap(),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-qm",
                "external",
            ])
            .output()
            .unwrap();
        assert!(committed.status.success());
        let committed_head = observe_worktree(&created.path).unwrap().head_sha;
        fs::remove_dir_all(&created.path).unwrap();
        std::os::unix::fs::symlink(&repository_path, &created.path).unwrap();
        assert!(prepare_local_task_worktree(&intent, None).is_err());
        fs::remove_file(&created.path).unwrap();
        let conflicting = TaskWorktreeIntent {
            branch: "other-branch".into(),
            ..intent.clone()
        };
        assert!(prepare_local_task_worktree(&conflicting, None).is_err());
        let recovered = prepare_local_task_worktree(&intent, None).unwrap();
        assert_eq!(recovered.head_sha, committed_head);
        assert_eq!(
            fs::read(recovered.path.join("committed.txt")).unwrap(),
            b"out-of-band commit\n"
        );
        assert!(!recovered.dirty);
        let other = TaskWorktreeIntent {
            task_id: "task_two".into(),
            ..intent.clone()
        };
        assert!(prepare_local_task_worktree(&other, None).is_err());
        let switched = Command::new("git")
            .args([
                "-C",
                recovered.path.to_str().unwrap(),
                "switch",
                "wrong-branch",
            ])
            .output()
            .unwrap();
        assert!(switched.status.success());
        fs::write(recovered.path.join("new.txt"), "keep until confirmed\n").unwrap();
        assert_eq!(
            remove_local_task_worktree(&intent, false, || Ok(())).unwrap(),
            WorktreeCleanup::ConfirmationRequired {
                dirty_file_paths: vec!["new.txt".into()]
            }
        );
        assert!(recovered.path.exists());
        assert!(
            remove_local_task_worktree(&intent, true, || Err(invalid("not authorized"))).is_err()
        );
        assert!(recovered.path.exists());
        assert_eq!(
            remove_local_task_worktree(&intent, true, || Ok(())).unwrap(),
            WorktreeCleanup::Cleaned
        );
        assert!(!recovered.path.exists());
        assert!(
            repository
                .find_branch("wrong-branch", BranchType::Local)
                .is_ok()
        );
        assert_eq!(
            remove_local_task_worktree(&intent, false, || Ok(())).unwrap(),
            WorktreeCleanup::AlreadyAbsent
        );
        fs::create_dir_all(&recovered.path).unwrap();
        let foreign = Repository::init(&recovered.path).unwrap();
        fs::write(recovered.path.join("keep.txt"), "foreign\n").unwrap();
        assert!(remove_local_task_worktree(&intent, true, || Ok(())).is_err());
        assert_eq!(
            fs::read_to_string(recovered.path.join("keep.txt")).unwrap(),
            "foreign\n"
        );
        drop(foreign);
        let clean_intent = TaskWorktreeIntent {
            task_id: "task_clean".into(),
            branch: "task-clean".into(),
            ..intent.clone()
        };
        let clean = prepare_local_task_worktree(&clean_intent, None).unwrap();
        let clean_repository = Repository::open(&clean.path).unwrap();
        fs::create_dir(clean_repository.path().join("modules")).unwrap();
        assert!(!has_populated_submodules(&clean.path).unwrap());
        drop(clean_repository);
        assert_eq!(
            remove_local_task_worktree(&clean_intent, false, || Ok(())).unwrap(),
            WorktreeCleanup::Cleaned
        );
        assert!(!clean.path.exists());
        let submodule_intent = TaskWorktreeIntent {
            task_id: "task_submodule".into(),
            branch: "task-submodule".into(),
            ..intent.clone()
        };
        let submodule_worktree = prepare_local_task_worktree(&submodule_intent, None).unwrap();
        let nested_path = submodule_worktree.path.join("nested");
        let nested = Repository::init(&nested_path).unwrap();
        fs::write(nested_path.join("README.md"), "nested\n").unwrap();
        let mut nested_index = nested.index().unwrap();
        nested_index.add_path(Path::new("README.md")).unwrap();
        nested_index.write().unwrap();
        let nested_tree = nested
            .find_tree(nested_index.write_tree().unwrap())
            .unwrap();
        let nested_head = nested
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "Nested",
                &nested_tree,
                &[],
            )
            .unwrap();
        drop(nested_tree);
        drop(nested);
        let gitlink = format!("160000,{nested_head},nested");
        let indexed = Command::new("git")
            .arg("-C")
            .arg(&submodule_worktree.path)
            .args(["update-index", "--add", "--cacheinfo", &gitlink])
            .output()
            .unwrap();
        assert!(indexed.status.success());
        let linked_repository = Repository::open(&submodule_worktree.path).unwrap();
        fs::write(
            submodule_worktree.path.join(".gitmodules"),
            format!(
                "[submodule \"nested\"]\n\tpath = nested\n\turl = {}\n",
                nested_path.display()
            ),
        )
        .unwrap();
        let mut linked_index = linked_repository.index().unwrap();
        linked_index.add_path(Path::new(".gitmodules")).unwrap();
        linked_index.write().unwrap();
        let linked_tree = linked_repository
            .find_tree(linked_index.write_tree().unwrap())
            .unwrap();
        let parent = linked_repository.head().unwrap().peel_to_commit().unwrap();
        linked_repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "Add gitlink",
                &linked_tree,
                &[&parent],
            )
            .unwrap();
        drop(parent);
        drop(linked_tree);
        drop(linked_repository);
        assert_eq!(
            dirty_file_paths(&submodule_worktree.path).unwrap(),
            Vec::<String>::new()
        );
        assert!(remove_local_task_worktree(&submodule_intent, false, || Ok(())).is_err());
        assert!(nested_path.join("README.md").exists());
        fs::rename(nested_path.join(".git"), nested_path.join(".git-stale")).unwrap();
        assert!(!has_populated_submodules(&submodule_worktree.path).unwrap());
        assert_eq!(
            remove_local_task_worktree(&submodule_intent, true, || Ok(())).unwrap(),
            WorktreeCleanup::Cleaned
        );
        drop(tree);
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fetches_a_missing_starting_commit_from_origin() {
        let root = std::env::temp_dir().join(format!("suplex-worktree-{}", uuid::Uuid::new_v4()));
        let origin_path = root.join("origin");
        let repository_path = root.join("repo");
        let run = |cwd: &Path, args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        let commit = [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.test",
            "commit",
        ];
        fs::create_dir_all(&origin_path).unwrap();
        run(&origin_path, &["init", "-q"]);
        run(
            &origin_path,
            &[&commit[..], &["-q", "--allow-empty", "-m", "one"]].concat(),
        );
        run(
            &root,
            &["clone", "-q", origin_path.to_str().unwrap(), "repo"],
        );
        run(
            &origin_path,
            &[&commit[..], &["-q", "--allow-empty", "-m", "two"]].concat(),
        );
        let pinned = run(&origin_path, &["rev-parse", "HEAD"]);
        let local = Repository::open(&repository_path).unwrap();
        assert!(
            local
                .find_commit(git2::Oid::from_str(&pinned).unwrap())
                .is_err()
        );
        let intent = TaskWorktreeIntent {
            task_id: "task_pinned".into(),
            repository_path: repository_path.clone(),
            worktree_root: root.join("worktrees"),
            branch: "task-pinned".into(),
            starting_sha: pinned.clone(),
        };
        assert_eq!(
            prepare_local_task_worktree(&intent, None).unwrap().head_sha,
            pinned
        );
        let absent = TaskWorktreeIntent {
            task_id: "task_absent".into(),
            branch: "task-absent".into(),
            starting_sha: "0123456789abcdef0123456789abcdef01234567".into(),
            ..intent.clone()
        };
        assert!(prepare_local_task_worktree(&absent, None).is_err());
        drop(local);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preparation_reobserves_a_conflicted_rebase_without_changing_user_work() {
        let root = std::env::temp_dir().join(format!("suplex-rebase-{}", uuid::Uuid::new_v4()));
        let repository_path = root.join("repo");
        fs::create_dir_all(&repository_path).unwrap();
        let run = |cwd: &Path, args: &[&str], success: bool| {
            let output = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap();
            assert_eq!(output.status.success(), success, "{output:?}");
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        run(&repository_path, &["init", "-q", "-b", "main"], true);
        fs::write(repository_path.join("conflict.txt"), "initial\n").unwrap();
        run(&repository_path, &["add", "conflict.txt"], true);
        run(
            &repository_path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-qm",
                "initial",
            ],
            true,
        );
        let starting_sha = run(&repository_path, &["rev-parse", "HEAD"], true);
        let intent = TaskWorktreeIntent {
            task_id: "task_rebase".into(),
            repository_path: repository_path.clone(),
            worktree_root: root.join("worktrees"),
            branch: "task-rebase".into(),
            starting_sha,
        };
        let worktree = prepare_local_task_worktree(&intent, None).unwrap().path;
        fs::write(worktree.join("conflict.txt"), "task\n").unwrap();
        run(&worktree, &["add", "conflict.txt"], true);
        run(
            &worktree,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-qm",
                "task",
            ],
            true,
        );
        fs::write(repository_path.join("conflict.txt"), "main\n").unwrap();
        run(&repository_path, &["add", "conflict.txt"], true);
        run(
            &repository_path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-qm",
                "main",
            ],
            true,
        );
        fs::write(worktree.join("preserved.txt"), "Preserve me\n").unwrap();
        run(&worktree, &["rebase", "main"], false);
        let head_before = run(&worktree, &["rev-parse", "HEAD"], true);
        let status_before = run(&worktree, &["status", "--porcelain=v1"], true);
        let conflict_before = fs::read(worktree.join("conflict.txt")).unwrap();
        let rebase_head = run(
            &worktree,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "rebase-merge/head-name",
            ],
            true,
        );
        let rebase_before = fs::read(&rebase_head).unwrap();

        let observed = prepare_local_task_worktree(&intent, None).unwrap();
        assert_eq!(observed.branch, intent.branch);
        assert_eq!(observed.head_sha, head_before);
        assert!(observed.dirty);
        assert_eq!(
            run(&worktree, &["status", "--porcelain=v1"], true),
            status_before
        );
        assert_eq!(
            fs::read(worktree.join("conflict.txt")).unwrap(),
            conflict_before
        );
        assert_eq!(
            fs::read(worktree.join("preserved.txt")).unwrap(),
            b"Preserve me\n"
        );
        assert_eq!(fs::read(&rebase_head).unwrap(), rebase_before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn materialization_rejects_foreign_paths_and_converges_concurrent_creation() {
        let root =
            std::env::temp_dir().join(format!("suplex-worktree-owner-{}", uuid::Uuid::new_v4()));
        let repository_path = root.join("repository");
        fs::create_dir_all(&repository_path).unwrap();
        let repository = Repository::init(&repository_path).unwrap();
        let signature = Signature::now("Suplex test", "suplex@example.test").unwrap();
        let tree = repository
            .find_tree(repository.index().unwrap().write_tree().unwrap())
            .unwrap();
        let starting_sha = repository
            .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .unwrap()
            .to_string();
        let intent = TaskWorktreeIntent {
            task_id: "task_owner".into(),
            repository_path: repository_path.clone(),
            worktree_root: root.join("worktrees"),
            branch: "task-owner".into(),
            starting_sha,
        };
        let path = intent.worktree_root.join(&intent.task_id);
        fs::create_dir_all(&intent.worktree_root).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("preserved.txt"), "unrelated directory\n").unwrap();
        assert!(prepare_local_task_worktree(&intent, None).is_err());
        assert_eq!(
            fs::read(path.join("preserved.txt")).unwrap(),
            b"unrelated directory\n"
        );
        fs::remove_dir_all(&path).unwrap();

        Repository::init(&path).unwrap();
        fs::write(path.join("preserved.txt"), "foreign repository\n").unwrap();
        assert!(prepare_local_task_worktree(&intent, None).is_err());
        assert_eq!(
            fs::read(path.join("preserved.txt")).unwrap(),
            b"foreign repository\n"
        );
        fs::remove_dir_all(&path).unwrap();

        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                prepare_local_task_worktree(&intent, None).map_err(|error| error.to_string())
            });
            let second = scope.spawn(|| {
                prepare_local_task_worktree(&intent, None).map_err(|error| error.to_string())
            });
            (first.join().unwrap(), second.join().unwrap())
        });
        assert_eq!(first.unwrap(), second.unwrap());
        drop(tree);
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }
}
