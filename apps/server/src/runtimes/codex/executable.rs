use std::{
    ffi::OsStr,
    io,
    path::{Path, PathBuf},
};

use crate::profiles::agent_profiles::{executable, home_directory};

fn resolve_with(
    override_path: Option<&Path>,
    configured: Option<&OsStr>,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
) -> io::Result<PathBuf> {
    if let Some(path) = override_path.or_else(|| configured.map(Path::new)) {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Codex CLI executable must be an absolute path. Check SUPLEX_CODEX_COMMAND.",
            ));
        }
        if !executable(path) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Codex CLI executable cannot be executed. Check SUPLEX_CODEX_COMMAND.",
            ));
        }
        return Ok(path.to_owned());
    }
    if let Some(search_path) = search_path {
        for directory in std::env::split_paths(search_path).filter(|path| path.is_absolute()) {
            let path = directory.join("codex");
            if executable(&path) {
                return Ok(path);
            }
        }
    }
    if let Some(home) = home {
        for path in [home.join(".local/bin/codex"), home.join(".codex/bin/codex")] {
            if executable(&path) {
                return Ok(path);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Install Codex CLI or set SUPLEX_CODEX_COMMAND to its absolute executable path.",
    ))
}

pub fn resolve_codex_executable(override_path: Option<&Path>) -> io::Result<PathBuf> {
    resolve_with(
        override_path,
        std::env::var_os("SUPLEX_CODEX_COMMAND").as_deref(),
        std::env::var_os("PATH").as_deref(),
        home_directory().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn override_path_precedes_path_and_home_and_requires_executable_file() {
        let root = std::env::temp_dir().join(format!("suplex-codex-exec-{}", uuid::Uuid::new_v4()));
        let on_path = root.join("bin/codex");
        let at_home = root.join("home/.local/bin/codex");
        fs::create_dir_all(on_path.parent().unwrap()).unwrap();
        fs::create_dir_all(at_home.parent().unwrap()).unwrap();
        for path in [&on_path, &at_home] {
            fs::write(path, "#!/bin/sh\n").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let search = std::env::join_paths([on_path.parent().unwrap()]).unwrap();
        assert_eq!(
            resolve_with(None, None, Some(&search), Some(&root.join("home"))).unwrap(),
            on_path
        );
        assert_eq!(
            resolve_with(Some(&at_home), None, Some(&search), None).unwrap(),
            at_home
        );
        assert!(
            resolve_with(Some(Path::new("relative/codex")), None, Some(&search), None).is_err()
        );
        fs::set_permissions(&at_home, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(resolve_with(Some(&at_home), None, Some(&search), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
