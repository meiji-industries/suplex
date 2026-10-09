//! suplex-bootstrap: run Suplex on a cloud VM. The interactive `bootstrap` asks the essentials (and
//! remembers them in vm.env / .env), creates or converges the server over SSH, and ends with an
//! owner login link. What runs on the VM is plain bash under `vm/`, embedded here.

mod cloudflare;
mod provider;
mod remote;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use cliclack::{confirm, input, intro, log, note, outro, password, select, spinner};
use console::style;
use provider::Provider;
use remote::{Host, Probe, as_suplex, quote};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

#[derive(Parser)]
#[command(name = "suplex-bootstrap", version, about = "Run Suplex on a cloud VM")]
struct Cli {
    /// Where the answers live (vm.env, and secrets in .env). Default: ~/.config/suplex-bootstrap
    #[arg(long, env = "SUPLEX_BOOTSTRAP_DIR", global = true)]
    dir: Option<PathBuf>,
    /// Without a command, runs the interactive bootstrap
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Interactive and idempotent: ask the essentials, create or converge the VM, print a login link
    Bootstrap,
    /// Power on and wait for SSH over the tailnet
    Up,
    /// Graceful shutdown. Most providers still bill a stopped server; `destroy` stops billing
    Down,
    /// Delete the server. Stops billing. Loses everything on its disk
    Destroy,
    /// Services, service user, exit node, egress IP, health
    Status,
    /// Admin shell (root). `ssh suplex@<host>` is the agent user
    Ssh,
    /// `suplex doctor` as the service user
    Doctor,
    /// Follow the service log
    Logs,
    /// Install or update the suplex binary, then restart the service
    InstallSuplex,
    /// Print a fresh one-time owner login link
    Recover,
}

// Remote scripts and units, embedded so the binary can run from anywhere.
const JOIN_SH: &str = include_str!("../vm/join.sh");
const CONVERGE_SH: &str = include_str!("../vm/converge.sh");
const STATUS_SH: &str = include_str!("../vm/status.sh");
const INSTALL_SH: &str = include_str!("../vm/install-suplex.sh");
const FILES: &[(&str, &str)] = &[
    ("install-suplex.sh", INSTALL_SH),
    ("suplex-egress.nft", include_str!("../vm/suplex-egress.nft")),
    (
        "suplex-egress.service",
        include_str!("../vm/suplex-egress.service"),
    ),
    ("suplex.service", include_str!("../vm/suplex.service")),
    ("herdr.service", include_str!("../vm/herdr.service")),
];
const REMOTE_TMP: &str = "/tmp/suplex-bootstrap";
const PUBLIC_KEYS: &[&str] = &[
    "PROVIDER",
    "SERVER_NAME",
    "VM_IP",
    "VM_USER",
    "TS_HOSTNAME",
    "EXIT_NODE",
    "GITHUB_KEY",
    "GIT_NAME",
    "GIT_EMAIL",
    "RECOVER",
    "SUPLEX_PORT",
    "ACCESS",
    "EXPOSURE",
    "DOMAIN",
];
const SECRET_KEYS: &[&str] = &[
    "TS_AUTHKEY",
    "HCLOUD_TOKEN",
    "DIGITALOCEAN_ACCESS_TOKEN",
    "CLOUDFLARE_API_TOKEN",
];

/// Remembered answers: `vm.env` (plain) and `.env` (secrets, 0600, gitignored). Both are
/// `KEY="value"` so a shell or mise can source them too.
#[derive(Default)]
struct Config {
    dir: PathBuf,
    values: BTreeMap<String, String>,
}

impl Config {
    fn load(dir: &Path) -> Config {
        let mut values = BTreeMap::new();
        for file in ["vm.env", ".env"] {
            for line in fs::read_to_string(dir.join(file))
                .unwrap_or_default()
                .lines()
            {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = line.split_once('=') {
                    let value = value.trim();
                    let value = value
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                        .map(|v| {
                            v.replace("\\\"", "\"")
                                .replace("\\$", "$")
                                .replace("\\\\", "\\")
                        })
                        .unwrap_or_else(|| value.to_string());
                    values.insert(key.trim().to_string(), value);
                }
            }
        }
        Config {
            dir: dir.to_path_buf(),
            values,
        }
    }

    fn get(&self, key: &str) -> &str {
        self.values.get(key).map_or("", String::as_str)
    }

    fn set(&mut self, key: &str, value: impl Into<String>) {
        self.values.insert(key.into(), value.into());
    }

