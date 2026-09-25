use std::{
    collections::HashMap,
    fs, io,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
};

const GIT_GUARD: &str = r#"#!/bin/sh
check_command() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C|-c|--git-dir|--work-tree|--namespace|--config-env) shift; [ "$#" -gt 0 ] || return 125; shift ;;
      -*) shift ;;
      *) command="$1"; shift; break ;;
    esac
  done
  case "$command" in
    push|clean|reset|checkout|switch|worktree|update-ref|filter-repo|gc|prune) echo "Suplex Worker policy blocked git $command" >&2; return 125 ;;
  esac
  for arg in "$@"; do
    [ "$arg" != -- ] || break
    case "$command:$arg" in
      commit:--amend|branch:-D|branch:-d|branch:--delete|branch:--force|branch:-f) echo "Suplex Worker policy blocked destructive git option $arg" >&2; return 125 ;;
    esac
  done
}
check_command "$@" || exit 125
exec "$SUPLEX_GIT_REAL_BIN" "$@"
"#;

const GH_GUARD: &str = r#"#!/bin/sh
case "$1 $2" in
  "run view"|"run list"|"pr view"|"pr list"|"pr diff"|"pr checks"|"repo view"|"issue view"|"issue list")
    if [ -n "$SUPLEX_GH_REAL_BIN" ]; then exec "$SUPLEX_GH_REAL_BIN" "$@"; fi ;;
esac
echo "Suplex Worker policy blocks provider-side GitHub mutation" >&2
exit 125
"#;

pub struct GitCommandGuard {
    pub directory: PathBuf,
    pub environment: HashMap<String, String>,
}

impl GitCommandGuard {
    pub fn cleanup(&self) -> io::Result<()> {
        match fs::remove_dir_all(&self.directory) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}

fn which(executable: &str, inherited: &HashMap<String, String>) -> Option<PathBuf> {
    let output = Command::new("which")
        .arg(executable)
        .env_clear()
        .envs(inherited)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Preserve the source SUPLEX_GIT_BIN override before looking up Git. The
/// GitHub CLI is optional because its guard denies all writes either way.
pub fn resolve_guard_binaries(
    inherited: &HashMap<String, String>,
) -> io::Result<(PathBuf, Option<PathBuf>)> {
    let git = inherited
        .get("SUPLEX_GIT_BIN")
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| which("git", inherited))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Git is not available for the guarded Worker",
            )
        })?;
    Ok((git, which("gh", inherited)))
}

fn write_executable(path: &Path, content: &str) -> io::Result<()> {
    let pending = path.with_extension(format!("{}.pending", uuid::Uuid::new_v4()));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&pending)?
        .write_all(content.as_bytes())?;
    fs::rename(pending, path)
}

pub fn create_git_command_guard(
    runtime_root: &Path,
    git_bin: &Path,
    gh_bin: Option<&Path>,
    inherited: &HashMap<String, String>,
) -> io::Result<GitCommandGuard> {
    let directory = if runtime_root.is_absolute() {
        runtime_root.to_owned()
    } else {
        std::env::current_dir()?.join(runtime_root)
    }
    .join("git-guard");
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    write_executable(&directory.join("git"), GIT_GUARD)?;
    write_executable(&directory.join("gh"), GH_GUARD)?;
    let path = inherited
        .get("PATH")
        .map(String::as_str)
        .unwrap_or_default();
    let mut environment = inherited.clone();
    environment.insert("PATH".to_owned(), format!("{}:{path}", directory.display()));
    environment.insert(
        "SUPLEX_GIT_REAL_BIN".to_owned(),
        git_bin
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid Git path"))?
            .to_owned(),
    );
    environment.insert(
        "SUPLEX_GH_REAL_BIN".to_owned(),
        gh_bin.and_then(Path::to_str).unwrap_or_default().to_owned(),
    );
    environment.insert(
        "SUPLEX_GIT_GUARD_DIR".to_owned(),
        directory.to_string_lossy().into_owned(),
    );
    Ok(GitCommandGuard {
        directory,
        environment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarded_git_allows_observation_and_blocks_destructive_operations() {
        let root = std::env::temp_dir().join(format!("suplex-git-guard-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let real_git = Command::new("which").arg("git").output().unwrap();
        assert!(real_git.status.success());
        let path = String::from_utf8(real_git.stdout).unwrap();
        let inherited = std::env::vars().collect::<HashMap<_, _>>();
        let fake_gh = root.join("fake-gh");
        write_executable(&fake_gh, "#!/bin/sh\nprintf 'allowed\\n'\n").unwrap();
        let guard =
            create_git_command_guard(&root, Path::new(path.trim()), Some(&fake_gh), &inherited)
                .unwrap();
        let run = |args: &[&str]| {
            Command::new(guard.directory.join("git"))
                .args(args)
                .env_clear()
                .envs(&guard.environment)
                .output()
                .unwrap()
        };
        assert!(run(&["--version"]).status.success());
        let repository = root.join("repository");
        assert!(
            Command::new(path.trim())
                .args(["init", "--quiet", repository.to_str().unwrap()])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            run(&["-C", repository.to_str().unwrap(), "status", "--short"])
                .status
                .success()
        );
        assert_eq!(
            run(&["-C", root.to_str().unwrap(), "reset", "--hard"])
                .status
                .code(),
            Some(125)
        );
        assert_eq!(run(&["branch", "-D", "main"]).status.code(), Some(125));
        assert_eq!(
            Command::new(guard.directory.join("gh"))
                .args(["pr", "create"])
                .env_clear()
                .envs(&guard.environment)
                .output()
                .unwrap()
                .status
                .code(),
            Some(125)
        );
        let allowed_gh = Command::new(guard.directory.join("gh"))
            .args(["pr", "view"])
            .env_clear()
            .envs(&guard.environment)
            .output()
            .unwrap();
        assert!(allowed_gh.status.success());
        assert_eq!(allowed_gh.stdout, b"allowed\n");
        guard.cleanup().unwrap();
        guard.cleanup().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configured_git_bin_precedes_path_lookup() {
        let inherited = HashMap::from([
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("SUPLEX_GIT_BIN".to_owned(), "  /custom/git  ".to_owned()),
        ]);
        let (git, _) = resolve_guard_binaries(&inherited).unwrap();
        assert_eq!(git, Path::new("/custom/git"));
    }
}
