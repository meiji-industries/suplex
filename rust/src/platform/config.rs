use std::{
    collections::HashMap,
    env, fs,
    net::IpAddr,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Installation {
    pub root: PathBuf,
    pub data: PathBuf,
    pub database: PathBuf,
    pub artifacts: PathBuf,
    pub logs: PathBuf,
    pub runtime: PathBuf,
    pub repositories: PathBuf,
    pub worktrees: PathBuf,
    pub configuration: PathBuf,
    pub port: u16,
    pub bind_address: String,
    pub reachable_address: String,
    pub access_mode: String,
    pub tailscale_exposure: String,
    pub installation_id: String,
    pub development_auto_login: bool,
    pub billing_service_url: Option<url::Url>,
}

impl Installation {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let current = env::current_dir()?;
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("HOME is required for default repository paths")?;
        let explicit = env::var_os("SUPLEX_ENV_FILE").map(PathBuf::from);
        let (configuration, desktop_root) =
            locate_configuration(&current, &home, explicit.as_deref());
        let file = read_environment(&configuration);
        let value = |key: &str| env::var(key).ok().or_else(|| file.get(key).cloned());
        if explicit.is_none()
            && !configuration.exists()
            && value("SUPLEX_ROOT").is_none()
            && value("SUPLEX_ACCESS_MODE").is_none()
        {
            return Err(format!(
                "No Suplex installation found. Looked for {} and {}. Run 'suplex setup' or open Suplex.app.",
                configuration.display(),
                desktop_configuration(&home).display()
            )
            .into());
        }
        for key in [
            "SUPLEX_TAILSCALE_ADDRESS",
            "SUPLEX_BIND_ADDRESS",
            "SUPLEX_DATA_ROOT",
            "SUPLEX_DATABASE_PATH",
            "SUPLEX_ARTIFACT_ROOT",
            "SUPLEX_RUNTIME_ROOT",
            "SUPLEX_REPOSITORY_ROOT",
            "SUPLEX_WORKTREE_ROOT",
        ] {
            if value(key).as_deref() == Some("") {
                return Err(format!("{key} must not be empty").into());
            }
        }
        let experimental = value("SUPLEX_ROOT").map(|root| absolute(&current, Path::new(&root)));
        let default_root = experimental
            .clone()
            .or(desktop_root)
            .unwrap_or_else(|| current.join(".suplex"));
        let data = value("SUPLEX_DATA_ROOT")
            .map(|path| absolute(&current, Path::new(&path)))
            .unwrap_or_else(|| default_root.join("data"));
        let root = data.parent().unwrap_or(&default_root).to_path_buf();
        let default_port = if experimental.is_some() {
            value("CONDUCTOR_PORT")
                .and_then(|port| port.parse::<u16>().ok())
                .unwrap_or(14111)
                .to_string()
        } else {
            "4111".into()
        };
        let configured_port = value("SUPLEX_PORT");
        let port = parse_port(&configured_port.unwrap_or(default_port))?;
        let access_mode = value("SUPLEX_ACCESS_MODE").unwrap_or_else(|| {
            if experimental.is_some() {
                "local"
            } else {
                "tailscale"
            }
            .into()
        });
        if !matches!(access_mode.as_str(), "local" | "tailscale" | "all") {
            return Err("SUPLEX_ACCESS_MODE must be local, tailscale, or all".into());
        }
        let tailscale_exposure = if access_mode != "tailscale" {
            "direct".to_owned()
        } else {
            value("SUPLEX_TAILSCALE_EXPOSURE").unwrap_or_else(|| "direct".into())
        };
        if !matches!(tailscale_exposure.as_str(), "direct" | "serve") {
            return Err("SUPLEX_TAILSCALE_EXPOSURE must be direct or serve".into());
        }
        let tailscale_address = value("SUPLEX_TAILSCALE_ADDRESS")
            .unwrap_or_default()
            .trim()
            .to_owned();
        let bind_address = value("SUPLEX_BIND_ADDRESS")
            .unwrap_or_else(|| match access_mode.as_str() {
                "local" => "127.0.0.1".into(),
                "all" => "0.0.0.0".into(),
                _ => tailscale_address.clone(),
            })
            .trim()
            .to_owned();
        let (host, scheme) = if access_mode == "local" {
            if !matches!(bind_address.as_str(), "127.0.0.1" | "::1") {
                return Err(
                    format!("Local access binds loopback only; received {bind_address}").into(),
                );
            }
            (bind_address.clone(), "http")
        } else if access_mode == "all" {
            if bind_address != "0.0.0.0" {
                return Err(format!(
                    "All-network access requires 0.0.0.0; received {bind_address}"
                )
                .into());
            }
            (bind_address.clone(), "http")
        } else {
            if tailscale_exposure == "serve" && tailscale_address.is_empty() {
                return Err(
                    "SUPLEX_TAILSCALE_ADDRESS is required when Tailscale Serve HTTPS is enabled"
                        .into(),
                );
            }
            if bind_address.is_empty() {
                return Err(
                    "SUPLEX_TAILSCALE_ADDRESS is required for Tailscale-only startup".into(),
                );
            }
            if !(is_tailscale_address(&bind_address)
                || tailscale_exposure == "serve"
                    && matches!(bind_address.as_str(), "127.0.0.1" | "::1"))
            {
                return Err(format!("Refusing non-Tailscale bind address: {bind_address}").into());
            }
            if !tailscale_address.is_empty() && !is_tailscale_address(&tailscale_address) {
                return Err(format!(
                    "Refusing non-Tailscale reachable address: {tailscale_address}"
                )
                .into());
            }
            (
                if tailscale_address.is_empty() {
                    bind_address.clone()
                } else {
                    tailscale_address
                },
                if tailscale_exposure == "serve" {
                    "https"
                } else {
                    "http"
                },
            )
        };
        let reachable_address = format!(
            "{scheme}://{}:{port}",
            if host.contains(':') {
                format!("[{host}]")
            } else {
                host
            }
        );
        let development_auto_login = match value("SUPLEX_DEVELOPMENT_AUTO_LOGIN").as_deref() {
            Some("1") => true,
            None => experimental.is_some(),
            Some(_) => return Err("SUPLEX_DEVELOPMENT_AUTO_LOGIN must be 1".into()),
        };
        if development_auto_login && !matches!(bind_address.as_str(), "127.0.0.1" | "::1") {
            return Err("Development auto-login requires a loopback bind address".into());
        }
        let installation_id = match value("SUPLEX_INSTALLATION_ID") {
            Some(id) if valid_installation_id(&id) => id,
            Some(_) => return Err("SUPLEX_INSTALLATION_ID is invalid".into()),
            None => persistent_installation_id(&data)?,
        };
        let billing_service_url =
            billing_service_url(value("SUPLEX_BILLING_SERVICE_URL"), experimental.is_some())?;
        let path = |key: &str, default: PathBuf| {
            value(key)
                .map(|path| absolute(&current, Path::new(&path)))
                .unwrap_or(default)
        };
        Ok(Self {
            database: path("SUPLEX_DATABASE_PATH", data.join("suplex.sqlite")),
            artifacts: path("SUPLEX_ARTIFACT_ROOT", data.join("artifacts")),
            runtime: path("SUPLEX_RUNTIME_ROOT", data.join("runtime")),
            logs: root.join("logs"),
            repositories: path(
                "SUPLEX_REPOSITORY_ROOT",
                if experimental.is_some() {
                    root.join("repositories")
                } else {
                    home.join("suplex/repos")
                },
            ),
            worktrees: path(
                "SUPLEX_WORKTREE_ROOT",
                if experimental.is_some() {
                    root.join("worktrees")
                } else {
                    home.join("suplex/worktrees")
                },
            ),
            development_auto_login,
            billing_service_url,
            root,
            data,
            configuration,
            port,
            bind_address,
            reachable_address,
            access_mode,
            tailscale_exposure,
            installation_id,
        })
    }
}
/// The configuration file and, for the Suplex.app installation, its root.
/// An explicit `SUPLEX_ENV_FILE` wins. Otherwise a `.suplex` in the current
/// directory wins over the Suplex.app installation.
fn locate_configuration(
    current: &Path,
    home: &Path,
    explicit: Option<&Path>,
) -> (PathBuf, Option<PathBuf>) {
    if let Some(explicit) = explicit {
        return (absolute(current, explicit), None);
    }
    let local = current.join(".suplex/suplex.env");
    let desktop = desktop_configuration(home);
    if !local.exists() && desktop.exists() {
        let root = desktop.parent().map(Path::to_path_buf);
        return (desktop, root);
    }
    (local, None)
}

