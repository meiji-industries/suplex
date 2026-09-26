use super::{config::Installation, supervisor};
use serde_json::{Value, json};
use std::sync::{LazyLock, Mutex};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const REPOSITORY: &str = "meiji-industries/suplex";
static AVAILABLE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
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
fn run(root: &Path, name: &str, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new(name).args(args).current_dir(root).output()?;
    if !output.status.success() {
        return Err(format!(
            "{name} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}
fn git(root: &Path, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
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
        if url.host_str() != Some("github.com")
            || !url.query().is_none()
            || !url.fragment().is_none()
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
fn remote(root: &Path) -> Result<String, Box<dyn std::error::Error>> {
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
fn check_remote(root: &Path) -> Result<(String, String, String), Box<dyn std::error::Error>> {
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

pub fn snapshot(installation: &Installation, check: bool, admin: bool) -> Value {
    let current = env!("SUPLEX_RUST_REVISION");
    let mut status = read_state(installation);
    let mut available = AVAILABLE.lock().ok().and_then(|value| value.clone());
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

pub fn request_apply(installation: &Installation) -> Result<Value, Box<dyn std::error::Error>> {
    if packaged() {
        return Err("Updates come with the desktop app.".into());
    }
    if !supervisor::current_is_supervised(installation) {
        return Err("Suplex update control is not available.".into());
    }
    let status = json!({"kind":"applying","step":"fetch","message":"Suplex checks the update."});
    write_state(installation, status.clone())?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(installation.runtime.join("update.log"))?;
    let mut command = Command::new(std::env::current_exe()?);
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
    command.spawn()?;
    Ok(json!({"accepted":true,"status":status}))
}

pub fn apply() -> Result<(), Box<dyn std::error::Error>> {
    let installation = Installation::load()?;
    fs::create_dir_all(&installation.runtime)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(installation.runtime.join("update.lock"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Ok(());
        }
    }
    let root = std::env::current_dir()?;
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        applying(&installation, "fetch", "Suplex checks the update.")?;
        let (head, available, remote_ref) = check_remote(&root)?;
        if head != available {
            applying(&installation, "merge", "Suplex applies the update.")?;
            git(&root, &["merge", "--ff-only", &remote_ref])?;
        }
        applying(&installation, "install", "Suplex installs dependencies.")?;
        run(&root, "pnpm", &["install", "--frozen-lockfile"])?;
        applying(&installation, "build", "Suplex builds production assets.")?;
        run(&root, "mise", &["run", "build"])?;
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("target"));
        let binary = if target.is_absolute() {
            target
        } else {
            root.join("rust").join(target)
        }
        .join("release/suplex");
        if !binary.is_file() {
            return Err(format!("Built Suplex binary is missing: {}", binary.display()).into());
        }
        applying(&installation, "stop", "Suplex stops the host.")?;
        supervisor::stop(&installation)?;
        applying(&installation, "start", "Suplex starts the host.")?;
        let output = Command::new(binary)
            .arg("start")
            .current_dir(&root)
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "Suplex restart failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        write_state(&installation, json!({"kind":"current"}))?;
        Ok(())
    })();
    if let Err(error) = &result {
        let _ = write_state(&installation, failure("apply", error));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
