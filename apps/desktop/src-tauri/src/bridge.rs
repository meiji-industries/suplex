//! Bridge commands. Tauri's ACL admits a command only for the view labels and origins its capability
//! names; each handler then checks that the calling webview is the current view of its kind on its
//! live origin. Arguments never carry authority: no URL, role, or label from JavaScript is trusted.

use std::{sync::Arc, time::Duration};

use tauri::{Runtime, State, Webview};

use crate::{
    boot::{BootEvent, Mode},
    contracts::{
        AppNetworkAccess, ConnectionTest, DesktopSnapshot, NetworkMode, TailscaleStatus, ZoomStep,
    },
    local_runtime::healthy,
    shell::Shell,
    tailscale,
    targets::parse_target,
    window::ViewKind,
};

type Shared<'a, R> = State<'a, Arc<Shell<R>>>;

pub const DENIED: &str = "This page cannot use the Suplex desktop bridge.";

fn require<R: Runtime>(
    shell: &Shell<R>,
    webview: &Webview<R>,
    kind: ViewKind,
) -> Result<(), String> {
    let url = webview.url().ok();
    if shell.caller_is(webview.label(), url.as_ref(), kind) {
        Ok(())
    } else {
        Err(DENIED.into())
    }
}

// ----- window.suplexDesktop: the bundled setup pages -----

#[tauri::command]
pub fn desktop_snapshot<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<DesktopSnapshot, String> {
    require(&shell, &webview, ViewKind::Setup)?;
    Ok(shell.snapshot())
}

#[tauri::command]
pub fn desktop_choose<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
    mode: Mode,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.choose(mode);
    Ok(())
}

#[tauri::command]
pub fn desktop_cancel<R: Runtime>(webview: Webview<R>, shell: Shared<'_, R>) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.cancel_install();
    Ok(())
}

#[tauri::command]
pub fn desktop_retry<R: Runtime>(webview: Webview<R>, shell: Shared<'_, R>) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.go(BootEvent::Retry);
    Ok(())
}

#[tauri::command]
pub fn desktop_launch<R: Runtime>(webview: Webview<R>, shell: Shared<'_, R>) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.go(BootEvent::Launch);
    Ok(())
}

#[tauri::command]
pub fn desktop_back<R: Runtime>(webview: Webview<R>, shell: Shared<'_, R>) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.go(BootEvent::Back);
    Ok(())
}

#[tauri::command]
pub fn desktop_open_logs<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.open_logs();
    Ok(())
}

#[tauri::command]
pub fn desktop_copy_output<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.copy_output();
    Ok(())
}

#[tauri::command]
pub async fn desktop_test_connection<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
    url: String,
) -> Result<ConnectionTest, String> {
    require(&shell, &webview, ViewKind::Setup)?;
    let target = match parse_target(&url) {
        Ok(target) => target,
        Err(reason) => {
            return Ok(ConnectionTest {
                ok: false,
                reason: Some(reason),
            })
        }
    };
    Ok(if healthy(&target.origin, Duration::from_secs(2)).await {
        ConnectionTest {
            ok: true,
            reason: None,
        }
    } else {
        ConnectionTest {
            ok: false,
            reason: Some(format!("No Suplex answered at {}/health.", target.origin)),
        }
    })
}

#[tauri::command]
pub async fn desktop_tailscale_status<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<TailscaleStatus, String> {
    require(&shell, &webview, ViewKind::Setup)?;
    Ok(tailscale::status(tailscale::COMMANDS, &tailscale::SystemRunner).await)
}

#[tauri::command]
pub async fn desktop_turn_on_tailscale<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<Option<String>, String> {
    require(&shell, &webview, ViewKind::Setup)?;
    Ok(tailscale::turn_on(tailscale::COMMANDS, &tailscale::SystemRunner).await)
}

