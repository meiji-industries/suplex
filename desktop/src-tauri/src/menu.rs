//! The application menu, the menu-bar tray, and the host picker. Menu and tray actions are chosen by
//! the local OS user, so they reach native behavior directly rather than through page authority.

use std::sync::Arc;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime,
};

use crate::{
    contracts::NetworkMode,
    network_access::ActiveNetworkAccess,
    platform::{LOCAL_SUPPORTED, MACHINE},
    shell::{Shell, View},
};

const TRAY: &str = "suplex";

fn host_label(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|url| {
            url.host_str().map(|host| match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_owned(),
            })
        })
        .unwrap_or_else(|| origin.to_owned())
}

type Items<R> = Vec<Box<dyn IsMenuItem<R>>>;

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    enabled: bool,
) -> Box<dyn IsMenuItem<R>> {
    Box::new(MenuItem::with_id(app, id, label, enabled, None::<&str>).expect("menu item"))
}

fn check<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    enabled: bool,
    checked: bool,
) -> Box<dyn IsMenuItem<R>> {
    Box::new(
        CheckMenuItem::with_id(app, id, label, enabled, checked, None::<&str>).expect("check item"),
    )
}

fn separator<R: Runtime>(app: &AppHandle<R>) -> Box<dyn IsMenuItem<R>> {
    Box::new(PredefinedMenuItem::separator(app).expect("separator"))
}

fn refs<R: Runtime>(items: &Items<R>) -> Vec<&dyn IsMenuItem<R>> {
    items.iter().map(|item| item.as_ref()).collect()
}

fn network_items<R: Runtime>(shell: &Shell<R>) -> Items<R> {
    let app = &shell.app;
    let state = shell.network.state();
    let installed = shell.local_installed();
    let enabled = installed && !state.busy;
    let mut items: Items<R> = vec![
        check(
            app,
            "network:local",
            &format!("This {MACHINE} only"),
            enabled,
            state.preference == NetworkMode::Local,
        ),
        check(
            app,
            "network:tailscale",
            "Tailscale",
            enabled,
            state.preference == NetworkMode::Tailscale,
        ),
        check(
            app,
            "network:all",
            "All networks",
            enabled,
            state.preference == NetworkMode::All,
        ),
    ];
    if matches!(&state.active, Some(ActiveNetworkAccess::Owned { access, .. }) if access.mode() != state.preference)
    {
        items.push(separator(app));
        items.push(item(app, "network:pending", "Restart required", false));
        items.push(item(app, "network:restart", "Restart", !state.busy));
    }
    if shell.tailscale_url().is_some() {
        items.push(separator(app));
        items.push(item(
            app,
            "network:copy-url",
            "Copy Tailscale URL",
            !state.busy,
        ));
    }
    items
}

/// "This Mac" (or "This computer") first where a local host runs, then each remembered host, with the shown one checked.
fn host_items<R: Runtime>(shell: &Shell<R>, include_local: bool) -> Items<R> {
    let app = &shell.app;
    let local = shell.local_origin();
    let shown = shell.view().origin().map(str::to_owned);
    let mut items: Items<R> = Vec::new();
    let include_local = include_local && LOCAL_SUPPORTED;
    if include_local {
        items.push(check(
            app,
            "host-local",
            &format!("This {MACHINE}"),
            true,
            local.is_some() && shown == local,
        ));
    }
    for origin in shell
        .registry()
        .origins()
        .into_iter()
        .filter(|origin| !include_local || Some(origin) != local.as_ref())
    {
        items.push(check(
            app,
            &format!("host:{origin}"),
            &host_label(&origin),
            true,
            shown.as_deref() == Some(origin.as_str()),
        ));
    }
    items
}

fn status<R: Runtime>(shell: &Shell<R>) -> &'static str {
    let state = shell.network.state();
    if !shell.local_installed() {
        "Not installed"
    } else if state.busy {
        "Suplex is busy"
    } else if state.active.is_none() {
        "Stopped"
    } else if matches!(state.active, Some(ActiveNetworkAccess::Adopted { .. })) {
        "Managed by another Suplex"
    } else {
        "Running"
    }
}

