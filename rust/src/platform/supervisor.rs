use super::{config::Installation, setup};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
struct OwnedProcess {
    pid: u32,
    command: String,
    start_time: String,
    executable: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Registry {
    version: u8,
    process: OwnedProcess,
    #[serde(default)]
    child: Option<OwnedProcess>,
    #[serde(default)]
    ready: bool,
}

fn registry_path(installation: &Installation) -> std::path::PathBuf {
    installation.runtime.join("owned-processes.json")
}
fn inspect(pid: u32) -> Option<OwnedProcess> {
    let field = |name: &str| -> Option<String> {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", name])
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    if field("stat=")?.starts_with('Z') {
        return None;
    }
    Some(OwnedProcess {
        pid,
        command: field("command=")?,
        start_time: field("lstart=")?,
        executable: field("comm=")?,
    })
}
fn matches(owned: &OwnedProcess) -> bool {
    inspect(owned.pid).is_some_and(|actual| {
        actual.command == owned.command
            && actual.start_time == owned.start_time
            && actual.executable == owned.executable
    })
}
pub fn current_is_supervised(installation: &Installation) -> bool {
    let Ok(pid) = std::env::var("SUPLEX_SUPERVISOR_PID")
        .unwrap_or_default()
        .parse::<u32>()
    else {
        return false;
    };
    let start = std::env::var("SUPLEX_SUPERVISOR_START").unwrap_or_default();
    inspect(pid).is_some_and(|process| {
        process.start_time == start && process.command.contains("start --foreground")
    }) && database_open_by(std::process::id(), installation)
}
pub fn inherited_supervisor_alive() -> bool {
    let Ok(pid) = std::env::var("SUPLEX_SUPERVISOR_PID") else {
        return true;
    };
    let Ok(pid) = pid.parse::<u32>() else {
        return false;
    };
    let start = std::env::var("SUPLEX_SUPERVISOR_START").unwrap_or_default();
    inspect(pid).is_some_and(|process| {
        process.start_time == start && process.command.contains("start --foreground")
    })
}
pub fn host_running(installation: &Installation) -> bool {
    let recorded = read(&registry_path(installation)).ok().flatten();
    let current = recorded
        .filter(|record| {
            record.ready
                && matches(&record.process)
                && record.child.as_ref().is_some_and(|child| {
                    matches(child) && database_open_by(child.pid, installation)
                })
        })
        .or_else(|| discover(installation));
    current.is_some()
        && std::net::TcpStream::connect((installation.bind_address.as_str(), installation.port))
            .is_ok()
}
fn read(path: &Path) -> io::Result<Option<Registry>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn discover(installation: &Installation) -> Option<Registry> {
    let output = Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{}", installation.port),
            "-sTCP:LISTEN",
            "-t",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some(child_pid) = line.parse::<u32>().ok() else {
            continue;
        };
        let Some(child) = inspect(child_pid) else {
            continue;
        };
        let Some(executable) = child.command.strip_suffix(" serve") else {
            continue;
        };
        if !database_open_by(child_pid, installation) {
            continue;
        }
        let parent = Command::new("ps")
            .args(["-p", &child_pid.to_string(), "-o", "ppid="])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|value| value.trim().parse::<u32>().ok())
            .and_then(inspect);
        if let Some(parent) = parent
            && parent.command.strip_suffix(" start --foreground") == Some(executable)
            && parent.executable == child.executable
        {
            return Some(Registry {
                version: 1,
                process: parent,
                child: Some(child),
                ready: true,
            });
        }
    }
    None
}
fn database_open_by(pid: u32, installation: &Installation) -> bool {
    let target = installation
        .database
        .canonicalize()
        .unwrap_or_else(|_| installation.database.clone());
    let Ok(output) = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-Fn"])
        .output()
    else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix('n'))
            .any(|name| {
                Path::new(name)
                    .canonicalize()
                    .unwrap_or_else(|_| Path::new(name).to_path_buf())
                    == target
            })
}
fn write(path: &Path, registry: &Registry) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let staged = path.with_extension("json.staging");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&staged)?;
    file.write_all(&serde_json::to_vec_pretty(registry)?)?;
    file.sync_all()?;
    fs::rename(staged, path)
}
fn serve_status(installation: &Installation) -> io::Result<bool> {
    let command = std::env::var("SUPLEX_TAILSCALE_COMMAND").unwrap_or_else(|_| "tailscale".into());
    let output = setup::tailscale(&command, &["serve", "status", "--json"])?;
    Ok(output.status.success() && setup::serve_route_matches(installation, &output.stdout))
}
fn stop_serve(installation: &Installation) -> io::Result<()> {
    if installation.access_mode != "tailscale"
        || installation.tailscale_exposure != "serve"
        || !serve_status(installation)?
    {
        return Ok(());
    }
    let command = std::env::var("SUPLEX_TAILSCALE_COMMAND").unwrap_or_else(|_| "tailscale".into());
    let port = format!("--https={}", installation.port);
    let output = setup::tailscale(&command, &["serve", &port, "off"])?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Register the foreground process before it binds; remove the record after graceful shutdown.
pub fn register_foreground(installation: &Installation) -> io::Result<()> {
    let path = registry_path(installation);
    if let Some(existing) = read(&path).ok().flatten()
        && matches(&existing.process)
        && existing.process.pid != std::process::id()
    {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "Suplex is already running",
        ));
    }
    if discover(installation).is_some_and(|record| record.process.pid != std::process::id()) {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "Suplex is already running",
        ));
    }
    let owned = inspect(std::process::id())
        .ok_or_else(|| io::Error::other("Could not inspect Suplex process identity"))?;
    write(
        &path,
        &Registry {
            version: 1,
            process: owned,
            child: None,
            ready: false,
        },
    )?;
    Ok(())
}
pub fn configure_foreground(installation: &Installation) -> Result<(), Box<dyn std::error::Error>> {
    setup::configure_serve(installation)
}
pub fn unregister_foreground(installation: &Installation) {
    let path = registry_path(installation);
    if read(&path)
        .ok()
        .flatten()
        .is_some_and(|record| record.process.pid == std::process::id())
    {
        let _ = stop_serve(installation);
        let _ = fs::remove_file(path);
    }
}
fn register_child(installation: &Installation, child_pid: u32) -> io::Result<()> {
    let path = registry_path(installation);
    let own = inspect(std::process::id())
        .ok_or_else(|| io::Error::other("Could not inspect Suplex supervisor"))?;
    let mut record = read(&path)
        .ok()
        .flatten()
        .filter(|record| record.process.pid == own.pid && matches(&record.process))
        .unwrap_or(Registry {
            version: 1,
            process: own,
            child: None,
            ready: false,
        });
    record.child = inspect(child_pid);
    record.ready = false;
    write(&path, &record)
}
fn mark_ready(installation: &Installation) -> io::Result<()> {
    let path = registry_path(installation);
    let Some(mut record) = read(&path).ok().flatten() else {
        return Ok(());
    };
    if record.process.pid == std::process::id() && matches(&record.process) {
        record.ready = true;
        write(&path, &record)?;
    }
    Ok(())
}
async fn stop_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        if let Some(pid) = child.id() {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }
    if tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}
