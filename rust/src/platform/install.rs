use super::{
    config::Installation,
    database::{OpenMode, SchemaState, SuplexDatabase},
    setup,
};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const STAGES: [(&str, &str); 5] = [
    ("prerequisites", "Check this Mac"),
    ("developer-tools", "Set up Git"),
    ("herdr", "Install Herdr terminals"),
    ("data", "Prepare Suplex data"),
    ("complete", "Finish"),
];
fn success(reason: impl Into<String>, skipped: bool) -> Value {
    json!({"ok":true,"reason":reason.into(),"skipped":skipped})
}
fn failure(reason: impl Into<String>, remedy: impl Into<String>) -> Value {
    json!({"ok":false,"reason":reason.into(),"remedy":remedy.into(),"skipped":false})
}
fn command(name: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new(name).args(args).output()
}
// statvfs block counts are u32 on macOS and u64 on Linux.
#[allow(clippy::unnecessary_cast)]
fn free_bytes(path: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let mut current = path.to_path_buf();
    loop {
        if let Ok(name) = std::ffi::CString::new(current.as_os_str().as_bytes()) {
            let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
            if unsafe { libc::statvfs(name.as_ptr(), stat.as_mut_ptr()) } == 0 {
                let stat = unsafe { stat.assume_init() };
                return (stat.f_bavail as u64).saturating_mul(stat.f_frsize);
            }
        }
        if !current.pop() {
            return 0;
        }
    }
}
fn prerequisites() -> Value {
    if env::consts::OS != "macos" {
        return failure(
            format!(
                "Suplex runs on macOS and this computer reports {}.",
                env::consts::OS
            ),
            "Install Suplex on a Mac.",
        );
    }
    let release = command("uname", &["-r"])
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default();
    let major = release
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    if major < 22 {
        return failure(
            format!("Suplex needs macOS 13 or newer and this Mac reports Darwin {release}."),
            "Update macOS in System Settings, then try again.",
        );
    }
    let arch = env::consts::ARCH;
    if !matches!(arch, "aarch64" | "x86_64") {
        return failure(
            format!("Suplex needs an Apple silicon or Intel Mac and this Mac reports {arch}."),
            "Run Suplex on an Apple silicon or Intel Mac.",
        );
    }
    let path = env::var("SUPLEX_DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".suplex/data"));
    let free = free_bytes(&path);
    if free < 2 * 1024 * 1024 * 1024 {
        return failure(
            format!(
                "Suplex needs 2 GB of free space and this disk has {:.1} GB.",
                free as f64 / 1024_f64.powi(3)
            ),
            "Free up disk space, then try again.",
        );
    }
    success(
        format!(
            "macOS {release} on {arch} with {:.1} GB free",
            free as f64 / 1024_f64.powi(3)
        ),
        false,
    )
}
async fn developer_tools() -> Value {
    let git = command("git", &["--version"]);
    if let Ok(git) = &git
        && git.status.success()
    {
        return success(
            format!(
                "{} already installed",
                String::from_utf8_lossy(&git.stdout).trim()
            ),
            true,
        );
    }
    if let Ok(git) = &git
        && !git.status.success()
    {
        eprintln!(
            "git --version failed: {}",
            if git.stderr.is_empty() {
                format!("exit {:?}", git.status.code())
            } else {
                String::from_utf8_lossy(&git.stderr).trim().to_owned()
            }
        );
    }
    let license = git.as_ref().is_ok_and(|output| {
        String::from_utf8_lossy(&output.stdout).contains("agreed to the Xcode")
            || String::from_utf8_lossy(&output.stderr).contains("agreed to the Xcode")
    });
    if license {
        eprintln!("Accepting the Xcode license; macOS asks for an administrator password");
        let accepted = command(
            "osascript",
            &[
                "-e",
                "do shell script \"xcodebuild -license accept\" with administrator privileges",
            ],
        );
        let retry = accepted
            .as_ref()
            .is_ok_and(|output| output.status.success())
            .then(|| command("git", &["--version"]));
        if let Some(Ok(retry)) = &retry
            && retry.status.success()
        {
            return success(
                format!(
                    "{} after accepting the Xcode license",
                    String::from_utf8_lossy(&retry.stdout).trim()
                ),
                false,
            );
        }
        let reason = accepted
            .as_ref()
            .ok()
            .and_then(|output| {
                (!output.stderr.is_empty())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_owned())
            })
            .or_else(|| {
                retry
                    .as_ref()
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|output| {
                        (!output.stderr.is_empty())
                            .then(|| String::from_utf8_lossy(&output.stderr).trim().to_owned())
                    })
            })
            .unwrap_or_else(|| "the password dialog was cancelled".into());
        return failure(
            format!("git needs the Xcode license accepted: {reason}"),
            "Open Terminal, run: sudo xcodebuild -license accept, then try again.",
        );
    }
    eprintln!("Asking macOS to install the Apple developer tools");
    let request = command("xcode-select", &["--install"]);
    if let Ok(request) = &request
        && !request.status.success()
    {
        eprintln!("{}", String::from_utf8_lossy(&request.stderr).trim());
    }
    if request.as_ref().is_ok_and(|output| {
        String::from_utf8_lossy(&output.stdout).contains("already installed")
            || String::from_utf8_lossy(&output.stderr).contains("already installed")
    }) {
        let reason = git
            .as_ref()
            .ok()
            .and_then(|output| {
                (!output.stderr.is_empty())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_owned())
            })
            .unwrap_or_else(|| "git did not work".into());
        return failure(
            format!(
                "macOS says the developer tools are installed, but git does not work: {reason}"
            ),
            "Open Terminal and run: sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install, finish the dialog, then try again.",
        );
    }
    for minute in 0..360 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Ok(git) = command("git", &["--version"])
            && git.status.success()
        {
            return success(String::from_utf8_lossy(&git.stdout).trim(), false);
        }
        if minute % 12 == 0 {
            eprintln!(
                "Waiting for the Apple developer tools ({} min)",
                minute / 12 + 1
            );
        }
    }
    failure(
        "The Apple developer tools did not finish installing within 30 minutes.",
        "Finish the macOS developer tools dialog, then try again.",
    )
}
async fn herdr() -> Value {
    let installed = command("herdr", &["--version"]).is_ok_and(|output| output.status.success());
    if !installed {
        let script =
            env::temp_dir().join(format!("suplex-herdr-install-{}.sh", uuid::Uuid::new_v4()));
        eprintln!("Downloading the Herdr installer");
        let downloaded = command(
            "curl",
            &[
                "-fsSL",
                "-o",
                &script.to_string_lossy(),
                "https://herdr.dev/install.sh",
            ],
        );
        if !downloaded
            .as_ref()
            .is_ok_and(|output| output.status.success())
        {
            return failure(
                format!(
                    "curl exited {}",
                    downloaded
                        .as_ref()
                        .ok()
                        .and_then(|output| output.status.code())
                        .map_or_else(|| "unknown".to_owned(), |code| code.to_string())
                ),
                "Check the network connection and try again.",
            );
        }
        eprintln!("Installing Herdr");
        let installed = command("sh", &[&script.to_string_lossy()]);
        let _ = fs::remove_file(&script);
        if !installed
            .as_ref()
            .is_ok_and(|output| output.status.success())
        {
            return failure(
                installed
                    .as_ref()
                    .ok()
                    .and_then(|output| {
                        String::from_utf8_lossy(&output.stderr)
                            .lines()
                            .last()
                            .map(str::to_owned)
                    })
                    .filter(|line| !line.is_empty())
                    .unwrap_or_else(|| {
                        format!(
                            "The Herdr installer exited {}",
                            installed
                                .as_ref()
                                .ok()
                                .and_then(|output| output.status.code())
                                .map_or_else(|| "unknown".to_owned(), |code| code.to_string())
                        )
                    }),
                "Check the network connection and try again.",
            );
        }
        if !command("herdr", &["--version"]).is_ok_and(|output| output.status.success()) {
            return failure(
                "Herdr installed but is not on the PATH.",
                "Add ~/.local/bin to PATH, then try again.",
            );
        }
    }
    let running =
        command("herdr", &["workspace", "list"]).is_ok_and(|output| output.status.success());
    if !running {
        let status = command("herdr", &["status", "server", "--json"]);
        let server = status
            .as_ref()
            .ok()
            .and_then(|output| serde_json::from_slice::<Value>(&output.stdout).ok());
        let stale = server.as_ref().is_some_and(|status| {
            status["running"] == true
                && (status["restart_needed"] == true || status["compatible"] == false)
        });
        if stale {
            eprintln!(
                "Stopping the old Herdr server ({}) so the new one can start",
                server
                    .as_ref()
                    .and_then(|status| status["version"].as_str())
                    .unwrap_or("unknown version")
            );
            let stopped = command("herdr", &["server", "stop"]);
            if !stopped.as_ref().is_ok_and(|output| output.status.success()) {
                eprintln!(
                    "herdr server stop exited {}",
                    stopped
                        .as_ref()
                        .ok()
                        .and_then(|output| output.status.code())
                        .map_or_else(|| "unknown".to_owned(), |code| code.to_string())
                );
            }
        }
        eprintln!("Starting the Herdr server");
        let mut server_command = Command::new("herdr");
        server_command
            .arg("server")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                server_command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
        }
        let _ = server_command.spawn();
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if command("herdr", &["workspace", "list"]).is_ok_and(|output| output.status.success())
            {
                return success("Herdr server is ready", false);
            }
        }
        return failure(
            "Herdr server did not become ready.",
            "Open Terminal, run herdr, then try again.",
        );
    }
    success("Herdr server is ready", installed)
}
fn data() -> Value {
    let path = match setup::environment_path() {
        Ok(path) => path,
        Err(error) => return failure(error.to_string(), "Check the Suplex configuration path."),
    };
    let old = fs::read_to_string(&path).unwrap_or_default();
    let port = env::var("SUPLEX_PORT")
        .ok()
        .or_else(|| {
            old.lines().find_map(|line| {
                line.split_once('=')
                    .filter(|(key, _)| key.trim() == "SUPLEX_PORT")
                    .map(|(_, value)| value.trim().trim_matches(['\'', '"']).to_owned())
            })
        })
        .unwrap_or_else(|| "4111".into());
    if let Err(error) = setup::upsert_environment(
        &path,
        &[
            ("SUPLEX_ACCESS_MODE", "local"),
            ("SUPLEX_BIND_ADDRESS", "127.0.0.1"),
            ("SUPLEX_PORT", &port),
        ],
    ) {
        return failure(error.to_string(), "Check the Suplex configuration path.");
    }
    let installation = match Installation::load() {
        Ok(value) => value,
        Err(error) => {
            return failure(
                error.to_string(),
                "Fix the Suplex configuration and try again.",
            );
        }
    };
    let existed = installation.database.exists();
    match SuplexDatabase::open(&installation.database, OpenMode::Migrate) {
        Ok(database) => match database.schema_status() {
            Ok(status) if status.state == SchemaState::Current => success(
                format!(
                    "schema current ({}/{} migrations)",
                    status.applied.len(),
                    status.expected.len()
                ),
                existed && fs::read_to_string(path).unwrap_or_default() == old,
            ),
            Ok(status) => failure(
                format!(
                    "schema {:?} ({}/{} migrations)",
                    status.state,
                    status.applied.len(),
                    status.expected.len()
                ),
                "Move the Suplex data folder aside and run the install again.",
            ),
            Err(error) => failure(
                error.to_string(),
                "Check the Suplex data folder and try again.",
            ),
        },
        Err(error) => failure(
            error.to_string(),
            "Check the Suplex data folder and try again.",
        ),
    }
}
async fn complete() -> Value {
    let installation = match Installation::load() {
        Ok(value) => value,
        Err(error) => {
            return failure(
                error.to_string(),
                "Fix the Suplex configuration and try again.",
            );
        }
    };
    let database = match SuplexDatabase::open(&installation.database, OpenMode::Migrate) {
        Ok(value) => value,
        Err(error) => {
            return failure(
                error.to_string(),
                "Check the Suplex data folder and try again.",
            );
        }
    };
    let state = crate::http::AppState::new(
        database,
        crate::http::session::SessionConfig {
            port: installation.port,
            reachable_address: installation.reachable_address.clone(),
            tailscale_exposure: installation.tailscale_exposure.clone(),
        },
    )
    .with_project_roots(
        installation.repositories.clone(),
        installation.worktrees.clone(),
    )
    .with_artifact_root(installation.artifacts.clone());
    match crate::cli::run_doctor(&state).await {
        Ok(checks) => match checks.iter().find(|check| check.status == "FAIL") {
            Some(check) => failure(
                format!("{}: {}", check.name, check.detail),
                "Fix the failing check and run the install again.",
            ),
            None => success(format!("{} checks passed", checks.len()), false),
        },
        Err(error) => failure(
            error.to_string(),
            "Fix the failing check and run the install again.",
        ),
    }
}
pub async fn run(args: &[String]) -> i32 {
    if args.iter().any(|arg| arg == "--manifest") {
        println!(
            "{}",
            json!({"protocolVersion":1,"stages":STAGES.iter().map(|(name,title)|json!({"name":name,"title":title})).collect::<Vec<_>>()})
        );
        return 0;
    }
    let Some(name) = args
        .iter()
        .position(|arg| arg == "--stage")
        .and_then(|index| args.get(index + 1))
    else {
        eprintln!("Usage: suplex install --manifest | suplex install --stage <name> --json");
        return 1;
    };
    let outcome = match name.as_str() {
        "prerequisites" => prerequisites(),
        "developer-tools" => developer_tools().await,
        "herdr" => herdr().await,
        "data" => data(),
        "complete" => complete().await,
        _ => failure(
            format!("Unknown install stage: {name}"),
            "Check the install manifest.",
        ),
    };
    let mut response = outcome.as_object().cloned().unwrap_or_default();
    response.insert("stage".into(), json!(name));
    println!("{}", Value::Object(response.clone()));
    if response.get("ok") == Some(&json!(true)) {
        0
    } else {
        1
    }
}
