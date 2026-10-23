#![allow(clippy::unwrap_used, reason = "integration test helpers")]

use std::{
    fs,
    io::{self, Read, Write},
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
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SUPLEX_TEST_COMMAND_LOG\"\nmkdir -p target/release\n# Replace, as cargo does: Linux refuses to write a running executable.\nrm -f target/release/suplex\nif [ -f \"$SUPLEX_TEST_FAIL_READY\" ]; then printf '#!/bin/sh\\nexit 0\\n' > target/release/suplex; chmod +x target/release/suplex; else cp \"$SUPLEX_TEST_BINARY\" target/release/suplex; fi\n",
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
        self.try_update(check).unwrap()
    }

    /// `Err` while the API restarts, or when it answers anything but 200.
    fn try_update(&self, check: bool) -> io::Result<serde_json::Value> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port))?;
        let suffix = if check { "?check=1" } else { "" };
        write!(
            stream,
            "GET /api/update{suffix} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            self.port
        )?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        if !response.starts_with("HTTP/1.1 200") {
            return Err(io::Error::other(response));
        }
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap_or_default())
            .map_err(io::Error::other)
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

/// The release feed as suplex.sh serves it: `/download` redirects to the archive, and the
/// manifest beside it names the version and checksum.
#[cfg(target_os = "linux")]
async fn feed(version: &'static str, archive: Vec<u8>) -> String {
    use axum::{Router, http::StatusCode, response::IntoResponse, routing::get};
    use sha2::{Digest, Sha256};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let file = format!("suplex-{version}-linux-x64.tar.gz");
    let location = format!("{base}/stable/linux/x64/{file}");
    let manifest = format!(
        "version: {version}\nfiles:\n  - url: {file}\n    sha256: {:x}\n",
        Sha256::digest(&archive)
    );
    let app =
        Router::new()
            .route(
                "/download",
                get(move || async move {
                    (StatusCode::FOUND, [("location", location)]).into_response()
                }),
            )
            .route(
                "/stable/linux/x64/latest-linux.yml",
                get(move || async move { manifest }),
            )
            .route(
                &format!("/stable/linux/x64/{file}"),
                get(move || async move { archive }),
            );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// An archive-installed host runs `update-apply` outside a source checkout; the updater
/// must reach the feed from that process without a runtime of its own.
#[cfg(target_os = "linux")]
#[test]
fn archive_update_apply_reports_current_against_an_older_feed() {
    let fixture = Fixture::new();
    let plain = fixture.root.join("plain");
    fs::create_dir_all(&plain).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let feed = runtime.block_on(feed("0.0.1", Vec::new()));
    let applied = fixture
        .command_builder(&["update-apply"])
        .current_dir(&plain)
        .env("SUPLEX_ACCOUNT_SERVICE_URL", &feed)
        .output()
        .unwrap();
    assert!(
        applied.status.success(),
        "exit {:?}: {}",
        applied.status.code(),
        String::from_utf8_lossy(&applied.stderr)
    );
    assert_eq!(fixture.status()["kind"], "current");
}

/// A release archive whose `suplex` is a script: it records each launch, answers `version`
/// with `reported`, and otherwise runs this build under the installed path.
#[cfg(target_os = "linux")]
fn release(fixture: &Fixture, reported: Option<&str>) -> Vec<u8> {
    let directory = fixture.root.join("release");
    fs::create_dir_all(&directory).unwrap();
    let version = match reported {
        Some(version) => format!("echo 'suplex {version}'; exit 0"),
        None => "exit 1".into(),
    };
    script(
        &directory.join("suplex"),
        &format!(
            "#!/bin/bash\necho \"$*\" >> {}\n[ \"$1\" = version ] && {{ {version}; }}\nexec -a \"$0\" {} \"$@\"\n",
            fixture.root.join("launches").display(),
            env!("CARGO_BIN_EXE_suplex")
        ),
    );
    let archive = fixture.root.join("release.tar.gz");
    let tar = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&directory)
        .arg("suplex")
        .status()
        .unwrap();
    assert!(tar.success());
    fs::read(archive).unwrap()
}

