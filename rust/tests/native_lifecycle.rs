use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};

fn update_response(port: u16) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "GET /api/update HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn run(binary: &Path, root: &Path, port: u16, arguments: &[&str]) -> Output {
    Command::new(binary)
        .args(arguments)
        .current_dir(root)
        .env_clear()
        .env("HOME", std::env::var_os("HOME").unwrap())
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("SUPLEX_ENV_FILE", root.join("suplex.env"))
        .env("SUPLEX_DATA_ROOT", root.join("custom/data"))
        .env("SUPLEX_REPOSITORY_ROOT", root.join("custom/repos"))
        .env("SUPLEX_WORKTREE_ROOT", root.join("custom/worktrees"))
        .env("SUPLEX_PORT", port.to_string())
        .env("SUPLEX_RUST_PORT", (port + 1).to_string())
        .env("SUPLEX_TAILSCALE_EXPOSURE", "serve")
        .env("SUPLEX_TAILSCALE_COMMAND", "/missing/tailscale")
        .output()
        .expect("run Suplex")
}

#[test]
fn native_manifest_and_owned_host_survive_missing_registry() {
    let binary = Path::new(env!("CARGO_BIN_EXE_suplex"));
    let root =
        std::env::temp_dir().join(format!("suplex-native-lifecycle-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("suplex.env"), "SUPLEX_ACCESS_MODE=local\nSUPLEX_BIND_ADDRESS=127.0.0.1\nSUPLEX_TAILSCALE_EXPOSURE=serve\nSUPLEX_PORT=1\n").unwrap();
    let manifest = run(binary, &root, 4111, &["install", "--manifest"]);
    assert!(manifest.status.success());
    let value: serde_json::Value = serde_json::from_slice(&manifest.stdout).unwrap();
    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["stages"].as_array().unwrap().len(), 5);
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let install = run(
        binary,
        &root,
        port,
        &["install", "--stage", "data", "--json"],
    );
    assert!(
        install.status.success(),
        "{}",
        String::from_utf8_lossy(&install.stderr)
    );
    let stage: serde_json::Value = serde_json::from_slice(&install.stdout).unwrap();
    assert_eq!(stage["stage"], "data");
    assert_eq!(stage["ok"], true);
    let start = run(binary, &root, port, &["start"]);
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    assert!(String::from_utf8_lossy(&start.stdout).contains(&format!("127.0.0.1:{port}")));
    assert!(root.join("custom/data/suplex.sqlite").is_file());
    assert!(root.join("custom/installation-id").is_file());
    let identity = fs::read_to_string(root.join("custom/installation-id")).unwrap();
    assert_eq!(identity.len(), 25);
    let registry = root.join("custom/data/runtime/owned-processes.json");
    let first: serde_json::Value = serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
    assert!(update_response(port).contains("\"canRestart\":true"));
    let child = first["child"]["pid"].as_i64().unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child as i32),
        nix::sys::signal::Signal::SIGKILL,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let current: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
        if current["child"]["pid"]
            .as_i64()
            .is_some_and(|pid| pid != child)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "supervisor did not restart the API"
        );
        thread::sleep(Duration::from_millis(100));
    }
    assert!(update_response(port).contains("\"canRestart\":true"));
    fs::remove_file(&registry).unwrap();
    let stop = run(binary, &root, port, &["stop"]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(String::from_utf8_lossy(&stop.stdout).contains("\"stopped\":1"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_non_tailnet_binding_before_opening_data() {
    let binary = Path::new(env!("CARGO_BIN_EXE_suplex"));
    let root =
        std::env::temp_dir().join(format!("suplex-invalid-binding-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let output = Command::new(binary)
        .arg("doctor")
        .current_dir(&root)
        .env_clear()
        .env("HOME", std::env::var_os("HOME").unwrap())
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("SUPLEX_ENV_FILE", root.join("missing.env"))
        .env("SUPLEX_ACCESS_MODE", "tailscale")
        .env("SUPLEX_TAILSCALE_ADDRESS", "0.0.0.0")
        .env("SUPLEX_DATA_ROOT", root.join("data"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("non-Tailscale bind address"));
    assert!(!root.join("data/suplex.sqlite").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn administrator_invitation_replaces_prior_token_and_preserves_recovery_metadata() {
    use suplex::{
        identity::auth::issue_administrator_invitation,
        platform::database::{OpenMode, SuplexDatabase},
        shared::hash::sha256_hex,
    };
    let filename =
        std::env::temp_dir().join(format!("suplex-invite-{}.sqlite", uuid::Uuid::new_v4()));
    let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
    let now = chrono::Utc::now();
    let first = issue_administrator_invitation(&mut database, "bootstrap", "{}", now)
        .unwrap()
        .unwrap();
    let second = issue_administrator_invitation(&mut database, "bootstrap", "{}", now)
        .unwrap()
        .unwrap();
    assert_ne!(first, second);
    let replaced: Option<String> = database
        .connection()
        .query_row(
            "SELECT replaced_at FROM suplex_invitations WHERE token_hash = ?1",
            [sha256_hex(&first)],
            |row| row.get(0),
        )
        .unwrap();
    assert!(replaced.is_some());
    let metadata = r#"{"initiationMethod":"local-cli","installationId":"installation-id"}"#;
    let recovery = issue_administrator_invitation(&mut database, "recovery", metadata, now)
        .unwrap()
        .unwrap();
    assert!(recovery.starts_with("invite_v1_recovery_"));
    let stored: (String, String) = database
        .connection()
        .query_row(
            "SELECT token_hash, metadata_json FROM suplex_invitations WHERE kind = 'recovery'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, (sha256_hex(&recovery), metadata.to_owned()));
    drop(database);
    let _ = fs::remove_file(filename);
}