    fn save(&self) -> Result<()> {
        let render = |keys: &[&str]| {
            keys.iter()
                .map(|key| {
                    let value = self
                        .get(key)
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('$', "\\$");
                    format!("{key}=\"{value}\"\n")
                })
                .collect::<String>()
        };
        fs::create_dir_all(&self.dir)?;
        fs::write(self.dir.join("vm.env"), render(PUBLIC_KEYS))?;
        let secrets = self.dir.join(".env");
        fs::write(&secrets, render(SECRET_KEYS))?;
        fs::set_permissions(&secrets, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    fn provider(&self) -> Provider {
        Provider::parse(self.get("PROVIDER"))
    }

    fn token(&self) -> &str {
        self.get(self.provider().token_env())
    }

    /// Admin SSH goes over the tailnet in Tailscale mode and over the public address otherwise.
    fn host(&self) -> Host {
        let name = if self.tailscale() {
            self.get("TS_HOSTNAME")
        } else {
            self.get("VM_IP")
        };
        Host {
            user: self.get("VM_USER").to_string(),
            name: name.to_string(),
        }
    }

    fn tailscale(&self) -> bool {
        self.get("ACCESS").is_empty() || self.get("ACCESS") == "tailscale"
    }
}

fn main() {
    let cli = Cli::parse();
    let dir = cli.dir.unwrap_or_else(default_dir);
    let result = match cli.command.unwrap_or(Cmd::Bootstrap) {
        Cmd::Bootstrap => bootstrap(&dir),
        other => command(other, Config::load(&dir)),
    };
    if let Err(error) = result {
        let _ = log::error(format!("{error:#}"));
        std::process::exit(1);
    }
}

/// `$XDG_CONFIG_HOME/suplex-bootstrap`, else `~/.config/suplex-bootstrap`.
fn default_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".config")))
        .unwrap_or_default()
        .join("suplex-bootstrap")
}

fn command(cmd: Cmd, cfg: Config) -> Result<()> {
    if cfg.host().name.is_empty() {
        bail!(
            "no server saved in {}; run `suplex-bootstrap` first",
            cfg.dir.display()
        );
    }
    let host = cfg.host();
    let (provider, token, name) = (cfg.provider(), cfg.token(), cfg.get("SERVER_NAME"));
    match cmd {
        Cmd::Bootstrap => unreachable!(),
        Cmd::Up => {
            if provider != Provider::Ip {
                provider.power(token, name, true)?;
            }
            wait_for(&host, "Waiting for SSH over the tailnet", false)?;
            command(Cmd::Status, cfg)
        }
        Cmd::Down => provider.power(token, name, false),
        Cmd::Destroy => {
            if provider == Provider::Ip {
                bail!("no provider configured: delete the server yourself");
            }
            let sure = confirm(format!(
                "Delete {name} on {}? Its disk is gone for good.",
                provider.label().0
            ))
            .initial_value(false)
            .interact()?;
            if !sure {
                bail!("kept {name}");
            }
            provider.destroy(token, name)
        }
        Cmd::Status => {
            if let Some(cli) = provider.cli() {
                match provider.list(token) {
                    Ok(servers) => {
                        for s in servers.iter().filter(|s| s.name == name) {
                            println!("{cli}: {} {} {}", s.name, s.ip, s.status);
                        }
                    }
                    Err(error) => println!("{cli}: {error}"),
                }
            }
            host.script(
                &host.target(),
                STATUS_SH,
                &[("SUPLEX_PORT", cfg.get("SUPLEX_PORT"))],
            )
        }
        Cmd::Ssh => host.interactive(""),
        Cmd::Doctor => host.run(&as_suplex("suplex doctor")),
        Cmd::Logs => host.interactive("journalctl -u suplex -f -n 50"),
        Cmd::InstallSuplex => host.script(
            &host.target(),
            &format!(
                "{INSTALL_SH}\nsystemctl restart suplex && sleep 3 && systemctl is-active suplex\n"
            ),
            &[],
        ),
        Cmd::Recover => {
            let link = recover(&host)?;
            println!("{link}");
            Ok(())
        }
    }
}

