//! Desktop applications that can open a task worktree on the Suplex host.
//! Every launcher is a resolved executable with a fixed argument array.

use std::{path::Path, sync::Arc};

use crate::profiles::agent_profiles::executable;

pub const WORKTREE_APP_IDS: [&str; 5] = ["finder", "cursor", "vscode", "ghostty", "terminal"];

/// Builds the fixed argument array for a worktree path.
pub type LauncherArgs = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;

#[derive(Clone)]
pub struct Launcher {
    pub id: &'static str,
    pub label: &'static str,
    pub command: String,
    pub args: LauncherArgs,
    /// The worktree path is the working directory instead of an argument.
    pub cwd_is_path: bool,
}

impl Launcher {
    fn new(
        id: &'static str,
        label: &'static str,
        command: String,
        args: impl Fn(&str) -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            id,
            label,
            command,
            args: Arc::new(args),
            cwd_is_path: false,
        }
    }
}

fn path_argument(path: &str) -> Vec<String> {
    vec![path.to_owned()]
}

pub fn resolve_executable(command: &str, is_executable: &dyn Fn(&str) -> bool) -> Option<String> {
    if command.contains('/') {
        return is_executable(command).then(|| command.to_owned());
    }
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|directory| !directory.is_empty())
        .map(|directory| {
            Path::new(directory)
                .join(command)
                .to_string_lossy()
                .into_owned()
        })
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &str) -> bool {
    executable(Path::new(path))
}

pub fn configured_editor_launcher(command: Option<&str>) -> Option<Launcher> {
    let configured = std::env::var("SUPLEX_EDITOR_COMMAND").ok();
    let command = command.or(configured.as_deref()).unwrap_or("code");
    resolve_executable(command, &is_executable)
        .map(|resolved| Launcher::new("editor", "Editor", resolved, path_argument))
}

pub struct Discovery<'a> {
    pub platform: &'a str,
    pub home: &'a str,
    pub exists: &'a dyn Fn(&str) -> bool,
    pub executable: &'a dyn Fn(&str) -> bool,
    pub resolve: &'a dyn Fn(&str) -> Option<String>,
}

pub fn discover_launchers(discovery: &Discovery<'_>) -> Vec<Launcher> {
    let resolve = discovery.resolve;
    let mut launchers = Vec::new();
    if discovery.platform == "macos" {
        let open = "/usr/bin/open";
        if !(discovery.executable)(open) {
            return launchers;
        }
        let home = format!("{}/Applications", discovery.home);
        let bundles = ["/Applications", "/System/Applications", home.as_str()];
        let bundled = |name: &str, relative: &str| {
            bundles
                .iter()
                .map(|directory| format!("{directory}/{name}/{relative}"))
                .find(|path| (discovery.executable)(path))
        };
        if (discovery.exists)("/System/Library/CoreServices/Finder.app") {
            launchers.push(Launcher::new(
                "finder",
                "Finder",
                open.into(),
                path_argument,
            ));
        }
        if let Some(cursor) =
            resolve("cursor").or_else(|| bundled("Cursor.app", "Contents/Resources/app/bin/cursor"))
        {
            launchers.push(Launcher::new("cursor", "Cursor", cursor, path_argument));
        }
        if let Some(code) = resolve("code")
            .or_else(|| bundled("Visual Studio Code.app", "Contents/Resources/app/bin/code"))
        {
            launchers.push(Launcher::new("vscode", "VS Code", code, path_argument));
        }
        if let Some(ghostty) = bundles
            .iter()
            .map(|directory| format!("{directory}/Ghostty.app"))
            .find(|path| (discovery.exists)(path))
        {
            launchers.push(Launcher::new(
                "ghostty",
                "Ghostty",
                open.into(),
                move |path| {
                    vec![
                        "-na".into(),
                        ghostty.clone(),
                        "--args".into(),
                        format!("--working-directory={path}"),
                    ]
                },
            ));
        }
        let terminal = "/System/Applications/Utilities/Terminal.app";
        if (discovery.exists)(terminal) {
            launchers.push(Launcher::new(
                "terminal",
                "Terminal",
                open.into(),
                move |path| vec!["-a".into(), terminal.into(), path.into()],
            ));
        }
    } else if discovery.platform == "linux" {
        if let Some(cursor) = resolve("cursor") {
            launchers.push(Launcher::new("cursor", "Cursor", cursor, path_argument));
        }
        if let Some(code) = resolve("code") {
            launchers.push(Launcher::new("vscode", "VS Code", code, path_argument));
        }
        if let Some(ghostty) = resolve("ghostty") {
            launchers.push(Launcher::new("ghostty", "Ghostty", ghostty, |path| {
                vec![
                    "+new-window".into(),
                    "--working-directory".into(),
                    path.into(),
                ]
            }));
        }
        if let Some(terminal) = resolve("x-terminal-emulator") {
            launchers.push(Launcher {
                cwd_is_path: true,
                ..Launcher::new("terminal", "Terminal", terminal, |_| Vec::new())
            });
        }
    }
    launchers
}

