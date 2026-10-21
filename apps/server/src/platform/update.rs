use super::{archive_update, config::Installation, supervisor};
use serde_json::{Value, json};
use std::sync::{LazyLock, Mutex};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const REPOSITORY: &str = "meiji-industries/suplex";
static AVAILABLE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static AVAILABLE_VERSION: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static ACTIVE_CHILD: LazyLock<Mutex<Option<Child>>> = LazyLock::new(|| Mutex::new(None));
static REQUEST_LOCK: Mutex<()> = Mutex::new(());
fn state_path(installation: &Installation) -> PathBuf {
    installation.runtime.join("update-status.json")
}
fn write_state(installation: &Installation, status: Value) -> io::Result<()> {
    fs::create_dir_all(&installation.runtime)?;
    let staged = state_path(installation).with_extension("json.staging");
    fs::write(&staged, serde_json::to_vec(&status)?)?;
    fs::rename(staged, state_path(installation))
}
fn read_state(installation: &Installation) -> Value {
    fs::read(state_path(installation))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(json!({"kind":"idle"}))
}
fn update_running(installation: &Installation) -> io::Result<bool> {
    if let Ok(mut active) = ACTIVE_CHILD.lock()
        && let Some(child) = active.as_mut()
    {
        if child.try_wait()?.is_none() {
            return Ok(true);
        }
        *active = None;
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(installation.runtime.join("update.lock"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            let _ = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) };
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error
            .raw_os_error()
            .is_some_and(|code| code == libc::EWOULDBLOCK || code == libc::EAGAIN)
        {
            return Ok(true);
        }
        Err(error)
    }
    #[cfg(not(unix))]
    {
        Ok(false)
    }
}
fn run(
    root: &Path,
    name: &str,
    args: &[&str],
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let mut command = Command::new(name);
    command
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().ok_or("Missing command stdout")?;
    let mut stderr = child.stderr.take().ok_or("Missing command stderr")?;
    let (send_out, read_out) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = send_out.send(stdout.read_to_end(&mut bytes).map(|_| bytes));
    });
    let (send_err, read_err) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = send_err.send(stderr.read_to_end(&mut bytes).map(|_| bytes));
    });
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut cancelled = None;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if !supervisor::inherited_supervisor_alive() {
            cancelled = Some("The Suplex host stopped during the update");
        } else if Instant::now() >= deadline {
            cancelled = Some("The update command timed out");
        }
        if cancelled.is_some() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGTERM);
            }
            thread::sleep(Duration::from_millis(250));
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
            break child.wait()?;
        }
        thread::sleep(Duration::from_millis(100));
    };
    if let Some(reason) = cancelled {
        return Err(reason.into());
    }
    let stdout = read_out
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Command stdout remained open after its process stopped")??;
    let stderr = read_err
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Command stderr remained open after its process stopped")??;
    if !status.success() {
        return Err(format!(
            "{name} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8(stdout)?.trim().to_owned())
}
fn git(root: &Path, args: &[&str]) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    run(root, "git", args)
}
fn canonical_remote(raw: &str) -> bool {
    let raw = raw.trim();
    let path = if let Some(path) = raw.strip_prefix("git@github.com:") {
        path.to_owned()
    } else {
        let Ok(url) = url::Url::parse(raw) else {
            return false;
        };
        if url.host_str() != Some("github.com") || url.query().is_some() || url.fragment().is_some()
        {
            return false;
        }
        if url.scheme() == "https" && (!url.username().is_empty() || url.password().is_some()) {
            return false;
        }
        if !matches!(url.scheme(), "https" | "ssh" | "git+ssh") {
            return false;
        }
        if matches!(url.scheme(), "ssh" | "git+ssh") && url.username() != "git" {
            return false;
        }
        url.path().trim_start_matches('/').to_owned()
    };
    path.trim_end_matches('/')
        .trim_end_matches(".git")
        .eq_ignore_ascii_case(REPOSITORY)
}
pub(crate) fn remote(root: &Path) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let branch = git(root, &["symbolic-ref", "--short", "HEAD"])?;
    if branch != "main" {
        return Err(format!(
            "Suplex updates require the main branch. The current branch is {branch}."
        )
        .into());
    }
    if let Ok(upstream) = git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    ) && let Some(name) = upstream.strip_suffix("/main")
    {
        if canonical_remote(&git(root, &["remote", "get-url", name])?) {
            return Ok(name.to_owned());
        }
        return Err("git upstream does not match meiji-industries/suplex".into());
    }
    let names = git(root, &["remote"])?;
    let mut matching = Vec::new();
    for name in names.lines() {
        if canonical_remote(&git(root, &["remote", "get-url", name])?) {
            matching.push(name.to_owned());
        }
    }
    if matching.iter().any(|name| name == "origin") {
        return Ok("origin".into());
    }
    if matching.len() == 1 {
        return Ok(matching.remove(0));
    }
    Err(if matching.is_empty() {
        "git found no remote for meiji-industries/suplex"
    } else {
        "git found multiple Suplex remotes and no authoritative upstream"
    }
    .into())
}
fn check_remote(
    root: &Path,
) -> Result<(String, String, String), Box<dyn std::error::Error + Send + Sync>> {
    let remote = remote(root)?;
    let remote_ref = format!("refs/remotes/{remote}/main");
    git(
        root,
        &[
            "fetch",
            "--no-tags",
            &remote,
            &format!("refs/heads/main:{remote_ref}"),
        ],
    )?;
    let head = git(root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let available = git(
        root,
        &["rev-parse", "--verify", &format!("{remote_ref}^{{commit}}")],
    )?;
    if !valid_revision(&head) || !valid_revision(&available) {
        return Err("git returned an invalid commit revision".into());
    }
    if head != available
        && !Command::new("git")
            .args(["merge-base", "--is-ancestor", &head, &remote_ref])
            .current_dir(root)
            .status()?
            .success()
    {
        return Err("The Suplex checkout has diverged from remote main. Resolve the branch before updating.".into());
    }
    Ok((head, available, remote_ref))
}
fn valid_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn packaged() -> bool {
    std::env::var("SUPLEX_PACKAGED").as_deref() == Ok("1")
}
fn failure(action: &str, error: impl ToString) -> Value {
    json!({"kind":"failed","action":action,"message":format!("Suplex could not {} an update.", if action == "check" { "check for" } else { "apply" }),"error":error.to_string()})
}
fn applying(installation: &Installation, step: &str, message: &str) -> io::Result<()> {
    write_state(
        installation,
        json!({"kind":"applying","step":step,"message":message}),
    )
}
fn start_binary(
    binary: &Path,
    root: &Path,
    installation: &Installation,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let output = Command::new(binary)
        .arg("start")
        .current_dir(root)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "Suplex restart failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    if !supervisor::host_running(installation) {
        return Err("Suplex API did not report readiness".into());
    }
    Ok(())
}
fn start_with_recovery(
    new_binary: &Path,
    previous_binary: &Path,
    mut start: impl FnMut(&Path) -> Result<(), String>,
    mut cleanup: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    match start(new_binary) {
        Ok(()) => Ok(()),
        Err(original) => match cleanup().and_then(|_| start(previous_binary)) {
            Ok(()) => Err(original),
            Err(recovery) => Err(format!(
                "{original}\nSuplex could not restart the previous binary: {recovery}"
            )),
        },
    }
}