fn bootstrap(dir: &Path) -> Result<()> {
    let mut cfg = Config::load(dir);
    banner();
    intro(style(" suplex-bootstrap ").on_magenta().black().bold())?;
    for tool in ["ssh", "scp"] {
        if which(tool).is_none() {
            bail!("{tool} is not installed");
        }
    }

    // --- Where ---------------------------------------------------------------------------------
    let mut where_ = select("Where does the VM live?");
    for provider in Provider::ALL {
        let (label, hint) = provider.label();
        where_ = where_.item(provider, label, hint);
    }
    let provider = where_.initial_value(cfg.provider()).interact()?;
    cfg.set("PROVIDER", provider.id());

    if let Some(cli) = provider.cli() {
        if which(cli).is_none() {
            bail!("{cli} is not installed. {}", provider.install_hint());
        }
        secret(
            &mut cfg,
            provider.token_env(),
            "API token (blank keeps the CLI's own login)",
        )?;
        let token = cfg.token().to_string();
        let sp = spinner();
        sp.start(format!("Asking {cli} for your servers…"));
        let servers = provider.list(&token);
        match &servers {
            Ok(servers) => sp.stop(format!("{} server(s) in the account", servers.len())),
            Err(error) => sp.error(format!("{error}")),
        }
        let servers = servers?;
        let mut pick = select("Which server?");
        for server in &servers {
            pick = pick.item(
                server.name.clone(),
                &server.name,
                format!("{} {}", server.ip, server.status),
            );
        }
        pick = pick.item(String::new(), "Create a new server", "");
        if servers.iter().any(|s| s.name == cfg.get("SERVER_NAME")) {
            pick = pick.initial_value(cfg.get("SERVER_NAME").to_string());
        }
        let chosen = pick.interact()?;
        if chosen.is_empty() {
            let d = provider.defaults();
            let name: String = input("Server name").default_input("suplex").interact()?;
            let sp = spinner();
            sp.start(format!("Reading the {} catalog…", provider.label().0));
            let locations = provider.locations(&token)?;
            sp.stop("Catalog loaded");
            let location = choose("Location", locations, d.location)?;
            let sizes = provider.sizes(&token, &location)?;
            let kind = choose(
                "Server type (price per month, hourly in brackets)",
                sizes,
                "",
            )?;
            let image = choose("Image", provider.images(&token)?, d.image)?;
            let keys = provider.ssh_keys(&token)?;
            if keys.is_empty() {
                bail!("the account has no SSH keys; upload your public key with {cli} first");
            }
            let mut pick_key = select("SSH key to inject (must be one this Mac can use)");
            for (id, key_name) in &keys {
                pick_key = pick_key.item(id.clone(), key_name, "");
            }
            let key = pick_key.interact()?;
            let sp = spinner();
            sp.start(format!("Creating {name} ({kind}, {image}, {location})…"));
            match provider.create(&token, &name, &kind, &image, &location, &key) {
                Ok(ip) => {
                    sp.stop(format!("{name} is up at {ip}"));
                    cfg.set("SERVER_NAME", name);
                    cfg.set("VM_IP", ip);
                }
                Err(error) => {
                    sp.error("create failed");
                    return Err(error);
                }
            }
            log::info("Giving the new server 20s to finish booting")?;
            thread::sleep(Duration::from_secs(20));
        } else {
            let server = servers
                .into_iter()
                .find(|s| s.name == chosen)
                .expect("picked");
            if server.ip.is_empty() {
                bail!(
                    "{} has no public IPv4 yet (status {}); wait for it and rerun",
                    server.name,
                    server.status
                );
            }
            cfg.set("SERVER_NAME", server.name);
            cfg.set("VM_IP", server.ip);
        }
    } else {
        cfg.set("SERVER_NAME", "");
        text(&mut cfg, "VM_IP", "Public IP or hostname of the server", "")?;
    }
    if cfg.get("VM_IP").is_empty() {
        bail!("no server address; nothing to connect to");
    }
    text(&mut cfg, "VM_USER", "Admin SSH user", "root")?;

    // --- Access --------------------------------------------------------------------------------
    let access: String = select("How do you reach Suplex?")
        .item("tailscale".to_string(), "Tailscale (recommended)", "private HTTPS on your tailnet, Tailscale SSH, optional exit-node egress")
        .item("cloudflare".to_string(), "Public HTTPS via Cloudflare Tunnel", "a hostname in a zone on your Cloudflare account; no inbound ports, no domain pointing at the server")
        .item("local".to_string(), "Localhost only", "reach it through an SSH tunnel: ssh -L 4111:127.0.0.1:4111")
        .item("all".to_string(), "All network access (not recommended)", "plain HTTP on every interface; remote clients still need HTTPS from a proxy you run")
        .initial_value(if cfg.get("ACCESS").is_empty() { "tailscale".to_string() } else { cfg.get("ACCESS").to_string() })
        .interact()?;
    cfg.set("ACCESS", access.clone());
    let tailscale = access == "tailscale";
    let mut exit_node = String::new();
    let mut port = "4111".to_string();
    let mut tunnel_token = String::new();
    if access == "cloudflare" {
        let domain: String =
            input("Public hostname for Suplex (in a zone on your Cloudflare account)")
                .default_input(cfg.get("DOMAIN"))
                .validate(|d: &String| {
                    if d.contains('/') || d.contains(':') || d.matches('.').count() < 2 {
                        Err("a hostname inside your zone, like demo.example.com")
                    } else {
                        Ok(())
                    }
                })
                .interact()?;
        cfg.set("DOMAIN", domain.trim().to_string());
        if cfg.get("CLOUDFLARE_API_TOKEN").is_empty() {
            note(
                style("Cloudflare API token").magenta().bold(),
                format!(
                    "Create one at {}\n{} → Custom token, with exactly these permissions:\n\n  {}  Cloudflare Tunnel   Edit\n  {}     DNS                 Edit\n  {}     Transform Rules     Edit\n\nZone Resources: the zone that contains {}. Nothing else is needed.",
                    style("https://dash.cloudflare.com/profile/api-tokens")
                        .cyan()
                        .underlined(),
                    style("Create Token").bold(),
                    style("Account").bold(),
                    style("Zone").bold(),
                    style("Zone").bold(),
                    style(cfg.get("DOMAIN")).bold()
                ),
            )?;
            let _ = Command::new("open")
                .arg("https://dash.cloudflare.com/profile/api-tokens")
                .status();
        }
        secret(&mut cfg, "CLOUDFLARE_API_TOKEN", "Cloudflare API token")?;
        if cfg.get("CLOUDFLARE_API_TOKEN").is_empty() {
            bail!("a Cloudflare API token is needed to create the tunnel");
        }
        let sp = spinner();
        sp.start("Setting up the Cloudflare Tunnel…");
        let tunnel = cloudflare::ensure(
            cfg.get("CLOUDFLARE_API_TOKEN"),
            cfg.get("DOMAIN"),
            &port,
            |line| {
                let _ = log::remark(line);
            },
        );
        match tunnel {
            Ok(tunnel) => {
                sp.stop(format!(
                    "Cloudflare Tunnel ready: https://{}",
                    cfg.get("DOMAIN")
                ));
                tunnel_token = tunnel.token;
            }
            Err(error) => {
                sp.error("Cloudflare setup failed");
                return Err(error);
            }
        }
    } else {
        cfg.set("DOMAIN", "");
    }
    if tailscale {
        text(
            &mut cfg,
            "TS_HOSTNAME",
            "Tailscale hostname for the VM",
            "suplex",
        )?;
        let nodes = local_exit_nodes();
        exit_node = if nodes.is_empty() {
            let value: String = input("Tailscale exit node for ALL egress (blank for none)")
                .default_input(cfg.get("EXIT_NODE"))
                .required(false)
                .interact()?;
            value
        } else {
            let mut pick = select("Route ALL of the VM's internet traffic through an exit node?");
            for node in &nodes {
                pick = pick.item(node.clone(), node, "enforced with a default-deny firewall");
            }
            pick = pick.item(
                String::new(),
                "No exit node",
                "the VM uses its own public IP",
            );
            if nodes.contains(&cfg.get("EXIT_NODE").to_string()) {
                pick = pick.initial_value(cfg.get("EXIT_NODE").to_string());
            }
            pick.interact()?
        };
        cfg.set("EXIT_NODE", exit_node.clone());
        let exposure: String = select("Who can open the Suplex URL?")
            .item(
                "serve".to_string(),
                "Only my tailnet (Tailscale Serve)",
                "private; tailnet users are signed in automatically",
            )
            .item(
                "funnel".to_string(),
                "Anyone on the internet (Tailscale Funnel)",
                "public URL through Tailscale's relay; visitors see the login page",
            )
            .initial_value(if cfg.get("EXPOSURE") == "funnel" {
                "funnel".to_string()
            } else {
                "serve".to_string()
            })
            .interact()?;
        cfg.set("EXPOSURE", exposure.clone());
        let saved_port = cfg.get("SUPLEX_PORT").to_string();
        let mut pick_port = select("HTTPS port for the Suplex URL");
        pick_port = pick_port.item(
            "443".to_string(),
            "443",
            "https://<host>.ts.net, no port in the URL",
        );
        if exposure == "funnel" {
            pick_port = pick_port
                .item("8443".to_string(), "8443", "https://<host>.ts.net:8443")
                .item(
                    "10000".to_string(),
                    "10000",
                    "https://<host>.ts.net:10000 (Funnel allows only these three)",
                );
        } else {
            pick_port = pick_port.item(
                "4111".to_string(),
                "4111",
                "Suplex's default, https://<host>.ts.net:4111",
            );
        }
        let allowed: &[&str] = if exposure == "funnel" {
            &["443", "8443", "10000"]
        } else {
            &["443", "4111"]
        };
        port = pick_port
            .initial_value(if allowed.contains(&saved_port.as_str()) {
                saved_port
            } else {
                "443".to_string()
            })
            .interact()?;
        secret(
            &mut cfg,
            "TS_AUTHKEY",
            "Tailscale auth key (tskey-auth-…; only needed before the first join)",
        )?;
    } else {
        cfg.set("EXIT_NODE", "");
    }
    cfg.set("SUPLEX_PORT", port.clone());

    // --- GitHub and friends ---------------------------------------------------------------------
    let home = std::env::var("HOME").unwrap_or_default();
    let default_key = if cfg.get("GITHUB_KEY").is_empty() {
        format!("{home}/.ssh/id_rsa")
    } else {
        cfg.get("GITHUB_KEY").to_string()
    };
    let key: String =
        input("GitHub SSH private key on this Mac (copied to the VM for the suplex user)")
            .default_input(&default_key)
            .validate(|path: &String| {
                if Path::new(path).is_file() {
                    Ok(())
                } else {
                    Err("no such file")
                }
            })
            .interact()?;
    cfg.set("GITHUB_KEY", key.clone());
    let git = |key: &str| {
        Command::new("git")
            .args(["config", "--global", key])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    text(&mut cfg, "GIT_NAME", "git user.name", &git("user.name"))?;
    text(&mut cfg, "GIT_EMAIL", "git user.email", &git("user.email"))?;
    let backup: String = if confirm("Restore a Suplex backup onto the VM?")
        .initial_value(false)
        .interact()?
    {
        input("Backup archive on this Mac (.tar.gz from `suplex backup` or Settings → Backups)")
            .validate(|path: &String| {
                if Path::new(path).is_file() {
                    Ok(())
                } else {
                    Err("no such file")
                }
            })
            .interact()?
    } else {
        String::new()
    };
    let recover_link = confirm("Print an owner login link at the end (suplex recover)?")
        .initial_value(cfg.get("RECOVER") != "n")
        .interact()?;
    cfg.set("RECOVER", if recover_link { "y" } else { "n" });
    cfg.save()?;
    log::success(format!(
        "Saved your answers in {} (secrets in .env)",
        cfg.dir.display()
    ))?;

    // --- Phase 1: join the tailnet --------------------------------------------------------------
    let mut host = cfg.host();
    if !tailscale {
        if host.probe() == Probe::StaleKey {
            forget_host_key(&host.name); // the provider's list or the user vouched for this address
        }
        if !host.reachable() {
            bail!(
                "cannot ssh {}; check the address, user, and your key",
                host.target()
            );
        }
        log::step(format!("{} answers over SSH", host.target()))?;
    } else if host.reachable() {
        log::step(format!("{} is already on the tailnet", host.name))?;
    } else {
        if cfg.get("TS_AUTHKEY").is_empty() {
            bail!(
                "{} is not on the tailnet and there is no auth key; rerun with one",
                host.name
            );
        }
        log::step(format!(
            "Joining the tailnet via {}@{}",
            host.user,
            cfg.get("VM_IP")
        ))?;
        // A recreated server reuses its address and name with a new host key; the provider's list
        // or our own join vouches for it, so stale known_hosts entries go.
        forget_host_key(cfg.get("VM_IP"));
        // With an exit node, replies to this public-IP session get rerouted and it hangs up; the
        // script sets the exit node after we leave, so a failure here is expected.
        let output = host.script_output(
            &format!("{}@{}", host.user, cfg.get("VM_IP")),
            JOIN_SH,
            &[
                ("TS_AUTHKEY", cfg.get("TS_AUTHKEY")),
                ("TS_HOSTNAME", &host.name),
                ("EXIT_NODE", &exit_node),
            ],
        );
        print!("{output}");
        let actual = output
            .lines()
            .find_map(|line| line.strip_prefix("SUPLEX_VM_NODE="))
            .map(str::trim)
            .unwrap_or("");
        if actual.is_empty() {
            bail!(
                "the join did not finish on {}@{} (see the output above); fix the cause and rerun",
                host.user,
                cfg.get("VM_IP")
            );
        }
        if actual != host.name {
            log::warning(format!(
                "The tailnet already has a node named {}, probably an earlier VM, so this one joined as {actual}.\n\
                 To reclaim the name: remove the old machine at https://login.tailscale.com/admin/machines,\n\
                 then `ssh root@{actual} tailscale set --hostname={}` and rerun bootstrap.",
                host.name, host.name
            ))?;
            if !confirm(format!("Continue as {actual}?"))
                .initial_value(true)
                .interact()?
            {
                bail!("stopped; reclaim the name and rerun");
            }
            cfg.set("TS_HOSTNAME", actual);
            cfg.save()?;
            host = cfg.host();
        }
        forget_host_key(&host.name);
        wait_for(
            &host,
            &format!("Waiting for {} on the tailnet", host.name),
            true,
        )?;
    }

    // --- Phase 2: converge ---------------------------------------------------------------------
    if !tailscale {
    } else if exit_node.is_empty() {
        host.run("tailscale set --exit-node=")?;
    } else {
        host.run(&format!(
            "tailscale set --exit-node={} --exit-node-allow-lan-access=false",
            quote(&exit_node)
        ))?;
        if !exit_node_online(&host)? {
            log::warning(format!(
                "Exit node {exit_node} is OFFLINE. The VM has no internet until it returns and installs will fail."
            ))?;
            if !confirm("Continue anyway?")
                .initial_value(false)
                .interact()?
            {
                bail!("stopped; bring {exit_node} online and rerun");
            }
        }
    }
    host.run(&format!("mkdir -p {REMOTE_TMP} && chmod 700 {REMOTE_TMP}"))?;
    host.upload(Path::new(&key), &format!("{REMOTE_TMP}/github_key"))?;
    let public_key = PathBuf::from(format!("{key}.pub"));
    if public_key.is_file() {
        host.upload(&public_key, &format!("{REMOTE_TMP}/github_key.pub"))?;
    }
    let mut restore = "";
    if !backup.is_empty() {
        if host.ok("test -s /home/suplex/.local/share/Suplex/data/suplex.sqlite") {
            log::warning("The VM already has a Suplex database.")?;
            if confirm("Replace it with the backup? Current tasks and projects on the VM are lost.")
                .initial_value(false)
                .interact()?
            {
                restore = "y";
            } else {
                log::info("Keeping the VM's database; the archive is not restored")?;
            }
        } else {
            restore = "y";
        }
        if restore == "y" {
            let sp = spinner();
            sp.start("Uploading the backup archive…");
            host.upload(Path::new(&backup), &format!("{REMOTE_TMP}/backup.tar.gz"))?;
            sp.stop("Archive uploaded");
        }
    }
    log::step("Converging the VM (this streams the remote log)")?;
    let mut script = String::new();
    for (name, body) in FILES {
        script.push_str(&format!(
            "cat > {REMOTE_TMP}/{name} <<'SUPLEX_VM_EOF'\n{body}\nSUPLEX_VM_EOF\n"
        ));
    }
    script.push_str(CONVERGE_SH);
    host.script(
        &host.target(),
        &script,
        &[
            ("ACCESS", &access),
            ("EXPOSURE", cfg.get("EXPOSURE")),
            ("DOMAIN", cfg.get("DOMAIN")),
            ("CF_TUNNEL_TOKEN", &tunnel_token),
            ("EXIT_NODE", &exit_node),
            ("SUPLEX_PORT", &port),
            ("GIT_NAME", cfg.get("GIT_NAME")),
            ("GIT_EMAIL", cfg.get("GIT_EMAIL")),
            ("RESTORE", restore),
        ],
    )?;

    // --- Sign-ins only a human can do ------------------------------------------------------------
    if !host.ok("test -f /home/suplex/.claude/.credentials.json")
        && confirm("Claude Code is not signed in for the suplex user. Sign in now?")
            .initial_value(true)
            .interact()?
    {
        log::info(
            "Copy the URL it prints into a browser on this Mac, sign in, then paste the code back here.",
        )?;
        let _ = host.interactive(&as_suplex("claude auth login"));
    }
    if !host.ok(&as_suplex("gh auth status"))
        && confirm(
            "GitHub CLI is not signed in for the suplex user (Suplex clones with it). Sign in now?",
        )
        .initial_value(true)
        .interact()?
    {
        github_login(&host)?;
    }

    // --- Done -----------------------------------------------------------------------------------
    let url = match access.as_str() {
        "cloudflare" => format!("https://{}  (public, Cloudflare Tunnel)", cfg.get("DOMAIN")),
        "local" => format!(
            "http://127.0.0.1:{port}  (first: ssh -L {port}:127.0.0.1:{port} {})",
            host.target()
        ),
        "all" => format!(
            "http://{}:{port}  (plain HTTP; remote clients need an HTTPS proxy in front)",
            cfg.get("VM_IP")
        ),
        _ if cfg.get("EXPOSURE") == "funnel" => {
            format!("{}  (public, Funnel)", suplex_url(&fqdn(&host)?, &port))
        }
        _ => suplex_url(&fqdn(&host)?, &port),
    };
    if recover_link {
        let mut link = recover(&host)?;
        if access == "cloudflare" {
            // The host prints its loopback address; browsers reach it through the tunnel.
            if let Some(path) = link.find("/auth") {
                link = format!("https://{}{}", cfg.get("DOMAIN"), &link[path..]);
            }
        }
        note(
            style("Sign in as the owner").magenta().bold(),
            format!(
                "{}\n\n{}\n\n{}",
                style("ONE-TIME LINK  ·  open it once, it then expires")
                    .yellow()
                    .bold(),
                style(link).cyan().bold().underlined(),
                style("Run `suplex-bootstrap recover` for a fresh one.").dim()
            ),
        )?;
    }
    outro(format!(
        "{}  {}\n   {}  {}\n   {}  {}",
        style("Suplex").bold(),
        style(&url).dim(),
        style("admin ").bold(),
        style(format!("ssh {}", host.target())).dim(),
        style("agents").bold(),
        style(format!("ssh suplex@{}", host.name)).dim()
    ))?;
    Ok(())
}

/// A filterable menu over a provider catalog; `preferred` is selected when the catalog has it.
fn choose(prompt: &str, choices: Vec<provider::Choice>, preferred: &str) -> Result<String> {
    if choices.is_empty() {
        bail!("{prompt}: the provider returned no options");
    }
    let mut pick = select(prompt).filter_mode().max_rows(12);
    for choice in &choices {
        pick = pick.item(choice.id.clone(), &choice.id, &choice.hint);
    }
    if choices.iter().any(|c| c.id == preferred) {
        pick = pick.initial_value(preferred.to_string());
    }
    Ok(pick.interact()?)
}

fn banner() {
    // The same wordmark as suplex.sh/install.sh.
    let lines = [
        r"  _______ ___ ___ _______ ___     _______  ___ ___",
        r" |   _   |   Y   |   _   |   |   |   _   |(   Y   )",
        r" |   1___|.  |   |.  1   |.  |   |.  1___| \  1  /",
        r" |____   |.  |   |.  ____|.  |___|.  __)_  /  _  \",
        r" |:  1   |:  1   |:  |   |:  1   |:  1   |/:  |   \",
        r" |::.. . |::.. . |::.|   |::.. . |::.. . (::. |:.  )",
        r" `-------`-------`---'   `-------`-------'`--- ---'",
    ];
    eprintln!();
    for (index, line) in lines.iter().enumerate() {
        let styled = match index {
            0..=2 => style(*line).magenta().bold(),
            3..=4 => style(*line).color256(141),
            _ => style(*line).color256(97),
        };
        eprintln!("{styled}");
    }
    eprintln!("{}", style("        build different.").dim().italic());
    eprintln!();
}

/// Text answer remembered in the config: saved value, else `fallback`, as the default.
fn text(cfg: &mut Config, key: &str, prompt: &str, fallback: &str) -> Result<()> {
    let default = if cfg.get(key).is_empty() {
        fallback.to_string()
    } else {
        cfg.get(key).to_string()
    };
    let value: String = input(prompt).default_input(&default).interact()?;
    cfg.set(key, value);
    Ok(())
}

/// Secret answer remembered in `.env`: enter keeps the saved value.
fn secret(cfg: &mut Config, key: &str, prompt: &str) -> Result<()> {
    let saved = cfg.get(key);
    let prompt = if saved.is_empty() {
        prompt.to_string()
    } else {
        format!(
            "{prompt}\n{} {}",
            style("saved:").dim(),
            style(preview(saved)).dim()
        )
    };
    let value = password(prompt).allow_empty().interact()?;
    if !value.is_empty() {
        cfg.set(key, value);
    }
    Ok(())
}

/// GitHub's device flow, driven from here: the VM has no browser, so the code it prints is shown
/// in a note and the device page opens on this machine. gh keeps polling until you approve.
fn github_login(host: &Host) -> Result<()> {
    let sp = spinner();
    sp.start("Asking GitHub for a device code…");
    let mut shown = false;
    host.stream(
        &as_suplex("BROWSER=false gh auth login -h github.com -p https -w"),
        |line| {
            if let Some(code) = line.split("one-time code:").nth(1).map(str::trim) {
                sp.stop("Device code ready");
                let _ = note(
                    style("Approve on GitHub").magenta().bold(),
                    format!(
                        "Enter this code at {}\n\n{}\n\n{}",
                        style("https://github.com/login/device").cyan().underlined(),
                        style(code).yellow().bold(),
                        style(
                            "Opening that page in your browser now. This waits until you approve."
                        )
                        .dim()
                    ),
                );
                let _ = Command::new("open")
                    .arg("https://github.com/login/device")
                    .status();
                shown = true;
            } else if shown && !line.contains("Open this URL") {
                let _ = log::remark(line);
            }
        },
    )?;
    if !shown {
        sp.error("gh printed no device code");
    }
    host.run(&as_suplex("gh auth setup-git"))?;
    log::success("GitHub: signed in; git uses gh for credentials")?;
    Ok(())
}

/// Enough of a secret to recognise it, never enough to use it.
fn preview(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 12 {
        return "•".repeat(chars.len());
    }
    let head: String = chars[..8].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}  (enter keeps it)")
}

