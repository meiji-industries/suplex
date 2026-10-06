//! The one logical application window: saved bounds, native titlebar, navigation and popup policy,
//! and downloads. Each view (setup pages, remote-failure page, or a host) is its own webview window
//! with a label of its kind; switching views replaces the window at the same bounds.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use url::Url;

use crate::{
    paths::write_atomic,
    shell::Shell,
    targets::{classify_navigation, NavigationDecision},
};

pub const MIN_WIDTH: f64 = 900.0;
pub const MIN_HEIGHT: f64 = 600.0;

/// `window-state.json`, in logical points, as the Electron shell wrote it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

/// A display's usable area in logical points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Area {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// Saved bounds fitted to a current display: the display holding the saved origin, else the primary one.
/// Missing or corrupt state uses the 1200 by 800 default; nothing is ever smaller than 900 by 600.
pub fn fit(saved: Option<Bounds>, displays: &[Area], primary: Area) -> Bounds {
    let saved = saved.unwrap_or_default();
    let area = match (saved.x, saved.y) {
        (Some(x), Some(y)) => displays
            .iter()
            .copied()
            .find(|area| area.contains(x, y))
            .unwrap_or(primary),
        _ => primary,
    };
    let positive = |value: f64, default: f64| {
        if value.is_finite() && value > 0.0 {
            value
        } else {
            default
        }
    };
    Bounds {
        width: positive(saved.width, 1200.0).min(area.width).max(MIN_WIDTH),
        height: positive(saved.height, 800.0)
            .min(area.height)
            .max(MIN_HEIGHT),
        x: saved
            .x
            .filter(|x| x.is_finite())
            .map(|x| x.min(area.x + area.width - 100.0).max(area.x)),
        y: saved
            .y
            .filter(|y| y.is_finite())
            .map(|y| y.min(area.y + area.height - 100.0).max(area.y)),
    }
}

pub fn read_bounds(file: &Path) -> Option<Bounds> {
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

pub fn write_bounds(file: &Path, bounds: Bounds) {
    if let Ok(text) = serde_json::to_string(&bounds) {
        let _ = write_atomic(file, text.as_bytes());
    }
}

fn areas<R: Runtime>(app: &tauri::AppHandle<R>) -> (Vec<Area>, Area) {
    const FALLBACK: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };
    if cfg!(test) {
        // Tauri's mock runtime has no displays.
        return (vec![FALLBACK], FALLBACK);
    }
    let area = |monitor: &tauri::Monitor| {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        Area {
            x: work.position.x as f64 / scale,
            y: work.position.y as f64 / scale,
            width: work.size.width as f64 / scale,
            height: work.size.height as f64 / scale,
        }
    };
    let displays: Vec<Area> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(area)
        .collect();
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| area(&monitor))
        .or_else(|| displays.first().copied())
        .unwrap_or(FALLBACK);
    (displays, primary)
}

pub fn current_bounds<R: Runtime>(window: &WebviewWindow<R>) -> Option<Bounds> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Bounds {
        width: size.width,
        height: size.height,
        x: Some(position.x),
        y: Some(position.y),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewKind {
    Setup,
    Unavailable,
    Host,
}

impl ViewKind {
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Unavailable => "unavailable",
            Self::Host => "host",
        }
    }
}

/// What a new view window loads and which bridge its main frame receives.
pub struct ViewSpec {
    pub kind: ViewKind,
    pub label: String,
    pub url: Url,
    /// The exact origin this view may stay on. Bundled pages use the app's own origin.
    pub origin: String,
    pub bridge: String,
    /// The web storage of this installation's data directory, as Chromium storage lived there before.
    pub data_store: [u8; 16],
    /// The same isolation where WebView2 and WebKitGTK key storage by directory.
    pub webview_data: PathBuf,
}

/// A stable 128-bit FNV-1a digest of the user data path, used as the WebKit data store identifier.
pub fn data_store_for(user_data: &Path) -> [u8; 16] {
    let mut hash: u128 = 0x6c62272e07bb014262b821756295c58d;
    for byte in user_data.as_os_str().as_encoded_bytes() {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(0x0000000001000000000000000000013b);
    }
    hash.to_be_bytes()
}