pub async fn run_foreground() -> Result<(), Box<dyn std::error::Error>> {
    let installation = Installation::load()?;
    register_foreground(&installation)?;
    let result = supervise(&installation).await;
    unregister_foreground(&installation);
    result
}
async fn supervise(installation: &Installation) -> Result<(), Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let started = inspect(std::process::id())
        .ok_or("Could not inspect supervisor")?
        .start_time;
    loop {
        let mut child = tokio::process::Command::new(&executable);
        child
            .arg("serve")
            .env("SUPLEX_SUPERVISOR_PID", std::process::id().to_string())
            .env("SUPLEX_SUPERVISOR_START", &started)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let mut child = child.spawn()?;
        register_child(
            installation,
            child.id().ok_or("Could not start Suplex API")?,
        )?;
        let ready_deadline = Instant::now() + Duration::from_secs(30);
        loop {
            #[cfg(unix)]
            tokio::select! {
                _ = interrupt.recv() => { stop_child(&mut child).await; return Ok(()); },
                _ = terminate.recv() => { stop_child(&mut child).await; return Ok(()); },
                result = child.wait() => return Err(format!("Suplex API stopped before readiness ({})", result?).into()),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
            #[cfg(not(unix))]
            tokio::time::sleep(Duration::from_millis(100)).await;
            if std::net::TcpStream::connect((installation.bind_address.as_str(), installation.port))
                .is_ok()
            {
                break;
            }
            if Instant::now() >= ready_deadline {
                let _ = child.kill().await;
                return Err("Suplex API did not report readiness".into());
            }
        }
        mark_ready(installation)?;
        #[cfg(unix)]
        let reason = {
            tokio::select! {
                _ = interrupt.recv() => Some("SIGINT"),
                _ = terminate.recv() => Some("SIGTERM"),
                result = child.wait() => { eprintln!("Suplex API stopped ({}) and will restart", result?); None },
            }
        };
        #[cfg(not(unix))]
        let reason = {
            tokio::select! { _ = tokio::signal::ctrl_c() => Some("SIGINT"), result = child.wait() => { eprintln!("Suplex API stopped ({}) and will restart", result?); None } }
        };
        if let Some(reason) = reason {
            eprintln!("Suplex supervisor received {reason}; stopping API");
            stop_child(&mut child).await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub fn start(installation: &Installation) -> Result<u32, Box<dyn std::error::Error>> {
    if let Some(existing) = read(&registry_path(installation)).ok().flatten()
        && matches(&existing.process)
    {
        return Ok(existing.process.pid);
    }
    if let Some(existing) = discover(installation) {
        return Ok(existing.process.pid);
    }
    fs::create_dir_all(&installation.runtime)?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(installation.runtime.join("server.log"))?;
    let executable = std::env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .args(["start", "--foreground"])
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
    let mut child = command.spawn()?;
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(format!("Suplex stopped before readiness ({status})").into());
        }
        let registered = read(&registry_path(installation))
            .ok()
            .flatten()
            .is_some_and(|registry| {
                registry.process.pid == pid && matches(&registry.process) && registry.ready
            });
        if registered
            && std::net::TcpStream::connect((installation.bind_address.as_str(), installation.port))
                .is_ok()
        {
            return Ok(pid);
        }
        thread::sleep(Duration::from_millis(100));
    }
    stop(installation)?;
    Err("Suplex API did not become reachable within 30 seconds".into())
}

pub fn stop(installation: &Installation) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let path = registry_path(installation);
    let recorded = read(&path).ok().flatten();
    let registry = recorded
        .as_ref()
        .filter(|record| matches(&record.process))
        .cloned()
        .or_else(|| discover(installation));
    let Some(registry) = registry else {
        if let Some(recorded) = recorded
            && inspect(recorded.process.pid).is_none()
        {
            let _ = fs::remove_file(&path);
        }
        stop_serve(installation)?;
        return Ok(serde_json::json!({"stopped":0,"skipped":[]}));
    };
    let pid = registry.process.pid;
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        kill(Pid::from_raw(pid as i32), Signal::SIGTERM)?;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && matches(&registry.process) {
        thread::sleep(Duration::from_millis(100));
    }
    if matches(&registry.process) {
        #[cfg(unix)]
        {
            use nix::sys::signal::{Signal, kill};
            use nix::unistd::Pid;
            kill(Pid::from_raw(pid as i32), Signal::SIGKILL)?;
        }
        thread::sleep(Duration::from_millis(200));
    }
    if matches(&registry.process) {
        return Err(format!("Suplex process {pid} did not stop").into());
    }
    if let Some(child) = &registry.child
        && matches(child)
    {
        #[cfg(unix)]
        {
            use nix::sys::signal::{Signal, kill};
            use nix::unistd::Pid;
            kill(Pid::from_raw(child.pid as i32), Signal::SIGTERM)?;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && matches(child) {
            thread::sleep(Duration::from_millis(100));
        }
        if matches(child) {
            return Err(format!("Suplex API process {} did not stop", child.pid).into());
        }
    }
    stop_serve(installation)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(serde_json::json!({"stopped":1,"skipped":[]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_identity_cannot_signal_reused_pid() {
        let actual = inspect(std::process::id()).unwrap();
        let stale = OwnedProcess {
            start_time: "old boot".into(),
            ..actual
        };
        assert!(!matches(&stale));
    }
}
