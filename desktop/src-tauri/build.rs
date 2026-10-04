fn main() {
    // Application-command permissions: with an app manifest, Tauri admits a command only when a
    // capability for the calling webview and origin grants `allow-<command>`.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "desktop_snapshot",
        "desktop_choose",
        "desktop_cancel",
        "desktop_retry",
        "desktop_launch",
        "desktop_back",
        "desktop_open_logs",
        "desktop_copy_output",
        "desktop_test_connection",
        "desktop_tailscale_status",
        "desktop_turn_on_tailscale",
        "desktop_open_tailscale",
        "desktop_remove_host",
        "desktop_select_host",
        "unavailable_retry",
        "unavailable_open_host_picker",
        "app_account_cleared",
        "app_open_host_picker",
        "app_network_access",
        "app_save_network_access_preference",
        "app_restart_network_access",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri build configuration");
}