/// Runs the in-app update the way the Update button does, against a host that a service
/// manager started as `suplex up --foreground`. Returns the final update status and whether
/// the service manager's process is still running.
#[cfg(target_os = "linux")]
fn update_from_the_web(fixture: &Fixture, archive: Vec<u8>) -> (serde_json::Value, bool) {
    let plain = fixture.root.join("plain");
    let installed = fixture.root.join("installed/suplex");
    fs::create_dir_all(&plain).unwrap();
    fs::create_dir_all(installed.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_suplex"), &installed).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let feed = runtime.block_on(feed("99.0.0", archive));
    let mut supervisor = fixture
        .command_builder_for(&installed, &["up", "--foreground"])
        .current_dir(&plain)
        .env("SUPLEX_ACCOUNT_SERVICE_URL", &feed)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    fixture.ready();
    let checked = fixture.update(true);
    assert_eq!(checked["canRestart"], true, "{checked}");
    assert_eq!(checked["availableVersion"], "99.0.0", "{checked}");

    let mut stream = TcpStream::connect(("127.0.0.1", fixture.port)).unwrap();
    write!(
        stream,
        "POST /api/update/restart HTTP/1.1\r\nHost: 127.0.0.1:{0}\r\nOrigin: http://127.0.0.1:{0}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        fixture.port
    )
    .unwrap();
    let mut accepted = String::new();
    stream.read_to_string(&mut accepted).unwrap();
    assert!(accepted.starts_with("HTTP/1.1 202"), "{accepted}");

    let deadline = Instant::now() + Duration::from_secs(90);
    let status = loop {
        if let Ok(response) = fixture.try_update(false) {
            let status = response["status"].clone();
            if status["kind"] == "current" || status["kind"] == "failed" {
                break status;
            }
        }
        assert!(Instant::now() < deadline, "the update did not finish");
        thread::sleep(Duration::from_millis(200));
    };
    let running = supervisor.try_wait().unwrap().is_none();
    let _ = fixture.command(&["stop"]);
    let _ = supervisor.wait();
    (status, running)
}

#[cfg(target_os = "linux")]
#[test]
fn web_update_restarts_the_service_process_in_place() {
    let fixture = Fixture::new();
    let (status, running) = update_from_the_web(&fixture, release(&fixture, Some("99.0.0")));
    assert_eq!(status["kind"], "current", "{status}");
    assert!(running, "the service manager's process exited");
    let launches = fs::read_to_string(fixture.root.join("launches")).unwrap();
    assert_eq!(launches, "version\nup --foreground\n");
}

#[cfg(target_os = "linux")]
#[test]
fn web_update_with_a_release_that_cannot_run_keeps_the_host() {
    let fixture = Fixture::new();
    let (status, running) = update_from_the_web(&fixture, release(&fixture, None));
    assert_eq!(status["kind"], "failed", "{status}");
    assert!(running, "the service manager's process exited");
    assert_eq!(
        fs::read(fixture.root.join("installed/suplex")).unwrap(),
        fs::read(env!("CARGO_BIN_EXE_suplex")).unwrap(),
        "the previous binary was not restored"
    );
    let launches = fs::read_to_string(fixture.root.join("launches")).unwrap();
    assert_eq!(launches, "version\n");
}

/// Stands in for a release whose API stops before it is ready: takes the port the moment
/// the old API releases it, and gives it back once the previous binary is at `installed`.
/// The supervisor spawns `serve` from its own executable, so the release script cannot
/// fail that command itself.
#[cfg(target_os = "linux")]
fn take_port_until_restored(port: u16, installed: PathBuf) -> thread::JoinHandle<()> {
    let restored_len = fs::metadata(env!("CARGO_BIN_EXE_suplex")).unwrap().len();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(90);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "the host did not start");
            thread::sleep(Duration::from_millis(20));
        }
        let listener = loop {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
                break listener;
            }
            assert!(
                Instant::now() < deadline,
                "the API did not release its port"
            );
            thread::sleep(Duration::from_millis(2));
        };
        listener.set_nonblocking(true).unwrap();
        while fs::metadata(&installed).map(|file| file.len()).ok() != Some(restored_len) {
            while listener.accept().is_ok() {}
            assert!(
                Instant::now() < deadline,
                "the previous binary was not restored"
            );
            thread::sleep(Duration::from_millis(10));
        }
    })
}

/// Under systemd the supervisor is the unit's main process. A release that reports its
/// version but whose API stops before it is ready must leave that process running, so the
/// updater can restore the previous binary and the host answers again. The final status
/// comes from the recovered host, which proves it answers.
#[cfg(target_os = "linux")]
#[test]
fn web_update_whose_api_stops_keeps_the_service_process_and_restores_the_previous_binary() {
    let fixture = Fixture::new();
    let blocker = take_port_until_restored(fixture.port, fixture.root.join("installed/suplex"));
    let (status, running) = update_from_the_web(&fixture, release(&fixture, Some("99.0.0")));
    blocker.join().unwrap();
    assert_eq!(status["kind"], "failed", "{status}");
    assert!(running, "the service manager's process exited");
    assert_eq!(
        fs::read(fixture.root.join("installed/suplex")).unwrap(),
        fs::read(env!("CARGO_BIN_EXE_suplex")).unwrap(),
        "the previous binary was not restored"
    );
    let launches = fs::read_to_string(fixture.root.join("launches")).unwrap();
    assert_eq!(launches, "version\nup --foreground\n");
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
    // The host runs `ps` without a locale; a localized start time would not match.
    let start = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .env_remove("LANG")
        .env_remove("LC_ALL")
        .env_remove("LC_TIME")
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
