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
        "app_update_status",
        "app_check_for_updates",
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
    // Tauri links its Windows application manifest (Common Controls 6, which the dialogs need) into the app
    // only, so test binaries could not start. The linker embeds the same manifest into every target instead.
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
                .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(manifest)
            .windows_attributes(windows),
    )
    .expect("tauri build configuration");
}
