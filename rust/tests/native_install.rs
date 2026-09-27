#![allow(clippy::unwrap_used, reason = "integration test helpers")]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{Duration, Instant},
};

struct Fixture {
    root: PathBuf,
    bin: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("suplex-native-install-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        Self { root, bin }
    }
    fn script(&self, name: &str, contents: &str) {
        let path = self.bin.join(name);
        fs::write(&path, contents).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    fn stage(&self, name: &str) -> (Output, serde_json::Value) {
        let output = Command::new(env!("CARGO_BIN_EXE_suplex"))
            .args(["install", "--stage", name, "--json"])
            .current_dir(&self.root)
            .env_clear()
            .env("HOME", &self.root)
            .env(
                "PATH",
                format!("{}:{}", self.bin.display(), std::env::var("PATH").unwrap()),
            )
            .env("SUPLEX_TEST_ROOT", &self.root)
            .env("SUPLEX_ENV_FILE", self.root.join("missing.env"))
            .output()
            .unwrap();
        let value = serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap();
        (output, value)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn marker(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

#[test]
fn developer_tools_accepts_existing_git_without_apple_tools() {
    let fixture = Fixture::new();
    fixture.script("git", "#!/bin/sh\necho 'git version 2.50.1'\n");
    fixture.script("xcode-select", "#!/bin/sh\necho 'must not run' >&2\nexit 1\n");
    let (output, result) = fixture.stage("developer-tools");
    assert!(output.status.success());
    assert_eq!(result["skipped"], true);
    assert_eq!(result["reason"], "git version 2.50.1 already installed");
}

#[test]
fn developer_tools_accepts_xcode_license_then_retries_git() {
    let fixture = Fixture::new();
    fixture.script("git", "#!/bin/sh\nif [ -f \"$SUPLEX_TEST_ROOT/license-accepted\" ]; then echo 'git version 2.50.1 (Apple Git-155)'; exit 0; fi\necho 'You have not agreed to the Xcode and Apple SDKs license.'\nexit 69\n");
    fixture.script("xcode-select", "#!/bin/sh\nexit 0\n");
    fixture.script(
        "osascript",
        "#!/bin/sh\ntouch \"$SUPLEX_TEST_ROOT/license-accepted\"\nexit 0\n",
    );
    let (output, result) = fixture.stage("developer-tools");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        result["reason"],
        "git version 2.50.1 (Apple Git-155) after accepting the Xcode license"
    );
    assert_eq!(result["skipped"], false);
    assert!(marker(&fixture.root, "license-accepted").exists());
}

#[test]
fn developer_tools_reports_cancelled_license_dialog_and_installed_but_broken_git() {
    let fixture = Fixture::new();
    fixture.script(
        "git",
        "#!/bin/sh\necho 'You have not agreed to the Xcode license.'\nexit 69\n",
    );
    fixture.script("xcode-select", "#!/bin/sh\nexit 0\n");
    fixture.script(
        "osascript",
        "#!/bin/sh\necho 'User canceled.' >&2\nexit 1\n",
    );
    let (cancelled, result) = fixture.stage("developer-tools");
    assert!(!cancelled.status.success());
    assert!(
        result["reason"]
            .as_str()
            .unwrap()
            .contains("User canceled.")
    );
    assert!(
        result["remedy"]
            .as_str()
            .unwrap()
            .contains("xcodebuild -license accept")
    );

    fixture.script(
        "git",
        "#!/bin/sh\necho 'xcrun: error: invalid active developer path' >&2\nexit 1\n",
    );
    fixture.script("xcode-select", "#!/bin/sh\nif [ \"$1\" = '--install' ]; then echo 'xcode-select: note: Command line tools are already installed.' >&2; exit 1; fi\nexit 0\n");
    let start = Instant::now();
    let (broken, result) = fixture.stage("developer-tools");
    assert!(!broken.status.success());
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "installer waited for tools macOS says are already installed"
    );
    assert!(
        result["reason"]
            .as_str()
            .unwrap()
            .contains("invalid active developer path")
    );
    assert!(
        result["remedy"]
            .as_str()
            .unwrap()
            .contains("xcode-select --install")
    );
}

#[test]
fn herdr_restarts_stale_server_before_starting_a_new_one() {
    let fixture = Fixture::new();
    fixture.script("herdr", "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SUPLEX_TEST_ROOT/herdr-commands\"\ncase \"$*\" in\n  --version) echo 'herdr 0.9.0'; exit 0;;\n  'workspace list') if [ -f \"$SUPLEX_TEST_ROOT/server-ready\" ]; then exit 0; else exit 1; fi;;\n  'status server --json') if [ -f \"$SUPLEX_TEST_ROOT/server-stopped\" ]; then echo '{\"running\":false,\"compatible\":true}'; else echo '{\"running\":true,\"restart_needed\":true,\"compatible\":false,\"version\":\"0.8.2\"}'; fi; exit 0;;\n  'server stop') touch \"$SUPLEX_TEST_ROOT/server-stopped\"; exit 0;;\n  server) touch \"$SUPLEX_TEST_ROOT/server-ready\"; exit 0;;\nesac\nexit 1\n");
    let (output, result) = fixture.stage("herdr");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(result["ok"], true);
    assert_eq!(result["skipped"], false);
    let calls = fs::read_to_string(marker(&fixture.root, "herdr-commands")).unwrap();
    assert!(
        calls.find("server stop").unwrap() < calls.rfind("server\n").unwrap(),
        "{calls}"
    );
}

#[test]
fn herdr_download_failure_reports_curl_exit_code() {
    let fixture = Fixture::new();
    fixture.script("herdr", "#!/bin/sh\nexit 1\n");
    fixture.script("curl", "#!/bin/sh\nexit 22\n");
    let (output, result) = fixture.stage("herdr");
    assert!(!output.status.success());
    assert_eq!(result["reason"], "curl exited 22");
    assert_eq!(
        result["remedy"],
        "Check the network connection and try again."
    );
}
