use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    process::{Command, ExitCode},
};
use suplex::runtimes::git_guard::{
    GitCommandGuard, create_git_command_guard, resolve_guard_binaries,
};

fn check(guard: &GitCommandGuard) -> io::Result<()> {
    for (arguments, expected) in [(vec!["--version"], 0), (vec!["worktree", "list"], 125)] {
        let output = Command::new(guard.directory.join("git"))
            .args(arguments)
            .env_clear()
            .envs(&guard.environment)
            .output()?;
        if output.status.code() != Some(expected) {
            return Err(io::Error::other(
                "The Worker Git guard changed during the test run",
            ));
        }
    }
    Ok(())
}

fn test_environment(guard: &GitCommandGuard) -> io::Result<HashMap<String, String>> {
    let mut environment = guard.environment.clone();
    if let Some(real_git) = environment.get("SUPLEX_GIT_REAL_BIN").cloned() {
        environment.insert("SUPLEX_GIT_BIN".into(), real_git);
    } else {
        environment.remove("SUPLEX_GIT_BIN");
    }
    environment.remove("SUPLEX_GIT_GUARD_DIR");
    let path = std::env::join_paths(
        std::env::split_paths(
            environment
                .get("PATH")
                .map(String::as_str)
                .unwrap_or_default(),
        )
        .filter(|path| {
            path.canonicalize().unwrap_or_else(|_| path.clone())
                != guard
                    .directory
                    .canonicalize()
                    .unwrap_or_else(|_| guard.directory.clone())
        }),
    )
    .map_err(io::Error::other)?;
    environment.insert("PATH".into(), path.to_string_lossy().into_owned());
    Ok(environment)
}

fn run() -> io::Result<u8> {
    let inherited: HashMap<String, String> = std::env::vars().collect();
    let mut temporary = None;
    let guard = if let Some(directory) = inherited
        .get("SUPLEX_GIT_GUARD_DIR")
        .filter(|value| !value.trim().is_empty())
    {
        GitCommandGuard {
            directory: PathBuf::from(directory),
            environment: inherited,
        }
    } else {
        let root =
            std::env::temp_dir().join(format!("suplex-guarded-tests-{}", uuid::Uuid::new_v4()));
        let (git, gh) = resolve_guard_binaries(&inherited)?;
        let guard = create_git_command_guard(&root, &git, gh.as_deref(), &inherited)?;
        temporary = Some(root);
        guard
    };
    let result = (|| {
        check(&guard)?;
        let result = Command::new("pnpm")
            .arg("test")
            .args(std::env::args().skip(1))
            .env_clear()
            .envs(test_environment(&guard)?)
            .status();
        check(&guard)?;
        Ok(result?
            .code()
            .and_then(|code| u8::try_from(code).ok())
            .unwrap_or(1))
    })();
    if let Some(root) = temporary {
        std::fs::remove_dir_all(root)?;
    }
    result
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_environment_leaves_the_inherited_worker_guard_intact() {
        let inherited = std::env::vars().collect();
        let root = std::env::temp_dir().join(format!(
            "suplex-guarded-test-check-{}",
            uuid::Uuid::new_v4()
        ));
        let (git, gh) = resolve_guard_binaries(&inherited).unwrap();
        let guard = create_git_command_guard(&root, &git, gh.as_deref(), &inherited).unwrap();
        check(&guard).unwrap();
        let environment = test_environment(&guard).unwrap();
        assert!(!environment.contains_key("SUPLEX_GIT_GUARD_DIR"));
        assert_eq!(environment["SUPLEX_GIT_BIN"], git.to_string_lossy());
        let output = Command::new("git")
            .args(["worktree", "list"])
            .env_clear()
            .envs(environment)
            .output()
            .unwrap();
        assert!(output.status.success());
        check(&guard).unwrap();
        assert!(guard.directory.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}
