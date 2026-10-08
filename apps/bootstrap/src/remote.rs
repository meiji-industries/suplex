//! SSH to the VM. Everything goes through the system `ssh`/`scp` so the user's keys, agent, and
//! Tailscale SSH all work unchanged.

use anyhow::{Context, Result, bail};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

const OPTS: &[&str] = &[
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
];

pub const SUPLEX_HOME: &str = "/home/suplex";
pub const SUPLEX_PATH: &str =
    "/home/suplex/.local/bin:/home/suplex/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin";

#[derive(PartialEq, Eq, Debug)]
pub enum Probe {
    Up,
    StaleKey,
    Down,
}

pub struct Host {
    pub user: String,
    /// Tailnet name; the address used for everything after the join.
    pub name: String,
}

impl Host {
    pub fn target(&self) -> String {
        format!("{}@{}", self.user, self.name)
    }

    fn ssh(target: &str) -> Command {
        let mut command = Command::new("ssh");
        command.args(OPTS).arg(target);
        command
    }

    pub fn reachable(&self) -> bool {
        self.probe() == Probe::Up
    }

    /// One SSH attempt, distinguishing a changed host key from a host that is simply not there.
    pub fn probe(&self) -> Probe {
        let output = Self::ssh(&self.target())
            .arg("true")
            .stdin(Stdio::null())
            .output();
        match output {
            Ok(output) if output.status.success() => Probe::Up,
            Ok(output)
                if String::from_utf8_lossy(&output.stderr)
                    .contains("Host key verification failed") =>
            {
                Probe::StaleKey
            }
            _ => Probe::Down,
        }
    }

    /// True when the command exits 0. Output is discarded.
    pub fn ok(&self, command: &str) -> bool {
        Self::ssh(&self.target())
            .arg(command)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Runs a command, streaming its output to the terminal.
    pub fn run(&self, command: &str) -> Result<()> {
        let status = Self::ssh(&self.target())
            .arg(command)
            .stdin(Stdio::null())
            .status()
            .context("ssh")?;
        if !status.success() {
            bail!("`{command}` failed on {}", self.target());
        }
        Ok(())
    }

    pub fn capture(&self, command: &str) -> Result<String> {
        let output = Self::ssh(&self.target())
            .arg(command)
            .stdin(Stdio::null())
            .output()
            .context("ssh")?;
        if !output.status.success() {
            bail!(
                "`{command}` failed on {}: {}",
                self.target(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Pipes a bash script over SSH. `env` is prepended as exports, so secrets never appear on a
    /// command line. Output streams to the terminal.
    pub fn script(&self, target: &str, body: &str, env: &[(&str, &str)]) -> Result<()> {
        let mut child = Self::ssh(target)
            .arg("bash -s")
            .stdin(Stdio::piped())
            .spawn()
            .context("ssh")?;
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(with_env(body, env).as_bytes())?;
        let status = child.wait()?;
        if !status.success() {
            bail!(
                "remote script failed on {target} (exit {})",
                status.code().unwrap_or(-1)
            );
        }
        Ok(())
    }

    /// Like `script`, but returns stdout (stderr still streams). Errors are ignored: used where the
    /// connection is expected to drop, such as setting an exit node over the public IP.
    pub fn script_output(&self, target: &str, body: &str, env: &[(&str, &str)]) -> String {
        let Ok(mut child) = Self::ssh(target)
            .arg("bash -s")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
        else {
            return String::new();
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(with_env(body, env).as_bytes());
        }
        child
            .wait_with_output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    }

    /// Runs a command, handing each output line (stdout and stderr merged) to `on_line` as it arrives.
    pub fn stream(&self, command: &str, mut on_line: impl FnMut(&str)) -> Result<()> {
        use std::io::BufRead;
        let mut child = Self::ssh(&self.target())
            .arg(format!("{command} 2>&1"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .context("ssh")?;
        let stdout = child.stdout.take().expect("piped stdout");
        for line in std::io::BufReader::new(stdout).lines() {
            on_line(&line?);
        }
        let status = child.wait()?;
        if !status.success() {
            bail!("`{command}` failed on {}", self.target());
        }
        Ok(())
    }

    /// An interactive session (TTY) for sign-ins the user must do by hand.
    pub fn interactive(&self, command: &str) -> Result<()> {
        let status = Command::new("ssh")
            .args(["-t", "-o", "StrictHostKeyChecking=accept-new"])
            .arg(self.target())
            .arg(command)
            .status()
            .context("ssh")?;
        if !status.success() {
            bail!(
                "interactive `{command}` ended with exit {}",
                status.code().unwrap_or(-1)
            );
        }
        Ok(())
    }

    pub fn upload(&self, local: &Path, remote: &str) -> Result<()> {
        let status = Command::new("scp")
            .args([
                "-q",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=accept-new",
            ])
            .arg(local)
            .arg(format!("{}:{remote}", self.target()))
            .status()
            .context("scp")?;
        if !status.success() {
            bail!("scp {} failed", local.display());
        }
        Ok(())
    }
}

fn with_env(body: &str, env: &[(&str, &str)]) -> String {
    let mut script = String::new();
    for (key, value) in env {
        script.push_str(&format!("export {key}={}\n", quote(value)));
    }
    script.push_str(body);
    script
}

/// Single-quotes a string for POSIX sh.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// A command run as the `suplex` service user from its home with its tools on PATH.
pub fn as_suplex(command: &str) -> String {
    format!(
        "runuser -u suplex -- env HOME={SUPLEX_HOME} PATH={SUPLEX_PATH} bash -c {}",
        quote(&format!("cd ~ && {command}"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_single_quotes() {
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote(""), "''");
        assert!(as_suplex("suplex doctor").ends_with("'cd ~ && suplex doctor'"));
    }
}
