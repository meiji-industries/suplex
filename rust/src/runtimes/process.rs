use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub command: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub process_group: u32,
    pub start_time: String,
    pub owner_uid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessOwnerObservation {
    Running { start_time: String },
    Absent,
    Unknown,
}

/// A failed `ps` read is ambiguous until the kernel confirms ESRCH. This
/// distinction keeps an uninspectable owner from being treated as stopped.
pub fn observe_process_owner(pid: u32) -> ProcessOwnerObservation {
    if let Some(identity) = inspect_process(pid) {
        return ProcessOwnerObservation::Running {
            start_time: identity.start_time,
        };
    }
    let Ok(pid) = i32::try_from(pid) else {
        return ProcessOwnerObservation::Unknown;
    };
    match kill(Pid::from_raw(pid), None) {
        Err(Errno::ESRCH) => ProcessOwnerObservation::Absent,
        Ok(()) | Err(_) => ProcessOwnerObservation::Unknown,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityMatch {
    Exact,
    NotRunning,
    PidReused,
    WrongProcessGroup,
    WrongStartTime,
    WrongExecutable,
    WrongArgv,
    WrongOwner,
    OwnerUncertain,
}

pub fn compare_identity(
    owned: &ProcessIdentity,
    observed: Option<&ProcessIdentity>,
) -> IdentityMatch {
    let Some(observed) = observed else {
        return IdentityMatch::NotRunning;
    };
    if observed.pid != owned.pid {
        return IdentityMatch::PidReused;
    }
    if observed.process_group != owned.process_group {
        return IdentityMatch::WrongProcessGroup;
    }
    if observed.start_time != owned.start_time {
        return IdentityMatch::WrongStartTime;
    }
    if observed.executable != owned.executable {
        return IdentityMatch::WrongExecutable;
    }
    if observed.argv != owned.argv {
        return IdentityMatch::WrongArgv;
    }
    if let Some(uid) = owned.owner_uid {
        match observed.owner_uid {
            Some(observed_uid) if observed_uid == uid => {}
            Some(_) => return IdentityMatch::WrongOwner,
            None => return IdentityMatch::OwnerUncertain,
        }
    }
    IdentityMatch::Exact
}

fn ps_field(pid: u32, field: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", field])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

pub fn inspect_process(pid: u32) -> Option<ProcessIdentity> {
    let command = ps_field(pid, "command=")?;
    let executable = ps_field(pid, "comm=")?;
    let process_group = ps_field(pid, "pgid=")?.parse().ok()?;
    let start_time = ps_field(pid, "lstart=")?;
    let owner_uid = ps_field(pid, "uid=").and_then(|uid| uid.parse().ok());
    let argv = normalized_argv(&command);
    Some(ProcessIdentity {
        pid,
        command,
        executable,
        argv,
        process_group,
        start_time,
        owner_uid,
    })
}

pub fn owner_marker(directory: &Path) -> String {
    let absolute = std::path::absolute(directory).unwrap_or_else(|_| directory.to_path_buf());
    let canonical = absolute.canonicalize().unwrap_or(absolute);
    format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    )
}

fn normalized_argv(command: &str) -> Vec<String> {
    let argv: Vec<String> = command.split_whitespace().map(str::to_owned).collect();
    if argv.len() <= 256
        && argv
            .iter()
            .all(|argument| argument.encode_utf16().count() <= 4_000)
    {
        argv
    } else {
        vec![format!("sha256:{:x}", Sha256::digest(command.as_bytes()))]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_process_identity_allows_owned_signal() {
        let owned = ProcessIdentity {
            pid: 123,
            command: "codex exec".into(),
            executable: "codex".into(),
            argv: vec!["codex".into(), "exec".into()],
            process_group: 123,
            start_time: "Thu Sep 25 00:00:00 2026".into(),
            owner_uid: Some(501),
        };
        assert_eq!(compare_identity(&owned, Some(&owned)), IdentityMatch::Exact);
        assert_eq!(compare_identity(&owned, None), IdentityMatch::NotRunning);
        assert_eq!(
            compare_identity(
                &owned,
                Some(&ProcessIdentity {
                    start_time: "later".into(),
                    ..owned.clone()
                })
            ),
            IdentityMatch::WrongStartTime
        );
        assert_eq!(
            compare_identity(
                &owned,
                Some(&ProcessIdentity {
                    owner_uid: None,
                    ..owned.clone()
                })
            ),
            IdentityMatch::OwnerUncertain
        );
        assert_eq!(
            compare_identity(
                &owned,
                Some(&ProcessIdentity {
                    process_group: 999,
                    ..owned.clone()
                })
            ),
            IdentityMatch::WrongProcessGroup
        );
    }

    #[test]
    fn oversized_ps_command_uses_source_digest_identity() {
        assert_eq!(normalized_argv("codex exec"), ["codex", "exec"]);
        let long = "x ".repeat(257);
        assert_eq!(
            normalized_argv(&long),
            vec![format!("sha256:{:x}", Sha256::digest(long.as_bytes()))]
        );
    }

    #[test]
    fn observes_own_live_process_without_assuming_ownership() {
        let observed =
            inspect_process(std::process::id()).expect("current process is visible to ps");
        assert_eq!(observed.pid, std::process::id());
        assert!(observed.process_group > 0);
        assert!(!observed.start_time.is_empty());
    }
}
