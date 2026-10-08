//! Suplex.app: the Tauri shell around the bundled `suplex` host. Assembly and plugin registration only;
//! behavior lives in the modules below.

mod boot;
mod bridge;
mod contracts;
mod effects;
mod installer;
mod local_runtime;
mod menu;
#[cfg(feature = "native-test")]
mod native_test;
mod network_access;
#[cfg(all(not(feature = "native-test"), target_os = "macos"))]
mod notifications;
mod paths;
mod platform;
mod shell;
mod tailscale;
mod targets;
mod updater;
mod window;

use std::{collections::HashMap, sync::Arc, time::Duration};

use tauri::{Manager, RunEvent, Runtime};

use crate::{shell::Shell, updater::DesktopUpdater};

type Updater<R> = DesktopUpdater<updater::TauriPorts<R>>;

const UPDATE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Registers the bridge commands. Shared by the app and the IPC authorization tests.
pub fn configure<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    use bridge::*;
    builder.invoke_handler(tauri::generate_handler![
        desktop_snapshot,
        desktop_choose,
        desktop_cancel,
        desktop_retry,
        desktop_launch,
        desktop_back,
        desktop_open_logs,
        desktop_copy_output,
        desktop_test_connection,
        desktop_tailscale_status,
        desktop_turn_on_tailscale,
        desktop_open_tailscale,
        desktop_remove_host,
        desktop_select_host,
        unavailable_retry,
        unavailable_open_host_picker,
        app_account_cleared,
        app_open_host_picker,
        app_network_access,
        app_save_network_access_preference,
        app_restart_network_access,
        app_update_status,
        app_check_for_updates,
    ])
}

// Recompiles the shell when the configuration that `generate_context!` reads changes; see build.rs.
const _: &str = include_str!(concat!(env!("OUT_DIR"), "/compiled-configuration"));

pub fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub(crate) fn updater_of<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Arc<Updater<R>>> {
    app.try_state::<Arc<Updater<R>>>()
        .map(|updater| updater.inner().clone())
}

pub(crate) async fn check_for_updates<R: Runtime>(shell: &Shell<R>, manual: bool) {
    if let Some(updater) = updater_of(&shell.app) {
        updater.check(manual).await;
    }
}

fn shell_of<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<Arc<Shell<R>>> {
    app.try_state::<Arc<Shell<R>>>()
        .map(|shell| shell.inner().clone())
}

pub fn run() {
    let argv: Vec<String> = std::env::args().collect();
    let environment: HashMap<String, String> = std::env::vars().collect();
    let builder = tauri::Builder::default()
        // A second launch, `suplex desktop`, or a cold suplex:// link reaches this process instead of starting another app.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(shell) = shell_of(app) {
                tauri::async_runtime::spawn(async move { shell.open_with(argv).await });
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(target_os = "macos"))]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    let builder = builder.setup(move |app| {
        let resources = app.path().resource_dir().unwrap_or_default();
        let shell = Shell::new(app.handle().clone(), argv, environment, &resources);
        app.manage(shell.clone());
        let ports = updater::TauriPorts::new(
            app.handle().clone(),
            Arc::downgrade(&shell),
            updater::packaged_feed(&resources),
        );
        let configured = ports.configured();
        if !configured {
            eprintln!("Suplex desktop updates are not configured in this build.");
        }
        app.manage(Arc::new(DesktopUpdater::new(ports, configured)));
        menu::create_tray(app.handle())?;
        let menu_shell = shell.clone();
        app.on_menu_event(move |_app, event| menu::handle(&menu_shell, &event));
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            // suplex:// brings Suplex to the front. Only a company invitation (suplex://join?url=https://...)
            // is read, and it switches to that host; other links carry nothing.
            let link_shell = shell.clone();
            app.deep_link().on_open_url(move |event| {
                let shell = link_shell.clone();
                let invitation = event
                    .urls()
                    .iter()
                    .find_map(|url| targets::invitation_target(url.as_str()));
                tauri::async_runtime::spawn(async move {
                    shell.open().await;
                    if let Some(target) = invitation {
                        shell.switch_to(target).await;
                    }
                });
            });
        }
        #[cfg(unix)]
        let signal_shell = shell.clone();
        #[cfg(unix)]
        tauri::async_runtime::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let (Ok(mut terminate), Ok(mut interrupt)) = (
                signal(SignalKind::terminate()),
                signal(SignalKind::interrupt()),
            ) else {
                return;
            };
            tokio::select! {
                _ = terminate.recv() => {}
                _ = interrupt.recv() => {}
            }
            signal_shell.quit().await;
        });
        #[cfg(feature = "native-test")]
        native_test::start(&shell);
        let start_shell = shell.clone();
        tauri::async_runtime::spawn(async move {
            start_shell.network.load_preference().await;
            start_shell.rebuild_menu();
            start_shell.open().await;
            let invitation = start_shell
                .argv
                .iter()
                .find_map(|value| targets::invitation_target(value));
            if let Some(target) = invitation {
                start_shell.switch_to(target).await;
            }
            loop {
                check_for_updates(&start_shell, false).await;
                tokio::time::sleep(UPDATE_INTERVAL).await;
            }
        });
        Ok(())
    });
    let app = configure(builder)
        .build(context())
        .expect("Suplex could not start its window system");
    app.run(|app, event| match event {
        // Closing the last window keeps the app, its tray, and an owned host running. An explicit exit runs the orderly quit first.
        RunEvent::ExitRequested { api, code, .. } => {
            let Some(shell) = shell_of(app) else { return };
            let Some(code) = code else {
                api.prevent_exit();
                return;
            };
            if !shell.is_quitting() {
                api.prevent_exit();
                tauri::async_runtime::spawn(async move { shell.exit(code).await });
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(shell) = shell_of(app) {
                tauri::async_runtime::spawn(async move { shell.open().await });
            }
        }
        // A quit that bypassed the menu (the Dock, logout) still stops the owned host before the process ends.
        RunEvent::Exit => {
            if let Some(shell) = shell_of(app) {
                tauri::async_runtime::block_on(shell.shutdown());
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod ipc_tests;
