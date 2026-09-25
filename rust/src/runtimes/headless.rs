use nix::errno::Errno;
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use std::time::Instant;
use uuid::Uuid;

use super::process::{
    IdentityMatch, ProcessIdentity, compare_identity, inspect_process, owner_marker,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedProcessIdentity {
    pub command: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub process_group: u32,
    pub start_time: String,
    pub owner_uid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessTurnRecord {
    pub generation: String,
    pub turn_id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub pid: u32,
    pub process_identity: RecordedProcessIdentity,
    #[serde(default)]
    pub dispatch_arguments: Vec<String>,
}

impl HeadlessTurnRecord {
    pub fn owned_identity(&self) -> ProcessIdentity {
        ProcessIdentity {
            pid: self.pid,
            command: self.process_identity.command.clone(),
            executable: self.process_identity.executable.clone(),
            argv: self.process_identity.argv.clone(),
            process_group: self.process_identity.process_group,
            start_time: self.process_identity.start_time.clone(),
            owner_uid: Some(self.process_identity.owner_uid),
        }
    }
}

pub struct DispatchInput<'a> {
    pub directory: &'a Path,
    pub worktree: &'a Path,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub executable: &'a Path,
    pub args: &'a [String],
    pub prompt: &'a str,
    pub environment: &'a HashMap<String, String>,
}

fn private_file(path: &Path, append: bool) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .append(append)
        .truncate(!append)
        .mode(0o600)
        .open(path)
}

fn write_record(path: &Path, record: &HeadlessTurnRecord) -> io::Result<()> {
    let mut file = private_file(path, false)?;
    serde_json::to_writer(&mut file, record)?;
    file.sync_all()
}

pub fn read_record(path: &Path) -> io::Result<Option<HeadlessTurnRecord>> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn turn_file(directory: &Path, turn_id: &str, suffix: &str) -> PathBuf {
    directory.join(format!("turn-{turn_id}.{suffix}"))
}

pub fn dispatch<F>(input: DispatchInput<'_>, claim: F) -> Result<HeadlessTurnRecord, Box<dyn Error>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error>>,
{
    dispatch_with_exclusions(input, &[], claim)
}

pub fn dispatch_with_exclusions<F>(
    input: DispatchInput<'_>,
    excluded_environment_keys: &[String],
    claim: F,
) -> Result<HeadlessTurnRecord, Box<dyn Error>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error>>,
{
    fs::create_dir_all(input.directory)?;
    fs::set_permissions(input.directory, fs::Permissions::from_mode(0o700))?;
    let generation = Uuid::new_v4().to_string();
    if !claim(&generation)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Prompt replay claim was not acquired",
        )
        .into());
    }
    let prompt_path = turn_file(input.directory, input.turn_id, "prompt");
    let log_path = turn_file(input.directory, input.turn_id, "jsonl");
    let stderr_path = turn_file(input.directory, input.turn_id, "stderr.log");
    let exit_path = turn_file(input.directory, input.turn_id, "exit");
    let mut prompt_file = private_file(&prompt_path, false)?;
    prompt_file.write_all(input.prompt.as_bytes())?;
    prompt_file.sync_all()?;
    let prompt_file = File::open(&prompt_path)?;
    let log_file = private_file(&log_path, true)?;
    let stderr_file = private_file(&stderr_path, true)?;
    let script = "\"$0\" \"$@\"; code=$?; printf \"%s\\n\" \"$code\" > \"$SUPLEX_HEADLESS_EXIT_FILE\"; exit \"$code\"";
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(script)
        .arg(input.executable)
        .args(input.args)
        .current_dir(input.worktree)
        .env_clear()
        .envs(input.environment)
        .env("SUPLEX_TASK_PROCESS_OWNER", owner_marker(input.worktree))
        .env(
            "SUPLEX_SESSION_PROCESS_OWNER",
            owner_marker(input.directory),
        )
        .env(
            "SUPLEX_EXECUTION_PROCESS_OWNER",
            owner_marker(&input.directory.join(&generation)),
        )
        .env("SUPLEX_HEADLESS_EXIT_FILE", &exit_path)
        .stdin(Stdio::from(prompt_file))
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_file))
        .process_group(0);
    for key in excluded_environment_keys {
        command.env_remove(key);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let mut inspection = None;
    let mut exited = false;
    for _ in 0..20 {
        if child.try_wait()?.is_some() {
            exited = true;
            break;
        }
        inspection = inspect_process(pid);
        if inspection.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if let Some(found) = &inspection
        && (found.owner_uid.is_none() || found.process_group != pid)
    {
        return Err(io::Error::other("Headless process identity could not be established").into());
    }
    let identity = if let Some(found) = inspection {
        RecordedProcessIdentity {
            command: found.command,
            executable: found.executable,
            argv: found.argv,
            process_group: found.process_group,
            start_time: found.start_time,
            owner_uid: found.owner_uid.unwrap(),
        }
    } else {
        RecordedProcessIdentity {
            command: input.executable.display().to_string(),
            executable: input.executable.display().to_string(),
            argv: std::iter::once(input.executable.display().to_string())
                .chain(input.args.iter().cloned())
                .collect(),
            process_group: pid,
            start_time: "exited-before-inspection".to_owned(),
            owner_uid: unsafe { libc::getuid() },
        }
    };
    let record = HeadlessTurnRecord {
        generation: generation.clone(),
        turn_id: input.turn_id.to_owned(),
        session_id: input.session_id.to_owned(),
        pid,
        process_identity: identity,
        dispatch_arguments: std::iter::once(input.executable.display().to_string())
            .chain(input.args.iter().cloned())
            .collect(),
    };
    let pending = input
        .directory
        .join(format!("dispatch-{generation}.json.pending"));
    write_record(&pending, &record)?;
    fs::rename(
        pending,
        input.directory.join(format!("dispatch-{generation}.json")),
    )?;
    write_record(&input.directory.join("turn.json"), &record)?;
    if !exited {
        thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(record)
}

fn process_pid(pid: u32) -> io::Result<Pid> {
    let pid = i32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid process identity"))?;
    if pid <= 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid process identity",
        ));
    }
    Ok(Pid::from_raw(pid))
}