pub fn snapshot(installation: &Installation, check: bool, admin: bool) -> Value {
    let current = env!("SUPLEX_REVISION");
    let mut status = read_state(installation);
    if status["kind"] == "applying" && update_running(installation).is_ok_and(|running| !running) {
        status = failure("apply", "The update process stopped before completion.");
        let _ = write_state(installation, status.clone());
    }
    if archive_update::managed() {
        return archive_snapshot(installation, status, check, admin);
    }
    let mut available = AVAILABLE.lock().ok().and_then(|value| value.clone());
    if available.is_none()
        && (status["kind"] == "available"
            || (status["kind"] == "failed" && status["action"] == "apply"))
    {
        let root = std::env::current_dir().unwrap_or_default();
        available = remote(&root)
            .and_then(|name| git(&root, &["rev-parse", &format!("refs/remotes/{name}/main")]))
            .ok()
            .filter(|revision| valid_revision(revision) && revision != current);
    }
    if packaged() && check {
        status = json!({"kind":"failed","action":"check","message":"Updates come with the desktop app.","error":"This Suplex ships inside Suplex.app; install the new app to update it."});
        let _ = write_state(installation, status.clone());
    } else if check {
        let prior_apply_failure =
            (status["kind"] == "failed" && status["action"] == "apply").then_some(status.clone());
        match check_remote(&std::env::current_dir().unwrap_or_default()) {
            Ok((_, remote, _)) => {
                available = (remote != current).then_some(remote);
                if let Ok(mut remembered) = AVAILABLE.lock() {
                    *remembered = available.clone();
                }
                status = prior_apply_failure.clone().unwrap_or_else(
                    || json!({"kind":if available.is_some(){"available"}else{"current"}}),
                );
            }
            Err(error) => status = prior_apply_failure.unwrap_or_else(|| failure("check", error)),
        }
        let _ = write_state(installation, status.clone());
    }
    let mut response = json!({"status":status,"canRestart":admin && supervisor::current_is_supervised(installation)});
    if valid_revision(current) {
        response["currentRevision"] = json!(current);
    }
    if let Some(available) = available {
        response["availableRevision"] = json!(available);
    }
    response
}