/// The macOS application menu.
fn set_app_menu<R: Runtime>(shell: &Shell<R>) {
    let app = &shell.app;
    let network = network_items(shell);
    let network_menu =
        Submenu::with_items(app, "Network access", true, &refs(&network)).expect("network menu");
    let hosts = host_items(shell, false);
    let mut settings: Items<R> = vec![
        item(app, "access", "Access…", shell.view().origin().is_some()),
        Box::new(network_menu),
        separator(app),
    ];
    if !hosts.is_empty() {
        settings.extend(hosts);
        settings.push(separator(app));
    }
    settings.push(item(app, "manage-hosts", "Manage Suplex hosts…", true));
    let settings_menu =
        Submenu::with_items(app, "Settings", true, &refs(&settings)).expect("settings menu");
    let about = PredefinedMenuItem::about(
        app,
        Some("About Suplex"),
        Some(tauri::menu::AboutMetadata {
            name: Some("Suplex".into()),
            version: Some(app.package_info().version.to_string()),
            ..Default::default()
        }),
    )
    .expect("about");
    let suplex: Items<R> = vec![
        Box::new(about),
        separator(app),
        Box::new(settings_menu),
        separator(app),
        Box::new(PredefinedMenuItem::services(app, None).expect("services")),
        separator(app),
        Box::new(PredefinedMenuItem::hide(app, None).expect("hide")),
        Box::new(PredefinedMenuItem::hide_others(app, None).expect("hide others")),
        Box::new(PredefinedMenuItem::show_all(app, None).expect("show all")),
        separator(app),
        item(app, "check-updates", "Check for updates", true),
        separator(app),
        Box::new(
            MenuItem::with_id(app, "quit", "Quit Suplex", true, Some("CmdOrCtrl+Q")).expect("quit"),
        ),
    ];
    let edit: Items<R> = vec![
        Box::new(PredefinedMenuItem::undo(app, None).expect("undo")),
        Box::new(PredefinedMenuItem::redo(app, None).expect("redo")),
        separator(app),
        Box::new(PredefinedMenuItem::cut(app, None).expect("cut")),
        Box::new(PredefinedMenuItem::copy(app, None).expect("copy")),
        Box::new(PredefinedMenuItem::paste(app, None).expect("paste")),
        Box::new(PredefinedMenuItem::select_all(app, None).expect("select all")),
    ];
    let shortcut = |id: &str, label: &str, keys: &str| -> Box<dyn IsMenuItem<R>> {
        Box::new(MenuItem::with_id(app, id, label, true, Some(keys)).expect("menu item"))
    };
    let view: Items<R> = vec![
        shortcut("reload", "Reload", "CmdOrCtrl+R"),
        separator(app),
        shortcut("zoom-reset", "Actual Size", "CmdOrCtrl+0"),
        shortcut("zoom-in", "Zoom In", "CmdOrCtrl+="),
        shortcut("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
        separator(app),
        Box::new(PredefinedMenuItem::fullscreen(app, None).expect("fullscreen")),
    ];
    let window: Items<R> = vec![
        Box::new(PredefinedMenuItem::minimize(app, None).expect("minimize")),
        Box::new(PredefinedMenuItem::maximize(app, None).expect("zoom")),
        separator(app),
        Box::new(PredefinedMenuItem::close_window(app, None).expect("close")),
    ];
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(app, "Suplex", true, &refs(&suplex)).expect("app menu"),
            &Submenu::with_items(app, "Edit", true, &refs(&edit)).expect("edit menu"),
            &Submenu::with_items(app, "View", true, &refs(&view)).expect("view menu"),
            &Submenu::with_items(app, "Window", true, &refs(&window)).expect("window menu"),
        ],
    )
    .expect("menu");
    let _ = app.set_menu(menu);
}

pub fn rebuild<R: Runtime>(shell: &Shell<R>) {
    if cfg!(test) {
        // Native menus need the macOS main thread, which Tauri's mock runtime does not provide.
        return;
    }
    // Windows and Linux would show this as a menu bar in every window; there the tray is the only native menu.
    if cfg!(target_os = "macos") {
        set_app_menu(shell);
    }
    let app = &shell.app;

    let Some(tray) = app.tray_by_id(TRAY) else {
        return;
    };
    let state = shell.network.state();
    let local = shell.local_origin();
    let owned = matches!(state.active, Some(ActiveNetworkAccess::Owned { .. }));
    let tray_network =
        Submenu::with_items(app, "Network access", true, &refs(&network_items(shell)))
            .expect("tray network menu");
    let packaged = login::available();
    let mut items: Items<R> = vec![item(app, "open", "Open Suplex", true), separator(app)];
    items.extend(host_items(shell, true));
    items.extend([
        separator(app),
        item(app, "manage-hosts", "Manage Suplex hosts…", true),
        separator(app),
    ]);
    // Windows has no local host to start, stop, or expose.
    if LOCAL_SUPPORTED {
        items.extend([
            Box::new(tray_network) as Box<dyn IsMenuItem<R>>,
            separator(app),
            item(app, "status", status(shell), false),
            separator(app),
            item(
                app,
                "start",
                "Start Suplex",
                shell.local_installed() && local.is_none() && !state.busy,
            ),
            item(
                app,
                "stop",
                "Stop Suplex",
                local.is_some() && owned && !state.busy,
            ),
            separator(app),
        ]);
    }
    // Login items use the macOS service for this app bundle; Windows and Linux have none yet.
    if cfg!(target_os = "macos") {
        items.extend([
            check(
                app,
                "login",
                if packaged {
                    "Start Suplex on Login"
                } else {
                    "Start Suplex on Login (installed app only)"
                },
                packaged,
                packaged && login::enabled(),
            ),
            separator(app),
        ]);
    }
    items.extend([
        item(app, "logs", "Open Logs", true),
        item(app, "check-updates", "Check for updates", true),
        separator(app),
        item(app, "quit", "Quit Suplex", true),
    ]);
    if let Ok(menu) = Menu::with_items(app, &refs(&items)) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // The template image is black and only macOS tints it; Windows and Linux panels need the colored app icon.
    let icon = if cfg!(target_os = "macos") {
        Image::from_bytes(include_bytes!("../../src/statusTemplate@2x.png"))?
    } else {
        Image::from_bytes(include_bytes!("../icons/32x32.png"))?
    };
    TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Suplex")
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

/// The host picker the page's host bar opens, at the pointer.
pub fn popup_host_picker<R: Runtime>(shell: &Arc<Shell<R>>) {
    let app = &shell.app;
    let mut items = host_items(shell, true);
    items.push(separator(app));
    items.push(item(app, "manage-hosts", "Manage Suplex hosts…", true));
    let (Some(label), Ok(menu)) = (
        shell.view().label().map(str::to_owned),
        Menu::with_items(app, &refs(&items)),
    ) else {
        return;
    };
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.popup_menu(&menu);
    }
}

