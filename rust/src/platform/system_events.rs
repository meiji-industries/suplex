//! Diagnostic system log. Events are dropped until the binary installs its log
//! directory; a failed write never changes the operation that produced it.

use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    sync::OnceLock,
};

use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};

static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

pub fn install(directory: PathBuf) {
    let _ = DIRECTORY.set(directory);
}

pub fn enabled() -> bool {
    DIRECTORY.get().is_some()
}

// ponytail: one unrotated file; port the TypeScript segment rotation and retention when the log needs it.
pub fn emit(event: Value) {
    let Some(directory) = DIRECTORY.get() else {
        return;
    };
    let mut record = json!({
        "schemaVersion": 1,
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "eventId": uuid::Uuid::new_v4().to_string(),
        "pid": std::process::id(),
    });
    if let (Some(record), Value::Object(event)) = (record.as_object_mut(), event) {
        record.extend(event);
    }
    let _ = fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .and_then(|()| {
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(directory.join("system.log"))
        })
        .and_then(|mut file| file.write_all(format!("{record}\n").as_bytes()));
}
