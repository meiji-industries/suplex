//! The desktop shell's state and orchestration: boot, host selection, the owned local host, network
//! restarts, and the native checks behind every bridge call. It either supervises the bundled host on
//! this computer or shows a host somebody else runs, which it never starts, stops, or signals.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};

use tauri::{ipc::CapabilityBuilder, AppHandle, Manager, Runtime, WebviewWindow, WindowEvent};
use url::Url;

use crate::{
    boot::{
        next, read_install_record, resolve_boot, runtime_stamp, write_install_record, BootEvent,
        BootState, InstallRecord, Mode, DEFAULT_PORT,
    },
    contracts::{
        AppNetworkAccess, BootFailure, DesktopSnapshot, FailureSource, FinishedStage, InstallEvent,
        InstallStage, ManagedNetworkAccess, NetworkMode, ZoomStep,
    },
    effects::Effects,
    installer::{InstallCancel, InstallOutcome, Installer},
    local_runtime::{LocalHost, Timing},
    menu,
    network_access::{
        ActiveNetworkAccess, Controller, NetworkState, Ports, ResolvedNetworkAccess, StartError,
        Started,
    },
    paths::{Paths, RuntimePaths},
    platform::{LOCAL_SUPPORTED, MACHINE},
    tailscale,
    targets::{
        self, classify_navigation, parse_target, NavigationDecision, Registry, SuplexTarget,
    },
    window::{self, app_page, build_view, current_bounds, ViewKind, ViewSpec, APP_ORIGIN},
};

pub const INVALID_TITLE: &str = "The Suplex URL is not valid";
const LOG_LIMIT: usize = 500;
/// How long the launch page gets to fill its bar and fade out before the app replaces it.
const LAUNCH_OUTRO: Duration = Duration::from_millis(500);

/// What the window shows. Labels are never reused, so grants bound to an old label cannot reach a new page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum View {
    None,
    Setup {
        label: String,
    },
    Unavailable {
        label: String,
        target: SuplexTarget,
    },
    Host {
        label: String,
        origin: String,
        generation: u64,
    },
}

impl View {
    pub fn label(&self) -> Option<&str> {
        match self {
            Self::None => None,
            Self::Setup { label } | Self::Unavailable { label, .. } | Self::Host { label, .. } => {
                Some(label)
            }
        }
    }
    pub fn origin(&self) -> Option<&str> {
        match self {
            Self::Host { origin, .. } => Some(origin),
            Self::Unavailable { target, .. } => Some(&target.origin),
            _ => None,
        }
    }
}

#[derive(Default)]
struct Progress {
    stages: Vec<InstallStage>,
    finished: Vec<FinishedStage>,
    current: Option<String>,
    log: Vec<String>,
}

struct State {
    boot: BootState,
    progress: Progress,
    registry: Registry,
    local_installed: bool,
    view: View,
    /// A local page whose admin session was verified; only it receives network-access changes.
    admin_page: Option<(String, u64)>,
    bounds: Option<window::Bounds>,
}

/// The local page captured before a network restart, so the window can return to it if nothing changed meanwhile.
#[derive(Clone, Debug)]
pub struct LocalPage {
    label: String,
    generation: u64,
    url: Url,
}

pub struct Shell<R: Runtime> {
    pub app: AppHandle<R>,
    pub argv: Vec<String>,
    pub environment: HashMap<String, String>,
    pub paths: Paths,
    pub runtime: RuntimePaths,
    pub default_port: u16,
    pub effects: Effects<R>,
    state: Mutex<State>,
    pub network: Arc<Controller<HostPorts>>,
    install_cancel: Mutex<Option<InstallCancel>>,
    labels: AtomicU64,
    quitting: AtomicBool,
    shut_down: AtomicBool,
    /// Launch arguments choose the first host only; a reopened window shows the current selection.
    launched: AtomicBool,
    bounds_generation: AtomicU64,
    zoom: Mutex<f64>,
    fullscreen: AtomicBool,
    weak: Weak<Shell<R>>,
}

/// The network controller's view of the owned host.
pub struct HostPorts {
    local: Arc<LocalHost>,
    paths: Paths,
    default_port: u16,
}

impl Ports for HostPorts {
    async fn resolve(&self, preference: NetworkMode) -> Result<ResolvedNetworkAccess, String> {
        Ok(match preference {
            NetworkMode::Local => ResolvedNetworkAccess::Local,
            NetworkMode::All => ResolvedNetworkAccess::All,
            NetworkMode::Tailscale => {
                let access =
                    tailscale::resolve_access(tailscale::COMMANDS, &tailscale::SystemRunner)
                        .await?;
                ResolvedNetworkAccess::Tailscale {
                    hostname: access.hostname,
                    command: access.command,
                }
            }
        })
    }

    async fn start(&self, access: &ResolvedNetworkAccess) -> Result<Started, StartError> {
        let record = read_install_record(&self.paths.install_record());
        let port = record
            .as_ref()
            .map_or(self.default_port, |record| record.port);
        match self.local.start(port, access).await {
            Ok(started) => {
                if let Some(record) = record.filter(|record| record.port != started.port) {
                    let _ = write_install_record(
                        &self.paths.install_record(),
                        &InstallRecord {
                            port: started.port,
                            ..record
                        },
                    );
                }
                Ok(started)
            }
            Err(StartError::CleanupRequired { message, port }) => {
                let ResolvedNetworkAccess::Tailscale { hostname, command } = access else {
                    return Err(StartError::Failed(message));
                };
                let removal = tailscale::remove_serve_route(
                    &tailscale::TailscaleAccess {
                        hostname: hostname.clone(),
                        command: command.clone(),
                    },
                    port,
                    &tailscale::SystemRunner,
                )
                .await;
                match removal {
                    Ok(()) => Err(StartError::Failed(message)),
                    Err(cleanup) => Err(StartError::CleanupRequired { message: format!("Suplex could not verify removal of its Tailscale Serve route. {message} {cleanup}"), port }),
                }
            }
            Err(error) => Err(error),
        }
    }

    async fn stop(&self) -> Result<(), String> {
        self.local.stop().await;
        Ok(())
    }

    async fn remove_serve_route(
        &self,
        hostname: &str,
        command: &str,
        port: u16,
    ) -> Result<(), String> {
        tailscale::remove_serve_route(
            &tailscale::TailscaleAccess {
                hostname: hostname.into(),
                command: command.into(),
            },
            port,
            &tailscale::SystemRunner,
        )
        .await
    }

