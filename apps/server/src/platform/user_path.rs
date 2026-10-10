//! The process PATH with the directories user installers write to. A
//! supervised Suplex starts with the system PATH, so tools that an installer
//! put in `~/.local/bin` or Homebrew, such as Herdr, gh, and git, were absent
//! from every probe and spawned shell.

use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};

/// Prepends the user tool directories that are not already on PATH. A
/// directory an installer creates later, such as `~/.local/bin`, is then
/// already searched. An unset or empty PATH starts from the standard system
/// directories, because a set PATH stops the system default lookup and the
/// in-process executable lookups read PATH directly.
/// Call it first in `main`, before the Tokio runtime starts.
pub fn extend() {
    let current = env::var_os("PATH").unwrap_or_default();
    let home = env::var_os("HOME").map(PathBuf::from);
    let joined = extended(&current, home.as_deref());
    if joined != current {
        // SAFETY: `main` calls this before it builds the Tokio runtime, so no other thread exists.
        unsafe { env::set_var("PATH", joined) };
    }
}

const SYSTEM_DIRECTORIES: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

fn extended(current: &OsString, home: Option<&Path>) -> OsString {
    let mut paths = env::split_paths(current).collect::<Vec<_>>();
    if paths.iter().all(|path| path.as_os_str().is_empty()) {
        // An empty entry means the current directory, so replace it.
        paths = SYSTEM_DIRECTORIES.iter().map(PathBuf::from).collect();
    }
    let candidates = home.map(|home| home.join(".local/bin")).into_iter().chain([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    let missing = candidates
        .filter(|directory| !paths.contains(directory))
        .collect::<Vec<_>>();
    paths.splice(0..0, missing);
    env::join_paths(paths).unwrap_or_else(|_| current.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(joined: &OsString) -> Vec<PathBuf> {
        env::split_paths(joined).collect()
    }

    fn paths(entries: &[&str]) -> Vec<PathBuf> {
        entries.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn prepends_user_directories_once() {
        let home = env::temp_dir().join(format!("suplex-user-path-{}", uuid::Uuid::new_v4()));
        let local = home.join(".local/bin");
        let first = extended(&OsString::from("/usr/bin:/bin"), Some(home.as_path()));
        let first_paths = split(&first);
        assert_eq!(first_paths[0], local);
        assert!(first_paths.contains(&PathBuf::from("/usr/bin")));
        let second = extended(&first, Some(home.as_path()));
        assert_eq!(second, first);
    }

    #[test]
    fn starts_an_empty_path_from_the_system_directories() {
        for current in ["", ":", "::"] {
            let joined = extended(&OsString::from(current), Some(Path::new("/home/ada")));
            assert_eq!(
                split(&joined),
                paths(&[
                    "/home/ada/.local/bin",
                    "/opt/homebrew/bin",
                    "/usr/local/bin",
                    "/usr/bin",
                    "/bin",
                    "/usr/sbin",
                    "/sbin",
                ]),
                "PATH {current:?}"
            );
            assert_eq!(extended(&joined, Some(Path::new("/home/ada"))), joined);
        }
    }

    #[test]
    fn starts_an_empty_path_from_the_system_directories_without_home() {
        let joined = extended(&OsString::new(), None);
        assert_eq!(
            split(&joined),
            paths(&[
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ])
        );
    }

    #[test]
    fn keeps_an_explicit_current_directory_entry() {
        let joined = extended(
            &OsString::from("/usr/bin::/bin"),
            Some(Path::new("/home/ada")),
        );
        assert_eq!(
            split(&joined),
            paths(&[
                "/home/ada/.local/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "",
                "/bin",
            ])
        );
    }
}
