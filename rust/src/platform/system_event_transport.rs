//! Local socket that carries Root bridge events into the server's system log,
//! as `platform/system-event-transport.ts` does. Delivery is best effort: a
//! missing receiver drops the event and never affects the producer.

use std::{
    io::Write,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, net::UnixListener, task::JoinHandle};

use super::system_events::Forwarded;

const MAX_BYTES: usize = 8192;

pub fn socket_path(database_path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(database_path).ok()?;
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    let digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Some(std::env::temp_dir().join(format!(
        "suplex-system-{}-{}.sock",
        unsafe { libc::getuid() },
        &digest[..20]
    )))
}

pub struct Producer {
    path: PathBuf,
    process_instance_id: String,
    sequence: AtomicU64,
    in_flight: Arc<AtomicUsize>,
}

impl Producer {
    pub fn new(database_path: &Path) -> Option<Self> {
        Some(Self {
            path: socket_path(database_path)?,
            process_instance_id: uuid::Uuid::new_v4().to_string(),
            sequence: AtomicU64::new(0),
            in_flight: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn send(&self, event: Value, context: &Map<String, Value>) -> Option<String> {
        let event_id = uuid::Uuid::new_v4().to_string();
        let task_id = context
            .get("taskId")
            .or_else(|| event.get("taskId"))
            .cloned()
            .unwrap_or_else(|| json!("unknown"));
        let mut wire_context = json!({
            "source": "root_bridge",
            "taskId": task_id,
            "trigger": context.get("trigger").cloned().unwrap_or_else(|| json!("bridge")),
        });
        if let Some(cause) = context.get("causeEventId") {
            wire_context["causeEventId"] = cause.clone();
        }
        let wire = json!({
            "schemaVersion": 1,
            "event": event,
            "context": wire_context,
            "meta": {
                "eventId": event_id,
                "producerTime": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                "producerPid": std::process::id(),
                "producerSequence": self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
                "processInstanceId": self.process_instance_id,
            },
        });
        let line = format!("{wire}\n");
        if line.len() > MAX_BYTES || self.in_flight.load(Ordering::Relaxed) >= 32 {
            return None;
        }
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        let (path, in_flight) = (self.path.clone(), self.in_flight.clone());
        std::thread::spawn(move || {
            if let Ok(mut socket) = UnixStream::connect(&path) {
                let _ = socket.set_write_timeout(Some(Duration::from_secs(1)));
                let _ = socket.write_all(line.as_bytes());
            }
            in_flight.fetch_sub(1, Ordering::Relaxed);
        });
        Some(event_id)
    }
}

pub struct Receiver {
    path: PathBuf,
    inode: u64,
    server: JoinHandle<()>,
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.server.abort();
        if std::fs::symlink_metadata(&self.path).is_ok_and(|metadata| metadata.ino() == self.inode)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

type Sink = Arc<dyn Fn(Value, Map<String, Value>, Forwarded) + Send + Sync>;

/// Listens until the returned receiver drops. Another live receiver keeps the
/// socket; a stale socket file is replaced.
pub async fn start_receiver(
    database_path: &Path,
    sink: impl Fn(Value, Map<String, Value>, Forwarded) + Send + Sync + 'static,
) -> Option<Receiver> {
    let path = socket_path(database_path)?;
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            let socket = std::fs::symlink_metadata(&path)
                .ok()?
                .file_type()
                .is_socket();
            let stale = matches!(
                tokio::time::timeout(Duration::from_millis(300), tokio::net::UnixStream::connect(&path)).await,
                Ok(Err(error)) if matches!(error.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound)
            );
            if !socket || !stale {
                return None;
            }
            std::fs::remove_file(&path).ok()?;
            UnixListener::bind(&path).ok()?
        }
        Err(_) => return None,
    };
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok()?;
    let inode = std::fs::metadata(&path).ok()?.ino();
    let sink: Sink = Arc::new(sink);
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((socket, _)) = accepted else { continue };
                    connections.spawn(receive(socket, sink.clone()));
                }
                Some(_) = connections.join_next() => {}
            }
        }
    });
    Some(Receiver {
        path,
        inode,
        server,
    })
}