fn group_alive(record: &HeadlessTurnRecord) -> io::Result<bool> {
    if record.process_identity.process_group != record.pid {
        return Ok(false);
    }
    match killpg(process_pid(record.pid)?, None) {
        Ok(()) | Err(Errno::EPERM) => Ok(true),
        Err(Errno::ESRCH) => Ok(false),
        Err(error) => Err(io::Error::other(error)),
    }
}

pub fn running(record: &HeadlessTurnRecord) -> io::Result<bool> {
    match compare_identity(
        &record.owned_identity(),
        inspect_process(record.pid).as_ref(),
    ) {
        IdentityMatch::Exact => Ok(true),
        IdentityMatch::NotRunning => group_alive(record),
        other => Err(io::Error::other(format!(
            "Recorded process ownership is {other:?}"
        ))),
    }
}

fn signal_owned(record: &HeadlessTurnRecord, signal: Signal) -> io::Result<()> {
    let target = match compare_identity(
        &record.owned_identity(),
        inspect_process(record.pid).as_ref(),
    ) {
        IdentityMatch::Exact => Some(record.process_identity.process_group == record.pid),
        IdentityMatch::NotRunning if group_alive(record)? => Some(true),
        IdentityMatch::NotRunning => None,
        other => {
            return Err(io::Error::other(format!(
                "Recorded process ownership is {other:?}"
            )));
        }
    };
    let Some(group) = target else { return Ok(()) };
    let pid = process_pid(record.pid)?;
    let result = if group {
        killpg(pid, signal)
    } else {
        kill(pid, signal)
    };
    match result {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(io::Error::other(error)),
    }
}

pub fn stop_owned(record: &HeadlessTurnRecord) -> io::Result<()> {
    if !running(record)? {
        return Ok(());
    }
    signal_owned(record, Signal::SIGTERM)?;
    thread::sleep(Duration::from_millis(250));
    if !running(record)? {
        return Ok(());
    }
    signal_owned(record, Signal::SIGKILL)?;
    thread::sleep(Duration::from_millis(250));
    if running(record)? {
        return Err(io::Error::other(
            "Recorded process did not exit after SIGKILL",
        ));
    }
    Ok(())
}

pub fn stop_session(directory: &Path, native_session_id: Option<&str>) -> io::Result<()> {
    if let Some(record) = read_record(&directory.join("turn.json"))? {
        if native_session_id.is_some_and(|session_id| session_id != record.session_id) {
            return Ok(());
        }
        stop_owned(&record)?;
    }
    stop_dispatch_records(directory, native_session_id)?;
    stop_discovered_processes("SUPLEX_SESSION_PROCESS_OWNER", directory)
}

