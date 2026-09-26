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
    ("developer-tools", "Install Apple developer tools (git)"),
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
fn free_bytes(path: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let mut current = path.to_path_buf();
    loop {
        if let Ok(name) = std::ffi::CString::new(current.as_os_str().as_bytes()) {
            let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
            if unsafe { libc::statvfs(name.as_ptr(), stat.as_mut_ptr()) } == 0 {
                let stat = unsafe { stat.assume_init() };
                return (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64);
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
    let tools = command("xcode-select", &["-p"]);
    if let (Ok(git), Ok(tools)) = (&git, &tools)
        && git.status.success()
        && tools.status.success()
    {
        return success(String::from_utf8_lossy(&git.stdout).trim(), true);
    }
    eprintln!("Asking macOS to install the Apple developer tools");
    let _ = command("xcode-select", &["--install"]);
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
        if !downloaded.is_ok_and(|output| output.status.success()) {
            return failure(
                "Herdr download failed.",
                "Check the network connection and try again.",
            );
        }
        eprintln!("Installing Herdr");
        let installed = command("sh", &[&script.to_string_lossy()]);
        let _ = fs::remove_file(&script);
        if !installed.is_ok_and(|output| output.status.success()) {
            return failure(
                "Herdr installer failed.",
                "Check the network connection and try again.",
            );
        }
    }
    let running =
        command("herdr", &["workspace", "list"]).is_ok_and(|output| output.status.success());
    if !running {
        eprintln!("Starting the Herdr server");
        let _ = Command::new("herdr")
            .arg("server")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
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