/// The shell's own bundled pages, served by the app protocol.
pub fn app_page(path: &str) -> Url {
    Url::parse(&format!("{APP_ORIGIN}/"))
        .unwrap()
        .join(path)
        .expect("a bundled page path")
}

/// Bundled pages: `tauri://localhost` on macOS and Linux; WebView2 on Windows serves them from `http://tauri.localhost`.
pub const APP_ORIGIN: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

/// True for a URL on the shell's own bundled-page origin.
pub fn is_app_page(url: &Url) -> bool {
    if cfg!(windows) {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    }
}

pub fn build_view<R: Runtime>(
    app: &tauri::AppHandle<R>,
    shell: Weak<Shell<R>>,
    spec: ViewSpec,
    bounds: Bounds,
    focus: bool,
) -> tauri::Result<WebviewWindow<R>> {
    let url = match spec.kind {
        ViewKind::Host => WebviewUrl::External(spec.url.clone()),
        // The path and query: a page such as choice.html?manage=1 reads its mode from the query.
        _ => WebviewUrl::App(
            spec.url[url::Position::BeforePath..]
                .trim_start_matches('/')
                .to_owned()
                .into(),
        ),
    };
    let (displays, primary) = areas(app);
    let bounds = fit(Some(bounds), &displays, primary);
    let navigation_shell = shell.clone();
    let window_shell = shell.clone();
    let page_shell = shell.clone();
    let popup_shell = shell.clone();
    let origin = spec.origin.clone();
    let popup_origin = spec.origin.clone();
    let kind = spec.kind;
    let label = spec.label.clone();
    let popup_label = spec.label.clone();
    let mut builder = WebviewWindowBuilder::new(app, &spec.label, url)
        .title("Suplex")
        .inner_size(bounds.width, bounds.height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .background_color(tauri::window::Color(10, 10, 10, 255))
        .focused(focus)
        .disable_drag_drop_handler()
        .initialization_script(spec.bridge)
        .on_navigation(move |url| navigation_allowed(&navigation_shell, kind, &label, &origin, url))
        .on_new_window(move |url, _features| {
            if let Some(shell) = popup_shell.upgrade() {
                shell.popup(kind, &popup_label, &popup_origin, url);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            if let Some(shell) = page_shell.upgrade() {
                shell.page_loaded(
                    webview.label(),
                    payload.url(),
                    payload.event() == PageLoadEvent::Started,
                );
            }
        });
    // macOS draws the traffic lights over the page; Windows and Linux keep their native title bar.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    // WKWebView isolates storage by identifier; WebView2 and WebKitGTK by directory.
    builder = if cfg!(target_os = "macos") {
        builder.data_store_identifier(spec.data_store)
    } else {
        builder.data_directory(spec.webview_data.clone())
    };
    if let (Some(x), Some(y)) = (bounds.x, bounds.y) {
        builder = builder.position(x, y);
    }
    if kind == ViewKind::Host {
        let downloads = Arc::new(Downloads::default());
        let download_shell = shell.clone();
        builder = builder.on_download(move |_webview, event| match download_shell.upgrade() {
            Some(shell) => downloads.handle(&shell.download_directory(), event, |path| {
                shell.reveal(path)
            }),
            None => false,
        });
    }
    let window = builder.build()?;
    place_traffic_lights(&window);
    let placed = window.clone();
    window.on_window_event(move |event| {
        // AppKit lays the title bar out again on these events.
        if matches!(
            event,
            WindowEvent::Resized(_)
                | WindowEvent::Focused(_)
                | WindowEvent::ScaleFactorChanged { .. }
        ) {
            place_traffic_lights(&placed);
        }
        if let Some(shell) = window_shell.upgrade() {
            shell.window_event(event);
        }
    });
    Ok(window)
}

/// Places the traffic lights 16 points from the left and 12 from the top. Tauri's `traffic_light_position` sizes the title bar container
/// but keeps each button's own vertical offset, which is 9 points on macOS 26, so the buttons sat 3 points from the top.
fn place_traffic_lights<R: Runtime>(window: &WebviewWindow<R>) {
    // Tauri's mock runtime hands out a placeholder NSWindow pointer.
    #[cfg(all(target_os = "macos", not(test)))]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
        use objc2_foundation::NSPoint;
        /// Where the traffic lights sit, in points from the window's top-left corner, as in the Electron shell.
        const TRAFFIC_LIGHTS: (f64, f64) = (16.0, 12.0);
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            // A closed window has no NSWindow, so a late call does nothing.
            let Ok(pointer) = target.ns_window() else {
                return;
            };
            // SAFETY: on the main thread, `ns_window` is this live window's NSWindow.
            let window = unsafe { &*(pointer as *const NSWindow) };
            if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
                return;
            }
            let buttons = [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .map(|kind| window.standardWindowButton(kind));
            let [Some(close), Some(minimize), Some(zoom)] = buttons else {
                return;
            };
            // SAFETY: the buttons live in the title bar view, inside the title bar container.
            let Some(container) = (unsafe { close.superview().and_then(|view| view.superview()) })
            else {
                return;
            };
            let (x, y) = TRAFFIC_LIGHTS;
            let height = close.frame().size.height + y;
            let mut frame = container.frame();
            frame.size.height = height;
            frame.origin.y = window.frame().size.height - height;
            container.setFrame(frame);
            let spacing = minimize.frame().origin.x - close.frame().origin.x;
            for (index, button) in [close, minimize, zoom].iter().enumerate() {
                button.setFrameOrigin(NSPoint::new(x + index as f64 * spacing, 0.0));
            }
        });
    }
    #[cfg(any(not(target_os = "macos"), test))]
    let _ = window;
}