    async fn recover_serve_route(&self, port: Option<u16>) -> Result<(), String> {
        let port = port.unwrap_or_else(|| {
            read_install_record(&self.paths.install_record())
                .map_or(self.default_port, |record| record.port)
        });
        match tailscale::serve_cli(tailscale::COMMANDS, &tailscale::SystemRunner).await? {
            None => Ok(()),
            Some(command) => {
                tailscale::remove_serve_route(
                    &tailscale::TailscaleAccess {
                        hostname: String::new(),
                        command,
                    },
                    port,
                    &tailscale::SystemRunner,
                )
                .await
            }
        }
    }
}

/// The bundled page that shows a setup step, or `None` once a host is selected.
fn setup_page(state: &BootState) -> Option<&'static str> {
    Some(match state {
        BootState::Resolve | BootState::Connected { .. } => return None,
        BootState::BootstrapNeeded | BootState::Choosing => "pages/choice.html",
        BootState::Installing { .. } => "pages/install.html",
        BootState::Ready => "pages/ready.html",
        BootState::Starting => "pages/connecting.html",
        BootState::ConnectingRemote { .. } => "connect.html",
        BootState::Failed(_) => "pages/failed.html",
    })
}

fn local_origin_of(state: &NetworkState) -> Option<String> {
    state.active.as_ref().map(|active| match active {
        ActiveNetworkAccess::Owned { port, .. } | ActiveNetworkAccess::Adopted { port } => {
            format!("http://127.0.0.1:{port}")
        }
    })
}

pub fn tail(file: &Path, lines: usize) -> Vec<String> {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let kept: Vec<String> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect();
    kept[kept.len().saturating_sub(lines)..].to_vec()
}

