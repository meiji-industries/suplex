//! Native side effects the local OS user sees: the system browser, Finder, the clipboard, dialogs,
//! and notifications. The `native-test` build records them to a file instead, so the native smoke
//! suite can assert them without opening a browser or touching the real Desktop.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime, WebviewWindow};
use url::Url;

use crate::{paths::Paths, updater::Kind};

pub struct Effects<R: Runtime> {
    #[cfg_attr(feature = "native-test", allow(dead_code))]
    app: AppHandle<R>,
    downloads: PathBuf,
    #[cfg(feature = "native-test")]
    log: PathBuf,
}

impl<R: Runtime> Effects<R> {
    pub fn new(app: AppHandle<R>, paths: &Paths) -> Self {
        #[cfg(feature = "native-test")]
        return Self {
            app,
            downloads: paths.user_data.join("Desktop"),
            log: paths.user_data.join("native-test-effects.log"),
        };
        #[cfg(not(feature = "native-test"))]
        {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| paths.user_data.clone());
            Self {
                app,
                downloads: home.join("Desktop"),
            }
        }
    }

    #[cfg(feature = "native-test")]
    pub fn record(&self, value: serde_json::Value) {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
        {
            let _ = writeln!(file, "{value}");
        }
    }

    /// Page downloads land on the Desktop, as in the Electron shell.
    pub fn download_directory(&self) -> PathBuf {
        self.downloads.clone()
    }

    pub fn open_external(&self, url: &Url) {
        #[cfg(feature = "native-test")]
        return self.record(serde_json::json!({ "effect": "open-external", "url": url.as_str() }));
        #[cfg(not(feature = "native-test"))]
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }

    pub fn reveal(&self, path: &Path) {
        #[cfg(feature = "native-test")]
        return self.record(serde_json::json!({ "effect": "reveal", "path": path, "bytes": std::fs::read(path).map(|bytes| bytes.len()).ok() }));
        #[cfg(not(feature = "native-test"))]
        let _ = tauri_plugin_opener::reveal_item_in_dir(path);
    }

    pub fn open_path(&self, path: &Path) {
        #[cfg(feature = "native-test")]
        return self.record(serde_json::json!({ "effect": "open-path", "path": path }));
        #[cfg(not(feature = "native-test"))]
        let _ = tauri_plugin_opener::open_path(path, None::<&str>);
    }

    pub fn copy(&self, text: String) {
        #[cfg(feature = "native-test")]
        return self.record(serde_json::json!({ "effect": "copy", "text": text }));
        #[cfg(not(feature = "native-test"))]
        std::thread::spawn(move || {
            use std::io::Write;
            if let Ok(mut child) = std::process::Command::new("/usr/bin/pbcopy")
                .stdin(std::process::Stdio::piped())
                .spawn()
            {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                let _ = child.wait();
            }
        });
    }

    /// A message box attached to a visible window when there is one; it never blocks the event loop.
    /// `answer` receives the index of the chosen button (the first is the default, the last cancels).
    pub fn dialog(
        &self,
        parent: Option<&WebviewWindow<R>>,
        kind: Kind,
        title: &str,
        detail: Option<&str>,
        buttons: &[&str],
        answer: impl FnOnce(usize) + Send + 'static,
    ) {
        #[cfg(feature = "native-test")]
        {
            let _ = kind;
            self.record(serde_json::json!({ "effect": "dialog", "title": title, "detail": detail, "buttons": buttons, "parent": parent.map(|window| window.label().to_owned()) }));
            answer(crate::native_test::dialog_answer(buttons.len()));
        }
        #[cfg(not(feature = "native-test"))]
        {
            use tauri_plugin_dialog::{
                DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
            };
            let mut builder = self
                .app
                .dialog()
                .message(detail.unwrap_or_default())
                .title(title)
                .kind(match kind {
                    Kind::Info => MessageDialogKind::Info,
                    Kind::Error => MessageDialogKind::Error,
                });
            if let Some(parent) = parent {
                let _ = parent.show();
                let _ = parent.set_focus();
                builder = builder.parent(parent);
            }
            let labels: Vec<String> = buttons.iter().map(|label| (*label).to_owned()).collect();
            builder = builder.buttons(match labels.as_slice() {
                [only] => MessageDialogButtons::OkCustom(only.clone()),
                [ok, cancel, ..] => {
                    MessageDialogButtons::OkCancelCustom(ok.clone(), cancel.clone())
                }
                [] => MessageDialogButtons::Ok,
            });
            builder.show_with_result(move |result| {
                let chosen = match result {
                    MessageDialogResult::Custom(label) => labels
                        .iter()
                        .position(|candidate| *candidate == label)
                        .unwrap_or(labels.len().saturating_sub(1)),
                    MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
                    _ => labels.len().saturating_sub(1),
                };
                answer(chosen);
            });
        }
    }

    /// A system notification; `clicked` runs when the viewer clicks it. Without notification permission nothing appears,
    /// and the menu action still reaches the pending state.
    pub fn notify(&self, message: String, clicked: impl FnOnce() + Send + 'static) {
        #[cfg(feature = "native-test")]
        {
            self.record(serde_json::json!({ "effect": "notify", "message": message }));
            drop(clicked);
        }
        #[cfg(all(not(feature = "native-test"), target_os = "macos"))]
        crate::notifications::post(crate::updater::TITLE, &message, clicked);
    }
}
