//! Cloud providers, each driven through its own CLI. Adding one is one more match arm per method.

use anyhow::{Context, Result, bail};
use std::process::Command;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    Hetzner,
    DigitalOcean,
    /// A server that already exists somewhere; power control is manual.
    Ip,
}

pub struct Server {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub status: String,
}

/// One option in a catalog menu: the provider's identifier, and a human hint.
pub struct Choice {
    pub id: String,
    pub hint: String,
}

impl Choice {
    fn new(id: impl Into<String>, hint: impl Into<String>) -> Choice {
        Choice {
            id: id.into(),
            hint: hint.into(),
        }
    }
}

fn str_of(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

pub struct Defaults {
    pub image: &'static str,
    pub location: &'static str,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Hetzner, Provider::DigitalOcean, Provider::Ip];

    pub fn parse(id: &str) -> Provider {
        match id {
            "hetzner" => Provider::Hetzner,
            "digitalocean" => Provider::DigitalOcean,
            _ => Provider::Ip,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Provider::Hetzner => "hetzner",
            Provider::DigitalOcean => "digitalocean",
            Provider::Ip => "ip",
        }
    }

    pub fn label(self) -> (&'static str, &'static str) {
        match self {
            Provider::Hetzner => ("Hetzner Cloud", "hcloud CLI, hourly billing"),
            Provider::DigitalOcean => ("DigitalOcean", "doctl CLI, hourly billing"),
            Provider::Ip => ("A server I already have", "just an IP address"),
        }
    }

    pub fn cli(self) -> Option<&'static str> {
        match self {
            Provider::Hetzner => Some("hcloud"),
            Provider::DigitalOcean => Some("doctl"),
            Provider::Ip => None,
        }
    }

    pub fn install_hint(self) -> &'static str {
        match self {
            Provider::Hetzner => "brew install hcloud  (or https://github.com/hetznercloud/cli)",
            Provider::DigitalOcean => {
                "brew install doctl  (or https://docs.digitalocean.com/reference/doctl/)"
            }
            Provider::Ip => "",
        }
    }

    /// The environment variable the CLI reads its API token from.
    pub fn token_env(self) -> &'static str {
        match self {
            Provider::Hetzner => "HCLOUD_TOKEN",
            Provider::DigitalOcean => "DIGITALOCEAN_ACCESS_TOKEN",
            Provider::Ip => "",
        }
    }

    pub fn defaults(self) -> Defaults {
        match self {
            Provider::Hetzner => Defaults {
                image: "ubuntu-24.04",
                location: "hel1",
            },
            Provider::DigitalOcean => Defaults {
                image: "ubuntu-24-04-x64",
                location: "nyc3",
            },
            Provider::Ip => Defaults {
                image: "",
                location: "",
            },
        }
    }

    fn cmd(self, token: &str, args: &[&str]) -> Result<String> {
        let cli = self.cli().context("this provider has no CLI")?;
        let mut command = Command::new(cli);
        command.args(args);
        if !token.is_empty() {
            command.env(self.token_env(), token);
        }
        let output = command.output().with_context(|| format!("run {cli}"))?;
        if !output.status.success() {
            bail!(
                "{cli} {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn json(self, token: &str, args: &[&str]) -> Result<serde_json::Value> {
        Ok(serde_json::from_str(&self.cmd(token, args)?)?)
    }

    /// Locations (regions) to create in, from the provider's live catalog.
    pub fn locations(self, token: &str) -> Result<Vec<Choice>> {
        let mut out = Vec::new();
        match self {
            Provider::Hetzner => {
                for l in self
                    .json(token, &["location", "list", "-o", "json"])?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    out.push(Choice::new(
                        str_of(&l["name"]),
                        format!("{}, {}", str_of(&l["city"]), str_of(&l["country"])),
                    ));
                }
            }
            Provider::DigitalOcean => {
                for r in self
                    .json(token, &["compute", "region", "list", "-o", "json"])?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if r["available"].as_bool().unwrap_or(false) {
                        out.push(Choice::new(str_of(&r["slug"]), str_of(&r["name"])));
                    }
                }
            }
            Provider::Ip => {}
        }
        Ok(out)
    }

    /// Server types available in `location`, cheapest first, with their price.
    pub fn sizes(self, token: &str, location: &str) -> Result<Vec<Choice>> {
        let mut out: Vec<(f64, Choice)> = Vec::new();
        match self {
            Provider::Hetzner => {
                for t in self
                    .json(token, &["server-type", "list", "-o", "json"])?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if t["deprecated"].as_bool().unwrap_or(false) || t["architecture"] != "x86" {
                        continue;
                    }
                    let Some(price) = t["prices"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|p| p["location"] == location)
                    else {
                        continue;
                    };
                    let monthly: f64 = str_of(&price["price_monthly"]["gross"])
                        .parse()
                        .unwrap_or(0.0);
                    let hourly: f64 = str_of(&price["price_hourly"]["gross"])
                        .parse()
                        .unwrap_or(0.0);
                    out.push((monthly, Choice::new(
                        str_of(&t["name"]),
                        format!(
                            "{} vCPU · {} GB RAM · {} GB disk · €{monthly:.2}/mo (€{hourly:.4}/h)",
                            t["cores"], t["memory"], t["disk"]
                        ),
                    )));
                }
            }
            Provider::DigitalOcean => {
                for z in self
                    .json(token, &["compute", "size", "list", "-o", "json"])?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    let here = z["regions"]
                        .as_array()
                        .is_some_and(|r| r.iter().any(|x| x == location));
                    if !z["available"].as_bool().unwrap_or(false) || !here {
                        continue;
                    }
                    let monthly = z["price_monthly"].as_f64().unwrap_or(0.0);
                    let hourly = z["price_hourly"].as_f64().unwrap_or(0.0);
                    out.push((monthly, Choice::new(
                        str_of(&z["slug"]),
                        format!(
                            "{} vCPU · {} GB RAM · {} GB disk · ${monthly:.2}/mo (${hourly:.4}/h){}",
                            z["vcpus"],
                            z["memory"].as_f64().unwrap_or(0.0) / 1024.0,
                            z["disk"],
                            z["description"].as_str().map(|d| format!(" · {d}")).unwrap_or_default()
                        ),
                    )));
                }
            }
            Provider::Ip => {}
        }
        out.sort_by(|a, b| a.0.total_cmp(&b.0));
        Ok(out.into_iter().map(|(_, choice)| choice).collect())
    }

    /// Operating system images (x86), newest Ubuntu first so the default is near the top.
    pub fn images(self, token: &str) -> Result<Vec<Choice>> {
        let mut out = Vec::new();
        match self {
            Provider::Hetzner => {
                for i in self
                    .json(token, &["image", "list", "--type", "system", "-o", "json"])?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if i["architecture"] == "x86" && i["deprecated"].is_null() {
                        out.push(Choice::new(str_of(&i["name"]), str_of(&i["description"])));
                    }
                }
            }
            Provider::DigitalOcean => {
                for i in self
                    .json(
                        token,
                        &[
                            "compute",
                            "image",
                            "list-distribution",
                            "--public",
                            "-o",
                            "json",
                        ],
                    )?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if let Some(slug) = i["slug"].as_str() {
                        out.push(Choice::new(
                            slug,
                            format!("{} {}", str_of(&i["distribution"]), str_of(&i["name"])),
                        ));
                    }
                }
            }
            Provider::Ip => {}
        }
        out.sort_by(|a, b| {
            b.id.starts_with("ubuntu")
                .cmp(&a.id.starts_with("ubuntu"))
                .then(b.id.cmp(&a.id))
        });
        Ok(out)
    }

    pub fn list(self, token: &str) -> Result<Vec<Server>> {
        let mut out = Vec::new();
        match self {
            Provider::Hetzner => {
                for v in self
                    .json(token, &["server", "list", "-o", "json"])?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    out.push(Server {
                        id: str_of(&v["id"]),
                        name: str_of(&v["name"]),
                        ip: v["public_net"]["ipv4"]["ip"]
                            .as_str()
                            .unwrap_or("")
                            .to_string(),
                        status: str_of(&v["status"]),
                    });
                }
            }
            Provider::DigitalOcean => {
                for v in self
                    .json(token, &["compute", "droplet", "list", "-o", "json"])?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    let ip = v["networks"]["v4"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|n| n["type"] == "public")
                        .and_then(|n| n["ip_address"].as_str())
                        .unwrap_or("")
                        .to_string();
                    out.push(Server {
                        id: str_of(&v["id"]),
                        name: str_of(&v["name"]),
                        ip,
                        status: str_of(&v["status"]),
                    });
                }
            }
            Provider::Ip => {}
        }
        Ok(out)
    }

    /// `(id, name)` of the account's SSH keys.
    pub fn ssh_keys(self, token: &str) -> Result<Vec<(String, String)>> {
        let out = match self {
            Provider::Hetzner => self.cmd(
                token,
                &["ssh-key", "list", "-o", "noheader", "-o", "columns=id,name"],
            )?,
            Provider::DigitalOcean => self.cmd(
                token,
                &[
                    "compute",
                    "ssh-key",
                    "list",
                    "--no-header",
                    "--format",
                    "ID,Name",
                ],
            )?,
            Provider::Ip => return Ok(Vec::new()),
        };
        Ok(out
            .lines()
            .filter_map(|line| {
                let mut f = line.split_whitespace();
                Some((f.next()?.to_string(), f.next()?.to_string()))
            })
            .collect())
    }

    /// Creates the server and returns its public IPv4, polling until the provider reports one.
    pub fn create(
        self,
        token: &str,
        name: &str,
        kind: &str,
        image: &str,
        location: &str,
        ssh_key_id: &str,
    ) -> Result<String> {
        match self {
            Provider::Hetzner => self.cmd(
                token,
                &[
                    "server",
                    "create",
                    "--name",
                    name,
                    "--type",
                    kind,
                    "--image",
                    image,
                    "--location",
                    location,
                    "--ssh-key",
                    ssh_key_id,
                ],
            )?,
            Provider::DigitalOcean => self.cmd(
                token,
                &[
                    "compute",
                    "droplet",
                    "create",
                    name,
                    "--size",
                    kind,
                    "--image",
                    image,
                    "--region",
                    location,
                    "--ssh-keys",
                    ssh_key_id,
                    "--wait",
                ],
            )?,
            Provider::Ip => bail!("cannot create a server without a provider"),
        };
        for _ in 0..40 {
            if let Some(server) = self
                .list(token)?
                .into_iter()
                .find(|s| s.name == name && !s.ip.is_empty())
            {
                return Ok(server.ip);
            }
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
        bail!(
            "{name} was created but has no public IPv4 yet; rerun bootstrap and pick it from the list"
        )
    }

    fn id_of(self, token: &str, name: &str) -> Result<String> {
        self.list(token)?
            .into_iter()
            .find(|server| server.name == name)
            .map(|server| server.id)
            .with_context(|| format!("no server named {name}"))
    }

    pub fn power(self, token: &str, name: &str, on: bool) -> Result<()> {
        match self {
            Provider::Hetzner => {
                self.cmd(
                    token,
                    &["server", if on { "poweron" } else { "shutdown" }, name],
                )?;
            }
            Provider::DigitalOcean => {
                let id = self.id_of(token, name)?;
                let action = if on { "power-on" } else { "shutdown" };
                self.cmd(token, &["compute", "droplet-action", action, &id, "--wait"])?;
            }
            Provider::Ip => bail!(
                "no provider: power the server {} yourself",
                if on { "on" } else { "off" }
            ),
        }
        Ok(())
    }

    pub fn destroy(self, token: &str, name: &str) -> Result<()> {
        match self {
            Provider::Hetzner => self.cmd(token, &["server", "delete", name])?,
            Provider::DigitalOcean => {
                self.cmd(token, &["compute", "droplet", "delete", name, "--force"])?
            }
            Provider::Ip => bail!("no provider: delete the server yourself"),
        };
        Ok(())
    }
}