fn navigation_allowed<R: Runtime>(
    shell: &Weak<Shell<R>>,
    kind: ViewKind,
    label: &str,
    origin: &str,
    url: &Url,
) -> bool {
    let Some(shell) = shell.upgrade() else {
        return false;
    };
    if kind != ViewKind::Host && is_app_page(url) {
        // The setup form submits ?url=… to connect; the shell validates it and switches the window.
        if let Some(submitted) = url
            .query_pairs()
            .find(|(key, _)| key == "url")
            .map(|(_, value)| value.into_owned())
        {
            if kind == ViewKind::Setup {
                shell.submitted_url(label, submitted);
            }
            return false;
        }
        return true;
    }
    if kind != ViewKind::Host && url.as_str() == "about:blank" {
        return true;
    }
    match classify_navigation(url.as_str(), (kind == ViewKind::Host).then_some(origin)) {
        NavigationDecision::Internal(_) => true,
        NavigationDecision::External(url) => {
            shell.open_external(&url);
            false
        }
        NavigationDecision::Blocked(_) => false,
    }
}

/// Saves page downloads to one directory under constrained, non-colliding names and reveals only completed files.
#[derive(Default)]
pub struct Downloads {
    pending: Mutex<HashMap<String, VecDeque<PathBuf>>>,
    reserved: Mutex<HashSet<PathBuf>>,
}

/// The suggested file name reduced to one safe path component.
pub fn safe_name(suggested: &str) -> String {
    let name: String = suggested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character == ':' || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    let name = name.trim().trim_start_matches('.').to_owned();
    if name.is_empty() {
        "download".into()
    } else {
        name
    }
}

/// `name (n).ext` for the first free slot, so an existing file is never overwritten.
pub fn unique_path(directory: &Path, name: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let candidate = directory.join(name);
    if !taken(&candidate) {
        return candidate;
    }
    let (stem, extension) = match name.split_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    (1..)
        .map(|index| directory.join(format!("{stem} ({index}){extension}")))
        .find(|path| !taken(path))
        .expect("an unused name")
}