async fn receive(mut socket: tokio::net::UnixStream, sink: Sink) {
    let mut buffer = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(1), async {
        let mut chunk = [0; 1024];
        loop {
            let count = socket.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..count]);
            if buffer.len() > MAX_BYTES {
                return None;
            }
            if buffer.ends_with(b"\n") {
                return Some(());
            }
        }
    })
    .await;
    if !matches!(read, Ok(Some(()))) {
        return;
    }
    let Ok(wire) = serde_json::from_slice::<Value>(&buffer[..buffer.len() - 1]) else {
        return;
    };
    if let Some((event, context, meta)) = parse_wire(wire) {
        sink(event, context, meta);
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Id,
    Text(usize),
    OneOf(&'static [&'static str]),
    NonNegative,
    NonNegativeOrNull,
    PositiveInteger,
    IntegerOrNull,
    TextOrNull(usize),
    Boolean,
    Uuid,
    Waits,
    Ids(usize),
}

use Kind::*;

const SHORT: Kind = Text(120);
const WAIT_REASONS: &[&str] = &[
    "prerequisite_not_started",
    "prerequisite_running",
    "prerequisite_needs_human",
    "prerequisite_cancelled",
    "prerequisite_archived",
    "prerequisite_merge_unobserved",
    "prerequisite_pull_request_open",
    "prerequisite_pull_request_closed",
];

/// Field rules for each bridge event; a trailing `?` marks an optional field.
fn event_fields(kind: &str) -> Option<&'static [(&'static str, Kind)]> {
    Some(match kind {
        "task_status" => &[("taskId", Id), ("status", Text(32)), ("previousStatus?", Text(32))],
        "queue_wait" => &[("taskId", Id), ("waits", Waits)],
        "task_admitted" => &[("taskId", Id), ("trigger", Text(120)), ("prerequisiteTaskId?", Id)],
        "task_action" => &[("taskId", Id), ("action", Text(80))],
        "bridge_tool" => &[
            ("taskId", Id),
            ("state", OneOf(&["requested", "completed", "error"])),
            ("tool", Text(80)),
            ("result?", Text(80)),
        ],
        "recovery" => &[
            ("taskId", Id),
            ("state", OneOf(&["requested", "started", "finished", "error"])),
            ("producer", OneOf(&["host"])),
            ("durationMs?", NonNegative),
            ("result?", SHORT),
        ],
        "headless_process" => &[
            ("state", OneOf(&["dispatched", "started", "exit_observed"])),
            ("taskId", Id),
            ("sessionId", Id),
            ("turnId", Id),
            ("generation", Id),
            ("targetPid?", PositiveInteger),
            ("startTime?", SHORT),
            ("exitCode?", IntegerOrNull),
            ("exitSignal?", TextOrNull(120)),
        ],
        "command_process" => &[
            ("state", OneOf(&["running", "finished", "error"])),
            ("taskId", Id),
            ("stepId?", Id),
            ("commandId", Uuid),
            ("targetPid?", PositiveInteger),
            ("exitCode?", IntegerOrNull),
            ("exitSignal?", TextOrNull(120)),
            ("durationMs?", NonNegative),
            ("timedOut?", Boolean),
        ],
        "process_signal" => &[
            ("state", OneOf(&["requested", "sent", "skipped", "error"])),
            ("targetPid", PositiveInteger),
            ("targetStartTime?", SHORT),
            ("targetName?", SHORT),
            ("senderPid", PositiveInteger),
            ("signal", SHORT),
            ("reason", SHORT),
            ("result?", SHORT),
        ],
        "native_turn" => &[
            ("state", OneOf(&["observed", "dispatched", "finished", "snapshot", "agent_final"])),
            ("taskId", Id),
            ("sessionId", Id),
            ("turnId", Id),
            ("nativeState?", SHORT),
            ("reason?", SHORT),
            ("admission?", SHORT),
            ("elapsedMs?", NonNegative),
            ("outputAgeMs?", NonNegativeOrNull),
            ("unsettledToolIds?", Ids(32)),
            ("processRunning?", Boolean),
        ],
        _ => return None,
    })
}

