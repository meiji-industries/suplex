//! Where the desktop shell keeps its files. macOS reads the existing Electron-era layout in
//! `~/Library/Application Support/Suplex` in place; Linux uses `~/.local/share/Suplex` and Windows
//! `%APPDATA%\Suplex`. Tauri's identifier-derived directory is never used.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
};

/// The shell's data directory and the files it owns there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub user_data: PathBuf,
}

impl Paths {
    /// `SUPLEX_DESKTOP_USER_DATA` isolates development and test runs; otherwise the production directory.
    pub fn from_environment(environment: &HashMap<String, String>) -> Self {
        let user_data = match environment.get("SUPLEX_DESKTOP_USER_DATA") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => default_user_data(environment),
        };
        Self { user_data }
    }

    pub fn install_record(&self) -> PathBuf {
        self.user_data.join("install.json")
    }
    pub fn targets(&self) -> PathBuf {
        self.user_data.join("desktop.json")
    }
    pub fn window_state(&self) -> PathBuf {
        self.user_data.join("window-state.json")
    }
    pub fn network_access(&self) -> PathBuf {
        self.user_data.join("network-access.json")
    }
    pub fn network_access_cleanup(&self) -> PathBuf {
        self.user_data.join("network-access-cleanup.json")
    }
    pub fn logs(&self) -> PathBuf {
        self.user_data.join("logs")
    }
    pub fn server_log(&self) -> PathBuf {
        self.logs().join("server.log")
    }
}

/// The packaged host binary and the directory holding its `manifest.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimePaths {
    pub binary: PathBuf,
    pub directory: PathBuf,
}

impl RuntimePaths {
    /// Packaged builds carry the host in `Contents/Resources/runtime`. Dev and tests point at a Rust build or fixture.
    pub fn resolve(environment: &HashMap<String, String>, resources: &Path) -> Self {
        let directory = environment
            .get("SUPLEX_DESKTOP_RUNTIME")
            .map(PathBuf::from)
            .unwrap_or_else(|| resources.join("runtime"));
        let binary = environment
            .get("SUPLEX_DESKTOP_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.join("bin").join("suplex"));
        Self { binary, directory }
    }
}

/// macOS keeps the Electron-era folder. Linux uses the XDG data default; the `suplex` CLI looks there
/// too, so neither reads `XDG_DATA_HOME`. Windows uses roaming AppData.
fn default_user_data(environment: &HashMap<String, String>) -> PathBuf {
    if cfg!(target_os = "macos") {
        home(environment).join("Library/Application Support/Suplex")
    } else if cfg!(windows) {
        environment
            .get("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home(environment).join("AppData").join("Roaming"))
            .join("Suplex")
    } else {
        home(environment).join(".local/share/Suplex")
    }
}

/// `HOME`, or `USERPROFILE` on Windows, where `HOME` is usually unset.
pub fn home(environment: &HashMap<String, String>) -> PathBuf {
    ["HOME", "USERPROFILE"]
        .iter()
        .find_map(|key| environment.get(*key).filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Writes through a sibling staging file and a rename, so a crash never leaves half a file.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staged = path.with_file_name(format!(
        "{}.staging",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file")
    ));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&staged)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    std::fs::rename(&staged, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn production_uses_the_existing_application_support_directory() {
        let paths = Paths::from_environment(&env(&[("HOME", "/Users/ada")]));
        assert_eq!(
            paths.user_data,
            PathBuf::from("/Users/ada/Library/Application Support/Suplex")
        );
        assert_eq!(
            paths.targets(),
            PathBuf::from("/Users/ada/Library/Application Support/Suplex/desktop.json")
        );
        assert_eq!(
            paths.server_log(),
            PathBuf::from("/Users/ada/Library/Application Support/Suplex/logs/server.log")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_uses_the_xdg_data_default() {
        let paths = Paths::from_environment(&env(&[("HOME", "/home/ada")]));
        assert_eq!(
            paths.user_data,
            PathBuf::from("/home/ada/.local/share/Suplex")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_roaming_app_data() {
        let paths = Paths::from_environment(&env(&[
            ("USERPROFILE", r"C:\Users\ada"),
            ("APPDATA", r"C:\Users\ada\AppData\Roaming"),
        ]));
        assert_eq!(
            paths.user_data,
            PathBuf::from(r"C:\Users\ada\AppData\Roaming\Suplex")
        );
        let without = Paths::from_environment(&env(&[("USERPROFILE", r"C:\Users\ada")]));
        assert_eq!(
            without.user_data,
            PathBuf::from(r"C:\Users\ada\AppData\Roaming\Suplex")
        );
    }

    #[test]
    fn user_data_override_isolates_development() {
        let paths = Paths::from_environment(&env(&[
            ("HOME", "/Users/ada"),
            ("SUPLEX_DESKTOP_USER_DATA", "/tmp/dev"),
        ]));
        assert_eq!(
            paths.install_record(),
            PathBuf::from("/tmp/dev/install.json")
        );
    }

    #[test]
    fn the_host_binary_is_under_the_bundle_resources() {
        assert_eq!(
            RuntimePaths::resolve(&env(&[]), Path::new("/r")),
            RuntimePaths {
                binary: "/r/runtime/bin/suplex".into(),
                directory: "/r/runtime".into()
            }
        );
    }

    #[test]
    fn the_environment_points_development_at_a_rust_build() {
        assert_eq!(
            RuntimePaths::resolve(
                &env(&[
                    (
                        "SUPLEX_DESKTOP_BINARY",
                        "/checkout/rust/target/debug/suplex"
                    ),
                    ("SUPLEX_DESKTOP_RUNTIME", "/checkout/desktop/runtime")
                ]),
                Path::new("/r"),
            ),
            RuntimePaths {
                binary: "/checkout/rust/target/debug/suplex".into(),
                directory: "/checkout/desktop/runtime".into()
            }
        );
    }

    #[test]
    fn atomic_writes_replace_the_whole_file() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("nested/state.json");
        write_atomic(&file, b"{\"a\":1}").unwrap();
        write_atomic(&file, b"2").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "2");
        assert!(!file.with_file_name("state.json.staging").exists());
    }
}
