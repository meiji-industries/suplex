//! Local Git worktree facts for task execution. Git remains the authority for
//! branch, repository, HEAD, and working-tree state.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use git2::{BranchType, Repository, StatusOptions, WorktreeAddOptions};

pub type WorktreeResult<T> = Result<T, Box<dyn Error>>;

#[derive(Debug, Clone)]
pub struct TaskWorktreeIntent {
    pub task_id: String,
    pub repository_path: PathBuf,
    pub worktree_root: PathBuf,
    pub branch: String,
    pub starting_sha: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
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

/// Prepare the local commit already present in Git. A later remote-source unit
/// will fetch a missing commit before calling this function.
pub fn prepare_local_task_worktree(
    intent: &TaskWorktreeIntent,
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
        let created = prepare_local_task_worktree(&intent).unwrap();
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
        assert!(prepare_local_task_worktree(&intent).unwrap().dirty);
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
        let changed = prepare_local_task_worktree(&intent).unwrap();
        assert_eq!(changed.branch, intent.branch);
        assert_eq!(changed.head_sha, commit.to_string());
        let restored = Command::new("git")
            .args(["-C", created.path.to_str().unwrap(), "switch", "task-one"])
            .output()
            .unwrap();
        assert!(restored.status.success());
        fs::remove_dir_all(&created.path).unwrap();
        std::os::unix::fs::symlink(&repository_path, &created.path).unwrap();
        assert!(prepare_local_task_worktree(&intent).is_err());
        fs::remove_file(&created.path).unwrap();
        let conflicting = TaskWorktreeIntent {
            branch: "other-branch".into(),
            ..intent.clone()
        };
        assert!(prepare_local_task_worktree(&conflicting).is_err());
        let recovered = prepare_local_task_worktree(&intent).unwrap();
        assert_eq!(recovered.head_sha, commit.to_string());
        assert!(!recovered.dirty);
        let other = TaskWorktreeIntent {
            task_id: "task_two".into(),
            ..intent.clone()
        };
        assert!(prepare_local_task_worktree(&other).is_err());
        drop(tree);
        drop(repository);
        fs::remove_dir_all(root).unwrap();
    }
}