/// The feed-based status of an archive-installed Linux host.
fn archive_snapshot(
    installation: &Installation,
    mut status: Value,
    check: bool,
    admin: bool,
) -> Value {
    let mut available = AVAILABLE_VERSION
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if check {
        let prior_apply_failure =
            (status["kind"] == "failed" && status["action"] == "apply").then_some(status.clone());
        let latest = archive_update::service_url(installation)
            .and_then(|service| archive_update::block_on(archive_update::latest(&service)));
        status = match latest {
            Ok(release) => {
                available = release.map(|release| release.version);
                if let Ok(mut remembered) = AVAILABLE_VERSION.lock() {
                    *remembered = available.clone();
                }
                prior_apply_failure.unwrap_or_else(
                    || json!({"kind":if available.is_some(){"available"}else{"current"}}),
                )
            }
            Err(error) => prior_apply_failure.unwrap_or_else(|| failure("check", error)),
        };
        let _ = write_state(installation, status.clone());
    }
    let mut response = json!({"status":status,"canRestart":admin && supervisor::current_is_supervised(installation),"currentVersion":env!("CARGO_PKG_VERSION")});
    if let Some(available) = available {
        response["availableVersion"] = json!(available);
    }
    response
}

/// Downloads the published archive, swaps this binary, and restarts the host.
fn apply_archive(
    installation: &Installation,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let root = std::env::current_dir()?;
    let rollback = installation.runtime.join("update-rollback-suplex");
    let target = crate::shared::fs::executable()?.canonicalize()?;
    let mut host_stopped = false;
    let mut recovery_attempted = false;
    let result = (|| -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        applying(installation, "fetch", "Suplex checks the update.")?;
        let service = archive_update::service_url(installation)?;
        let Some(release) = archive_update::block_on(archive_update::latest(&service))? else {
            write_state(installation, json!({"kind":"current"}))?;
            return Ok(());
        };
        applying(
            installation,
            "install",
            &format!("Suplex downloads version {}.", release.version),
        )?;
        let archive = archive_update::block_on(archive_update::download(&release))?;
        archive_update::install(&archive, &target, &rollback)?;
        if !supervisor::inherited_supervisor_alive() {
            return Err("The Suplex host stopped during the update".into());
        }
        applying(installation, "stop", "Suplex stops the host.")?;
        supervisor::stop(installation)?;
        host_stopped = true;
        applying(installation, "start", "Suplex starts the host.")?;
        recovery_attempted = true;
        start_with_recovery(
            &target,
            &rollback,
            |candidate| {
                if candidate != target {
                    archive_update::restore(&rollback, &target)
                        .map_err(|error| error.to_string())?;
                }
                start_binary(&target, &root, installation).map_err(|error| error.to_string())
            },
            || {
                supervisor::stop(installation)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
        )?;
        write_state(installation, json!({"kind":"current"}))?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut message = error.to_string();
        if host_stopped && !recovery_attempted {
            let recovery = archive_update::restore(&rollback, &target)
                .and_then(|_| supervisor::stop(installation).map(|_| ()))
                .and_then(|_| start_binary(&target, &root, installation));
            if let Err(recovery_error) = recovery {
                message.push_str(&format!(
                    "\nSuplex could not restart the previous binary: {recovery_error}"
                ));
            }
        }
        let _ = write_state(installation, failure("apply", &message));
        return Err(message.into());
    }
    Ok(())
}

pub fn request_apply(
    installation: &Installation,
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    let _request = REQUEST_LOCK
        .lock()
        .map_err(|_| "Update request lock was poisoned")?;
    if packaged() {
        return Err("Updates come with the desktop app.".into());
    }
    if !supervisor::current_is_supervised(installation) {
        return Err("Suplex update control is not available.".into());
    }
    if update_running(installation)? {
        return Ok(json!({"accepted":true,"status":read_state(installation)}));
    }
    let status = json!({"kind":"applying","step":"fetch","message":"Suplex checks the update."});
    write_state(installation, status.clone())?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(installation.runtime.join("update.log"))?;
    let mut command = Command::new(crate::shared::fs::executable()?);
    command
        .arg("update-apply")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    let child = command.spawn()?;
    if let Ok(mut active) = ACTIVE_CHILD.lock() {
        *active = Some(child);
    }
    Ok(json!({"accepted":true,"status":status}))
}

pub fn apply() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let installation = Installation::load()?;
    fs::create_dir_all(&installation.runtime)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(installation.runtime.join("update.lock"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Ok(());
        }
    }
    if archive_update::managed() {
        return apply_archive(&installation);
    }
    let root = std::env::current_dir()?;
    let rollback = installation.runtime.join("update-rollback-suplex");
    let mut host_stopped = false;
    let mut recovery_attempted = false;
    let result = (|| -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        applying(&installation, "fetch", "Suplex checks the update.")?;
        let (head, available, remote_ref) = check_remote(&root)?;
        if head != available {
            applying(&installation, "merge", "Suplex applies the update.")?;
            git(&root, &["merge", "--ff-only", &remote_ref])?;
        }
        applying(&installation, "install", "Suplex installs dependencies.")?;
        run(&root, "pnpm", &["install", "--frozen-lockfile"])?;
        let current_binary = std::env::current_exe()?;
        let staged_rollback = rollback.with_extension("staging");
        fs::copy(&current_binary, &staged_rollback)?;
        fs::set_permissions(
            &staged_rollback,
            fs::metadata(&current_binary)?.permissions(),
        )?;
        fs::rename(staged_rollback, &rollback)?;
        applying(&installation, "build", "Suplex builds production assets.")?;
        run(&root, "mise", &["run", "build"])?;
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("target"));
        let binary = if target.is_absolute() {
            target
        } else {
            root.join(target)
        }
        .join("release/suplex");
        if !binary.is_file() {
            return Err(format!("Built Suplex binary is missing: {}", binary.display()).into());
        }
        if !supervisor::inherited_supervisor_alive() {
            return Err("The Suplex host stopped during the update".into());
        }
        applying(&installation, "stop", "Suplex stops the host.")?;
        supervisor::stop(&installation)?;
        host_stopped = true;
        applying(&installation, "start", "Suplex starts the host.")?;
        recovery_attempted = true;
        start_with_recovery(
            &binary,
            &rollback,
            |candidate| {
                start_binary(candidate, &root, &installation).map_err(|error| error.to_string())
            },
            || {
                supervisor::stop(&installation)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
        )?;
        write_state(&installation, json!({"kind":"current"}))?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut message = error.to_string();
        if host_stopped && !recovery_attempted {
            let recovery = supervisor::stop(&installation)
                .and_then(|_| start_binary(&rollback, &root, &installation));
            if let Err(recovery_error) = recovery {
                message.push_str(&format!(
                    "\nSuplex could not restart the previous binary: {recovery_error}"
                ));
            }
        }
        let _ = write_state(&installation, failure("apply", &message));
        // A recovered supervisor still needs this executable when its API restarts.
        return Err(message.into());
    }
    let _ = fs::remove_file(&rollback);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn descendant_output_cannot_keep_a_finished_update_command_pending() {
        let started = Instant::now();
        let error = run(Path::new("/tmp"), "sh", &["-c", "sleep 3 & printf done"]).unwrap_err();
        assert!(error.to_string().contains("remained open"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn remote_identity_accepts_only_canonical_suplex() {
        assert!(canonical_remote(
            "git@github.com:meiji-industries/suplex.git"
        ));
        assert!(canonical_remote(
            "https://github.com/meiji-industries/suplex.git"
        ));
        assert!(!canonical_remote(
            "https://example.com/meiji-industries/suplex"
        ));
        assert!(!canonical_remote("https://github.com/elsewhere/suplex"));
    }
}