/// Installations use the production billing service unless configured. An
/// empty value turns billing off. Development roots never default to
/// production, so development data does not register production accounts.
fn billing_service_url(
    configured: Option<String>,
    development: bool,
) -> Result<Option<url::Url>, String> {
    match configured {
        Some(url) if url.is_empty() => Ok(None),
        Some(url) => crate::billing::parse_service_url(&url).map(Some),
        None if development => Ok(None),
        None => crate::billing::parse_service_url(crate::billing::PRODUCTION_SERVICE_URL).map(Some),
    }
}

fn desktop_configuration(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Suplex/suplex.env")
}

fn valid_installation_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn absolute(current: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        current.join(path)
    }
}
fn parse_port(value: &str) -> Result<u16, Box<dyn std::error::Error>> {
    let port = value.parse::<u16>()?;
    if port == 0 {
        return Err("SUPLEX_PORT must be between 1 and 65535".into());
    }
    Ok(port)
}
fn read_environment(path: &Path) -> HashMap<String, String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once('=')?;
            let key = key.trim();
            if key.is_empty()
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            {
                return None;
            }
            Some((
                key.to_owned(),
                value.trim().trim_matches(['\'', '"']).to_owned(),
            ))
        })
        .collect()
}
pub fn is_tailscale_address(address: &str) -> bool {
    let normalized = address.trim().to_ascii_lowercase();
    match normalized.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let octets = ip.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }
        Ok(IpAddr::V6(ip)) => ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
        Err(_) => {
            normalized.ends_with(".ts.net")
                && !normalized.contains(['/', ' ', ':'])
                && normalized.len() > ".ts.net".len()
        }
    }
}
fn persistent_installation_id(data: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let path = data
        .parent()
        .ok_or("Data root has no parent")?
        .join("installation-id");
    if let Ok(existing) = fs::read_to_string(&path)
        && !existing.trim().is_empty()
    {
        return Ok(existing.trim().to_owned());
    }
    fs::create_dir_all(path.parent().ok_or("Installation identity has no parent")?)?;
    let id = uuid::Uuid::new_v4().simple().to_string()[..24].to_owned();
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            writeln!(file, "{id}")?;
            Ok(id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(fs::read_to_string(path)?.trim().to_owned())
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_prefers_explicit_then_local_then_desktop() {
        let base = std::env::temp_dir().join(format!("suplex-config-{}", uuid::Uuid::new_v4()));
        let (current, home) = (base.join("project"), base.join("home"));
        let desktop = home.join("Library/Application Support/Suplex");
        fs::create_dir_all(&current).unwrap();
        let local = current.join(".suplex/suplex.env");
        assert_eq!(
            locate_configuration(&current, &home, None),
            (local.clone(), None)
        );
        fs::create_dir_all(&desktop).unwrap();
        fs::write(desktop.join("suplex.env"), "").unwrap();
        assert_eq!(
            locate_configuration(&current, &home, None),
            (desktop.join("suplex.env"), Some(desktop.clone()))
        );
        fs::create_dir_all(local.parent().unwrap()).unwrap();
        fs::write(&local, "").unwrap();
        assert_eq!(locate_configuration(&current, &home, None), (local, None));
        assert_eq!(
            locate_configuration(&current, &home, Some(Path::new("custom.env"))),
            (current.join("custom.env"), None)
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn tailscale_binding_rejects_public_addresses() {
        assert!(is_tailscale_address("100.64.0.1"));
        assert!(is_tailscale_address("fd7a:115c:a1e0::1"));
        assert!(is_tailscale_address("host.tailnet.ts.net"));
        assert!(!is_tailscale_address("0.0.0.0"));
        assert!(!is_tailscale_address("192.168.1.2"));
        assert!(!is_tailscale_address("fd00::1"));
    }
    #[test]
    fn billing_defaults_to_production_except_in_development() {
        let url = |configured: Option<&str>, development| {
            billing_service_url(configured.map(str::to_owned), development)
                .unwrap()
                .map(|url| url.to_string())
        };
        assert_eq!(
            url(None, false).as_deref(),
            Some("https://billing.suplex.sh/")
        );
        assert_eq!(url(None, true), None);
        assert_eq!(url(Some(""), false), None);
        assert_eq!(
            url(Some("http://127.0.0.1:4211"), true).as_deref(),
            Some("http://127.0.0.1:4211/")
        );
        assert!(billing_service_url(Some("http://billing.example.test".into()), false).is_err());
    }
    #[test]
    fn rejects_invalid_port() {
        assert!(parse_port("0").is_err());
        assert!(parse_port("65536").is_err());
    }
}