impl Downloads {
    pub fn handle(
        &self,
        directory: &Path,
        event: DownloadEvent<'_>,
        reveal: impl Fn(&Path),
    ) -> bool {
        match event {
            DownloadEvent::Requested { url, destination } => {
                let name = safe_name(
                    &destination
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                );
                let _ = std::fs::create_dir_all(directory);
                let mut reserved = self.reserved.lock().unwrap();
                let path = unique_path(directory, &name, |path| {
                    path.exists() || reserved.contains(path)
                });
                reserved.insert(path.clone());
                *destination = path.clone();
                self.pending
                    .lock()
                    .unwrap()
                    .entry(url.to_string())
                    .or_default()
                    .push_back(path);
                true
            }
            DownloadEvent::Finished { url, path, success } => {
                let chosen = self
                    .pending
                    .lock()
                    .unwrap()
                    .get_mut(url.as_str())
                    .and_then(VecDeque::pop_front);
                let finished = path.or(chosen);
                if let Some(finished) = &finished {
                    self.reserved.lock().unwrap().remove(finished);
                    if success && finished.is_file() {
                        reveal(finished);
                    }
                }
                true
            }
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const MAIN: Area = Area {
        x: 0.0,
        y: 25.0,
        width: 1920.0,
        height: 1055.0,
    };
    const SIDE: Area = Area {
        x: 1920.0,
        y: 0.0,
        width: 1280.0,
        height: 800.0,
    };

    #[test]
    fn missing_or_corrupt_state_uses_the_default_size() {
        assert_eq!(
            fit(None, &[MAIN], MAIN),
            Bounds {
                width: 1200.0,
                height: 800.0,
                x: None,
                y: None
            }
        );
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("window-state.json");
        std::fs::write(&file, "{broken").unwrap();
        assert_eq!(read_bounds(&file), None);
        std::fs::write(&file, r#"{"width":1500,"height":900,"x":40,"y":60}"#).unwrap();
        assert_eq!(
            read_bounds(&file),
            Some(Bounds {
                width: 1500.0,
                height: 900.0,
                x: Some(40.0),
                y: Some(60.0)
            })
        );
    }

    #[test]
    fn bounds_keep_the_900_by_600_minimum_and_fit_the_display() {
        assert_eq!(
            fit(
                Some(Bounds {
                    width: 300.0,
                    height: 200.0,
                    x: Some(10.0),
                    y: Some(40.0)
                }),
                &[MAIN],
                MAIN
            ),
            Bounds {
                width: 900.0,
                height: 600.0,
                x: Some(10.0),
                y: Some(40.0)
            }
        );
        assert_eq!(
            fit(
                Some(Bounds {
                    width: 5000.0,
                    height: 5000.0,
                    x: None,
                    y: None
                }),
                &[MAIN],
                MAIN
            ),
            Bounds {
                width: 1920.0,
                height: 1055.0,
                x: None,
                y: None
            }
        );
    }

    #[test]
    fn off_screen_positions_are_clamped_to_a_current_display() {
        let gone = fit(
            Some(Bounds {
                width: 1200.0,
                height: 800.0,
                x: Some(5000.0),
                y: Some(-400.0),
            }),
            &[MAIN],
            MAIN,
        );
        assert_eq!((gone.x, gone.y), (Some(1820.0), Some(25.0)));
        let side = fit(
            Some(Bounds {
                width: 1200.0,
                height: 700.0,
                x: Some(2000.0),
                y: Some(50.0),
            }),
            &[MAIN, SIDE],
            MAIN,
        );
        assert_eq!(
            side,
            Bounds {
                width: 1200.0,
                height: 700.0,
                x: Some(2000.0),
                y: Some(50.0)
            },
            "a window on a second display stays there"
        );
    }

    #[test]
    fn bounds_round_trip_in_the_existing_file_format() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("window-state.json");
        write_bounds(
            &file,
            Bounds {
                width: 1200.0,
                height: 800.0,
                x: Some(0.0),
                y: Some(25.0),
            },
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            r#"{"width":1200.0,"height":800.0,"x":0.0,"y":25.0}"#
        );
        assert_eq!(read_bounds(&file).unwrap().width, 1200.0);
    }

    #[test]
    fn download_names_are_single_safe_components() {
        assert_eq!(safe_name("report.csv"), "report.csv");
        assert_eq!(safe_name("../../.ssh/authorized_keys"), "authorized_keys");
        assert_eq!(safe_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(safe_name(".."), "download");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name("x:y\u{7}.txt"), "x_y_.txt");
        assert_eq!(safe_name(""), "download");
    }

    #[test]
    fn collisions_get_a_numbered_name_instead_of_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("report.csv"), "theirs").unwrap();
        std::fs::write(directory.path().join("report (1).csv"), "theirs").unwrap();
        assert_eq!(
            unique_path(directory.path(), "report.csv", Path::exists),
            directory.path().join("report (2).csv")
        );
        assert_eq!(
            unique_path(directory.path(), "notes", Path::exists),
            directory.path().join("notes")
        );
    }

