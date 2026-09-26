use super::config::{Installation, is_tailscale_address};
use super::database::{OpenMode, SuplexDatabase};
use serde_json::Value;
use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
};

pub fn environment_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = env::var("SUPLEX_ENV_FILE").unwrap_or_else(|_| ".suplex/suplex.env".into());
    Ok(env::current_dir()?.join(path))
}

pub fn upsert_environment(path: &Path, values: &[(&str, &str)]) -> io::Result<()> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    let mut written = std::collections::HashSet::new();
    let mut lines = Vec::new();
    for line in existing.lines() {
        let key = line.split_once('=').map(|(key, _)| key.trim());
        if let Some((name, value)) = values.iter().find(|(name, _)| Some(*name) == key) {
            lines.push(format!("{name}={value}"));
            written.insert(*name);
        } else {
            lines.push(line.to_owned());
        }
    }
    for (name, value) in values {
        if !written.contains(name) {
            lines.push(format!("{name}={value}"));
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let staged = path.with_extension("env.staging");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staged)?;
    writeln!(file, "{}", lines.join("\n"))?;
    fs::rename(staged, path)?;
    Ok(())
}

fn ask(question: &str, fallback: &str) -> io::Result<String> {
    print!("{question} [{fallback}] ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    let answer = answer.trim();
    Ok(if answer.is_empty() {
        fallback.to_owned()
    } else {
        answer.to_owned()
    })
}

pub fn tailscale(command: &str, args: &[&str]) -> io::Result<std::process::Output> {
    Command::new(command).args(args).output()
}
pub fn tailscale_hostname(raw: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(raw).ok()?["Self"]["DNSName"]
        .as_str()
        .map(|host| host.trim_end_matches('.').to_owned())
        .filter(|host| host.ends_with(".ts.net"))
}
pub fn serve_route_matches(installation: &Installation, raw: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(raw) else {
        return false;
    };
    let host = installation
        .reachable_address
        .split("//")
        .nth(1)
        .unwrap_or_default();
    let route = host.to_owned();
    value["Web"][route]["Handlers"]["/"]["Proxy"].as_str()
        == Some(serve_proxy(installation).as_str())
}
pub fn serve_proxy(installation: &Installation) -> String {
    let host = if installation.bind_address.contains(':') {
        format!("[{}]", installation.bind_address)
    } else {
        installation.bind_address.clone()
    };
    format!("http://{host}:{}", installation.port)
}

pub fn configure_serve(installation: &Installation) -> Result<(), Box<dyn std::error::Error>> {
    if installation.access_mode != "tailscale" || installation.tailscale_exposure != "serve" {
        return Ok(());
    }
    let command = env::var("SUPLEX_TAILSCALE_COMMAND").unwrap_or_else(|_| "tailscale".into());
    let port = format!("--https={}", installation.port);
    let proxy = serve_proxy(installation);
    let output = tailscale(&command, &["serve", "--bg", &port, &proxy])?;
    if !output.status.success() {
        return Err(format!(
            "Tailscale Serve failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let status = tailscale(&command, &["serve", "status", "--json"])?;
    if !status.status.success() || !serve_route_matches(installation, &status.stdout) {
        return Err("Tailscale Serve route does not point to Suplex".into());
    }
    Ok(())
}

pub fn run(local: bool) -> Result<(), Box<dyn std::error::Error>> {
    let file = environment_path()?;
    let port = env::var("SUPLEX_PORT").unwrap_or_else(|_| "4111".into());
    let _ = port.parse::<std::num::NonZeroU16>()?;
    if local {
        upsert_environment(
            &file,
            &[
                ("SUPLEX_ACCESS_MODE", "local"),
                ("SUPLEX_BIND_ADDRESS", "127.0.0.1"),
                ("SUPLEX_PORT", &port),
            ],
        )?;
        let installation = Installation::load()?;
        println!(
            "Saved local Suplex configuration to {}\nStart Suplex with: suplex start\nOpen: {}/health",
            file.display(),
            installation.reachable_address
        );
        return Ok(());
    }
    let command = env::var("SUPLEX_TAILSCALE_COMMAND").unwrap_or_else(|_| "tailscale".into());
    let discovered = tailscale(&command, &["status", "--json"])
        .ok()
        .and_then(|output| tailscale_hostname(&output.stdout));
    let hostname = match discovered {
        Some(host) => host,
        None => ask(
            "MagicDNS hostname",
            &env::var("SUPLEX_TAILSCALE_ADDRESS")
                .unwrap_or_else(|_| "machine.tailnet.ts.net".into()),
        )?,
    };
    if !is_tailscale_address(&hostname) {
        return Err("Tailscale did not report a valid MagicDNS hostname".into());
    }
    println!(
        "\nSuplex exposure mode:\n  1) Tailscale Serve HTTPS (recommended for an HTTPS-enforcing tailnet)\n  2) Direct Tailscale HTTP (only when the endpoint does not terminate HTTPS)"
    );
    let mode = loop {
        let answer = ask("Choose 1 or 2", "1")?;
        if matches!(answer.as_str(), "1" | "2") {
            break answer;
        }
        println!("Choose one of: 1, 2");
    };
    let exposure = if mode == "1" { "serve" } else { "direct" };
    let port = ask("Suplex port", &port)?;
    let _ = port.parse::<std::num::NonZeroU16>()?;
    let bind = if exposure == "serve" {
        "127.0.0.1"
    } else {
        &hostname
    };
    upsert_environment(
        &file,
        &[
            ("SUPLEX_ACCESS_MODE", "tailscale"),
            ("SUPLEX_TAILSCALE_EXPOSURE", exposure),
            ("SUPLEX_TAILSCALE_ADDRESS", &hostname),
            ("SUPLEX_PORT", &port),
            ("SUPLEX_BIND_ADDRESS", bind),
        ],
    )?;
    let installation = Installation::load()?;
    println!(
        "Saved idempotent Suplex configuration to {}",
        file.display()
    );
    let mut database = SuplexDatabase::open(&installation.database, OpenMode::Migrate)?;
    if let Some(token) = crate::identity::auth::issue_administrator_invitation(
        &mut database,
        "bootstrap",
        "{}",
        chrono::Utc::now(),
    )? {
        println!(
            "Bootstrap enrollment (showing once): {}/auth?invite={token}",
            installation.reachable_address
        );
    } else {
        println!(
            "Bootstrap administrator is already enrolled. Use `suplex recover` for explicit recovery."
        );
    }
    if exposure == "serve" {
        configure_serve(&installation)?;
    }
    println!(
        "Start Suplex with: suplex start\nOpen: {}/health",
        installation.reachable_address
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_updates_preserve_unrelated_settings_and_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("suplex-setup-{}", uuid::Uuid::new_v4()));
        let path = root.join("suplex.env");
        upsert_environment(&path, &[("SUPLEX_PORT", "4111"), ("UNRELATED", "keep")]).unwrap();
        upsert_environment(
            &path,
            &[("SUPLEX_PORT", "4222"), ("SUPLEX_ACCESS_MODE", "local")],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "SUPLEX_PORT=4222\nUNRELATED=keep\nSUPLEX_ACCESS_MODE=local\n"
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }
}
