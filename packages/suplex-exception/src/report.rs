use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::frames::{self, relative_path};

/// Thread names Suplex sets itself. Any other name could carry user content.
const THREADS: [&str; 2] = ["main", "tokio-runtime-worker"];
const MAX_ATTRIBUTE: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    pub function: String,
    pub filename: Option<String>,
    pub lineno: Option<u32>,
    pub colno: Option<u32>,
    pub in_app: bool,
}

/// One exception: a fixed type and mechanism, frames, and fixed attributes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// The program that recorded it: `host`, `desktop`, `hosted`, or `billing`.
    pub source: String,
    /// A fixed exception type such as `Panic` or `InternalServerError`.
    pub kind: String,
    /// A fixed mechanism such as `panic`, `caught_panic`, or `http_internal_error`.
    pub mechanism: String,
    pub handled: bool,
    pub thread: Option<String>,
    pub frames: Vec<Frame>,
    /// Fixed route and loop names. Values are checked by [`Report::attribute`].
    pub attributes: BTreeMap<String, String>,
    pub fingerprint: String,
    /// When the first occurrence was recorded, in Unix milliseconds.
    pub recorded_at_ms: i64,
    pub last_at_ms: i64,
    pub occurrences: u32,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// A deterministic UUID-shaped PostHog event ID, so a resent event is deduplicated.
