//! The desktop package stays a Rust shell with plain JavaScript pages: no Electron, no TypeScript, no route into
//! the host's code or database, and a host crate with no desktop dependency.

use std::path::{Path, PathBuf};

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn read(path: &str) -> String {
    std::fs::read_to_string(repository().join(path)).unwrap()
}

fn files(directory: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).unwrap().filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !matches!(
                name.as_str(),
                "node_modules" | "target" | "gen" | "release" | "runtime" | ".build"
            ) {
                files(&path, found);
            }
        } else {
            found.push(path);
        }
    }
}

#[test]
fn the_desktop_package_has_no_typescript_and_no_electron() {
    let mut found = Vec::new();
    files(&repository().join("apps/desktop"), &mut found);
    let typescript: Vec<&PathBuf> = found
        .iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "ts" || extension == "tsx")
        })
        .collect();
    assert!(typescript.is_empty(), "{typescript:?}");
    let desktop: serde_json::Value =
        serde_json::from_str(&read("apps/desktop/package.json")).unwrap();
    assert!(
        desktop.get("dependencies").is_none(),
        "the shell has no JavaScript runtime dependencies"
    );
    assert_eq!(
        desktop["devDependencies"],
        serde_json::json!({ "@tauri-apps/cli": "2.12.1" })
    );
    for manifest in [
        "package.json",
        "apps/desktop/package.json",
        "pnpm-workspace.yaml",
    ] {
        assert!(
            !read(manifest).to_lowercase().contains("electron"),
            "{manifest}"
        );
    }
    assert!(!repository().join("apps/desktop/tsconfig.json").exists());
}

#[test]
fn the_shell_and_host_crates_stay_independent() {
    let shell = read("apps/desktop/src-tauri/Cargo.toml");
    assert!(shell.contains("name = \"suplex-desktop\""));
    assert!(
        !shell.contains("path = \"../../server") && !shell.contains("suplex = "),
        "the shell never links the host"
    );
    let host = read("apps/server/Cargo.toml");
    assert!(
        !host.contains("tauri") && !host.contains("wry"),
        "the headless host has no desktop dependency"
    );
    let mut sources = Vec::new();
    files(
        &repository().join("apps/desktop/src-tauri/src"),
        &mut sources,
    );
    for source in sources {
        let text = std::fs::read_to_string(&source).unwrap();
        for forbidden in ["rusqlite", ".sqlite\"", "suplex::"] {
            assert!(
                !text.contains(forbidden),
                "{} reaches the host's code or database: {forbidden}",
                source.display()
            );
        }
    }
}

#[test]
fn the_bundle_builds_the_native_host_and_the_dev_shell_has_its_own_identity() {
    let bundle = read("scripts/bundle-runtime.sh");
    assert!(
        bundle.contains("cargo build --release --target")
            && bundle.contains("pnpm --filter suplex-web build")
    );
    let dev = read("apps/desktop/scripts/dev.mjs");
    assert!(dev.contains("identifier: \"dev.suplex.desktop.dev\""));
    assert!(
        !dev.contains("kill 0") && !dev.contains("pkill") && !dev.contains("killall"),
        "no catch-all process termination"
    );
    let native = read("apps/desktop/scripts/test-native.sh");
    assert!(
        native.contains("dev.suplex.desktop.test"),
        "native tests never share the installed app's single-instance lock"
    );
}
