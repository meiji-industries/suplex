//! Diagnostic system log. Events are dropped until the binary installs its log
//! directory; a failed write never changes the operation that produced it.
//! The writer rotates like `platform/system-events.ts`: by segment bytes, total
//! bytes, seven-day retention, and UTC day, into `system-<iso>-<uuid>.log`.

use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, OnceLock},
    time::{Instant, UNIX_EPOCH},
};

use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::{redaction, system_event_transport::Producer};

pub static ARCHIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^system-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]+\.log$")
        .expect("system log archive pattern")
});

enum Sink {
    File(Mutex<Writer>),
    Socket(Producer),
}

static SINK: OnceLock<Sink> = OnceLock::new();

pub fn install(directory: PathBuf) {
    let _ = SINK.set(Sink::File(Mutex::new(Writer::new(directory))));
}

/// The Root bridge process forwards its events to the server's receiver.
pub fn install_producer(database_path: &Path) {
    if let Some(producer) = Producer::new(database_path) {
        let _ = SINK.set(Sink::Socket(producer));
    }
}

/// Tests share one process-wide log directory because the sink installs once.
#[cfg(test)]
pub fn install_for_test() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("suplex-test-logs-{}", std::process::id()));
    install(directory.clone());
    directory
}

pub fn enabled() -> bool {
    SINK.get().is_some()
}

pub fn emit(event: Value) {
    emit_with_context(event, Map::new());
}

pub fn emit_with_context(event: Value, context: Map<String, Value>) -> Option<String> {
    match SINK.get()? {
        Sink::File(writer) => writer
            .lock()
            .ok()?
            .write(event, context, None, Utc::now()),
        Sink::Socket(producer) => producer.send(event, &context),
    }
}

/// Writes an event another process already identified.
pub fn forward(event: Value, context: Map<String, Value>, forwarded: Forwarded) {
    if let Some(Sink::File(writer)) = SINK.get()
        && let Ok(mut writer) = writer.lock()
    {
        writer.write(event, context, Some(forwarded), Utc::now());
    }
}

pub struct Forwarded {
    pub event_id: String,
    pub producer_time: String,
    pub producer_pid: u64,
    pub producer_sequence: u64,
    pub process_instance_id: String,
}

pub struct Writer {
    directory: PathBuf,
    segment_bytes: u64,
    total_bytes: u64,
    retention_ms: i64,
    max_record_bytes: u64,
    boot_id: String,
    boot: Instant,
    sequence: u64,
    last_prune: i64,
    current_start: Option<i64>,
}

impl Writer {
    pub fn new(directory: PathBuf) -> Self {
        Self::with_limits(directory, 10 * 1024 * 1024, 100 * 1024 * 1024, 8 * 1024)
    }

    pub fn with_limits(
        directory: PathBuf,
        segment_bytes: u64,
        total_bytes: u64,
        max_record_bytes: u64,
    ) -> Self {
        Self {
            directory,
            segment_bytes,
            total_bytes,
            retention_ms: 7 * 24 * 60 * 60 * 1000,
            max_record_bytes,
            boot_id: uuid::Uuid::new_v4().to_string(),
            boot: Instant::now(),
            sequence: 0,
            last_prune: 0,
            current_start: None,
        }
    }

    pub fn write(
        &mut self,
        event: Value,
        context: Map<String, Value>,
        forwarded: Option<Forwarded>,
        time: DateTime<Utc>,
    ) -> Option<String> {
        self.try_write(event, context, forwarded, time).ok().flatten()
    }

