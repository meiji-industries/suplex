use super::transcript::{self, CodexEvent};
use crate::runtimes::headless;
use crate::runtimes::process::{IdentityMatch, compare_identity, inspect_process};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug)]
pub struct NativeTurn {
    pub id: String,
    pub events: Vec<CodexEvent>,
    pub updated_at: SystemTime,
}

pub fn session_directory(database_path: &Path, session_id: &str) -> io::Result<PathBuf> {
    if session_id.is_empty()
        || !session_id.as_bytes()[0].is_ascii_alphanumeric()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid task session identity",
        ));
    }
    let parent = database_path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Database path has no parent")
    })?;
    Ok(parent.join("runtime/task-sessions").join(session_id))
}

pub fn turns(directory: &Path) -> io::Result<Vec<NativeTurn>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut turns = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(id) = name
            .strip_prefix("turn-")
            .and_then(|rest| rest.strip_suffix(".jsonl"))
        else {
            continue;
        };
        if id.is_empty()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            continue;
        }
        let text = fs::read_to_string(entry.path())?;
        let updated_at = entry.metadata()?.modified()?;
        turns.push(NativeTurn {
            id: id.to_owned(),
            events: transcript::parse_events(&text),
            updated_at,
        });
    }
    // Node's readdir order for native turn filenames on the supported host is
    // lexical. History retains that native listing order; usage sorts its own
    // timeline separately below the reader boundary.
    turns.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(turns)
}

pub fn turn_evidence(directory: &Path, turn_id: &str) -> io::Result<Option<Vec<CodexEvent>>> {
    if turn_id.is_empty()
        || !turn_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid turn identity",
        ));
    }
    Ok(
        crate::shared::fs::read_optional(&directory.join(format!("turn-{turn_id}.jsonl")))?
            .map(|text| transcript::parse_events(&text)),
    )
}

pub fn busy(directory: &Path) -> io::Result<bool> {
    let Some(record) = headless::read_record(&directory.join("turn.json"))? else {
        return Ok(false);
    };
    Ok(compare_identity(
        &record.owned_identity(),
        inspect_process(record.pid).as_ref(),
    ) == IdentityMatch::Exact)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::headless::HeadlessTurnRecord;

    #[test]
    fn session_path_rejects_traversal_and_uses_database_installation() {
        let database = Path::new("/tmp/suplex/.suplex-rust/suplex.db");
        assert_eq!(
            session_directory(database, "session:1").unwrap(),
            Path::new("/tmp/suplex/.suplex-rust/runtime/task-sessions/session:1")
        );
        assert!(session_directory(database, "../outside").is_err());
        assert!(session_directory(database, "").is_err());
    }

    #[test]
    fn missing_native_turn_is_absent_and_path_traversal_is_rejected() {
        let directory = Path::new("/tmp/suplex-missing-codex-native-turn");
        assert!(turn_evidence(directory, "msg_1").unwrap().is_none());
        assert!(turn_evidence(directory, "../msg_1").is_err());
    }

    #[test]
    fn reads_native_history_without_changing_it() {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "suplex-codex-reader-{}",
            u64::from_ne_bytes(suffix)
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("turn-msg_1.jsonl");
        let jsonl = "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"Done\"}}\n";
        fs::write(&path, jsonl).unwrap();
        let found = turns(&directory).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "msg_1");
        assert_eq!(transcript::result_text(&found[0].events), "Done");
        assert_eq!(
            turn_evidence(&directory, "msg_1").unwrap().unwrap().len(),
            2
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), jsonl);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn source_headless_record_uses_top_level_pid() {
        let record: HeadlessTurnRecord = serde_json::from_str(
            r#"{
            "generation":"generation-1","turnId":"turn-1","sessionID":"session-1","pid":123,"processIdentity":{"command":"codex exec","executable":"codex",
            "argv":["codex","exec"],"processGroup":123,"startTime":"start","ownerUid":501}
        }"#,
        )
        .unwrap();
        assert_eq!(record.owned_identity().pid, 123);
        assert_eq!(record.owned_identity().owner_uid, Some(501));
    }
}
