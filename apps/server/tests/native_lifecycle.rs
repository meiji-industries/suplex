#![allow(clippy::unwrap_used, reason = "integration test helpers")]

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

fn command(binary: &Path, root: &Path, port: u16, arguments: &[&str]) -> Command {
    let mut command = Command::new(binary);
    command
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
        .env("SUPLEX_TAILSCALE_EXPOSURE", "serve")
        .env("SUPLEX_TAILSCALE_COMMAND", "/missing/tailscale");
    command
}

fn run(binary: &Path, root: &Path, port: u16, arguments: &[&str]) -> Output {
    command(binary, root, port, arguments)
        .output()
        .expect("run Suplex")
}

fn registry(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// A host under systemd runs `suplex up --foreground`. `suplex restart` must keep that
/// process (its pid is the unit's main pid) and run the program on disk, so a replaced
/// binary takes over without a stop.
#[cfg(unix)]
#[test]
fn restart_keeps_the_supervisor_pid_and_runs_the_program_on_disk() {
    use std::os::unix::fs::PermissionsExt;
    let real = Path::new(env!("CARGO_BIN_EXE_suplex"));
    let root = std::env::temp_dir().join(format!("suplex-native-restart-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::write(
        root.join("suplex.env"),
        "SUPLEX_ACCESS_MODE=local\nSUPLEX_BIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    let installed = root.join("bin/suplex");
    fs::copy(real, &installed).unwrap();
    let port = free_port();
    let log = fs::File::create(root.join("supervisor.log")).unwrap();
    let mut supervisor = command(&installed, &root, port, &["up", "--foreground"])
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(Instant::now() < deadline, "host did not become ready");
        thread::sleep(Duration::from_millis(100));
    }
    assert!(update_response(port).contains("\"canRestart\":true"));
    let registry_path = root.join("custom/data/runtime/owned-processes.json");
    let before = registry(&registry_path);
    assert_eq!(
        before["process"]["pid"].as_u64().unwrap(),
        u64::from(supervisor.id())
    );
    let child = before["child"]["pid"].as_u64().unwrap();

    // Linux refuses to write a running executable; the installer renames over it too.
    let marker = root.join("launches");
    let staged = root.join("bin/suplex.staging");
    fs::write(
        &staged,
        format!(
            "#!/bin/sh\necho \"$*\" >> {}\nexec {} \"$@\"\n",
            marker.display(),
            real.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).unwrap();
    fs::rename(&staged, &installed).unwrap();

    let restart = run(real, &root, port, &["restart"]);
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    assert!(String::from_utf8_lossy(&restart.stdout).contains("Suplex restarted"));
    let after = registry(&registry_path);
    assert_eq!(after["process"]["pid"], before["process"]["pid"]);
    assert_eq!(after["ready"], true);
    assert_ne!(after["child"]["pid"].as_u64().unwrap(), child);
    assert!(update_response(port).contains("\"canRestart\":true"));
    assert!(
        supervisor.try_wait().unwrap().is_none(),
        "the supervisor process exited"
    );
    let launches = fs::read_to_string(&marker).unwrap();
    assert!(
        launches.lines().any(|line| line == "up --foreground"),
        "{launches}"
    );

    let stop = run(real, &root, port, &["stop"]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while supervisor.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "supervisor did not stop");
        thread::sleep(Duration::from_millis(100));
    }
    let _ = fs::remove_dir_all(root);
}

/// A supervisor that SIGUSR2 relaunched is the service unit's main process. When its API
/// cannot start it keeps running and retries, so an updater can restore its rollback and
/// signal again. A supervisor started fresh with the same problem still stops at once.
#[cfg(unix)]
#[test]
fn a_relaunched_supervisor_retries_an_api_that_cannot_start() {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    let binary = Path::new(env!("CARGO_BIN_EXE_suplex"));
    let root =
        std::env::temp_dir().join(format!("suplex-native-relaunch-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("suplex.env"),
        "SUPLEX_ACCESS_MODE=local\nSUPLEX_BIND_ADDRESS=127.0.0.1\n",
    )
    .unwrap();
    let port = free_port();
    let registry_path = root.join("custom/data/runtime/owned-processes.json");
    let alive = |pid: i32| kill(Pid::from_raw(pid), None).is_ok();

    let taken = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let mut fresh = command(binary, &root, port, &["up", "--foreground"])
        .stderr(fs::File::create(root.join("fresh.log")).unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while fresh.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "a fresh supervisor kept running");
        thread::sleep(Duration::from_millis(100));
    }
    assert!(!fresh.wait().unwrap().success());
    assert!(
        fs::read_to_string(root.join("fresh.log"))
            .unwrap()
            .contains("stopped before readiness")
    );
    drop(taken);

    let log = fs::File::create(root.join("supervisor.log")).unwrap();
    let mut supervisor = command(binary, &root, port, &["up", "--foreground"])
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    let ready = |path: &Path| {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .filter(|record| record["ready"] == true)
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let child = loop {
        if let Some(record) = ready(&registry_path) {
            break record["child"]["pid"].as_i64().unwrap();
        }
        assert!(Instant::now() < deadline, "host did not become ready");
        thread::sleep(Duration::from_millis(100));
    };
    let pid = supervisor.id() as i32;
    kill(Pid::from_raw(pid), Signal::SIGUSR2).unwrap();
    let taken = loop {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            break listener;
        }
        assert!(
            Instant::now() < deadline,
            "the API did not release its port"
        );
        thread::sleep(Duration::from_millis(2));
    };
    taken.set_nonblocking(true).unwrap();
    loop {
        while taken.accept().is_ok() {}
        assert!(
            supervisor.try_wait().unwrap().is_none(),
            "the relaunched supervisor exited"
        );
        let current = registry(&registry_path);
        let relaunched = current["child"]["pid"].as_i64();
        if relaunched.is_some_and(|new| new != child && !alive(new as i32)) {
            assert_eq!(current["ready"], false);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the relaunched API did not start"
        );
        thread::sleep(Duration::from_millis(50));
    }
    drop(taken);

    let deadline = Instant::now() + Duration::from_secs(30);
    while ready(&registry_path).is_none() || TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(Instant::now() < deadline, "the host did not recover");
        thread::sleep(Duration::from_millis(100));
    }
    assert!(update_response(port).contains("\"canRestart\":true"));
    assert_eq!(
        registry(&registry_path)["process"]["pid"].as_i64().unwrap(),
        i64::from(pid)
    );
    let stop = run(binary, &root, port, &["stop"]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while supervisor.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "supervisor did not stop");
        thread::sleep(Duration::from_millis(100));
    }
    let _ = fs::remove_dir_all(root);
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
    let port = free_port();
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
fn recovery_invitation_replaces_prior_token_and_preserves_metadata() {
    use suplex::{
        identity::auth::issue_recovery_invitation,
        platform::database::{OpenMode, SuplexDatabase},
        shared::hash::sha256_hex,
    };
    let filename =
        std::env::temp_dir().join(format!("suplex-invite-{}.sqlite", uuid::Uuid::new_v4()));
    let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
    let now = chrono::Utc::now();
    let first = issue_recovery_invitation(&mut database, "{}", now).unwrap();
    let second = issue_recovery_invitation(&mut database, "{}", now).unwrap();
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
    let recovery = issue_recovery_invitation(&mut database, metadata, now).unwrap();
    assert!(recovery.starts_with("invite_v1_recovery_"));
    let stored: (String, String) = database
        .connection()
        .query_row(
            "SELECT token_hash, metadata_json FROM suplex_invitations WHERE kind = 'recovery' AND replaced_at IS NULL",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, (sha256_hex(&recovery), metadata.to_owned()));
    drop(database);
    let _ = fs::remove_file(filename);
}

#[test]
fn advisor_stdio_refuses_missing_or_incorrect_credentials_before_initialization() {
    use suplex::coordination::advisor_bridge::{AdvisorRole, write_binding};
    let root = std::env::temp_dir().join(format!("suplex-advisor-auth-{}", uuid::Uuid::new_v4()));
    let binding = write_binding(&root, AdvisorRole::Rater, env!("CARGO_BIN_EXE_suplex")).unwrap();
    for token in [None, Some("00000000-0000-4000-8000-000000000000")] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_suplex"));
        command
            .args(["mcp", "advisor"])
            .env_clear()
            .env("SUPLEX_ADVISOR_BINDING", &binding.binding_path)
            .env("SUPLEX_ADVISOR_RESULT", root.join("result.json"));
        if let Some(token) = token {
            command.env("SUPLEX_ADVISOR_TOKEN", token);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("authentication failed"));
        assert!(!root.join("result.json").exists());
    }
    fs::remove_dir_all(root).unwrap();
}