pub fn stop_execution(directory: &Path, generation: &str) -> io::Result<()> {
    stop_discovered_processes(
        "SUPLEX_EXECUTION_PROCESS_OWNER",
        &directory.join(generation),
    )
}

fn stop_dispatch_records(directory: &Path, native_session_id: Option<&str>) -> io::Result<()> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("dispatch-") || !name.ends_with(".json") {
            continue;
        }
        let Ok(Some(record)) = read_record(&entry.path()) else {
            continue;
        };
        if native_session_id.is_some_and(|session_id| session_id != record.session_id) {
            continue;
        }
        stop_owned(&record)?;
    }
    Ok(())
}

fn discovered_process_ids(key: &str, directory: &Path) -> io::Result<Vec<u32>> {
    let marker = format!("{key}={}", owner_marker(directory));
    #[cfg(target_os = "linux")]
    {
        let mut found = Vec::new();
        for entry in fs::read_dir("/proc")? {
            let Ok(entry) = entry else { continue };
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if pid == std::process::id() {
                continue;
            }
            if let Ok(environment) = fs::read(entry.path().join("environ"))
                && environment
                    .split(|byte| *byte == 0)
                    .any(|value| value == marker.as_bytes())
            {
                found.push(pid);
            }
        }
        return Ok(found);
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("ps").args(["-axo", "pid="]).output()?;
        if !output.status.success() || output.stdout.len() > 64 * 1024 * 1024 {
            return Err(io::Error::other("Process discovery failed"));
        }
        let mut found = Vec::new();
        for pid in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
        {
            if pid == std::process::id() {
                continue;
            }
            if macos_process_environment(pid)
                .is_ok_and(|environment| environment.iter().any(|item| item == marker.as_bytes()))
            {
                found.push(pid);
            }
        }
        Ok(found)
    }
}

#[cfg(target_os = "macos")]
fn macos_process_environment(pid: u32) -> io::Result<Vec<Vec<u8>>> {
    let mut name = [
        libc::CTL_KERN,
        libc::KERN_PROCARGS2,
        i32::try_from(pid).map_err(io::Error::other)?,
    ];
    let mut size = 0_usize;
    if unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if !(5..=64 * 1024 * 1024).contains(&size) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Process environment is too large or empty",
        ));
    }
    let mut data = vec![0_u8; size];
    if unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            data.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    data.truncate(size);
    let argc = i32::from_ne_bytes(data[..4].try_into().unwrap());
    if !(0..=4096).contains(&argc) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid process argument count",
        ));
    }
    let mut offset = 4;
    offset += data[offset..]
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "Missing executable terminator")
        })?;
    while data.get(offset) == Some(&0) {
        offset += 1;
    }
    for _ in 0..argc {
        offset += data
            .get(offset..)
            .and_then(|rest| rest.iter().position(|byte| *byte == 0))
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Missing argument terminator")
            })?
            + 1;
    }
    while data.get(offset) == Some(&0) {
        offset += 1;
    }
    Ok(data[offset..]
        .split(|byte| *byte == 0)
        .take_while(|item| !item.is_empty())
        .map(|item| item.to_vec())
        .collect())
}

