use super::{config::Installation, setup};
use crate::http::routes::access::NetworkAccessMode;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    io::{BufRead, Read, Write},
    net::ToSocketAddrs,
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
/// Supervisors that write version 2 restart in place on SIGUSR2; earlier ones stop on it.
const REGISTRY_VERSION: u8 = 2;
/// Set on a supervisor that SIGUSR2 relaunched, never on its `serve` child.
const RELAUNCH_VARIABLE: &str = "SUPLEX_SUPERVISOR_RELAUNCH";
#[derive(Clone, Serialize, Deserialize)]
struct Registry {
    version: u8,
    process: OwnedProcess,
    #[serde(default)]
    child: Option<OwnedProcess>,
    #[serde(default)]
    ready: bool,
}

pub fn require_non_root_host() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    refuse_root(
        unsafe { libc::geteuid() },
        &std::env::args().skip(1).collect::<Vec<_>>().join(" "),
    )?;
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn refuse_root(effective_uid: u32, command: &str) -> io::Result<()> {
    if effective_uid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "Suplex cannot run as root. Run this command as the dedicated non-root user that owns the installation, for example:\n  sudo -u suplex -i suplex {command}\nSee https://github.com/meiji-industries/suplex/blob/main/README.md#linux-host."
            ),
        ));
    }
    Ok(())
}

