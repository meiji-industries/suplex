//! The process PATH with the directories user installers write to. A
//! supervised Suplex starts with the system PATH, so tools that an installer
//! put in `~/.local/bin` or Homebrew, such as Herdr, gh, and git, were absent
//! from every probe and spawned shell.

use std::{env, ffi::OsString, path::PathBuf};

/// Prepends the user tool directories that are not already on PATH. A
/// directory an installer creates later, such as `~/.local/bin`, is then
/// already searched.
/// Call it first in `main`, before any other thread starts.
pub fn extend() {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let current = env::var_os("PATH").unwrap_or_default();
    let joined = extended(&current, &home);
    if joined != current {
        // SAFETY: called before the runtime spawns threads, so no concurrent reader exists.
        unsafe { env::set_var("PATH", joined) };
    }
}

fn extended(current: &OsString, home: &std::path::Path) -> OsString {
    let candidates = [
        home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    let mut paths = env::split_paths(current).collect::<Vec<_>>();
    let missing = candidates
        .into_iter()
        .filter(|directory| !paths.contains(directory))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return current.clone();
    }
    paths.splice(0..0, missing);
    env::join_paths(paths).unwrap_or_else(|_| current.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepends_user_directories_once() {
        let home = env::temp_dir().join(format!("suplex-user-path-{}", uuid::Uuid::new_v4()));
        let local = home.join(".local/bin");
        let first = extended(&OsString::from("/usr/bin:/bin"), &home);
        let first_paths = env::split_paths(&first).collect::<Vec<_>>();
        assert_eq!(first_paths[0], local);
        assert!(first_paths.contains(&PathBuf::from("/usr/bin")));
        let second = extended(&first, &home);
        assert_eq!(second, first);
    }
}