fn stop_discovered_processes(key: &str, directory: &Path) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let discovered = discovered_process_ids(key, directory)?;
        let confirmed = discovered_process_ids(key, directory)?;
        let owned: Vec<ProcessIdentity> = discovered
            .into_iter()
            .filter(|pid| confirmed.contains(pid))
            .filter_map(inspect_process)
            .filter(|identity| identity.owner_uid == Some(unsafe { libc::getuid() }))
            .collect();
        if owned.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other(
                "Task commands are still running after cleanup",
            ));
        }
        for identity in owned {
            let current = inspect_process(identity.pid);
            if compare_identity(&identity, current.as_ref()) != IdentityMatch::Exact {
                continue;
            }
            let pid = process_pid(identity.pid)?;
            match kill(pid, Signal::SIGTERM) {
                Ok(()) | Err(Errno::ESRCH) => {}
                Err(error) => return Err(io::Error::other(error)),
            }
            thread::sleep(Duration::from_millis(250));
            if compare_identity(&identity, inspect_process(identity.pid).as_ref())
                != IdentityMatch::Exact
            {
                continue;
            }
            match kill(pid, Signal::SIGKILL) {
                Ok(()) | Err(Errno::ESRCH) => {}
                Err(error) => return Err(io::Error::other(error)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::process::{IdentityMatch, compare_identity};

    #[test]
    fn claim_precedes_detached_launch_and_record_uses_source_shape() {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory =
            std::env::temp_dir().join(format!("suplex-headless-{}", u64::from_ne_bytes(suffix)));
        let args = vec!["-c".to_owned(), "read line; printf '{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\\n'; sleep 1".to_owned()];
        let environment = HashMap::new();
        let input = || DispatchInput {
            directory: &directory,
            worktree: Path::new("/tmp"),
            session_id: "codex-session-1",
            turn_id: "message-1",
            executable: Path::new("/bin/sh"),
            args: &args,
            prompt: "build the task\n",
            environment: &environment,
        };
        assert!(dispatch(input(), |_| Ok(false)).is_err());
        assert!(!turn_file(&directory, "message-1", "prompt").exists());
        let record = dispatch(input(), |_| Ok(true)).unwrap();
        assert_eq!(record.process_identity.process_group, record.pid);
        assert_eq!(record.owned_identity().pid, record.pid);
        assert_eq!(
            compare_identity(
                &record.owned_identity(),
                inspect_process(record.pid).as_ref()
            ),
            IdentityMatch::Exact
        );
        let raw = fs::read_to_string(directory.join("turn.json")).unwrap();
        assert!(raw.contains("\"sessionID\":\"codex-session-1\""));
        assert!(!raw.contains("\"processIdentity\":{\"pid\""));
        assert!(
            read_record(&directory.join(format!("dispatch-{}.json", record.generation)))
                .unwrap()
                .is_some()
        );
        for _ in 0..40 {
            if turn_file(&directory, "message-1", "exit").exists() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            fs::read_to_string(turn_file(&directory, "message-1", "exit")).unwrap(),
            "0\n"
        );
        assert!(
            fs::read_to_string(turn_file(&directory, "message-1", "jsonl"))
                .unwrap()
                .contains("thread-1")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stop_signals_only_the_recorded_session_process_group() {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "suplex-headless-stop-{}",
            u64::from_ne_bytes(suffix)
        ));
        let args = vec!["-c".to_owned(), "sleep 10".to_owned()];
        let environment = HashMap::new();
        let record = dispatch(
            DispatchInput {
                directory: &directory,
                worktree: Path::new("/tmp"),
                session_id: "codex-session-2",
                turn_id: "message-2",
                executable: Path::new("/bin/sh"),
                args: &args,
                prompt: "stop this process\n",
                environment: &environment,
            },
            |_| Ok(true),
        )
        .unwrap();
        stop_session(&directory, Some("another-session")).unwrap();
        assert_eq!(
            compare_identity(
                &record.owned_identity(),
                inspect_process(record.pid).as_ref()
            ),
            IdentityMatch::Exact
        );
        stop_session(&directory, Some("codex-session-2")).unwrap();
        assert!(!running(&record).unwrap());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stop_rediscovers_tagged_process_after_record_loss_but_never_signals_unsafe_pid() {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "suplex-headless-recover-{}",
            u64::from_ne_bytes(suffix)
        ));
        let args = vec![
            "-c".to_owned(),
            "test -n \"$SUPLEX_SESSION_PROCESS_OWNER\"; echo marker=$?; sleep 10".to_owned(),
        ];
        let environment = HashMap::new();
        let record = dispatch(
            DispatchInput {
                directory: &directory,
                worktree: Path::new("/tmp"),
                session_id: "codex-session-3",
                turn_id: "message-3",
                executable: Path::new("/bin/sh"),
                args: &args,
                prompt: "stop after record loss\n",
                environment: &environment,
            },
            |_| Ok(true),
        )
        .unwrap();
        fs::remove_file(directory.join("turn.json")).unwrap();
        assert!(
            fs::read_to_string(turn_file(&directory, "message-3", "jsonl"))
                .unwrap()
                .contains("marker=0")
        );
        // The durable dispatch record still identifies the process after turn.json is lost.
        assert!(
            directory
                .join(format!("dispatch-{}.json", record.generation))
                .exists()
        );
        stop_session(&directory, Some("codex-session-3")).unwrap();
        assert!(!running(&record).unwrap());
        let mut unsafe_record = record;
        unsafe_record.pid = std::process::id();
        unsafe_record.process_identity.start_time = "stale start time".to_owned();
        write_record(&directory.join("turn.json"), &unsafe_record).unwrap();
        assert!(stop_session(&directory, Some("codex-session-3")).is_err());
        assert!(inspect_process(std::process::id()).is_some());
        fs::remove_dir_all(directory).unwrap();
    }
}
