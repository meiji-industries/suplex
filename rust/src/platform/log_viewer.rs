//! `suplex logs`: the merged tail of `system-*.log` segments and `system.log`.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::system_events::ARCHIVE;

#[derive(Default)]
pub struct Options {
    pub directory: PathBuf,
    pub task_id: Option<String>,
    pub errors: bool,
    pub since: Option<String>,
    pub follow: bool,
    pub all: bool,
}

pub fn parse_since(value: &str) -> Result<i64, String> {
    let invalid = || format!("Invalid --since value: {value}. Use a duration such as 10m or 2h.");
    let (number, unit) = value.split_at(value.len().saturating_sub(1));
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let multiplier = match unit.to_ascii_lowercase().as_str() {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return Err(invalid()),
    };
    number
        .parse::<i64>()
        .ok()
        .and_then(|number| number.checked_mul(multiplier))
        .ok_or_else(invalid)
}

fn timestamp(record: &Value) -> i64 {
    record["time"]
        .as_str()
        .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
        .map_or(0, |time| time.timestamp_millis())
}

fn matches(record: &Value, options: &Options, since: Option<i64>, now: i64) -> bool {
    if !options.all && record["level"].as_u64().is_some_and(|level| level < 30) {
        return false;
    }
    if options.errors
        && record["state"] != "error"
        && record["level"].as_f64().is_none_or(|level| level < 40.0)
    {
        return false;
    }
    if let Some(task_id) = &options.task_id
        && ![&record["taskId"], &record["workflowId"], &record["url"]]
            .iter()
            .any(|value| value.as_str().is_some_and(|text| text.contains(task_id)))
    {
        return false;
    }
    since.is_none_or(|since| timestamp(record) >= now - since)
}

fn records(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(Value::is_object)
}

pub fn format(record: &Value) -> String {
    let text = |name: &str| match &record[name] {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other @ Value::Bool(_)
        | other @ Value::Number(_)
        | other @ Value::Array(_)
        | other @ Value::Object(_) => Some(other.to_string()),
    };
    let mut line = format!(
        "{}  {} {}",
        text("time").unwrap_or_default(),
        text("type").unwrap_or_else(|| "event".into()),
        text("state").unwrap_or_default()
    );
    let line_start = line.trim_end().len();
    line.truncate(line_start);
    let fields = [
        "method",
        "url",
        "requestId",
        "durationMs",
        "taskId",
        "sessionId",
        "turnId",
        "action",
        "status",
        "tool",
        "result",
        "reason",
    ]
    .iter()
    .filter_map(|name| text(name).map(|value| format!("{name}={value}")))
    .collect::<Vec<_>>();
    if !fields.is_empty() {
        line.push_str("  ");
        line.push_str(&fields.join(" "));
    }
    line
}

fn segments(directory: &Path) -> Vec<PathBuf> {
    let mut archives = fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .is_some_and(|name| ARCHIVE.is_match(&name.to_string_lossy()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    archives.sort();
    archives.push(directory.join("system.log"));
    archives
}

/// Prints the last 200 matching records. With follow enabled, polls the
/// current segment for new records until the process stops.
pub fn run(options: &Options, output: &mut impl Write) -> io::Result<()> {
    let since = options
        .since
        .as_deref()
        .map(parse_since)
        .transpose()
        .map_err(io::Error::other)?;
    let now = Utc::now().timestamp_millis();
    let mut entries = Vec::new();
    for path in segments(&options.directory) {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        entries.extend(records(&text).filter(|record| matches(record, options, since, now)));
    }
    entries.sort_by_key(timestamp);
    for record in &entries[entries.len().saturating_sub(200)..] {
        writeln!(output, "{}", format(record))?;
    }
    if !options.follow {
        return Ok(());
    }
    let current = options.directory.join("system.log");
    let mut offset = fs::metadata(&current).map_or(0, |metadata| metadata.len());
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let size = fs::metadata(&current).map_or(0, |metadata| metadata.len());
        let start = if size < offset { 0 } else { offset };
        if size > start {
            let bytes = fs::read(&current).unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes[start as usize..]);
            let now = Utc::now().timestamp_millis();
            for record in records(&text).filter(|record| matches(record, options, since, now)) {
                writeln!(output, "{}", format(&record))?;
            }
        }
        offset = size;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_segments_in_time_order_and_filters_task_and_errors() {
        let directory = std::env::temp_dir().join(format!("suplex-logs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("system-2026-08-22T12-00-00.000Z-11111111-1111-4111-8111-111111111111.log"),
            "{\"time\":\"2026-08-22T12:00:02.000Z\",\"type\":\"task_action\",\"taskId\":\"task-a\",\"action\":\"start\"}\n",
        )
        .unwrap();
        fs::write(
            directory.join("system.log"),
            [
                r#"{"time":"2026-08-22T12:00:04.000Z","type":"recovery","state":"error","taskId":"task-b","result":"bad"}"#,
                r#"{"time":"2026-08-22T12:00:03.000Z","type":"native_turn","state":"finished","taskId":"task-a","turnId":"turn-1"}"#,
                "not json",
            ]
            .join("\n"),
        )
        .unwrap();
        let mut output = Vec::new();
        let task = Options {
            directory: directory.clone(),
            task_id: Some("task-a".into()),
            ..Options::default()
        };
        run(&task, &mut output).unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "2026-08-22T12:00:02.000Z  task_action  taskId=task-a action=start\n2026-08-22T12:00:03.000Z  native_turn finished  taskId=task-a turnId=turn-1\n"
        );
        let mut output = Vec::new();
        let errors = Options {
            directory: directory.clone(),
            errors: true,
            ..Options::default()
        };
        run(&errors, &mut output).unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "2026-08-22T12:00:04.000Z  recovery error  taskId=task-b result=bad\n"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn debug_requests_are_hidden_unless_requested_and_keep_diagnostic_fields() {
        let record = serde_json::json!({"type":"http","level":20,"method":"GET","url":"/api/tasks/task-a","status":200,"requestId":"request-a","durationMs":4});
        let mut options = Options::default();
        assert!(!matches(&record, &options, None, 0));
        options.all = true;
        assert!(matches(&record, &options, None, 0));
        options.task_id = Some("task-a".into());
        assert!(matches(&record, &options, None, 0));
        let line = format(&record);
        for value in [
            "method=GET",
            "url=/api/tasks/task-a",
            "status=200",
            "requestId=request-a",
            "durationMs=4",
        ] {
            assert!(line.contains(value), "{line}");
        }
    }

    #[test]
    fn validates_since_durations() {
        assert_eq!(parse_since("10m"), Ok(600_000));
        assert_eq!(parse_since("2H"), Ok(7_200_000));
        assert!(
            parse_since("soon")
                .unwrap_err()
                .starts_with("Invalid --since value")
        );
        assert!(parse_since("m").is_err());
    }
}