fn forget_host_key(name: &str) {
    let _ = Command::new("ssh-keygen")
        .args(["-R", name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn which(tool: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(tool))
            .find(|candidate| candidate.is_file())
    })
}

/// Exit nodes this Mac's tailnet offers, by short hostname (Mullvad relays left out).
fn local_exit_nodes() -> Vec<String> {
    let Ok(output) = Command::new("tailscale")
        .args(["exit-node", "list"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (ip, host) = (fields.next()?, fields.next()?);
            (ip.starts_with("100.") && !host.ends_with("mullvad.ts.net"))
                .then(|| host.split('.').next().unwrap_or(host).to_string())
        })
        .collect()
}

/// Waits for SSH. `just_joined` means this run put the node on the tailnet itself, so a changed
/// host key is the new node (or the name briefly pointing at an old one) and gets replaced.
fn wait_for(host: &Host, message: &str, just_joined: bool) -> Result<()> {
    let sp = spinner();
    sp.start(message);
    for _ in 0..40 {
        match host.probe() {
            Probe::Up => {
                sp.stop(format!("{} answers over the tailnet", host.target()));
                return Ok(());
            }
            Probe::StaleKey if just_joined => forget_host_key(&host.name),
            Probe::StaleKey => {
                sp.error("host key changed");
                bail!(
                    "the host key for {} changed. If you recreated the server, run `ssh-keygen -R {}` and retry.",
                    host.name,
                    host.name
                );
            }
            Probe::Down => {}
        }
        thread::sleep(Duration::from_secs(3));
    }
    sp.error("no answer");
    bail!("cannot reach {} over the tailnet", host.target())
}