/// The cookies a browser would send to `url` from a cookie store, per RFC 6265 domain, path, and secure rules.
pub fn cookie_header(cookies: &[tauri::webview::Cookie<'static>], url: &Url) -> Option<String> {
    let host = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let path = url.path();
    let now = time::OffsetDateTime::now_utc();
    let pairs: Vec<String> = cookies
        .iter()
        .filter(|cookie| {
            let domain = cookie
                .domain()
                .unwrap_or_default()
                .trim_start_matches('.')
                .to_ascii_lowercase();
            let domain_matches = domain == host
                || (!domain.is_empty()
                    && host.ends_with(&format!(".{domain}"))
                    && host.parse::<std::net::IpAddr>().is_err());
            let cookie_path = cookie.path().unwrap_or("/");
            let path_matches = path == cookie_path
                || (path.starts_with(cookie_path)
                    && (cookie_path.ends_with('/') || path[cookie_path.len()..].starts_with('/')));
            let secure_ok = !cookie.secure().unwrap_or(false)
                || url.scheme() == "https"
                || matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
            let live = cookie
                .expires_datetime()
                .is_none_or(|expires| expires > now);
            domain_matches && path_matches && secure_ok && live
        })
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect();
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

/// The host's own answer to "who is signed in here": an active admin, per `/api/auth/me`.
pub fn is_admin(body: &serde_json::Value) -> bool {
    body.get("user")
        .and_then(|user| user.get("role"))
        .and_then(serde_json::Value::as_str)
        == Some("admin")
}

/// Chrome's page zoom levels from 50 to 200 percent.
pub const ZOOM_LEVELS: [f64; 11] = [
    0.5,
    2.0 / 3.0,
    0.75,
    0.8,
    0.9,
    1.0,
    1.1,
    1.25,
    1.5,
    1.75,
    2.0,
];

/// The zoom level nearest to `zoom`; a value that is not a positive number is 100 percent.
pub fn snap_zoom(zoom: f64) -> f64 {
    if !zoom.is_finite() || zoom <= 0.0 {
        return 1.0;
    }
    ZOOM_LEVELS
        .into_iter()
        .min_by(|a, b| (a - zoom).abs().total_cmp(&(b - zoom).abs()))
        .unwrap()
}

/// The next page zoom: one level in or out, clamped at both ends, or back to 100 percent.
pub fn next_zoom(current: f64, step: ZoomStep) -> f64 {
    let current = snap_zoom(current);
    let index = ZOOM_LEVELS
        .iter()
        .position(|level| *level == current)
        .unwrap();
    match step {
        ZoomStep::In => ZOOM_LEVELS[(index + 1).min(ZOOM_LEVELS.len() - 1)],
        ZoomStep::Out => ZOOM_LEVELS[index.saturating_sub(1)],
        ZoomStep::Reset => 1.0,
    }
}

impl<R: Runtime> Shell<R> {
    pub fn new(
        app: AppHandle<R>,
        argv: Vec<String>,
        environment: HashMap<String, String>,
        resources: &Path,
    ) -> Arc<Self> {
        let paths = Paths::from_environment(&environment);
        let zoom = window::read_state(&paths.window_state())
            .and_then(|state| state.zoom)
            .map_or(1.0, snap_zoom);
        let runtime = RuntimePaths::resolve(&environment, resources);
        let default_port = environment
            .get("SUPLEX_DESKTOP_PORT")
            .and_then(|port| port.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let local = Arc::new(LocalHost::new(
            runtime.clone(),
            paths.user_data.clone(),
            environment.clone(),
            Timing::PRODUCTION,
        ));
        Arc::new_cyclic(|weak: &Weak<Shell<R>>| {
            let listener = weak.clone();
            let network = Controller::new(
                HostPorts {
                    local: local.clone(),
                    paths: paths.clone(),
                    default_port,
                },
                paths.network_access(),
                paths.network_access_cleanup(),
                move |_state| {
                    if let Some(shell) = listener.upgrade() {
                        // Off the caller's thread: the controller publishes while it holds its operation lock,
                        // and a menu rebuild waits for the main thread.
                        tauri::async_runtime::spawn(async move { shell.network_changed() });
                    }
                },
            );
            let effects = Effects::new(app.clone(), &paths);
            Shell {
                app,
                argv,
                environment,
                paths,
                runtime,
                default_port,
                effects,
                state: Mutex::new(State {
                    boot: BootState::Resolve,
                    progress: Progress::default(),
                    registry: Registry::default(),
                    local_installed: false,
                    view: View::None,
                    admin_page: None,
                    bounds: None,
                }),
                network,
                install_cancel: Mutex::new(None),
                labels: AtomicU64::new(0),
                quitting: AtomicBool::new(false),
                shut_down: AtomicBool::new(false),
                launched: AtomicBool::new(false),
                bounds_generation: AtomicU64::new(0),
                zoom: Mutex::new(zoom),
                fullscreen: AtomicBool::new(false),
                weak: weak.clone(),
            }
        })
    }

    fn spawn(
        &self,
        work: impl FnOnce(Arc<Self>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            + Send
            + 'static,
    ) {
        if let Some(shell) = self.weak.upgrade() {
            tauri::async_runtime::spawn(work(shell));
        }
    }

    // ----- observations -----

    pub fn local_origin(&self) -> Option<String> {
        local_origin_of(&self.network.state())
    }

    pub fn view(&self) -> View {
        self.state.lock().unwrap().view.clone()
    }

    pub fn boot_state(&self) -> BootState {
        self.state.lock().unwrap().boot.clone()
    }

    pub fn registry(&self) -> Registry {
        self.state.lock().unwrap().registry.clone()
    }

    pub fn local_installed(&self) -> bool {
        self.state.lock().unwrap().local_installed
    }

    fn window(&self) -> Option<WebviewWindow<R>> {
        self.view()
            .label()
            .and_then(|label| self.app.get_webview_window(label))
    }

    pub fn snapshot(&self) -> DesktopSnapshot {
        let state = self.state.lock().unwrap();
        DesktopSnapshot {
            state: state.boot.name(),
            stages: state.progress.stages.clone(),
            finished: state.progress.finished.clone(),
            current: state.progress.current.clone(),
            log: state.progress.log.clone(),
            failure: match &state.boot {
                BootState::Failed(failure) => Some(failure.clone()),
                _ => None,
            },
            hosts: state.registry.origins(),
            current_host: state
                .registry
                .current
                .as_ref()
                .map(|target| target.origin.clone()),
            local_host: self.local_origin(),
            platform: crate::platform::NAME,
        }
    }

    pub fn tailscale_url(&self) -> Option<String> {
        match self.network.state().active {
            Some(ActiveNetworkAccess::Owned {
                access: ResolvedNetworkAccess::Tailscale { hostname, .. },
                port,
            }) => Some(format!("https://{hostname}:{port}")),
            _ => None,
        }
    }

    pub fn access_snapshot(&self) -> AppNetworkAccess {
        let state = self.network.state();
        match &state.active {
            Some(ActiveNetworkAccess::Owned { access, .. }) => {
                AppNetworkAccess::Managed(ManagedNetworkAccess {
                    managed: true,
                    preference: state.preference,
                    active: Some(access.mode()),
                    pending: access.mode() != state.preference,
                    busy: state.busy,
                    https_url: self.tailscale_url(),
                })
            }
            _ => AppNetworkAccess::unmanaged(),
        }
    }

    // ----- views -----

    fn bridge(kind: ViewKind, origin: &str, target: Option<&str>, version: &str) -> String {
        let config = serde_json::json!({
            "kind": kind.prefix(),
            "origin": origin,
            "platform": crate::platform::NAME,
            "target": target,
            "version": version,
        });
        format!(
            "({})({config});",
            include_str!("../../src/bridge.js")
                .trim()
                .trim_end_matches(';')
        )
    }

    fn next_label(&self, kind: ViewKind) -> String {
        format!(
            "{}-{}",
            kind.prefix(),
            self.labels.fetch_add(1, Ordering::SeqCst) + 1
        )
    }

    /// Replaces the window with a new view at the same bounds, then destroys the previous view and its grants' only webview.
    fn replace_view(
        &self,
        kind: ViewKind,
        url: Url,
        origin: String,
        target: Option<SuplexTarget>,
    ) -> Option<String> {
        let label = self.next_label(kind);
        if kind == ViewKind::Host {
            // Bound to this exact label and origin. Remote content never receives bundled-page or plugin grants.
            let capability = CapabilityBuilder::new(label.clone())
                .remote(format!("{origin}/*"))
                .local(false)
                .webview(label.clone())
                .permission("allow-app-account-cleared")
                .permission("allow-app-open-host-picker")
                .permission("allow-app-network-access")
                .permission("allow-app-save-network-access-preference")
                .permission("allow-app-restart-network-access")
                .permission("allow-app-update-status")
                .permission("allow-app-check-for-updates")
                .permission("allow-app-zoom")
                .permission("core:window:allow-start-dragging")
                .permission("core:window:allow-internal-toggle-maximize");
            if let Err(error) = self.app.add_capability(capability) {
                eprintln!("Suplex could not grant the host page its bridge: {error}");
                return None;
            }
        }
        let previous = self.window();
        let focused = previous
            .as_ref()
            .is_none_or(|window| window.is_focused().unwrap_or(true));
        let bounds = previous
            .as_ref()
            .and_then(current_bounds)
            .or_else(|| self.state.lock().unwrap().bounds)
            .or_else(|| window::read_state(&self.paths.window_state()).map(|state| state.bounds))
            .unwrap_or_default();
        let bridge = Self::bridge(
            kind,
            &origin,
            target.as_ref().map(|target| target.origin.as_str()),
            &self.app.package_info().version.to_string(),
        );
        let spec = ViewSpec {
            kind,
            label: label.clone(),
            url,
            origin: origin.clone(),
            bridge,
            data_store: window::data_store_for(&self.paths.user_data),
            webview_data: self.paths.user_data.join("webview"),
        };
        match build_view(&self.app, self.weak.clone(), spec, bounds, focused) {
            Ok(window) => {
                let zoom = *self.zoom.lock().unwrap();
                if zoom != 1.0 {
                    let _ = window.set_zoom(zoom);
                }
                let view = match kind {
                    ViewKind::Setup => View::Setup {
                        label: label.clone(),
                    },
                    ViewKind::Unavailable => View::Unavailable {
                        label: label.clone(),
                        target: target.expect("the failure page names its host"),
                    },
                    ViewKind::Host => View::Host {
                        label: label.clone(),
                        origin,
                        generation: 0,
                    },
                };
                self.state.lock().unwrap().view = view;
                if let Some(previous) = previous {
                    let _ = previous.destroy();
                }
                Some(label)
            }
            Err(error) => {
                eprintln!("Suplex could not open its window: {error}");
                None
            }
        }
    }

    /// Shows a bundled setup page, reusing the current setup view when there is one.
    pub fn show_page(&self, page: &str) {
        let url = app_page(page);
        if let (View::Setup { .. }, Some(window)) = (self.view(), self.window()) {
            if window.navigate(url.clone()).is_ok() {
                return;
            }
        }
        self.replace_view(ViewKind::Setup, url, APP_ORIGIN.into(), None);
    }

    /// Loads a host in a host view for its exact origin. An unreachable remote shows the bundled failure page.
    pub async fn load(&self, target: &SuplexTarget) {
        if !self.answers(target).await {
            return;
        }
        if let View::Host { origin, .. } = self.view() {
            if origin == target.origin {
                if let Some(window) = self.window() {
                    let _ = window.navigate(target.url.clone());
                    return;
                }
            }
        }
        self.replace_view(
            ViewKind::Host,
            target.url.clone(),
            target.origin.clone(),
            None,
        );
    }

    /// True when `target` answers. Otherwise shows the failure page (remote) or the failed-start page (local).
    async fn answers(&self, target: &SuplexTarget) -> bool {
        let local = self
            .local_origin()
            .is_some_and(|local| local == target.origin);
        if !local && !crate::local_runtime::reachable(&target.origin, Duration::from_secs(4)).await
        {
            self.show_unavailable(target);
            return false;
        }
        if local && !crate::local_runtime::healthy(&target.origin, Duration::from_secs(4)).await {
            let log = tail(&self.paths.server_log(), 200);
            self.go(BootEvent::Failed(BootFailure {
                from: FailureSource::Starting,
                title: format!("Start Suplex on this {MACHINE}"),
                reason: format!("Suplex on this {MACHINE} stopped answering."),
                remedy: Some("Retry starts it again.".into()),
                stage: None,
                log,
            }));
            return false;
        }
        true
    }

    /// View > Reload: a host that stopped answering gets its failure page instead of a dead page.
    pub async fn reload(&self) {
        if let View::Host { origin, .. } = self.view() {
            let Ok(target) = parse_target(&format!("{origin}/")) else {
                return;
            };
            if !self.answers(&target).await {
                return;
            }
        }
        if let Some(window) = self.window() {
            let _ = window.reload();
        }
    }

    /// Zooms every view through the webview's native page zoom and saves the level for this device.
    pub fn zoom(&self, step: ZoomStep) {
        let zoom = {
            let mut zoom = self.zoom.lock().unwrap();
            *zoom = next_zoom(*zoom, step);
            *zoom
        };
        let current = self.window();
        if let Some(window) = &current {
            let _ = window.set_zoom(zoom);
        }
        let bounds = current
            .as_ref()
            .and_then(current_bounds)
            .or_else(|| self.state.lock().unwrap().bounds)
            .or_else(|| window::read_state(&self.paths.window_state()).map(|state| state.bounds));
        if let Some(bounds) = bounds {
            self.save_window_state(bounds);
        }
    }

    /// Writes `window-state.json` with these bounds and the current zoom.
    fn save_window_state(&self, bounds: window::Bounds) {
        let zoom = *self.zoom.lock().unwrap();
        window::write_state(
            &self.paths.window_state(),
            window::WindowState {
                bounds,
                zoom: (zoom != 1.0).then_some(zoom),
            },
        );
    }

    fn show_unavailable(&self, target: &SuplexTarget) {
        self.replace_view(
            ViewKind::Unavailable,
            app_page("pages/unavailable.html"),
            APP_ORIGIN.into(),
            Some(target.clone()),
        );
    }

    /// Remembers the target's origin and shows it.
    pub async fn switch_to(&self, target: SuplexTarget) {
        if let Ok(registry) = targets::remember(&self.paths.targets(), &target) {
            self.state.lock().unwrap().registry = registry;
        }
        self.state.lock().unwrap().boot = BootState::Connected {
            url: target.url.to_string(),
        };
        self.rebuild_menu();
        self.load(&target).await;
    }

    // ----- boot -----

    pub fn go(&self, event: BootEvent) {
        let changed = {
            let mut state = self.state.lock().unwrap();
            let updated = next(&state.boot, &event);
            let changed = updated != state.boot;
            state.boot = updated;
            changed
        };
        if changed {
            self.spawn(|shell| shell.enter());
        }
        self.rebuild_menu();
    }

    /// Performs the current boot state; every page load in the boot sequence happens here.
    /// Boxed so the boot sequence can re-enter itself from spawned work.
    pub fn enter(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        let Some(shell) = self.weak.upgrade() else {
            return Box::pin(async {});
        };
        Box::pin(async move { shell.enter_now().await })
    }

    async fn enter_now(&self) {
        match self.boot_state() {
            BootState::BootstrapNeeded => {
                self.show_page("pages/choice.html");
                let mut state = self.state.lock().unwrap();
                state.boot = next(&state.boot, &BootEvent::Shown);
            }
            BootState::Choosing => self.show_page("pages/choice.html"),
            BootState::Installing { from } => {
                self.show_page("pages/install.html");
                self.spawn(move |shell| Box::pin(async move { shell.run_install(from).await }));
            }
            BootState::Ready => self.show_page("pages/ready.html"),
            BootState::Starting => {
                self.show_page("pages/connecting.html");
                self.spawn(|shell| Box::pin(async move { shell.start_local().await }));
            }
            BootState::ConnectingRemote { url: None } => self.show_page("connect.html"),
            BootState::ConnectingRemote { url: Some(url) } => {
                self.connect_remote(&url, false).await
            }
            BootState::Connected { url } => {
                if let Ok(target) = parse_target(&url) {
                    self.switch_to(target).await;
                }
            }
            BootState::Failed(_) => self.show_page("pages/failed.html"),
            BootState::Resolve => {}
        }
    }

    fn emit(&self, event: InstallEvent) {
        let failure = {
            let mut state = self.state.lock().unwrap();
            let progress = &mut state.progress;
            match &event {
                InstallEvent::Stages { stages, .. } => progress.stages = stages.clone(),
                InstallEvent::StageStarted { stage } => progress.current = Some(stage.clone()),
                InstallEvent::StageFinished {
                    stage,
                    skipped,
                    elapsed_ms,
                } => {
                    progress.finished.push(FinishedStage {
                        stage: stage.clone(),
                        skipped: *skipped,
                        elapsed_ms: *elapsed_ms,
                    });
                    progress.current = None;
                }
                InstallEvent::Log { line } => {
                    progress.log.push(line.clone());
                    let excess = progress.log.len().saturating_sub(LOG_LIMIT);
                    progress.log.drain(..excess);
                }
                _ => {}
            }
            match &event {
                InstallEvent::Failed {
                    stage,
                    title,
                    reason,
                    remedy,
                } => Some(BootFailure {
                    from: FailureSource::Installing,
                    title: title.clone(),
                    reason: reason.clone(),
                    remedy: remedy.clone(),
                    stage: Some(stage.clone()),
                    log: progress.log.clone(),
                }),
                _ => None,
            }
        };
        if let Some(failure) = failure {
            self.go(BootEvent::Failed(failure));
        }
        if let View::Setup { label } = self.view() {
            self.dispatch(&label, &event);
        }
    }

    /// Shows the desktop update status in the host page, when one is open.
    pub fn show_update_status(&self, status: &crate::updater::Status) {
        if let View::Host { label, .. } = self.view() {
            self.dispatch(&label, &serde_json::json!({ "update": status }));
        }
    }

    /// Delivers a JSON event to the bridge in one view's main frame.
    fn dispatch(&self, label: &str, payload: &impl serde::Serialize) {
        if let (Some(window), Ok(json)) = (
            self.app.get_webview_window(label),
            serde_json::to_string(payload),
        ) {
            let _ = window.eval(format!(
                "window.__suplexBridgeEvent && window.__suplexBridgeEvent({json});"
            ));
        }
    }

    pub(crate) async fn run_install(&self, from: Option<String>) {
        self.state.lock().unwrap().progress = Progress::default();
        let record = read_install_record(&self.paths.install_record());
        let port = record
            .as_ref()
            .map_or(self.default_port, |record| record.port);
        let cancel = InstallCancel::default();
        *self.install_cancel.lock().unwrap() = Some(cancel.clone());
        let installer = Installer {
            runtime: self.runtime.clone(),
            user_data: self.paths.user_data.clone(),
            base: self.environment.clone(),
            port,
            cancel,
        };
        let outcome = installer
            .run(from.as_deref(), |event| self.emit(event))
            .await;
        *self.install_cancel.lock().unwrap() = None;
        match outcome {
            InstallOutcome::Cancelled => {
                self.state.lock().unwrap().boot = BootState::Choosing;
                self.spawn(|shell| shell.enter());
            }
            InstallOutcome::Failed => {}
            InstallOutcome::Complete => {
                let completed_at = time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default();
                let stamp = runtime_stamp(&self.runtime.directory).unwrap_or_default();
                // Without the record the next launch sends the user through setup again, so a failed write fails the install.
                if let Err(error) = write_install_record(
                    &self.paths.install_record(),
                    &InstallRecord {
                        completed_at,
                        runtime_stamp: stamp,
                        port,
                    },
                ) {
                    self.emit(InstallEvent::Failed {
                        stage: "record".into(),
                        title: "Save the install record".into(),
                        reason: format!("{}: {error}", self.paths.install_record().display()),
                        remedy: Some(
                            "Make sure Suplex can write to this folder, then retry.".into(),
                        ),
                    });
                    return;
                }
                self.state.lock().unwrap().local_installed = true;
                self.go(BootEvent::Installed {
                    upgrade: record.is_some(),
                });
            }
        }
    }

    pub fn cancel_install(&self) {
        if let Some(cancel) = self.install_cancel.lock().unwrap().as_ref() {
            cancel.cancel();
        }
    }

    pub async fn start_local(&self) {
        if self.network.state().busy || self.local_origin().is_some() {
            return;
        }
        match self.network.start_preferred().await {
            Ok(active) => {
                let port = match active {
                    ActiveNetworkAccess::Owned { port, .. }
                    | ActiveNetworkAccess::Adopted { port } => port,
                };
                if let (BootState::Starting, View::Setup { label }) =
                    (self.boot_state(), self.view())
                {
                    self.dispatch(&label, &serde_json::json!({ "started": true }));
                    tokio::time::sleep(LAUNCH_OUTRO).await;
                }
                self.go(BootEvent::Connected {
                    url: format!("http://127.0.0.1:{port}/"),
                });
            }
            Err(reason) => self.go(BootEvent::Failed(BootFailure {
                from: FailureSource::Starting,
                title: format!("Start Suplex on this {MACHINE}"),
                reason,
                remedy: Some("Open the logs for the server's own words, then retry.".into()),
                stage: None,
                log: tail(&self.paths.server_log(), 200),
            })),
        }
        self.rebuild_menu();
    }

    /// Tray Stop: only a host this shell started. An adopted host is not desktop-managed.
    pub async fn stop_local(&self) {
        let state = self.network.state();
        if state.busy || !matches!(state.active, Some(ActiveNetworkAccess::Owned { .. })) {
            return;
        }
        let stopped = self.local_origin();
        match self.network.shutdown().await {
            Ok(()) if stopped.is_some() && self.view().origin() == stopped.as_deref() => {
                self.open_manager().await
            }
            Ok(()) => {}
            Err(error) => self.warn("Suplex could not stop network access", &error),
        }
        self.rebuild_menu();
    }

    pub async fn connect_remote(&self, value: &str, report: bool) {
        match parse_target(value) {
            Ok(target) => self.switch_to(target).await,
            Err(reason) if report => self.warn(INVALID_TITLE, &reason),
            Err(_) => self.show_page("connect.html"),
        }
    }

    pub fn submitted_url(&self, label: &str, value: String) {
        if self.view().label() != Some(label) {
            return;
        }
        self.spawn(move |shell| Box::pin(async move { shell.connect_remote(&value, true).await }));
    }

    pub async fn open_manager(&self) {
        self.state.lock().unwrap().boot = BootState::Choosing;
        self.show_page("pages/choice.html?manage=1");
        self.focus();
        self.rebuild_menu();
    }

    pub async fn select_local(&self) {
        if self.network.state().busy {
            return;
        }
        if let Some(origin) = self.local_origin() {
            if let Ok(target) = parse_target(&format!("{origin}/")) {
                self.switch_to(target).await;
            }
            return;
        }
        if !self.local_installed() {
            self.open_manager().await;
            return;
        }
        self.state.lock().unwrap().boot = BootState::Starting;
        self.show_page("pages/connecting.html");
        self.start_local().await;
    }

    pub async fn select_host(&self, origin: &str) {
        let registry = targets::read_registry(&self.paths.targets());
        self.state.lock().unwrap().registry = registry.clone();
        if let Some(target) = registry
            .targets
            .into_iter()
            .find(|target| target.origin == origin)
        {
            self.switch_to(target).await;
        }
    }

    pub fn forget_host(&self, origin: &str) {
        if let Ok(registry) = targets::forget(&self.paths.targets(), origin) {
            self.state.lock().unwrap().registry = registry;
        }
        self.rebuild_menu();
    }

    /// Focuses the window, or creates one: at launch for the resolved target, later for the current setup step
    /// or the current host selection.
    pub async fn open(&self) {
        if let Some(window) = self.window() {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
        let registry = targets::read_registry(&self.paths.targets());
        let record = read_install_record(&self.paths.install_record());
        {
            let mut state = self.state.lock().unwrap();
            state.registry = registry.clone();
            state.local_installed = record.is_some();
        }
        let first = !self.launched.swap(true, Ordering::SeqCst);
        if let (false, Some(page)) = (first, setup_page(&self.boot_state())) {
            // Setup work such as a running install continues; only its page is shown again.
            self.show_page(page);
            self.rebuild_menu();
            return;
        }
        let resolved = match first.then(|| targets::resolve_target(&self.argv, &self.environment)) {
            None => None,
            Some(Ok(resolved)) => resolved,
            Some(Err(message)) => {
                self.fail_launch(&message);
                return;
            }
        };
        let local_origin = self.local_origin();
        if let Some((_, target)) = resolved {
            self.switch_to(target).await;
        } else if let (false, Some(current)) = (first, &registry.current) {
            self.switch_to(current.clone()).await;
        } else if let Some(local) = local_origin {
            let target = registry
                .current
                .clone()
                .or_else(|| parse_target(&format!("{local}/")).ok());
            if let Some(target) = target {
                self.switch_to(target).await;
            }
        } else if let (Some(record), Some(current)) = (&record, &registry.current) {
            if current.origin != format!("http://127.0.0.1:{}", record.port) {
                self.switch_to(current.clone()).await;
            } else {
                self.boot_from(Some(record), Some(current.url.as_str()))
                    .await;
            }
        } else {
            let remote = registry
                .current
                .as_ref()
                .map(|target| target.url.to_string());
            self.boot_from(record.as_ref(), remote.as_deref()).await;
        }
        self.rebuild_menu();
    }

    async fn boot_from(&self, record: Option<&InstallRecord>, remote: Option<&str>) {
        let stamp = runtime_stamp(&self.runtime.directory);
        self.state.lock().unwrap().boot = resolve_boot(record, stamp.as_deref(), remote);
        self.enter().await;
    }

    /// A second launch carries its own arguments; an invitation link or a `--url` switches the window, otherwise it only focuses.
    pub async fn open_with(&self, argv: Vec<String>) {
        let invitation = argv
            .iter()
            .find_map(|value| targets::invitation_target(value));
        let requested = match targets::resolve_target(&argv, &HashMap::new()) {
            Ok(requested) => invitation.or(requested.map(|(_, target)| target)),
            Err(message) => {
                eprintln!("{INVALID_TITLE}: {message}");
                self.warn(INVALID_TITLE, &message);
                return;
            }
        };
        self.open().await;
        if let Some(target) = requested {
            self.switch_to(target).await;
        }
    }

    /// An invalid explicit target at launch fails visibly and exits; it never falls through to another host.
    fn fail_launch(&self, message: &str) {
        eprintln!("{INVALID_TITLE}: {message}");
        let app = self.app.clone();
        self.effects.dialog(
            None,
            crate::updater::Kind::Error,
            INVALID_TITLE,
            Some(message),
            &["Quit"],
            move |_| app.exit(1),
        );
    }

    pub fn warn(&self, title: &str, message: &str) {
        let window = self.window();
        self.effects.dialog(
            window.as_ref(),
            crate::updater::Kind::Error,
            title,
            Some(message),
            &["Continue"],
            |_| {},
        );
    }

    pub fn focus(&self) {
        if let Some(window) = self.window() {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    // ----- webview events -----

    pub fn page_loaded(&self, label: &str, url: &Url, started: bool) {
        if started {
            let mut state = self.state.lock().unwrap();
            if let View::Host {
                label: current,
                generation,
                ..
            } = &mut state.view
            {
                if current == label {
                    *generation += 1;
                }
            }
        }
        if !started {
            self.mark_fullscreen(true);
        }
        #[cfg(feature = "native-test")]
        crate::native_test::page_loaded(self, label, url, started);
        #[cfg(not(feature = "native-test"))]
        let _ = url;
    }

    /// `window.open` never creates a webview: same-origin opens in place, http(s) elsewhere in the browser.
    pub fn popup(&self, kind: ViewKind, label: &str, origin: &str, url: Url) {
        match classify_navigation(url.as_str(), (kind == ViewKind::Host).then_some(origin)) {
            NavigationDecision::Internal(url) => {
                if let Some(window) = self.app.get_webview_window(label) {
                    let _ = window.navigate(url);
                }
            }
            NavigationDecision::External(url) => self.open_external(&url),
            NavigationDecision::Blocked(_) => {}
        }
    }

    pub fn open_external(&self, url: &Url) {
        self.effects.open_external(url);
    }

    pub fn reveal(&self, path: &Path) {
        self.effects.reveal(path);
    }

    pub fn download_directory(&self) -> PathBuf {
        self.effects.download_directory()
    }

    /// Full screen hides the traffic lights, so the host page drops its titlebar inset.
    fn mark_fullscreen(&self, loaded: bool) {
        if let (View::Host { .. }, Some(window)) = (self.view(), self.window()) {
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            // A resize only matters when it enters or leaves full screen; a new page always needs its class.
            if self.fullscreen.swap(fullscreen, Ordering::SeqCst) == fullscreen && !loaded {
                return;
            }
            let _ = window.eval(format!(
                "document.documentElement.classList.toggle('suplex-fullscreen', {fullscreen});"
            ));
        }
    }

    pub fn window_event(&self, event: &WindowEvent) {
        if matches!(event, WindowEvent::Resized(_)) {
            self.mark_fullscreen(false);
        }
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if let Some(bounds) = self.window().as_ref().and_then(current_bounds) {
                    self.state.lock().unwrap().bounds = Some(bounds);
                    let generation = self.bounds_generation.fetch_add(1, Ordering::SeqCst) + 1;
                    self.spawn(move |shell| {
                        Box::pin(async move {
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            if shell.bounds_generation.load(Ordering::SeqCst) == generation {
                                shell.save_window_state(bounds);
                            }
                        })
                    });
                }
            }
            WindowEvent::CloseRequested { .. } => {
                if let Some(bounds) = self.window().as_ref().and_then(current_bounds) {
                    self.save_window_state(bounds);
                }
            }
            WindowEvent::Destroyed => {
                let mut state = self.state.lock().unwrap();
                let open = state
                    .view
                    .label()
                    .is_some_and(|label| self.app.get_webview_window(label).is_some());
                if !open {
                    state.view = View::None;
                    state.admin_page = None;
                }
            }
            _ => {}
        }
    }

    // ----- bridge authority -----

    /// The calling webview is the current view of `kind`, and its live top-level URL is that view's origin.
    pub fn caller_is(
        &self,
        webview_label: &str,
        current_url: Option<&Url>,
        kind: ViewKind,
    ) -> bool {
        let view = self.view();
        let label_matches = view.label() == Some(webview_label);
        let origin_matches = match (&view, current_url) {
            (View::Host { origin, .. }, Some(url)) => url.origin().ascii_serialization() == *origin,
            (View::Setup { .. } | View::Unavailable { .. }, Some(url)) => window::is_app_page(url),
            _ => false,
        };
        let kind_matches = matches!(
            (&view, kind),
            (View::Host { .. }, ViewKind::Host)
                | (View::Setup { .. }, ViewKind::Setup)
                | (View::Unavailable { .. }, ViewKind::Unavailable)
        );
        label_matches && origin_matches && kind_matches
    }

    fn host_capture(&self, label: &str) -> Option<(String, u64)> {
        match self.view() {
            View::Host {
                label: current,
                origin,
                generation,
            } if current == label => Some((origin, generation)),
            _ => None,
        }
    }

    /// Port of `localAdminFrame`: the current local host page, with an admin session in its own cookie store,
    /// still current after the check. Renderer-supplied claims are never consulted.
    pub async fn local_admin(&self, webview: &tauri::Webview<R>) -> bool {
        let label = webview.label().to_owned();
        let Some(local) = self.local_origin() else {
            return false;
        };
        let Some((origin, generation)) = self.host_capture(&label) else {
            return false;
        };
        let current = webview.url().ok();
        if origin != local
            || current
                .as_ref()
                .map(|url| url.origin().ascii_serialization())
                != Some(local.clone())
        {
            return false;
        }
        let Ok(me) = Url::parse(&format!("{local}/api/auth/me")) else {
            return false;
        };
        let reader = webview.clone();
        let cookies = match tauri::async_runtime::spawn_blocking(move || reader.cookies()).await {
            Ok(Ok(cookies)) => cookies,
            _ => return false,
        };
        // Only cookies valid for this URL, in memory for this request. A request without cookies still lets the host apply its own local session rules.
        let Ok(client) = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .no_proxy()
            .build()
        else {
            return false;
        };
        let mut request = client.get(me.clone());
        if let Some(cookie) = cookie_header(&cookies, &me) {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let admin = match request.send().await {
            Ok(response) if response.status().is_success() => response
                .json::<serde_json::Value>()
                .await
                .is_ok_and(|body| is_admin(&body)),
            _ => false,
        };
        // Navigation or a host switch during the request invalidates this request only.
        let still = self.host_capture(&label) == Some((origin.clone(), generation))
            && self.local_origin().as_deref() == Some(origin.as_str())
            && webview
                .url()
                .ok()
                .map(|url| url.origin().ascii_serialization())
                .as_deref()
                == Some(origin.as_str());
        let verified = admin && still;
        if verified {
            self.state.lock().unwrap().admin_page = Some((label, generation));
        }
        verified
    }

    // ----- network access -----

    fn network_changed(&self) {
        if self.shut_down.load(Ordering::SeqCst) {
            return;
        }
        self.rebuild_menu();
        let admin_page = self.state.lock().unwrap().admin_page.clone();
        if let Some((label, generation)) = admin_page {
            if self.host_capture(&label).is_some_and(|(origin, current)| {
                current == generation && Some(origin) == self.local_origin()
            }) {
                self.dispatch(&label, &self.access_snapshot());
            }
        }
    }

    pub async fn save_network_preference(&self, mode: NetworkMode) {
        if self.network.state().busy {
            return;
        }
        if let Err(error) = self.network.save_preference(mode).await {
            self.warn("Suplex could not save network access", &error);
        }
        self.rebuild_menu();
    }

    fn capture_local_page(&self) -> Option<LocalPage> {
        let local = self.local_origin()?;
        let View::Host {
            label,
            origin,
            generation,
        } = self.view()
        else {
            return None;
        };
        if origin != local {
            return None;
        }
        let url = self.app.get_webview_window(&label)?.url().ok()?;
        (url.origin().ascii_serialization() == local).then_some(LocalPage {
            label,
            generation,
            url,
        })
    }

    fn same_page(&self, page: &LocalPage) -> bool {
        self.host_capture(&page.label)
            .is_some_and(|(_, generation)| generation == page.generation)
            && self
                .app
                .get_webview_window(&page.label)
                .and_then(|window| window.url().ok())
                .as_ref()
                == Some(&page.url)
    }

    pub async fn restart_network(&self) -> Result<Option<LocalPage>, String> {
        if self.network.state().busy {
            return Ok(None);
        }
        let page = self.capture_local_page();
        match self.network.apply_preference().await {
            Ok(_) => Ok(page),
            Err(error) => {
                if let Some(page) = page.as_ref().filter(|page| self.same_page(page)) {
                    self.dispatch(&page.label, &self.access_snapshot());
                }
                Err(error)
            }
        }
    }

    /// Returns to the captured local page only if the user has not navigated or switched hosts meanwhile.
    pub async fn return_to(&self, page: Option<LocalPage>) {
        let (Some(page), Some(local)) = (page, self.local_origin()) else {
            return;
        };
        if !self.same_page(&page) {
            return;
        }
        let path = match page.url.query() {
            Some(query) => format!("{}?{query}", page.url.path()),
            None => page.url.path().to_owned(),
        };
        if let Ok(target) = parse_target(&format!("{local}{path}")) {
            self.state.lock().unwrap().boot = BootState::Connected {
                url: target.url.to_string(),
            };
            self.rebuild_menu();
            self.load(&target).await;
        }
    }

    pub async fn restart_from_menu(&self) {
        match self.restart_network().await {
            Ok(page) => self.return_to(page).await,
            Err(error) => self.warn("Suplex could not restart network access", &error),
        }
    }

    // ----- account and lifecycle -----

    /// This computer's host was cleared, so the next launch starts at the choice screen. A remote clear leaves the local install alone.
    pub async fn account_cleared(&self, label: &str) {
        if self.forget_local_install(label) {
            self.quit().await;
        }
    }

    /// Removes the install record when `label` shows this computer's host. False when `label` is not the shown host.
    pub(crate) fn forget_local_install(&self, label: &str) -> bool {
        let Some((origin, _)) = self.host_capture(label) else {
            return false;
        };
        if self.local_origin().as_deref() == Some(origin.as_str()) {
            let _ = std::fs::remove_file(self.paths.install_record());
        }
        true
    }

    /// Orderly quit: owned-host shutdown and route cleanup, then exit.
    pub async fn quit(&self) {
        self.exit(0).await;
    }

    /// The orderly quit with an exit status, so a failed launch still exits 1 after cleanup.
    pub async fn exit(&self, code: i32) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shutdown().await;
        self.app.exit(code);
    }

    pub async fn shutdown(&self) {
        if self.shut_down.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(error) = self.network.shutdown().await {
            eprintln!("Suplex could not finish network cleanup: {error}");
        }
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn show_host_for_test(&self, target: &SuplexTarget) -> Option<String> {
        self.replace_view(
            ViewKind::Host,
            target.url.clone(),
            target.origin.clone(),
            None,
        )
    }

    #[cfg(test)]
    pub fn show_page_for_test(
        &self,
        kind: ViewKind,
        page: &str,
        target: Option<SuplexTarget>,
    ) -> Option<String> {
        self.replace_view(kind, app_page(page), APP_ORIGIN.into(), target)
    }

    pub fn rebuild_menu(&self) {
        menu::rebuild(self);
    }

    pub fn copy(&self, text: String) {
        self.effects.copy(text);
    }

    pub fn copy_output(&self) {
        let state = self.state.lock().unwrap();
        let text = match &state.boot {
            BootState::Failed(failure) => [
                vec![
                    failure.title.clone(),
                    failure.reason.clone(),
                    failure.remedy.clone().unwrap_or_default(),
                ],
                failure.log.clone(),
            ]
            .concat()
            .join("\n"),
            _ => state.progress.log.join("\n"),
        };
        drop(state);
        self.copy(text);
    }

    pub fn open_logs(&self) {
        let _ = std::fs::create_dir_all(self.paths.logs());
        self.effects.open_path(&self.paths.logs());
    }

    pub fn choose(&self, mode: Mode) {
        // Windows has no bundled host; a raw `desktop_choose("local")` changes nothing.
        if mode == Mode::Local && !LOCAL_SUPPORTED {
            return;
        }
        if mode == Mode::Local && self.local_installed() {
            self.spawn(|shell| Box::pin(async move { shell.select_local().await }));
        } else {
            self.go(BootEvent::Choose(mode));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::webview::Cookie;

    fn cookie(text: &str) -> Cookie<'static> {
        Cookie::parse(text.to_owned()).unwrap()
    }

    #[test]
    fn zoom_moves_through_chrome_levels_and_clamps_at_both_ends() {
        let mut zoom = 1.0;
        let mut levels = Vec::new();
        for _ in 0..7 {
            zoom = next_zoom(zoom, ZoomStep::In);
            levels.push(zoom);
        }
        assert_eq!(levels, [1.1, 1.25, 1.5, 1.75, 2.0, 2.0, 2.0]);
        let mut levels = Vec::new();
        for _ in 0..12 {
            zoom = next_zoom(zoom, ZoomStep::Out);
            levels.push(zoom);
        }
        assert_eq!(
            levels,
            [
                1.75,
                1.5,
                1.25,
                1.1,
                1.0,
                0.9,
                0.8,
                0.75,
                2.0 / 3.0,
                0.5,
                0.5,
                0.5
            ]
        );
        assert_eq!(next_zoom(1.75, ZoomStep::Reset), 1.0);
        assert_eq!(next_zoom(0.5, ZoomStep::Reset), 1.0);
    }

    #[test]
    fn a_saved_zoom_off_the_levels_snaps_to_the_nearest_level() {
        assert_eq!(snap_zoom(1.3), 1.25);
        assert_eq!(snap_zoom(0.67), 2.0 / 3.0);
        assert_eq!(snap_zoom(1.7), 1.75);
        assert_eq!(snap_zoom(9.0), 2.0);
        assert_eq!(snap_zoom(0.1), 0.5);
        assert_eq!(snap_zoom(f64::NAN), 1.0);
        assert_eq!(snap_zoom(-1.0), 1.0);
        assert_eq!(next_zoom(1.3, ZoomStep::In), 1.5);
        assert_eq!(next_zoom(1.3, ZoomStep::Out), 1.1);
    }

    #[test]
    fn the_session_cookie_is_selected_for_the_exact_local_url() {
        let me = Url::parse("http://127.0.0.1:4111/api/auth/me").unwrap();
        let cookies = [
            cookie("sid_v1=admin; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax"),
            cookie("csrf=token; Domain=127.0.0.1; Path=/"),
            cookie("scoped=1; Domain=127.0.0.1; Path=/admin"),
            cookie("elsewhere=1; Domain=suplex.example; Path=/"),
            cookie("expired=1; Domain=127.0.0.1; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT"),
        ];
        assert_eq!(
            cookie_header(&cookies, &me).as_deref(),
            Some("sid_v1=admin; csrf=token")
        );
        assert_eq!(
            cookie_header(&[cookie("a=1; Domain=suplex.example; Path=/")], &me),
            None
        );
    }

    #[test]
    fn domain_and_secure_cookies_follow_browser_rules() {
        let remote = Url::parse("https://box.suplex.example/api/auth/me").unwrap();
        let cookies = [
            cookie("parent=1; Domain=.suplex.example; Path=/; Secure"),
            cookie("api=1; Domain=box.suplex.example; Path=/api"),
        ];
        assert_eq!(
            cookie_header(&cookies, &remote).as_deref(),
            Some("parent=1; api=1")
        );
        let plain = Url::parse("http://localhost:4111/api/auth/me").unwrap();
        assert_eq!(
            cookie_header(&[cookie("s=1; Domain=localhost; Path=/; Secure")], &plain).as_deref(),
            Some("s=1"),
            "loopback is a secure context"
        );
        assert_eq!(
            cookie_header(&[cookie("ap=1; Domain=localhost; Path=/api2")], &plain),
            None,
            "path prefixes match on segment boundaries"
        );
    }

    #[test]
    fn only_an_admin_answer_from_the_host_grants_network_control() {
        assert!(is_admin(
            &serde_json::json!({ "user": { "id": "u1", "role": "admin" } })
        ));
        for body in [
            serde_json::json!({ "user": { "role": "member" } }),
            serde_json::json!({ "user": null }),
            serde_json::json!({ "role": "admin" }),
            serde_json::json!([]),
        ] {
            assert!(!is_admin(&body), "{body}");
        }
    }

    #[test]
    fn the_bridge_is_injected_as_data_not_concatenated_code() {
        let script = Shell::<tauri::test::MockRuntime>::bridge(
            ViewKind::Unavailable,
            APP_ORIGIN,
            Some("https://x.example/\"</script><img onerror=alert(1)>"),
            "1.0.0",
        );
        assert!(script.contains("(config) => {"));
        assert!(script.ends_with(&format!(
            r#"({{"kind":"unavailable","origin":"{APP_ORIGIN}","platform":"{}","target":"https://x.example/\"</script><img onerror=alert(1)>","version":"1.0.0"}});"#,
            crate::platform::NAME
        )));
    }

    #[test]
    fn reopening_during_setup_shows_the_current_step_without_restarting_it() {
        assert_eq!(
            setup_page(&BootState::Installing {
                from: Some("herdr".into())
            }),
            Some("pages/install.html")
        );
        assert_eq!(
            setup_page(&BootState::Starting),
            Some("pages/connecting.html")
        );
        assert_eq!(
            setup_page(&BootState::ConnectingRemote { url: None }),
            Some("connect.html")
        );
        assert_eq!(
            setup_page(&BootState::Connected {
                url: "https://suplex.example/".into()
            }),
            None,
            "a selected host is opened again instead"
        );
        assert_eq!(setup_page(&BootState::Resolve), None);
    }

    #[test]
    fn the_server_log_tail_keeps_the_last_nonblank_lines() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("server.log");
        std::fs::write(
            &file,
            (0..300)
                .map(|line| format!("line {line}\n\n"))
                .collect::<String>(),
        )
        .unwrap();
        let lines = tail(&file, 200);
        assert_eq!(lines.len(), 200);
        assert_eq!(lines[0], "line 100");
        assert!(tail(&directory.path().join("missing"), 200).is_empty());
    }
}