    #[test]
    fn downloads_are_constrained_reserved_and_revealed_only_when_complete() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("export.json"), "existing").unwrap();
        let downloads = Downloads::default();
        let revealed = RefCell::new(Vec::new());
        let url = Url::parse("blob:https://suplex.example/1").unwrap();
        let mut first = PathBuf::from("/Users/ada/Downloads/../../etc/export.json");
        let mut second = PathBuf::from("/Users/ada/Downloads/export.json");
        downloads.handle(
            directory.path(),
            DownloadEvent::Requested {
                url: url.clone(),
                destination: &mut first,
            },
            |path| revealed.borrow_mut().push(path.to_owned()),
        );
        downloads.handle(
            directory.path(),
            DownloadEvent::Requested {
                url: url.clone(),
                destination: &mut second,
            },
            |path| revealed.borrow_mut().push(path.to_owned()),
        );
        assert_eq!(first, directory.path().join("export (1).json"));
        assert_eq!(
            second,
            directory.path().join("export (2).json"),
            "a concurrent download does not reuse a reserved name"
        );
        std::fs::write(&first, "bytes").unwrap();
        downloads.handle(
            directory.path(),
            DownloadEvent::Finished {
                url: url.clone(),
                path: None,
                success: true,
            },
            |path| revealed.borrow_mut().push(path.to_owned()),
        );
        downloads.handle(
            directory.path(),
            DownloadEvent::Finished {
                url,
                path: None,
                success: false,
            },
            |path| revealed.borrow_mut().push(path.to_owned()),
        );
        assert_eq!(*revealed.borrow(), [first]);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("export.json")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn each_data_directory_has_its_own_stable_web_storage() {
        let production = data_store_for(Path::new("/Users/ada/Library/Application Support/Suplex"));
        assert_eq!(
            production,
            data_store_for(Path::new("/Users/ada/Library/Application Support/Suplex"))
        );
        assert_ne!(production, data_store_for(Path::new("/tmp/suplex-dev")));
        assert_eq!(
            production,
            [197, 143, 196, 60, 11, 86, 36, 227, 229, 34, 74, 1, 251, 178, 218, 37],
            "FNV-1a 128 of the path"
        );
    }

    #[test]
    fn app_pages_stay_on_the_app_origin() {
        assert_eq!(
            app_page("pages/choice.html?manage=1").as_str(),
            format!("{APP_ORIGIN}/pages/choice.html?manage=1")
        );
        assert!(is_app_page(&app_page("pages/choice.html")));
        assert!(!is_app_page(
            &Url::parse("https://tauri.localhost/pages/choice.html").unwrap()
        ));
        if cfg!(windows) {
            assert_eq!(
                app_page("pages/choice.html").origin().ascii_serialization(),
                APP_ORIGIN
            );
        } else {
            assert_eq!(
                app_page("pages/choice.html").origin().ascii_serialization(),
                "null",
                "custom schemes have opaque origins; the label and scheme check guard them"
            );
        }
    }
}
