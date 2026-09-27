#![allow(clippy::unwrap_used, reason = "integration test helpers")]

use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    root: PathBuf,
    checkout: PathBuf,
    producer: PathBuf,
    remote: PathBuf,
    bin: PathBuf,
    port: u16,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("suplex-native-update-{}", uuid::Uuid::new_v4()));
        let checkout = root.join("checkout");
        let producer = root.join("producer");
        let remote = root.join("remote.git");
        let bin = root.join("bin");
        fs::create_dir_all(&checkout).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::write(checkout.join("keep.txt"), "base\n").unwrap();
        fs::write(checkout.join("overlap.txt"), "base\n").unwrap();
        fs::write(checkout.join("remote.txt"), "before\n").unwrap();
        git(&checkout, &["init", "--initial-branch=main"]);
        git(&checkout, &["config", "user.name", "Suplex test"]);
        git(
            &checkout,
            &["config", "user.email", "suplex@example.invalid"],
        );
        git(&checkout, &["add", "."]);
        git(&checkout, &["commit", "-m", "Initial"]);
        git(
            &root,
            &[
                "clone",
                "--bare",
                checkout.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        git(
            &checkout,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:meiji-industries/suplex.git",
            ],
        );
        git(&checkout, &["config", "branch.main.remote", "origin"]);
        git(
            &checkout,
            &["config", "branch.main.merge", "refs/heads/main"],
        );
        git(
            &root,
            &[
                "clone",
                remote.to_str().unwrap(),
                producer.to_str().unwrap(),
            ],
        );
        git(&producer, &["config", "user.name", "Suplex test"]);
        git(
            &producer,
            &["config", "user.email", "suplex@example.invalid"],
        );
        script(
            &bin.join("ssh"),
            "#!/bin/sh\nexec git-upload-pack \"$SUPLEX_TEST_REMOTE\"\n",
        );
        script(
            &bin.join("pnpm"),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SUPLEX_TEST_COMMAND_LOG\"\nif [ -f \"$SUPLEX_TEST_FAIL_INSTALL\" ]; then echo deliberate-install-failure >&2; exit 1; fi\nif [ -f \"$SUPLEX_TEST_SLOW_INSTALL\" ]; then sleep 1; fi\nif [ -f \"$SUPLEX_TEST_BLOCK_INSTALL\" ]; then sleep 10 & echo $! > \"$SUPLEX_TEST_BLOCK_PID\"; wait; fi\n",
        );
        script(
            &bin.join("mise"),
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SUPLEX_TEST_COMMAND_LOG\"\nmkdir -p rust/target/release\n# Replace, as cargo does: Linux refuses to write a running executable.\nrm -f rust/target/release/suplex\nif [ -f \"$SUPLEX_TEST_FAIL_READY\" ]; then printf '#!/bin/sh\\nexit 0\\n' > rust/target/release/suplex; chmod +x rust/target/release/suplex; else cp \"$SUPLEX_TEST_BINARY\" rust/target/release/suplex; fi\n",
        );
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        Self {
            root,
            checkout,
            producer,
            remote,
            bin,
            port,
        }
    }

    fn command_builder(&self, args: &[&str]) -> Command {
        self.command_builder_for(Path::new(env!("CARGO_BIN_EXE_suplex")), args)
    }

    fn command_builder_for(&self, binary: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(&self.checkout)
            .env_clear()
            .env("HOME", std::env::var_os("HOME").unwrap())
            .env(
                "PATH",
                format!("{}:{}", self.bin.display(), std::env::var("PATH").unwrap()),
            )
            .env("GIT_SSH_COMMAND", self.bin.join("ssh"))
            .env("GIT_SSH_VARIANT", "ssh")
            .env("SUPLEX_TEST_REMOTE", &self.remote)
            .env("SUPLEX_TEST_BINARY", env!("CARGO_BIN_EXE_suplex"))
            .env("SUPLEX_TEST_COMMAND_LOG", self.root.join("commands.log"))
            .env("SUPLEX_TEST_FAIL_INSTALL", self.root.join("fail-install"))
            .env("SUPLEX_TEST_SLOW_INSTALL", self.root.join("slow-install"))
            .env("SUPLEX_TEST_BLOCK_INSTALL", self.root.join("block-install"))
            .env("SUPLEX_TEST_BLOCK_PID", self.root.join("block.pid"))
            .env("SUPLEX_TEST_FAIL_READY", self.root.join("fail-ready"))
            .env("SUPLEX_ACCESS_MODE", "local")
            .env("SUPLEX_BIND_ADDRESS", "127.0.0.1")
            .env("SUPLEX_PORT", self.port.to_string())
            .env("SUPLEX_ENV_FILE", self.root.join("missing.env"))
            .env("SUPLEX_DATA_ROOT", self.root.join("data"))
            .env("SUPLEX_REPOSITORY_ROOT", self.root.join("repos"))
            .env("SUPLEX_WORKTREE_ROOT", self.root.join("worktrees"));
        command
    }

    fn command(&self, args: &[&str]) -> Output {
        self.command_builder(args).output().unwrap()
    }

    fn start(&self) {
        let result = self.command(&["start"]);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        self.ready();
    }

    fn ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while TcpStream::connect(("127.0.0.1", self.port)).is_err() {
            assert!(
                Instant::now() < deadline,
                "native host did not become ready"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn restart_api(&self) {
        let registry_path = self.root.join("data/runtime/owned-processes.json");
        let before: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
        let child = before["child"]["pid"].as_i64().unwrap();
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child as i32),
            nix::sys::signal::Signal::SIGKILL,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let after: serde_json::Value =
                serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
            if after["child"]["pid"]
                .as_i64()
                .is_some_and(|pid| pid != child)
                && after["ready"] == true
            {
                break;
            }
            assert!(Instant::now() < deadline, "host did not restart");
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn publish(&self, name: &str, contents: &str) -> String {
        fs::write(self.producer.join(name), contents).unwrap();
        git(&self.producer, &["add", "."]);
        git(&self.producer, &["commit", "-m", "Update"]);
        git(&self.producer, &["push", "origin", "main"]);
        git(&self.producer, &["rev-parse", "HEAD"])
    }

    fn status(&self) -> serde_json::Value {
        serde_json::from_slice(
            &fs::read(self.root.join("data/runtime/update-status.json")).unwrap(),
        )
        .unwrap()
    }

    fn update(&self, check: bool) -> serde_json::Value {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        let suffix = if check { "?check=1" } else { "" };
        write!(
            stream,
            "GET /api/update{suffix} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            self.port
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.command(&["stop"]);
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn script(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn failed_install_preserves_host_and_dirty_nonoverlap_then_retries_once() {
    let fixture = Fixture::new();
    fixture.publish("remote.txt", "after\n");
    fs::write(fixture.checkout.join("keep.txt"), "dirty\n").unwrap();
    fixture.start();
    fs::write(fixture.root.join("fail-install"), "1").unwrap();
    let failed = fixture.command(&["update-apply"]);
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("deliberate-install-failure"));
    fixture.ready();
    assert_eq!(fixture.status()["kind"], "failed");
    assert_eq!(
        fs::read_to_string(fixture.checkout.join("keep.txt")).unwrap(),
        "dirty\n"
    );
    fs::remove_file(fixture.root.join("fail-install")).unwrap();
    let succeeded = fixture.command(&["update-apply"]);
    assert!(
        succeeded.status.success(),
        "{}",
        String::from_utf8_lossy(&succeeded.stderr)
    );
    fixture.ready();
    assert_eq!(fixture.status()["kind"], "current");
    assert_eq!(
        fs::read_to_string(fixture.checkout.join("keep.txt")).unwrap(),
        "dirty\n"
    );
    assert_eq!(
        git(&fixture.checkout, &["rev-parse", "HEAD"]),
        git(&fixture.producer, &["rev-parse", "HEAD"])
    );
}

#[test]
fn overlapping_change_and_divergence_leave_existing_host_running() {
    let fixture = Fixture::new();
    fixture.start();
    fs::write(fixture.checkout.join("overlap.txt"), "local\n").unwrap();
    fixture.publish("overlap.txt", "remote\n");
    assert!(!fixture.command(&["update-apply"]).status.success());
    fixture.ready();
    assert_eq!(
        fs::read_to_string(fixture.checkout.join("overlap.txt")).unwrap(),
        "local\n"
    );
    git(&fixture.checkout, &["add", "."]);
    git(&fixture.checkout, &["commit", "-m", "Local divergence"]);
    assert!(!fixture.command(&["update-apply"]).status.success());
    fixture.ready();
    assert_eq!(fixture.status()["kind"], "failed");
}

#[test]
fn replacement_without_readiness_restores_previous_host_and_failed_status() {
    let fixture = Fixture::new();
    fixture.publish("remote.txt", "after\n");
    fixture.start();
    fs::write(fixture.root.join("fail-ready"), "1").unwrap();
    let failed = fixture.command(&["update-apply"]);
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("did not report readiness"));
    fixture.ready();
    assert_eq!(fixture.status()["kind"], "failed");
    fixture.restart_api();
    assert_eq!(fixture.status()["kind"], "failed");

    // A retry can originate in the recovered executable itself.
    let rollback = fixture.root.join("data/runtime/update-rollback-suplex");
    assert!(rollback.is_file());
    let retry = fixture
        .command_builder_for(&rollback, &["update-apply"])
        .output()
        .unwrap();
    assert!(!retry.status.success());
    fixture.ready();
    fixture.restart_api();

    // The normal CLI must rediscover this host even though it uses another executable.
    fs::remove_file(fixture.root.join("data/runtime/owned-processes.json")).unwrap();
    fs::remove_file(fixture.root.join("fail-ready")).unwrap();
    let succeeded = fixture.command(&["update-apply"]);
    assert!(
        succeeded.status.success(),
        "{}",
        String::from_utf8_lossy(&succeeded.stderr)
    );
    fixture.ready();
    assert!(!rollback.exists());
}

#[test]
fn stale_apply_is_recoverable_and_running_revision_survives_checkout_advance() {
    let fixture = Fixture::new();
    let remote_revision = fixture.publish("remote.txt", "after\n");
    fixture.start();
    assert_eq!(fixture.update(true)["availableRevision"], remote_revision);
    fixture.restart_api();
    assert_eq!(fixture.update(false)["availableRevision"], remote_revision);
    let applied = fixture.command(&["update-apply"]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    fixture.ready();
    assert_eq!(
        git(&fixture.checkout, &["rev-parse", "HEAD"]),
        remote_revision
    );
    let checked = fixture.update(true);
    assert_eq!(checked["currentRevision"], env!("SUPLEX_REVISION"));
    assert_eq!(checked["availableRevision"], remote_revision);
    assert_eq!(checked["status"]["kind"], "available");
    fs::write(
        fixture.root.join("data/runtime/update-status.json"),
        r#"{"kind":"applying","step":"build","message":"old"}"#,
    )
    .unwrap();
    let recovered = fixture.update(false);
    assert_eq!(recovered["status"]["kind"], "failed");
    assert_eq!(recovered["status"]["action"], "apply");
    let retry = fixture.command(&["update-apply"]);
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    fixture.ready();
    assert_eq!(fixture.status()["kind"], "current");
}

#[test]
fn concurrent_update_helpers_install_once() {
    let fixture = Fixture::new();
    fixture.publish("remote.txt", "after\n");
    fixture.start();
    fs::write(fixture.root.join("slow-install"), "1").unwrap();
    let first = thread::scope(|scope| {
        let first = scope.spawn(|| fixture.command(&["update-apply"]));
        thread::sleep(Duration::from_millis(200));
        let second = scope.spawn(|| fixture.command(&["update-apply"]));
        (first.join().unwrap(), second.join().unwrap())
    });
    assert!(
        first.0.status.success(),
        "{}",
        String::from_utf8_lossy(&first.0.stderr)
    );
    assert!(
        first.1.status.success(),
        "{}",
        String::from_utf8_lossy(&first.1.stderr)
    );
    fixture.ready();
    assert_eq!(fixture.status()["kind"], "current");
    let commands = fs::read_to_string(fixture.root.join("commands.log")).unwrap();
    assert_eq!(
        commands
            .lines()
            .filter(|line| *line == "install --frozen-lockfile")
            .count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn stopping_supervisor_cancels_installer_and_does_not_restart_host() {
    let fixture = Fixture::new();
    fixture.publish("remote.txt", "after\n");
    fixture.start();
    let registry: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.root.join("data/runtime/owned-processes.json")).unwrap(),
    )
    .unwrap();
    let pid = registry["process"]["pid"].as_u64().unwrap() as i32;
    let start = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .unwrap();
    let start = String::from_utf8(start.stdout).unwrap().trim().to_owned();
    fs::write(fixture.root.join("block-install"), "1").unwrap();
    let mut update = fixture
        .command_builder(&["update-apply"])
        .env("SUPLEX_SUPERVISOR_PID", pid.to_string())
        .env("SUPLEX_SUPERVISOR_START", start)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.root.join("block.pid").exists() {
        assert!(Instant::now() < deadline, "installer did not start");
        thread::sleep(Duration::from_millis(50));
    }
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let result = update.wait().unwrap();
    assert!(!result.success());
    assert_eq!(fixture.status()["kind"], "failed");
    thread::sleep(Duration::from_millis(400));
    assert!(TcpStream::connect(("127.0.0.1", fixture.port)).is_err());
}