fn valid(value: &Value, kind: Kind) -> bool {
    let length = |text: &str| text.encode_utf16().count();
    match kind {
        Id => value.as_str().is_some_and(|text| {
            (1..=256).contains(&length(text))
                && text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
        }),
        Text(max) => value.as_str().is_some_and(|text| length(text) <= max),
        OneOf(options) => value.as_str().is_some_and(|text| options.contains(&text)),
        NonNegative => value.as_f64().is_some_and(|number| number >= 0.0),
        NonNegativeOrNull => value.is_null() || valid(value, NonNegative),
        PositiveInteger => value.as_u64().is_some_and(|number| number > 0),
        IntegerOrNull => value.is_null() || value.is_i64() || value.is_u64(),
        TextOrNull(max) => value.is_null() || valid(value, Text(max)),
        Boolean => value.is_boolean(),
        Uuid => value
            .as_str()
            .is_some_and(|text| uuid::Uuid::parse_str(text).is_ok() && text.len() == 36),
        Waits => value.as_array().is_some_and(|waits| {
            waits.len() <= 64
                && waits.iter().all(|wait| {
                    strict(wait, &[("id", Id), ("reason", OneOf(WAIT_REASONS))])
                })
        }),
        Ids(max) => value
            .as_array()
            .is_some_and(|ids| ids.len() <= max && ids.iter().all(|id| valid(id, Id))),
    }
}

fn strict(value: &Value, fields: &[(&str, Kind)]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let known = |key: &str| {
        fields
            .iter()
            .any(|(name, _)| name.trim_end_matches('?') == key)
    };
    object.keys().all(|key| known(key))
        && fields.iter().all(|(name, kind)| {
            let optional = name.ends_with('?');
            match object.get(name.trim_end_matches('?')) {
                Some(value) => valid(value, *kind),
                None => optional,
            }
        })
}