#[tauri::command]
pub async fn desktop_open_tailscale<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    #[cfg(target_os = "macos")]
    let _ = tokio::process::Command::new("/usr/bin/open")
        .args(["-b", "io.tailscale.ipn.macos"])
        .status()
        .await;
    #[cfg(windows)]
    {
        let programs = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let app = std::path::Path::new(&programs).join(r"Tailscale\tailscale-ipn.exe");
        if std::process::Command::new(app).spawn().is_err() {
            shell
                .open_external(&url::Url::parse("https://tailscale.com/download/windows").unwrap());
        }
    }
    // Linux has no Tailscale app; machine approval happens in the admin console.
    #[cfg(target_os = "linux")]
    shell.open_external(&url::Url::parse("https://login.tailscale.com/admin/machines").unwrap());
    Ok(())
}

#[tauri::command]
pub fn desktop_remove_host<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
    origin: String,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.forget_host(&origin);
    Ok(())
}

#[tauri::command]
pub async fn desktop_select_host<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
    origin: String,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Setup)?;
    shell.select_host(&origin).await;
    Ok(())
}

// ----- the bundled remote-failure page -----

#[tauri::command]
pub async fn unavailable_retry<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Unavailable)?;
    if let crate::shell::View::Unavailable { target, .. } = shell.view() {
        if crate::local_runtime::reachable(&target.origin, Duration::from_secs(2)).await
            && shell.view().label() == Some(webview.label())
        {
            shell.load(&target).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn unavailable_open_host_picker<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Unavailable)?;
    crate::menu::popup_host_picker(&shell);
    Ok(())
}

// ----- window.suplexApp: the selected host's top-level page -----

#[tauri::command]
pub async fn app_account_cleared<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Host)?;
    shell.account_cleared(webview.label()).await;
    Ok(())
}

#[tauri::command]
pub fn app_open_host_picker<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Host)?;
    crate::menu::popup_host_picker(&shell);
    Ok(())
}

/// The update status for a page that just loaded; later changes arrive as bridge events.
#[tauri::command]
pub fn app_update_status<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<crate::updater::Status, String> {
    require(&shell, &webview, ViewKind::Host)?;
    Ok(crate::updater_of(&shell.app)
        .map_or(crate::updater::Status::Idle, |updater| updater.status()))
}

/// The same manual check the menu's "Check for updates" runs.
#[tauri::command]
pub async fn app_check_for_updates<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Host)?;
    crate::check_for_updates(&shell, true).await;
    Ok(())
}

/// The page's zoom shortcuts, which Windows and Linux have no menu bar for; the same as View > Zoom on macOS.
#[tauri::command]
pub fn app_zoom<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
    step: ZoomStep,
) -> Result<(), String> {
    require(&shell, &webview, ViewKind::Host)?;
    shell.zoom(step);
    Ok(())
}

#[tauri::command]
pub async fn app_network_access<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<AppNetworkAccess, String> {
    require(&shell, &webview, ViewKind::Host)?;
    if !shell.local_admin(&webview).await {
        return Ok(AppNetworkAccess::unmanaged());
    }
    Ok(shell.access_snapshot())
}

#[tauri::command]
pub async fn app_save_network_access_preference<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
    mode: NetworkMode,
) -> Result<AppNetworkAccess, String> {
    require(&shell, &webview, ViewKind::Host)?;
    if !shell.local_admin(&webview).await {
        return Ok(AppNetworkAccess::unmanaged());
    }
    shell.network.save_preference(mode).await?;
    Ok(shell.access_snapshot())
}

#[tauri::command]
pub async fn app_restart_network_access<R: Runtime>(
    webview: Webview<R>,
    shell: Shared<'_, R>,
) -> Result<AppNetworkAccess, String> {
    require(&shell, &webview, ViewKind::Host)?;
    if !shell.local_admin(&webview).await {
        return Ok(AppNetworkAccess::unmanaged());
    }
    let page = shell.restart_network().await?;
    let snapshot = shell.access_snapshot();
    let shell = shell.inner().clone();
    tauri::async_runtime::spawn(async move { shell.return_to(page).await });
    Ok(snapshot)
}
