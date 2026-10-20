use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
};

use super::cli::PiCli;
use crate::{profiles::agent_profiles::home_directory, runtimes::task_harness::resolve_executable};

pub fn resolve_pi_executable(
    cli: &PiCli,
    override_path: Option<&Path>,
    environment: &HashMap<String, String>,
) -> io::Result<PathBuf> {
    resolve_executable(
        &cli.executable,
        override_path,
        environment,
        home_directory().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::pi::cli::{OMP, PI};
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn the_pinned_path_precedes_path_and_must_be_an_absolute_executable() {
        let root = std::env::temp_dir().join(format!("suplex-pi-exec-{}", uuid::Uuid::new_v4()));
        let on_path = root.join("bin/pi");
        let pinned = root.join("pinned/pi");
        for path in [&on_path, &pinned] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "#!/bin/sh\n").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path = HashMap::from([(
            "PATH".to_owned(),
            on_path.parent().unwrap().to_string_lossy().into_owned(),
        )]);
        assert_eq!(resolve_pi_executable(&PI, None, &path).unwrap(), on_path);
        let mut pinned_environment = path.clone();
        pinned_environment.insert(
            "SUPLEX_PI_COMMAND".into(),
            pinned.to_string_lossy().into_owned(),
        );
        assert_eq!(
            resolve_pi_executable(&PI, None, &pinned_environment).unwrap(),
            pinned
        );
        // omp has its own pin, so a Pi pin never selects it.
        assert_ne!(
            resolve_pi_executable(&OMP, None, &pinned_environment).ok(),
            Some(pinned.clone())
        );
        pinned_environment.insert("SUPLEX_PI_COMMAND".into(), "relative/pi".into());
        assert!(resolve_pi_executable(&PI, None, &pinned_environment).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
