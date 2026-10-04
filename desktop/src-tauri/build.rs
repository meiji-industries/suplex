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
    // `generate_context!` compiles the merged configuration (`tauri build --config`) and the version into the
    // shell. The shell includes this file, so Cargo recompiles it when the file changes and a build with
    // another feed, updater key, or version never keeps the previous one.
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=../package.json");
    let compiled = format!(
        "{}{}",
        std::env::var("TAURI_CONFIG").unwrap_or_default(),
        std::fs::read_to_string("../package.json").unwrap_or_default()
    );
    let record = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("compiled-configuration");
    if std::fs::read_to_string(&record).ok().as_deref() != Some(compiled.as_str()) {
        std::fs::write(&record, compiled).expect("write the compiled configuration record");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri build configuration");
}
