//! Suplex for iOS and Android: one webview that shows a remote Suplex host. It never installs or runs a host.

mod host;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

use tauri::{ipc::CapabilityBuilder, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use host::Navigation;

const WINDOW: &str = "main";

#[cfg(target_os = "android")]
const PICKER: &str = "http://tauri.localhost/index.html?pick=1";
#[cfg(not(target_os = "android"))]
const PICKER: &str = "tauri://localhost/index.html?pick=1";

/// `window.open` and `target="_blank"` links never open a second webview: navigation policy keeps the
/// host in place and sends other origins to the system browser. Android WebView ignores both otherwise.
/// Only the current host's origin can call `open_host_picker`.
const BRIDGE: &str = r#"window.open = (url) => { try { const u = new URL(String(url), location.href); if (u.protocol === "http:" || u.protocol === "https:") location.assign(u.href); } catch {} return null; };
document.addEventListener("click", (event) => { const link = event.target instanceof Element ? event.target.closest("a[target=_blank][href]") : null; if (!link || event.button !== 0) return; event.preventDefault(); window.open(link.href); }, true);
if (location.protocol === "https:" && window.__TAURI_INTERNALS__) window.suplexMobile = { openHostPicker: () => window.__TAURI_INTERNALS__.invoke("open_host_picker") };"#;

/// The host the window shows now. `None` while the picker shows.
#[derive(Default)]
struct Current {
    host: Mutex<Option<Url>>,
    grants: AtomicUsize,
}

fn open_host(app: &AppHandle, input: &str) -> Result<(), String> {
    let host = host::parse_host(input).map_err(str::to_owned)?;
    let current = app.state::<Current>();
    // Each connection grants the picker command to that exact origin, and to nothing else.
    let grant = current.grants.fetch_add(1, Ordering::SeqCst);
    app.add_capability(
        CapabilityBuilder::new(format!("host-{grant}"))
            .remote(format!("{}/*", host.origin().ascii_serialization()))
            .local(false)
            .window(WINDOW)
            .permission("allow-open-host-picker"),
    )
    .map_err(|error| error.to_string())?;
    if let Ok(directory) = app.path().app_data_dir() {
        if let Err(error) = host::save_host(&directory, &host) {
            eprintln!("Suplex could not save the host: {error}");
        }
    }
    *current.host.lock().unwrap() = Some(host.clone());
    app.get_webview_window(WINDOW)
        .ok_or("The Suplex window is not available.")?
        .navigate(host)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn connect(app: AppHandle, url: String) -> Result<(), String> {
    open_host(&app, &url)
}

#[tauri::command]
fn saved_host(app: AppHandle) -> Option<String> {
    let directory = app.path().app_data_dir().ok()?;
    host::load_host(&directory).map(String::from)
}

#[tauri::command]
fn open_host_picker(app: AppHandle) -> Result<(), String> {
    if let Ok(directory) = app.path().app_data_dir() {
        if let Err(error) = host::clear_host(&directory) {
            eprintln!("Suplex could not clear the saved host: {error}");
        }
    }
    *app.state::<Current>().host.lock().unwrap() = None;
    let picker = Url::parse(PICKER).map_err(|error| error.to_string())?;
    app.get_webview_window(WINDOW)
        .ok_or("The Suplex window is not available.")?
        .navigate(picker)
        .map_err(|error| error.to_string())
}

fn open_link(app: &AppHandle, link: &Url) {
    // `suplex://auth/done` only brings the app to the front, which the system already did.
    let Some(host) = host::invitation_host(link) else {
        return;
    };
    // Links arrive on the UI thread, and the Android path plugin waits for that thread.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_host(&app, host.as_str()) {
            eprintln!("Suplex could not open the invitation: {error}");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(Current::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            saved_host,
            open_host_picker
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
                .initialization_script(BRIDGE)
                .on_navigation(move |url| {
                    let current = handle.state::<Current>().host.lock().unwrap().clone();
                    match host::classify(url, current.as_ref()) {
                        Navigation::Allow => true,
                        Navigation::External(url) => {
                            // This callback runs on the UI thread, and the Android opener waits for that thread.
                            let opener = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) =
                                    opener.opener().open_url(url.as_str(), None::<&str>)
                                {
                                    eprintln!("Suplex could not open the link: {error}");
                                }
                            });
                            false
                        }
                        Navigation::Block => false,
                    }
                })
                .build()?;
            let links = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for link in event.urls() {
                    open_link(&links, &link);
                }
            });
            if let Ok(Some(links)) = app.deep_link().get_current() {
                for link in links {
                    open_link(app.handle(), &link);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Suplex could not start");
}
