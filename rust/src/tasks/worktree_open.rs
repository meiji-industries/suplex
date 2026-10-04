//! Desktop applications that can open a task worktree on the Suplex host.
//! Every launcher is a resolved executable with a fixed argument array.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};

use crate::profiles::agent_profiles::executable;

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
    /// The installed application bundle that supplies the icon.
    pub bundle: Option<String>,
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
            bundle: None,
        }
    }

    fn with_bundle(self, bundle: Option<String>) -> Self {
        Self { bundle, ..self }
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
        let directories = [
            "/Applications",
            "/System/Applications",
            "/System/Applications/Utilities",
            home.as_str(),
        ];
        let bundle = |name: &str| {
            directories
                .iter()
                .map(|directory| format!("{directory}/{name}"))
                .find(|path| (discovery.exists)(path))
        };
        let bundled = |name: &str, relative: &str| {
            directories
                .iter()
                .map(|directory| format!("{directory}/{name}/{relative}"))
                .find(|path| (discovery.executable)(path))
        };
        let open_app = |id, label, name: &str| {
            bundle(name).map(|app| {
                let argument = app.clone();
                Launcher::new(id, label, open.into(), move |path| {
                    vec!["-a".into(), argument.clone(), path.into()]
                })
                .with_bundle(Some(app))
            })
        };
        let finder = "/System/Library/CoreServices/Finder.app";
        if (discovery.exists)(finder) {
            launchers.push(
                Launcher::new("finder", "Finder", open.into(), path_argument)
                    .with_bundle(Some(finder.into())),
            );
        }
        if let Some(cursor) =
            resolve("cursor").or_else(|| bundled("Cursor.app", "Contents/Resources/app/bin/cursor"))
        {
            launchers.push(
                Launcher::new("cursor", "Cursor", cursor, path_argument)
                    .with_bundle(bundle("Cursor.app")),
            );
        }
        if let Some(code) = resolve("code")
            .or_else(|| bundled("Visual Studio Code.app", "Contents/Resources/app/bin/code"))
        {
            launchers.push(
                Launcher::new("vscode", "VS Code", code, path_argument)
                    .with_bundle(bundle("Visual Studio Code.app")),
            );
        }
        launchers.extend(open_app("devin", "Devin Desktop", "Devin.app"));
        launchers.extend(open_app("xcode", "Xcode", "Xcode.app"));
        if let Some(ghostty) = bundle("Ghostty.app") {
            let argument = ghostty.clone();
            launchers.push(
                Launcher::new("ghostty", "Ghostty", open.into(), move |path| {
                    vec![
                        "-na".into(),
                        argument.clone(),
                        "--args".into(),
                        format!("--working-directory={path}"),
                    ]
                })
                .with_bundle(Some(ghostty)),
            );
        }
        launchers.extend(open_app("iterm", "iTerm", "iTerm.app"));
        launchers.extend(open_app("terminal", "Terminal", "Terminal.app"));
        launchers.extend(open_app("antigravity", "Antigravity", "Antigravity.app"));
        launchers.extend(open_app("conductor", "Conductor", "Conductor.app"));
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

/// Draws the bundle icon at 64 px through NSWorkspace, which also reads Assets.car icons.
const ICON_SCRIPT: &str = r#"ObjC.import("AppKit");
function run(argv) {
  const size = 64;
  const image = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  return rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).base64EncodedStringWithOptions(0).js;
}"#;

/// A PNG data URL of the bundle icon, or `None` when extraction fails.
// ponytail: cached for the process lifetime; an updated app icon shows after a restart.
pub fn app_icon(bundle: &str) -> Option<String> {
    static ICONS: LazyLock<Mutex<HashMap<String, Option<String>>>> =
        LazyLock::new(Default::default);
    if let Some(icon) = ICONS.lock().ok()?.get(bundle).cloned() {
        return icon;
    }
    let icon = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", ICON_SCRIPT, bundle])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|png| png.starts_with("iVBOR"))
        .map(|png| format!("data:image/png;base64,{png}"));
    ICONS.lock().ok()?.insert(bundle.to_owned(), icon.clone());
    icon
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
                    "/Applications/Visual Studio Code.app",
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
            apps[1].bundle.as_deref(),
            Some("/Applications/Visual Studio Code.app")
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
    fn lists_every_installed_macos_application_in_menu_order() {
        let installed = [
            "/System/Library/CoreServices/Finder.app",
            "/Applications/Cursor.app",
            "/Applications/Visual Studio Code.app",
            "/Applications/Devin.app",
            "/Applications/Xcode.app",
            "/Applications/Ghostty.app",
            "/Users/test/Applications/iTerm.app",
            "/System/Applications/Utilities/Terminal.app",
            "/Applications/Antigravity.app",
            "/Applications/Conductor.app",
        ];
        let apps = discover_launchers(&Discovery {
            platform: "macos",
            home: "/Users/test",
            exists: &|path| installed.contains(&path),
            executable: &|path| path == "/usr/bin/open",
            resolve: &|command| Some(format!("/usr/local/bin/{command}")),
        });
        assert_eq!(
            apps.iter()
                .map(|app| (app.id, app.label))
                .collect::<Vec<_>>(),
            [
                ("finder", "Finder"),
                ("cursor", "Cursor"),
                ("vscode", "VS Code"),
                ("devin", "Devin Desktop"),
                ("xcode", "Xcode"),
                ("ghostty", "Ghostty"),
                ("iterm", "iTerm"),
                ("terminal", "Terminal"),
                ("antigravity", "Antigravity"),
                ("conductor", "Conductor"),
            ]
        );
        assert_eq!(
            apps.iter()
                .map(|app| app.bundle.as_deref().unwrap())
                .collect::<Vec<_>>(),
            installed
        );
        assert_eq!(
            apps.iter().map(|app| app.id).collect::<Vec<_>>(),
            crate::http::contracts::typed::tasks::WORKTREE_APPS
        );
        assert!(apps.iter().all(|app| {
            crate::http::contracts::task_reads::WorktreeApp::parse(app.id).is_some()
        }));
        assert_eq!(apps[1].command, "/usr/local/bin/cursor");
        for index in [3, 4, 6, 8, 9] {
            assert_eq!(apps[index].command, "/usr/bin/open");
            assert_eq!(
                (apps[index].args)("/worktrees/a; rm -rf /"),
                ["-a", installed[index], "/worktrees/a; rm -rf /"]
            );
        }
        let none = discover_launchers(&Discovery {
            platform: "macos",
            home: "/Users/test",
            exists: &|_| false,
            executable: &|path| path == "/usr/bin/open",
            resolve: &|_| None,
        });
        assert!(none.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn renders_a_cached_png_icon_from_the_installed_bundle() {
        let finder = "/System/Library/CoreServices/Finder.app";
        let icon = app_icon(finder).unwrap();
        assert!(icon.starts_with("data:image/png;base64,iVBOR"));
        assert_eq!(app_icon(finder), Some(icon));
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
