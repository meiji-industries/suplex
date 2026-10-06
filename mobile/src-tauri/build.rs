fn main() {
    // With an app manifest, Tauri admits a command only when a capability for the calling page grants `allow-<command>`.
    let manifest =
        tauri_build::AppManifest::new().commands(&["connect", "saved_host", "open_host_picker"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri build configuration");
}