pub fn event_uuid(seed: &str) -> String {
    let hash = format!("{:x}", Sha256::digest(seed.as_bytes()));
    let mut bytes = hash.as_bytes()[..32].to_vec();
    bytes[12] = b'5';
    bytes[16] = match bytes[16] {
        b'0'..=b'3' => b'8',
        b'4'..=b'7' => b'9',
        b'8'..=b'b' => b'a',
        _ => b'b',
    };
    let hex = String::from_utf8(bytes).unwrap_or_default();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

impl Report {
    pub fn new(
        source: &'static str,
        kind: &'static str,
        mechanism: &'static str,
        handled: bool,
        frames: Vec<Frame>,
    ) -> Self {
        let mut report = Self {
            source: source.to_owned(),
            kind: kind.to_owned(),
            mechanism: mechanism.to_owned(),
            handled,
            thread: None,
            frames,
            attributes: BTreeMap::new(),
            fingerprint: String::new(),
            recorded_at_ms: now_ms(),
            last_at_ms: 0,
            occurrences: 1,
        };
        report.last_at_ms = report.recorded_at_ms;
        report.seal();
        report
    }

    /// A panic. `location` is where the panic was raised; the thread name is kept
    /// only when Suplex set it. `backtrace` is the `{:#}` text of a captured backtrace.
    pub fn panic(
        source: &'static str,
        handled: bool,
        location: Option<(&str, u32, u32)>,
        thread: Option<&str>,
        backtrace: &str,
    ) -> Self {
        let mut frames = frames::parse_frames(backtrace);
        if let Some((file, line, column)) = location
            && let Some(file) = relative_path(file)
        {
            match frames.first_mut() {
                Some(top) if top.filename.is_none() => {
                    top.filename = Some(file);
                    top.lineno = Some(line);
                    top.colno = Some(column);
                }
                Some(_) => {}
                None => frames.push(Frame {
                    function: "<panic>".to_owned(),
                    filename: Some(file),
                    lineno: Some(line),
                    colno: Some(column),
                    in_app: true,
                }),
            }
        }
        let mut report = Self::new(
            source,
            "Panic",
            if handled { "caught_panic" } else { "panic" },
            handled,
            frames,
        );
        report.thread = thread
            .filter(|name| THREADS.contains(name))
            .map(str::to_owned);
        report
    }

    /// Names the program that sends this report, which the hosted service sets
    /// after the hook recorded it as `host`.
    #[must_use]
    pub fn with_source(mut self, source: &'static str) -> Self {
        self.source = source.to_owned();
        self.seal();
        self
    }

    /// Adds a fixed attribute such as an HTTP route template. Text outside the
    /// route alphabet is dropped, so a raw path or message cannot enter.
    #[must_use]
    pub fn attribute(mut self, key: &'static str, value: &str) -> Self {
        let safe = !value.is_empty()
            && value.len() <= MAX_ATTRIBUTE
            && !value.contains("..")
            && value.chars().all(|character| {
                character.is_ascii_alphanumeric() || "/_-{}:.*".contains(character)
            });
        if safe {
            self.attributes.insert(key.to_owned(), value.to_owned());
            self.seal();
        }
        self
    }

    /// Groups equal failures: the type, mechanism, attributes, and the first
    /// Suplex frames, without line numbers, so a release does not split a group.
    fn seal(&mut self) {
        let mut seed = format!("{}\0{}\0{}", self.source, self.kind, self.mechanism);
        for (key, value) in &self.attributes {
            seed.push_str(&format!("\0{key}={value}"));
        }
        for frame in self.frames.iter().filter(|frame| frame.in_app).take(5) {
            seed.push_str(&format!(
                "\0{}@{}",
                frame.function,
                frame.filename.as_deref().unwrap_or("")
            ));
        }
        self.fingerprint = format!("{:x}", Sha256::digest(seed.as_bytes()))[..32].to_owned();
    }

    /// The PostHog event ID: one per fingerprint and first occurrence.
    pub fn uuid(&self) -> String {
        event_uuid(&format!(
            "exception\0{}\0{}",
            self.fingerprint, self.recorded_at_ms
        ))
    }

    fn value(&self) -> String {
        match self.frames.iter().find(|frame| frame.in_app) {
            Some(frame) => format!("{} in {}", self.kind, frame.function),
            None => self.kind.clone(),
        }
    }

    /// The event properties PostHog Error Tracking reads, plus fixed context.
    pub fn properties(&self) -> Map<String, Value> {
        let frames: Vec<Value> = self
            .frames
            .iter()
            .map(|frame| {
                let mut value = json!({
                    "platform": "custom",
                    "lang": "rust",
                    "function": frame.function,
                    "in_app": frame.in_app,
                    "resolved": true,
                });
                if let Some(filename) = &frame.filename {
                    value["filename"] = json!(filename);
                }
                if let Some(line) = frame.lineno {
                    value["lineno"] = json!(line);
                }
                if let Some(column) = frame.colno {
                    value["colno"] = json!(column);
                }
                value
            })
            .collect();
        let mut properties = Map::new();
        properties.insert(
            "$exception_list".into(),
            json!([{
                "type": self.kind,
                "value": self.value(),
                "mechanism": {
                    "type": self.mechanism,
                    "handled": self.handled,
                    "synthetic": !self.mechanism.ends_with("panic"),
                },
                "stacktrace": {"type": "raw", "frames": frames},
            }]),
        );
        properties.insert(
            "$exception_level".into(),
            json!(if self.handled { "error" } else { "fatal" }),
        );
        properties.insert("$exception_fingerprint".into(), json!(self.fingerprint));
        properties.insert("exception_source".into(), json!(self.source));
        properties.insert("exception_occurrences".into(), json!(self.occurrences));
        if let Some(thread) = &self.thread {
            properties.insert("exception_thread".into(), json!(thread));
        }
        for (key, value) in &self.attributes {
            properties.insert(key.clone(), json!(value));
        }
        properties
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BACKTRACE: &str =
        "   0: core::panicking::panic_fmt\n   1: suplex::tasks::run\n   2: suplex::main\n";

    #[test]
    fn a_panic_report_has_rust_frames_and_a_suplex_relative_location() {
        let report = Report::panic(
            "host",
            false,
            Some(("/home/ada/work/suplex/apps/server/src/tasks/mod.rs", 42, 9)),
            Some("main"),
            BACKTRACE,
        );
        let properties = report.properties();
        let entry = &properties["$exception_list"][0];
        assert_eq!(entry["type"], "Panic");
        assert_eq!(entry["mechanism"]["handled"], false);
        assert_eq!(entry["mechanism"]["type"], "panic");
        assert_eq!(entry["mechanism"]["synthetic"], false);
        let frame = &entry["stacktrace"]["frames"][0];
        assert_eq!(frame["lang"], "rust");
        assert_eq!(frame["platform"], "custom");
        assert_eq!(frame["function"], "suplex::tasks::run");
        assert_eq!(frame["filename"], "apps/server/src/tasks/mod.rs");
        assert_eq!(frame["lineno"], 42);
        assert_eq!(properties["$exception_level"], "fatal");
        assert_eq!(properties["exception_thread"], "main");
    }

    #[test]
    fn nothing_but_fixed_text_can_reach_a_report() {
        let report = Report::panic(
            "host",
            false,
            Some(("/home/ada/secret-project/src/main.rs", 1, 1)),
            Some("worker for ada@example.com"),
            "   0: suplex::run\n             at /home/ada/secret-project/src/lib.rs:3:4\n",
        )
        .attribute("http_route", "/Users/ada/Secret Project/token=sk-live-1234");
        let sent = serde_json::to_string(&report.properties()).unwrap();
        for leak in [
            "ada",
            "secret",
            "Secret",
            "sk-live",
            "/home",
            "/Users",
            "example.com",
        ] {
            assert!(!sent.contains(leak), "{leak} in {sent}");
        }
        assert!(report.thread.is_none() && report.attributes.is_empty());
    }

    #[test]
    fn equal_failures_share_a_fingerprint_that_ignores_line_numbers() {
        let a = Report::panic(
            "host",
            false,
            Some(("apps/server/src/a.rs", 1, 1)),
            None,
            BACKTRACE,
        );
        let b = Report::panic(
            "host",
            false,
            Some(("apps/server/src/a.rs", 9, 9)),
            None,
            BACKTRACE,
        );
        assert_eq!(a.fingerprint, b.fingerprint);
        let handled = Report::panic(
            "host",
            true,
            Some(("apps/server/src/a.rs", 1, 1)),
            None,
            BACKTRACE,
        );
        assert_ne!(a.fingerprint, handled.fingerprint);
        let route = Report::new(
            "host",
            "InternalServerError",
            "http_internal_error",
            true,
            vec![],
        )
        .attribute("http_route", "/api/tasks/{id}");
        assert_eq!(route.properties()["http_route"], "/api/tasks/{id}");
        assert!(route.properties()["$exception_list"][0]["mechanism"]["synthetic"] == true);
    }
}
