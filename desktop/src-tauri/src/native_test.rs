//! The native smoke suite's driver: compiled only with `--features native-test`, never into a release.
//! It listens on a loopback port named in `<user data>/native-test-driver.port` and accepts JSON lines
//! to read shell state, evaluate a script in the current view, and trigger native actions.

use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{Manager, Runtime};

use crate::shell::{Shell, View};

/// Searched for by the package check to prove the driver is absent from production builds.
pub const MARKER: &str = "suplex-native-test-driver";

static EVALS: AtomicU64 = AtomicU64::new(0);

/// The label and URL of the last page that finished loading; cleared while a page loads.
static LOADED: Mutex<Option<(String, String)>> = Mutex::new(None);

pub fn dialog_answer(buttons: usize) -> usize {
    std::env::var("SUPLEX_NATIVE_TEST_DIALOG_ANSWER")
        .ok()
        .and_then(|answer| answer.parse().ok())
        .unwrap_or(0)
        .min(buttons.saturating_sub(1))
}

pub fn page_loaded<R: Runtime>(shell: &Shell<R>, label: &str, url: &url::Url, started: bool) {
    *LOADED.lock().unwrap() = (!started).then(|| (label.to_owned(), url.to_string()));
    shell.effects.record(
        json!({ "event": "page", "label": label, "url": url.as_str(), "started": started }),
    );
}

pub fn start<R: Runtime>(shell: &Arc<Shell<R>>) {
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else {
        return;
    };
    let Ok(address) = listener.local_addr() else {
        return;
    };
    let _ = std::fs::create_dir_all(&shell.paths.user_data);
    let _ = std::fs::write(
        shell.paths.user_data.join("native-test-driver.port"),
        format!("{}\n{MARKER}\n", address.port()),
    );
    let shell = Arc::downgrade(shell);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let shell = shell.clone();
            std::thread::spawn(move || {
                let mut writer = match stream.try_clone() {
                    Ok(writer) => writer,
                    Err(_) => return,
                };
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let Some(shell) = shell.upgrade() else { return };
                    let reply = match serde_json::from_str::<Value>(&line) {
                        Ok(command) => tauri::async_runtime::block_on(handle(&shell, command)),
                        Err(error) => json!({ "error": error.to_string() }),
                    };
                    if writeln!(writer, "{reply}").is_err() {
                        return;
                    }
                }
            });
        }
    });
}

fn view_json(view: &View) -> Value {
    match view {
        View::None => json!({ "kind": "none" }),
        View::Setup { label } => json!({ "kind": "setup", "label": label }),
        View::Unavailable { label, target } => {
            json!({ "kind": "unavailable", "label": label, "target": target.origin })
        }
        View::Host {
            label,
            origin,
            generation,
        } => json!({ "kind": "host", "label": label, "origin": origin, "generation": generation }),
    }
}

async fn handle<R: Runtime>(shell: &Arc<Shell<R>>, command: Value) -> Value {
    match command["cmd"].as_str().unwrap_or_default() {
        "state" => {
            let windows: Vec<String> = shell.app.webview_windows().keys().cloned().collect();
            let network = shell.network.state();
            json!({
                "view": view_json(&shell.view()),
                "boot": serde_json::to_value(shell.snapshot().state).unwrap_or_default(),
                "local": shell.local_origin(),
                "windows": windows,
                "registry": shell.registry().origins(),
                "busy": network.busy,
                "preference": serde_json::to_value(network.preference).unwrap_or_default(),
                // The loaded page, not the window's URL: WKWebView reports a new URL before its page replaces the
                // old one, and a script evaluated in between is lost with the old page.
                "url": LOADED.lock().unwrap().as_ref().filter(|(label, _)| shell.view().label() == Some(label.as_str())).map(|(_, url)| url.clone()),
            })
        }
        "eval" => {
            evaluate(
                shell,
                command["script"].as_str().unwrap_or_default(),
                Duration::from_millis(command["timeoutMs"].as_u64().unwrap_or(10_000)),
            )
            .await
        }
        "close-window" => {
            if let Some(window) = shell
                .view()
                .label()
                .and_then(|label| shell.app.get_webview_window(label))
            {
                let _ = window.close();
            }
            json!({ "ok": true })
        }
        "reopen" => {
            shell.open().await;
            json!({ "ok": true })
        }
        "quit" => {
            let shell = shell.clone();
            tauri::async_runtime::spawn(async move { shell.quit().await });
            json!({ "ok": true })
        }
        other => json!({ "error": format!("unknown command {other}") }),
    }
}

/// Runs an async script body in the current view's main frame and returns its JSON result.
async fn evaluate<R: Runtime>(shell: &Arc<Shell<R>>, body: &str, timeout: Duration) -> Value {
    let Some(window) = shell
        .view()
        .label()
        .and_then(|label| shell.app.get_webview_window(label))
    else {
        return json!({ "error": "no view" });
    };
    let id = EVALS.fetch_add(1, Ordering::SeqCst);
    let script = format!(
        "window.__suplexDriver = window.__suplexDriver || {{}}; (async () => {{ try {{ const value = await (async () => {{ {body} }})(); window.__suplexDriver[{id}] = JSON.stringify({{ ok: true, value }}); }} catch (error) {{ window.__suplexDriver[{id}] = JSON.stringify({{ ok: false, error: String(error && error.message || error) }}); }} }})();"
    );
    if window.eval(script).is_err() {
        return json!({ "error": "eval failed" });
    }
    let began = Instant::now();
    while began.elapsed() < timeout {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Mutex::new(Some(sender));
        let probe = format!("(window.__suplexDriver && window.__suplexDriver[{id}]) || null");
        if window
            .eval_with_callback(probe, move |result| {
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(result);
                }
            })
            .is_err()
        {
            continue;
        }
        let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(2), receiver).await else {
            continue;
        };
        let Ok(Value::String(stored)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        return serde_json::from_str(&stored).unwrap_or(json!({ "error": "unreadable result" }));
    }
    json!({ "error": "timeout" })
}