    fn try_write(
        &mut self,
        event: Value,
        context: Map<String, Value>,
        forwarded: Option<Forwarded>,
        time: DateTime<Utc>,
    ) -> std::io::Result<Option<String>> {
        let event_id = forwarded
            .as_ref()
            .map(|forwarded| forwarded.event_id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        self.sequence += 1;
        let mut record = json!({
            "schemaVersion": 1,
            "time": iso(time),
            "eventId": event_id,
            "bootId": self.boot_id,
            "sequence": self.sequence,
            "pid": std::process::id(),
            "bootElapsedMs": self.boot.elapsed().as_millis() as u64,
        });
        let fields = record.as_object_mut().expect("record object");
        if let Some(forwarded) = forwarded {
            fields.insert("producerTime".into(), json!(forwarded.producer_time));
            fields.insert("producerPid".into(), json!(forwarded.producer_pid));
            fields.insert(
                "producerSequence".into(),
                json!(forwarded.producer_sequence),
            );
            fields.insert(
                "processInstanceId".into(),
                json!(forwarded.process_instance_id),
            );
        }
        fields.extend(context);
        if let Value::Object(event) = event {
            fields.extend(event);
        }
        let line = format!("{}\n", redaction::value(record));
        let size = line.len() as u64;
        if size > self.max_record_bytes || size > self.total_bytes {
            return Ok(None);
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.directory)?;
        let current = self.directory.join("system.log");
        let now = time.timestamp_millis();
        let current_size = fs::metadata(&current).ok().map(|metadata| metadata.len());
        let start = current_size.and_then(|_| self.first_record_time(&current));
        let rotate = current_size.is_some_and(|current_size| {
            current_size > 0
                && start.is_none_or(|start| {
                    current_size + size > self.segment_bytes.min(self.total_bytes)
                        || now - start > self.retention_ms
                        || DateTime::from_timestamp_millis(start).map(|start| start.date_naive())
                            != Some(time.date_naive())
                })
        });
        if rotate {
            fs::rename(
                &current,
                self.directory.join(format!(
                    "system-{}-{}.log",
                    iso(time).replace(':', "-"),
                    uuid::Uuid::new_v4()
                )),
            )?;
            self.current_start = None;
        }
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&current)?
            .write_all(line.as_bytes())?;
        self.current_start.get_or_insert(now);
        fs::set_permissions(&current, fs::Permissions::from_mode(0o600))?;
        if rotate || now - self.last_prune >= 60_000 || self.has_archive()? {
            self.last_prune = now;
            self.prune(now)?;
        }
        Ok(Some(event_id))
    }

    fn has_archive(&self) -> std::io::Result<bool> {
        Ok(fs::read_dir(&self.directory)?
            .flatten()
            .any(|entry| ARCHIVE.is_match(&entry.file_name().to_string_lossy())))
    }

    fn first_record_time(&mut self, current: &Path) -> Option<i64> {
        if self.current_start.is_some() {
            return self.current_start;
        }
        let mut file = fs::File::open(current).ok()?;
        let mut buffer = vec![0; 8192];
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        let mut last = [0];
        file.seek(SeekFrom::End(-1)).ok()?;
        file.read_exact(&mut last).ok()?;
        if last[0] != b'\n' {
            return None;
        }
        let text = String::from_utf8_lossy(&buffer[..count]);
        let record: Value = serde_json::from_str(text.split('\n').next()?).ok()?;
        let parsed = DateTime::parse_from_rfc3339(record["time"].as_str()?).ok()?;
        self.current_start = Some(parsed.timestamp_millis());
        self.current_start
    }

    fn prune(&self, now: i64) -> std::io::Result<()> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.directory)?.flatten() {
            if !ARCHIVE.is_match(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let metadata = entry.metadata()?;
            let modified = metadata
                .modified()?
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as i64);
            files.push((entry.path(), metadata.len(), modified));
        }
        files.sort_by_key(|(_, _, modified)| *modified);
        let current = fs::metadata(self.directory.join("system.log")).map_or(0, |value| value.len());
        let mut bytes = current + files.iter().map(|(_, size, _)| size).sum::<u64>();
        for (path, size, modified) in files {
            if now - modified <= self.retention_ms && bytes <= self.total_bytes {
                continue;
            }
            fs::remove_file(path)?;
            bytes -= size;
        }
        Ok(())
    }
}

fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("suplex-system-events-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc)
    }

    fn names(path: &Path) -> Vec<String> {
        let mut names = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn records_are_bounded_redacted_correlated_and_privately_written() {
        let path = directory();
        let mut writer = Writer::new(path.clone());
        let context = json!({"source":"test","requestId":"request-1","clientId":"client-1"});
        let event = json!({"type":"recovery","taskId":"task-1","state":"requested","producer":"host","result":"Bearer secret-value"});
        assert!(
            writer
                .write(event, context.as_object().unwrap().clone(), None, Utc::now())
                .is_some()
        );
        let file = path.join("system.log");
        let text = fs::read_to_string(&file).unwrap();
        let record: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(record["schemaVersion"], 1);
        assert_eq!(record["type"], "recovery");
        assert_eq!(record["requestId"], "request-1");
        assert_eq!(record["clientId"], "client-1");
        assert_eq!(record["sequence"], 1);
        assert_eq!(record["result"], "[REDACTED]");
        assert!(!text.contains("secret-value"));
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn forwarded_bridge_identity_stays_separate_from_the_writer_identity() {
        let path = directory();
        let mut writer = Writer::new(path.clone());
        let event_id = "11111111-1111-4111-8111-111111111111";
        writer.write(
            json!({"type":"task_admitted","taskId":"task-2","trigger":"prerequisite completion","prerequisiteTaskId":"task-1"}),
            json!({"source":"root_bridge","taskId":"task-1"}).as_object().unwrap().clone(),
            Some(Forwarded {
                event_id: event_id.into(),
                producer_time: "2026-09-22T12:00:00.000Z".into(),
                producer_pid: 12345,
                producer_sequence: 7,
                process_instance_id: "33333333-3333-4333-8333-333333333333".into(),
            }),
            Utc::now(),
        );
        let record: Value =
            serde_json::from_str(&fs::read_to_string(path.join("system.log")).unwrap()).unwrap();
        assert_eq!(record["eventId"], event_id);
        assert_eq!(record["pid"], std::process::id());
        assert_eq!(record["producerPid"], 12345);
        assert_eq!(record["producerSequence"], 7);
        assert_eq!(record["source"], "root_bridge");
        assert_eq!(record["taskId"], "task-2");
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn rotation_prunes_old_archives_and_enforces_total_bytes() {
        let path = directory();
        let mut writer = Writer::with_limits(path.clone(), 650, 1200, 8 * 1024);
        let time = at("2026-09-22T12:00:00Z");
        for index in 0..20 {
            writer.write(
                json!({"type":"task_status","taskId":format!("task-{index}"),"status":"active"}),
                json!({"source":"test"}).as_object().unwrap().clone(),
                None,
                time,
            );
        }
        let files = names(&path);
        assert!(files.iter().any(|name| ARCHIVE.is_match(name)));
        assert!(
            files
                .iter()
                .map(|name| fs::metadata(path.join(name)).unwrap().len())
                .sum::<u64>()
                <= 1200
        );
        let old = std::time::SystemTime::from(at("2026-09-01T12:00:00Z"));
        for name in &files {
            fs::File::options()
                .write(true)
                .open(path.join(name))
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        writer.write(
            json!({"type":"server","state":"heartbeat"}),
            Map::new(),
            None,
            at("2026-09-23T12:00:00Z"),
        );
        assert_eq!(names(&path), ["system.log"]);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn writer_failures_and_oversize_events_do_not_affect_callers() {
        let path = directory();
        let mut writer = Writer::with_limits(path.clone(), 1024, 4096, 250);
        assert!(
            writer
                .write(
                    json!({"type":"task_status","taskId":"x".repeat(1000),"status":"active"}),
                    Map::new(),
                    None,
                    Utc::now()
                )
                .is_none()
        );
        assert!(names(&path).is_empty());
        fs::write(path.join("unavailable"), "file").unwrap();
        let mut unavailable = Writer::new(path.join("unavailable/logs"));
        assert!(
            unavailable
                .write(json!({"type":"server"}), Map::new(), None, Utc::now())
                .is_none()
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn a_corrupt_current_segment_is_preserved_and_logging_resumes_in_a_clean_file() {
        let path = directory();
        fs::write(path.join("system.log"), r#"{"time":"2026-09-01T00:00:00.000Z""#).unwrap();
        let mut writer = Writer::new(path.clone());
        assert!(
            writer
                .write(
                    json!({"type":"server","state":"heartbeat"}),
                    Map::new(),
                    None,
                    at("2026-09-22T12:00:00Z")
                )
                .is_some()
        );
        let record: Value =
            serde_json::from_str(&fs::read_to_string(path.join("system.log")).unwrap()).unwrap();
        assert_eq!(record["state"], "heartbeat");
        let archives = names(&path)
            .into_iter()
            .filter(|name| ARCHIVE.is_match(name))
            .collect::<Vec<_>>();
        assert_eq!(archives.len(), 1);
        assert_eq!(
            fs::read_to_string(path.join(&archives[0])).unwrap(),
            r#"{"time":"2026-09-01T00:00:00.000Z""#
        );
        fs::remove_dir_all(path).unwrap();
    }
}