pub fn worktree_launchers() -> Vec<Launcher> {
    let home = crate::profiles::agent_profiles::home_directory()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default();
    discover_launchers(&Discovery {
        platform: std::env::consts::OS,
        home: &home,
        exists: &|path| Path::new(path).exists(),
        executable: &is_executable,
        resolve: &|command| resolve_executable(command, &is_executable),
    })
}

pub fn worktree_launcher(
    app: &str,
    launchers: Vec<Launcher>,
    editor: Option<Launcher>,
) -> Option<Launcher> {
    if app == "editor" {
        return editor;
    }
    launchers.into_iter().find(|launcher| launcher.id == app)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn discovers_resolved_macos_applications_with_fixed_argument_arrays() {
        let apps = discover_launchers(&Discovery {
            platform: "macos",
            home: "/Users/test",
            exists: &|path| {
                [
                    "/System/Library/CoreServices/Finder.app",
                    "/System/Applications/Utilities/Terminal.app",
                    "/Applications/Ghostty.app",
                ]
                .contains(&path)
            },
            executable: &|path| {
                [
                    "/usr/bin/open",
                    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
                ]
                .contains(&path)
            },
            resolve: &|_| None,
        });
        assert_eq!(
            apps.iter().map(|app| app.id).collect::<Vec<_>>(),
            ["finder", "vscode", "ghostty", "terminal"]
        );
        assert_eq!(
            (apps[3].args)("/worktrees/a; rm -rf /"),
            [
                "-a",
                "/System/Applications/Utilities/Terminal.app",
                "/worktrees/a; rm -rf /"
            ]
        );
        assert_eq!(
            (apps[2].args)("/worktrees/task"),
            [
                "-na",
                "/Applications/Ghostty.app",
                "--args",
                "--working-directory=/worktrees/task"
            ]
        );
    }

    #[test]
    fn does_not_advertise_linux_applications_that_do_not_resolve() {
        let apps = discover_launchers(&Discovery {
            platform: "linux",
            home: "",
            exists: &|_| false,
            executable: &|_| false,
            resolve: &|command| {
                (command == "x-terminal-emulator")
                    .then(|| "/usr/bin/x-terminal-emulator".to_owned())
            },
        });
        assert_eq!(
            apps.iter().map(|app| app.id).collect::<Vec<_>>(),
            ["terminal"]
        );
        assert!(apps[0].cwd_is_path);
        assert!((apps[0].args)("/worktrees/task").is_empty());
    }

    #[test]
    fn resolves_only_executable_regular_files_and_keeps_the_editor_command() {
        let directory =
            std::env::temp_dir().join(format!("suplex-worktree-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(directory.join("folder")).unwrap();
        let editor = directory.join("editor");
        let plain = directory.join("not-executable");
        std::fs::write(&editor, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&editor, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&plain, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o600)).unwrap();
        let editor = editor.to_string_lossy().into_owned();
        assert_eq!(
            resolve_executable(&editor, &is_executable),
            Some(editor.clone())
        );
        assert_eq!(
            resolve_executable(&plain.to_string_lossy(), &is_executable),
            None
        );
        assert_eq!(
            resolve_executable(&directory.join("folder").to_string_lossy(), &is_executable),
            None
        );
        let launcher = configured_editor_launcher(Some(&editor)).unwrap();
        assert_eq!(
            (launcher.id, launcher.command.as_str()),
            ("editor", editor.as_str())
        );
        assert!(configured_editor_launcher(Some(&plain.to_string_lossy())).is_none());
        let _ = std::fs::remove_dir_all(directory);
    }
}