pub fn handle<R: Runtime>(shell: &Arc<Shell<R>>, event: &MenuEvent) {
    let id = event.id().as_ref().to_owned();
    let shell = shell.clone();
    tauri::async_runtime::spawn(async move {
        match id.as_str() {
            "open" => shell.open().await,
            "quit" => shell.quit().await,
            "reload" => shell.reload().await,
            "zoom-reset" => shell.zoom_by(None),
            "zoom-in" => shell.zoom_by(Some(0.1)),
            "zoom-out" => shell.zoom_by(Some(-0.1)),
            "manage-hosts" => shell.open_manager().await,
            "host-local" => shell.select_local().await,
            "start" => shell.select_local().await,
            "stop" => shell.stop_local().await,
            "logs" => shell.open_logs(),
            "check-updates" => crate::check_for_updates(&shell, true).await,
            "access" => {
                if let View::Host { origin, .. } = shell.view() {
                    if let Ok(target) =
                        crate::targets::parse_target(&format!("{origin}/admin/access"))
                    {
                        shell.load(&target).await;
                    }
                }
            }
            "network:local" => shell.save_network_preference(NetworkMode::Local).await,
            "network:tailscale" => shell.save_network_preference(NetworkMode::Tailscale).await,
            "network:all" => shell.save_network_preference(NetworkMode::All).await,
            "network:restart" => shell.restart_from_menu().await,
            "network:copy-url" => {
                if let Some(url) = shell.tailscale_url() {
                    shell.copy(url);
                }
            }
            "login" => {
                let requested = !login::enabled();
                if let Err(detail) = login::set(requested) {
                    shell.warn("Suplex could not change the login setting", &detail);
                }
                shell.rebuild_menu();
            }
            other => {
                if let Some(origin) = other.strip_prefix("host:") {
                    shell.select_host(origin).await;
                }
            }
        }
        shell.rebuild_menu();
    });
}

/// "Start Suplex on Login" through the macOS login item service for this app bundle.
mod login {
    /// Only an installed bundle can register a login item; a development binary cannot.
    pub fn available() -> bool {
        std::env::current_exe()
            .is_ok_and(|path| path.to_string_lossy().contains(".app/Contents/MacOS/"))
    }

    #[cfg(target_os = "macos")]
    pub fn enabled() -> bool {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // SAFETY: SMAppService is thread-safe for the main app service and status reads.
        available()
            && unsafe { SMAppService::mainAppService().status() } == SMAppServiceStatus::Enabled
    }

    #[cfg(target_os = "macos")]
    pub fn set(enabled: bool) -> Result<(), String> {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // SAFETY: registering or unregistering this app's own login item.
        let service = unsafe { SMAppService::mainAppService() };
        let result = unsafe {
            if enabled {
                service.registerAndReturnError()
            } else {
                service.unregisterAndReturnError()
            }
        };
        if enabled && unsafe { service.status() } == SMAppServiceStatus::RequiresApproval {
            return Err("Allow Suplex in System Settings > General > Login Items.".into());
        }
        result.map_err(|_| "Open the installed Suplex app, then retry.".into())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn enabled() -> bool {
        false
    }

    #[cfg(not(target_os = "macos"))]
    pub fn set(_enabled: bool) -> Result<(), String> {
        Err("Login items are available on macOS only.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::host_label;

    #[test]
    fn hosts_are_labelled_by_host_and_explicit_port() {
        assert_eq!(
            host_label("https://meiji.tail1234.ts.net:4111"),
            "meiji.tail1234.ts.net:4111"
        );
        assert_eq!(
            host_label("https://suplex.tail1234.ts.net"),
            "suplex.tail1234.ts.net"
        );
        assert_eq!(host_label("http://localhost:4211"), "localhost:4211");
    }
}
