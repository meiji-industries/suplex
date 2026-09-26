use super::transcript::{parse_events, thread_id};
use serde::Deserialize;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::SystemTime;

#[derive(Deserialize)]
struct Session {
    #[serde(rename = "threadId")]
    thread_id: String,
}

pub fn read_thread_id(directory: &Path) -> io::Result<Option<String>> {
    let Some(content) = crate::shared::fs::read_optional(&directory.join("session.json"))? else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<Session>(&content)
        .ok()
        .map(|session| session.thread_id.trim().to_owned())
        .filter(|id| !id.is_empty()))
}

fn dead_thread_ids(directory: &Path) -> HashSet<String> {
    let content = fs::read_to_string(directory.join("session.unresumable")).unwrap_or_default();
    content
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn persist_thread_id(directory: &Path, thread_id: &str) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    crate::shared::fs::write_private(
        &directory.join("session.json"),
        serde_json::to_string(&serde_json::json!({ "threadId": thread_id }))?.as_bytes(),
    )
}

pub fn persist_observed_thread(directory: &Path, thread_id: &str) -> io::Result<()> {
    if read_thread_id(directory)?.is_none() && !dead_thread_ids(directory).contains(thread_id) {
        persist_thread_id(directory, thread_id)?;
    }
    Ok(())
}

pub fn recover_thread_id(directory: &Path) -> io::Result<Option<String>> {
    if let Some(thread_id) = read_thread_id(directory)? {
        return Ok(Some(thread_id));
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };
    let mut logs = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("turn-") && name.ends_with(".jsonl") {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            logs.push((modified, entry.path()));
        }
    }
    logs.sort_by(|left, right| right.0.cmp(&left.0));
    let dead = dead_thread_ids(directory);
    for (_, path) in logs {
        let content = fs::read_to_string(path).unwrap_or_default();
        let events = parse_events(&content);
        if let Some(thread_id) = thread_id(&events).filter(|id| !dead.contains(*id)) {
            persist_thread_id(directory, thread_id)?;
            return Ok(Some(thread_id.to_owned()));
        }
    }
    Ok(None)
}

pub fn forget_unresumable_thread(directory: &Path) -> io::Result<()> {
    let thread_id = read_thread_id(directory)?;
    match fs::remove_file(directory.join("session.json")) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Some(thread_id) = thread_id {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(directory.join("session.unresumable"))?;
        writeln!(file, "{thread_id}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_thread_from_native_log_but_never_resurrects_unresumable_thread() {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "suplex-codex-thread-{}",
            u64::from_ne_bytes(suffix)
        ));
        fs::create_dir(&directory).unwrap();
        fs::write(
            directory.join("turn-msg_1.jsonl"),
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
        )
        .unwrap();
        assert_eq!(
            recover_thread_id(&directory).unwrap().as_deref(),
            Some("thread-1")
        );
        fs::write(directory.join("session.json"), "broken").unwrap();
        assert_eq!(
            recover_thread_id(&directory).unwrap().as_deref(),
            Some("thread-1")
        );
        fs::write(
            directory.join("session.json"),
            r#"{"threadId":"  thread-1  "}"#,
        )
        .unwrap();
        assert_eq!(
            read_thread_id(&directory).unwrap().as_deref(),
            Some("thread-1")
        );
        forget_unresumable_thread(&directory).unwrap();
        assert_eq!(recover_thread_id(&directory).unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(directory.join("session.unresumable"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unreadable_recovery_observations_do_not_block_a_new_thread() {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "suplex-codex-thread-errors-{}",
            u64::from_ne_bytes(suffix)
        ));
        fs::create_dir(&directory).unwrap();
        fs::create_dir(directory.join("session.unresumable")).unwrap();
        fs::create_dir(directory.join("turn-broken.jsonl")).unwrap();
        assert_eq!(recover_thread_id(&directory).unwrap(), None);
        fs::remove_dir_all(directory).unwrap();
    }
}