fn exit_node_online(host: &Host) -> Result<bool> {
    let status: serde_json::Value =
        serde_json::from_str(&host.capture("tailscale status --json")?)?;
    Ok(status["ExitNodeStatus"]["Online"]
        .as_bool()
        .unwrap_or(false))
}

fn suplex_url(fqdn: &str, port: &str) -> String {
    if port == "443" {
        format!("https://{fqdn}")
    } else {
        format!("https://{fqdn}:{port}")
    }
}

fn fqdn(host: &Host) -> Result<String> {
    let status: serde_json::Value =
        serde_json::from_str(&host.capture("tailscale status --self --json")?)?;
    Ok(status["Self"]["DNSName"]
        .as_str()
        .unwrap_or(&host.name)
        .trim_end_matches('.')
        .to_string())
}

fn recover(host: &Host) -> Result<String> {
    let output = host.capture(&as_suplex("suplex recover --confirm-recovery"))?;
    output
        .split_whitespace()
        .find(|word| word.starts_with("https://"))
        .map(str::to_string)
        .with_context(|| format!("suplex recover printed no link:\n{output}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_quotes_and_dollars() {
        let dir =
            std::env::temp_dir().join(format!("suplex-bootstrap-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut cfg = Config {
            dir: dir.clone(),
            values: BTreeMap::new(),
        };
        cfg.set("GIT_NAME", r#"Ada "The" $Lovelace\"#);
        cfg.set("TS_AUTHKEY", "tskey-auth-x");
        cfg.save().unwrap();
        let again = Config::load(&dir);
        assert_eq!(again.get("GIT_NAME"), r#"Ada "The" $Lovelace\"#);
        assert_eq!(again.get("TS_AUTHKEY"), "tskey-auth-x");
        assert!(
            !fs::read_to_string(dir.join("vm.env"))
                .unwrap()
                .contains("tskey")
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