fn registry_path(installation: &Installation) -> std::path::PathBuf {
    installation.runtime.join("owned-processes.json")
}
fn inspect(pid: u32) -> Option<OwnedProcess> {
    let field = |name: &str| -> Option<String> {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", name])
            .env("LC_ALL", "C")
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
/// The executable of a supervisor command line: `suplex start --foreground` from the CLI,
/// `suplex up --foreground` from the systemd unit.
fn foreground_executable(command: &str) -> Option<&str> {
    command
        .strip_suffix(" start --foreground")
        .or_else(|| command.strip_suffix(" up --foreground"))
}
fn inherited_supervisor() -> Option<OwnedProcess> {
    let pid = std::env::var("SUPLEX_SUPERVISOR_PID")
        .ok()?
        .parse::<u32>()
        .ok()?;
    let start = std::env::var("SUPLEX_SUPERVISOR_START").unwrap_or_default();
    inspect(pid).filter(|process| {
        process.start_time == start && foreground_executable(&process.command).is_some()
    })
}
pub fn current_is_supervised(installation: &Installation) -> bool {
    inherited_supervisor().is_some() && database_open_by(std::process::id(), installation)
}
pub fn inherited_supervisor_alive() -> bool {
    std::env::var_os("SUPLEX_SUPERVISOR_PID").is_none() || inherited_supervisor().is_some()
}
/// The supervisor that owns this installation's host, whether or not its API answers yet.
fn running_supervisor(installation: &Installation) -> Option<Registry> {
    read(&registry_path(installation))
        .ok()
        .flatten()
        .filter(|record| matches(&record.process))
        .or_else(|| discover(installation))
}
pub fn supervisor_running(installation: &Installation) -> bool {
    running_supervisor(installation).is_some()
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
    current.is_some() && http_ready(&installation.bind_address, installation.port)
}

// The public page proves HTTP readiness without waiting on optional provider probes.
fn http_ready(host: &str, port: u16) -> bool {
    let host = match host {
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        value => value,
    };
    let timeout = Duration::from_millis(500);
    let Some(mut stream) = (host, port).to_socket_addrs().ok().and_then(|addresses| {
        addresses
            .into_iter()
            .find_map(|address| std::net::TcpStream::connect_timeout(&address, timeout).ok())
    }) else {
        return false;
    };
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
        || write!(
            stream,
            "GET /auth HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        )
        .is_err()
    {
        return false;
    }
    let mut status = String::new();
    io::BufReader::new(stream.take(64))
        .read_line(&mut status)
        .is_ok()
        && [
            "HTTP/1.1 200 ",
            "HTTP/1.0 200 ",
            "HTTP/1.1 303 ",
            "HTTP/1.0 303 ",
        ]
        .iter()
        .any(|prefix| status.starts_with(prefix))
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
            && foreground_executable(&parent.command) == Some(executable)
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
fn stop_serve_arguments(port: u16, proxy: &str) -> Vec<String> {
    vec![
        "serve".into(),
        format!("--https={port}"),
        "--set-path=/".into(),
        proxy.into(),
        "off".into(),
    ]
}
fn stop_serve(installation: &Installation) -> io::Result<()> {
    if installation.access_mode != NetworkAccessMode::Tailscale.as_str()
        || installation.tailscale_exposure != "serve"
        || !serve_status(installation)?
    {
        return Ok(());
    }
    let command = std::env::var("SUPLEX_TAILSCALE_COMMAND").unwrap_or_else(|_| "tailscale".into());
    let arguments = stop_serve_arguments(installation.port, &setup::serve_proxy(installation));
    let output = setup::tailscale(
        &command,
        &arguments.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
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
            version: REGISTRY_VERSION,
            process: owned,
            child: None,
            ready: false,
        },
    )?;
    Ok(())
}
pub fn configure_foreground(
    installation: &Installation,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
            version: REGISTRY_VERSION,
            process: own,
            child: None,
            ready: false,
        });
    // A child that exited before `ps` saw it stays on record, so `restart` learns it stopped.
    record.child = Some(inspect(child_pid).unwrap_or(OwnedProcess {
        pid: child_pid,
        command: String::new(),
        start_time: String::new(),
        executable: String::new(),
    }));
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
/// Replaces this process with the program on disk, keeping pid, start time, and command
/// line. The registry record and the systemd unit therefore keep describing this process.
/// Returns only when the exec failed; the caller then keeps supervising with this program.
#[cfg(unix)]
fn exec_installed() {
    use std::os::unix::process::CommandExt;
    let mut arguments = std::env::args_os();
    let arg0 = arguments.next().unwrap_or_default();
    eprintln!("Suplex supervisor restarts from the installed program");
    let error = match crate::shared::fs::executable() {
        Ok(executable) => Command::new(executable)
            .arg0(arg0)
            .args(arguments)
            .env(RELAUNCH_VARIABLE, "1")
            .exec(),
        Err(error) => error,
    };
    eprintln!("Suplex supervisor could not restart from the installed program: {error}");
}
#[cfg(unix)]
struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    relaunch: tokio::signal::unix::Signal,
}
#[cfg(unix)]
impl Signals {
    fn install() -> io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            relaunch: signal(SignalKind::user_defined2())?,
        })
    }
}
#[cfg(not(unix))]
struct Signals;
#[cfg(not(unix))]
impl Signals {
    fn install() -> io::Result<Self> {
        Ok(Self)
    }
}
pub async fn run_foreground() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    require_non_root_host()?;
    let installation = Installation::load()?;
    // Installed before the registry says this supervisor handles SIGUSR2.
    let mut signals = Signals::install()?;
    register_foreground(&installation)?;
    let result = supervise(&installation, &mut signals).await;
    unregister_foreground(&installation);
    result
}
async fn supervise(
    installation: &Installation,
    signals: &mut Signals,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let executable = crate::shared::fs::executable()?;
    let started = inspect(std::process::id())
        .ok_or("Could not inspect supervisor")?
        .start_time;
    // A relaunched supervisor is the service's main process. It retries the program on disk
    // instead of exiting, so the updater can restore its rollback and signal again.
    let mut relaunched = std::env::var_os(RELAUNCH_VARIABLE).is_some();
    'supervise: loop {
        let mut command = tokio::process::Command::new(&executable);
        command
            .arg("serve")
            .env("SUPLEX_SUPERVISOR_PID", std::process::id().to_string())
            .env("SUPLEX_SUPERVISOR_START", &started)
            .env_remove(RELAUNCH_VARIABLE)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let failure: Box<dyn std::error::Error + Send + Sync> = 'attempt: {
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => break 'attempt error.into(),
            };
            register_child(
                installation,
                child.id().ok_or("Could not start Suplex API")?,
            )?;
            let ready_deadline = Instant::now() + Duration::from_secs(30);
            loop {
                #[cfg(unix)]
                tokio::select! {
                    _ = signals.interrupt.recv() => { stop_child(&mut child).await; return Ok(()); },
                    _ = signals.terminate.recv() => { stop_child(&mut child).await; return Ok(()); },
                    _ = signals.relaunch.recv() => { stop_child(&mut child).await; exec_installed(); relaunched = true; continue 'supervise; },
                    result = child.wait() => break 'attempt format!("Suplex API stopped before readiness ({})", result?).into(),
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                }
                #[cfg(not(unix))]
                tokio::time::sleep(Duration::from_millis(100)).await;
                if http_ready(&installation.bind_address, installation.port) {
                    break;
                }
                if Instant::now() >= ready_deadline {
                    let _ = child.kill().await;
                    break 'attempt "Suplex API did not report readiness".into();
                }
            }
            mark_ready(installation)?;
            relaunched = false;
            #[cfg(unix)]
            let reason = {
                tokio::select! {
                    _ = signals.interrupt.recv() => Some("SIGINT"),
                    _ = signals.terminate.recv() => Some("SIGTERM"),
                    _ = signals.relaunch.recv() => { stop_child(&mut child).await; exec_installed(); relaunched = true; continue 'supervise; },
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
            continue 'supervise;
        };
        if !relaunched {
            return Err(failure);
        }
        eprintln!("{failure}; Suplex supervisor retries the installed program in 5 seconds");
        #[cfg(unix)]
        tokio::select! {
            _ = signals.interrupt.recv() => return Ok(()),
            _ = signals.terminate.recv() => return Ok(()),
            _ = signals.relaunch.recv() => exec_installed(),
            _ = tokio::time::sleep(Duration::from_secs(5)) => {},
        }
        #[cfg(not(unix))]
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

pub fn start(installation: &Installation) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    require_non_root_host()?;
    if let Some(existing) = read(&registry_path(installation)).ok().flatten()
        && matches(&existing.process)
    {
        setup::configure_serve(installation)?;
        return Ok(existing.process.pid);
    }
    if let Some(existing) = discover(installation) {
        setup::configure_serve(installation)?;
        return Ok(existing.process.pid);
    }
    fs::create_dir_all(&installation.runtime)?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(installation.runtime.join("server.log"))?;
    let executable = crate::shared::fs::executable()?;
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
        if registered && http_ready(&installation.bind_address, installation.port) {
            return Ok(pid);
        }
        thread::sleep(Duration::from_millis(100));
    }
    stop(installation)?;
    Err("Suplex API did not become reachable within 30 seconds".into())
}

/// Restarts the host in place: the supervisor stops its API, replaces itself with the
/// program on disk, and keeps its pid, so a systemd unit sees no exit. Returns that pid once
/// the new API answers.
pub fn restart(
    installation: &Installation,
) -> Result<u32, Box<dyn std::error::Error + Send + Sync>> {
    let registry = running_supervisor(installation).ok_or("Suplex is not running")?;
    let pid = registry.process.pid;
    if registry.version < REGISTRY_VERSION {
        let service = runs_as_service(pid);
        stop(installation)?;
        if !service {
            return start(installation);
        }
        // The service manager starts the unit again; a host from `start` would fight it.
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if let Some(current) = running_supervisor(installation)
                && current.process.pid != pid
                && current.ready
                && http_ready(&installation.bind_address, installation.port)
            {
                return Ok(current.process.pid);
            }
            thread::sleep(Duration::from_millis(100));
        }
        return Err("Suplex API did not become reachable within 60 seconds of the restart".into());
    }
    let previous_child = registry.child.as_ref().map(|child| child.pid);
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        kill(Pid::from_raw(pid as i32), Signal::SIGUSR2)?;
    }
    #[cfg(not(unix))]
    return Err("Suplex cannot restart in place on this platform".into());
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if inspect(pid).is_none_or(|process| process.start_time != registry.process.start_time) {
            return Err(format!("Suplex supervisor {pid} stopped during the restart").into());
        }
        let current = read(&registry_path(installation))
            .ok()
            .flatten()
            .filter(|current| current.process.pid == pid && matches(&current.process));
        if let Some(current) = &current
            && let Some(child) = &current.child
            && Some(child.pid) != previous_child
        {
            if current.ready && http_ready(&installation.bind_address, installation.port) {
                return Ok(pid);
            }
            if !current.ready && inspect(child.pid).is_none() {
                return Err("The new Suplex API stopped before it was ready".into());
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Suplex API did not become reachable within 60 seconds of the restart".into())
}
/// A supervisor whose cgroup is a service unit, which its service manager starts again.
fn runs_as_service(pid: u32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/cgroup")).is_ok_and(|cgroup| service_cgroup(&cgroup))
}
fn service_cgroup(cgroup: &str) -> bool {
    cgroup.lines().any(|line| {
        line.rsplit(':')
            .next()
            .is_some_and(|path| path.ends_with(".service"))
    })
}

pub fn stop(
    installation: &Installation,
) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
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
        // Another owner's server still answers on this port; its route is not ours to remove.
        if !http_ready(&installation.bind_address, installation.port) {
            stop_serve(installation)?;
        }
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
    fn host_refuses_only_effective_root() {
        let error = refuse_root(0, "down").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("dedicated non-root user"));
        assert!(
            error
                .to_string()
                .contains("sudo -u suplex -i suplex down\n")
        );
        assert!(error.to_string().contains("README.md#linux-host"));
        assert!(refuse_root(1000, "down").is_ok());
    }

    #[test]
    fn serve_cleanup_removes_only_the_matching_root_handler() {
        assert_eq!(
            stop_serve_arguments(4222, "http://127.0.0.1:4222"),
            [
                "serve",
                "--https=4222",
                "--set-path=/",
                "http://127.0.0.1:4222",
                "off"
            ]
        );
    }
    #[test]
    fn readiness_requires_an_http_response_from_the_application() {
        for (status, expected) in [
            ("500 Broken", false),
            ("200 OK", true),
            ("303 See Other", true),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = io::BufReader::new(&mut stream);
                let mut request = String::new();
                while !request.ends_with("\r\n\r\n") {
                    assert!(reader.read_line(&mut request).unwrap() > 0);
                }
                assert!(request.starts_with("GET /auth HTTP/1.1\r\n"));
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").unwrap();
            });
            assert_eq!(
                http_ready(if expected { "0.0.0.0" } else { "127.0.0.1" }, port),
                expected
            );
            server.join().unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn stop_without_an_owned_server_keeps_the_route_of_a_server_still_answering() {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!("suplex-stop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let calls = directory.join("tailscale-calls");
        let tailscale = directory.join("tailscale");
        fs::write(
            &tailscale,
            format!("#!/bin/sh\necho \"$@\" >> {}\nexit 1\n", calls.display()),
        )
        .unwrap();
        fs::set_permissions(&tailscale, fs::Permissions::from_mode(0o755)).unwrap();
        // SAFETY: no other test in this binary reads or writes this variable.
        unsafe { std::env::set_var("SUPLEX_TAILSCALE_COMMAND", &tailscale) };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Not joined: a regression would never connect, and the test must fail, not hang.
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = io::BufReader::new(&mut stream);
            let mut request = String::new();
            while !request.ends_with("\r\n\r\n") {
                assert!(reader.read_line(&mut request).unwrap() > 0);
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap();
        });
        let installation = Installation {
            root: directory.clone(),
            data: directory.clone(),
            database: directory.join("suplex.sqlite"),
            artifacts: directory.join("artifacts"),
            logs: directory.join("logs"),
            runtime: directory.join("runtime"),
            repositories: directory.join("repos"),
            worktrees: directory.join("worktrees"),
            configuration: directory.join("suplex.env"),
            port,
            bind_address: "127.0.0.1".into(),
            reachable_address: String::new(),
            access_mode: "tailscale".into(),
            tailscale_exposure: "serve".into(),
            installation_id: "test".into(),
            development_auto_login: false,
            billing_service_url: None,
            account_service_url: None,
        };
        assert_eq!(stop(&installation).unwrap()["stopped"], 0);
        assert!(!calls.exists(), "stop touched Tailscale Serve");
        let _ = fs::remove_dir_all(directory);
    }
    #[test]
    fn a_service_unit_cgroup_names_a_service_managed_supervisor() {
        assert!(service_cgroup("0::/system.slice/suplex.service\n"));
        assert!(service_cgroup(
            "12:pids:/system.slice/suplex.service\n1:name=systemd:/system.slice/suplex.service\n"
        ));
        assert!(!service_cgroup(
            "0::/user.slice/user-1000.slice/session-3.scope\n"
        ));
        assert!(!service_cgroup(""));
    }
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
