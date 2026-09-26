use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn files(root: &Path, suffix: Option<&str>) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry.expect("read bundle entry").path();
        if path.is_dir() {
            paths.extend(files(&path, suffix));
        } else if suffix
            .is_none_or(|extension| path.extension().is_some_and(|actual| actual == extension))
        {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

fn embedded_files(root: &Path, suffix: Option<&str>) -> String {
    println!("cargo:rerun-if-changed={}", root.display());
    let mut entries = String::new();
    for path in files(root, suffix) {
        println!("cargo:rerun-if-changed={}", path.display());
        let name = path
            .strip_prefix(root)
            .expect("bundle file under root")
            .to_str()
            .expect("UTF-8 bundle filename");
        let absolute = path.canonicalize().expect("bundle file exists");
        entries.push_str(&format!(
            "EmbeddedFile {{ name: {name:?}, bytes: include_bytes!({:?}) }},\n",
            absolute.to_str().expect("UTF-8 bundle path")
        ));
    }
    entries
}

fn git(manifest: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .current_dir(manifest)
        .output()
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| String::from_utf8(result.stdout).ok())
        .map(|value| value.trim().to_owned())
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let migrations = embedded_files(&manifest.join("../migrations"), Some("sql"));
    let frontend = embedded_files(&manifest.join("../dist/web"), None);
    if env::var("PROFILE").as_deref() == Ok("release") {
        for asset in ["suplex-ui.js", "suplex-ui.css"] {
            assert!(
                manifest.join("../dist/web").join(asset).is_file(),
                "Missing frontend asset {asset}; run pnpm build to build the native bundle"
            );
        }
    }
    let output = format!(
        "pub static MIGRATIONS: &[EmbeddedFile] = &[{migrations}];\npub static FRONTEND: &[EmbeddedFile] = &[{frontend}];\n"
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR").expect("Cargo output directory")).join("embedded.rs"),
        output,
    )
    .expect("write bundle index");

    let revision = git(&manifest, &["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=SUPLEX_RUST_REVISION={revision}");
    if let Some(head) = git(&manifest, &["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
    }
    if let Some(branch) = git(&manifest, &["symbolic-ref", "--quiet", "HEAD"])
        && let Some(reference) = git(&manifest, &["rev-parse", "--git-path", &branch])
    {
        println!("cargo:rerun-if-changed={reference}");
    }
}