fn parse_wire(wire: Value) -> Option<(Value, Map<String, Value>, Forwarded)> {
    let object = wire.as_object()?;
    if object.len() != 4 || wire["schemaVersion"] != 1 {
        return None;
    }
    let event = &wire["event"];
    let fields = event_fields(event["type"].as_str()?)?;
    let without_type = event.as_object().map(|fields| {
        let mut fields = fields.clone();
        fields.remove("type");
        Value::Object(fields)
    })?;
    if !strict(&without_type, fields) {
        return None;
    }
    let context = &wire["context"];
    if !strict(
        context,
        &[
            ("source", OneOf(&["root_bridge"])),
            ("taskId", Id),
            ("trigger", Text(80)),
            ("causeEventId?", Uuid),
        ],
    ) {
        return None;
    }
    let meta = &wire["meta"];
    if !strict(
        meta,
        &[
            ("eventId", Uuid),
            ("producerTime", Text(64)),
            ("producerPid", PositiveInteger),
            ("producerSequence", IntegerOrNull),
            ("processInstanceId", Uuid),
        ],
    ) || !meta["producerSequence"].is_u64()
        || !meta["producerTime"]
            .as_str()
            .is_some_and(|time| time.ends_with('Z') && DateTime::parse_from_rfc3339(time).is_ok())
    {
        return None;
    }
    Some((
        event.clone(),
        context.as_object()?.clone(),
        Forwarded {
            event_id: meta["eventId"].as_str()?.to_owned(),
            producer_time: meta["producerTime"].as_str()?.to_owned(),
            producer_pid: meta["producerPid"].as_u64()?,
            producer_sequence: meta["producerSequence"].as_u64()?,
            process_instance_id: meta["processInstanceId"].as_str()?.to_owned(),
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    async fn until(predicate: impl Fn() -> bool) {
        for _ in 0..200 {
            if predicate() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for the local event receiver");
    }

    fn database() -> (PathBuf, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("suplex-event-ipc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("suplex.sqlite");
        std::fs::write(&database, "database marker").unwrap();
        (directory, database)
    }

    #[tokio::test]
    async fn bridge_events_cross_the_socket_with_producer_identity_after_restart() {
        let (directory, database) = database();
        let received = Arc::new(Mutex::new(Vec::<(Value, Map<String, Value>, Forwarded)>::new()));
        let sink = {
            let received = received.clone();
            move |event, context, meta| received.lock().unwrap().push((event, context, meta))
        };
        let producer = Producer::new(&database).unwrap();
        let receiver = start_receiver(&database, sink.clone()).await.unwrap();
        assert!(start_receiver(&database, sink.clone()).await.is_none());
        let context = json!({"taskId":"task-1","trigger":"request_delivery"});
        let context = context.as_object().unwrap();
        let cause = producer
            .send(
                json!({"type":"bridge_tool","taskId":"task-1","state":"requested","tool":"request_delivery"}),
                context,
            )
            .unwrap();
        until(|| received.lock().unwrap().len() == 1).await;
        let mut caused = context.clone();
        caused.insert("causeEventId".into(), json!(cause));
        producer.send(
            json!({"type":"task_admitted","taskId":"task-2","trigger":"prerequisite completion","prerequisiteTaskId":"task-1"}),
            &caused,
        );
        until(|| received.lock().unwrap().len() == 2).await;
        {
            let received = received.lock().unwrap();
            let (event, context, meta) = &received[1];
            assert_eq!(event["prerequisiteTaskId"], "task-1");
            assert_eq!(context["source"], "root_bridge");
            assert_eq!(context["taskId"], "task-1");
            assert_eq!(context["causeEventId"], received[0].2.event_id.as_str());
            assert_eq!(meta.producer_pid, u64::from(std::process::id()));
            assert_eq!(meta.process_instance_id, received[0].2.process_instance_id);
        }
        drop(receiver);
        assert!(
            producer
                .send(
                    json!({"type":"task_action","taskId":"task-1","action":"offline"}),
                    context
                )
                .is_some()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _receiver = start_receiver(&database, sink).await.unwrap();
        producer.send(
            json!({"type":"task_action","taskId":"task-1","action":"reconnected"}),
            context,
        );
        until(|| {
            received
                .lock()
                .unwrap()
                .iter()
                .any(|(event, _, _)| event["action"] == "reconnected")
        })
        .await;
        assert!(
            !received
                .lock()
                .unwrap()
                .iter()
                .any(|(event, _, _)| event["action"] == "offline")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn malformed_and_oversized_input_is_ignored() {
        let (directory, database) = database();
        let received = Arc::new(AtomicUsize::new(0));
        let counter = received.clone();
        let _receiver = start_receiver(&database, move |_, _, _| {
            counter.fetch_add(1, Ordering::Relaxed);
        })
        .await
        .unwrap();
        let path = socket_path(&database).unwrap();
        for payload in [
            "{bad json}\n".to_owned(),
            format!("{}\n", "x".repeat(9000)),
            format!(
                "{}\n",
                json!({"schemaVersion":1,"event":{"type":"task_action","taskId":"t","action":"a","extra":1},"context":{"source":"root_bridge","taskId":"t","trigger":"x"},"meta":{"eventId":uuid::Uuid::new_v4(),"producerTime":"2026-09-22T12:00:00.000Z","producerPid":1,"producerSequence":1,"processInstanceId":uuid::Uuid::new_v4()}})
            ),
        ] {
            let mut socket = UnixStream::connect(&path).unwrap();
            let _ = socket.write_all(payload.as_bytes());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(received.load(Ordering::Relaxed), 0);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
