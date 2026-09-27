//! Herdr CLI client. Herdr owns workspaces and panes; everything read here is
//! an observation. Herdr does not persist pane metadata across restarts, so
//! callers never treat it as durable Suplex state.

use std::{collections::BTreeMap, fmt, io, process::Command, sync::Arc};

use serde::Deserialize;
use serde_json::Value;

#[cfg(not(test))]
const DEFAULT_BINARY: &str = "herdr";
// Unit tests inject a fake runner. A test that reaches the default client must
// not open real panes on the developer's Herdr server.
#[cfg(test)]
const DEFAULT_BINARY: &str = "suplex-test-herdr-is-unavailable";

const MISSING: [&str; 2] = ["workspace_not_found", "pane_not_found"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrFailure {
    pub code: String,
    pub retryable: bool,
    pub message: String,
}

impl HerdrFailure {
    fn new(code: &str, retryable: bool, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            retryable,
            message: message.into(),
        }
    }

    fn invalid(message: &str) -> Self {
        Self::new("invalid_response", false, message)
    }

    pub fn missing(&self) -> bool {
        MISSING.contains(&self.code.as_str())
    }
}

impl fmt::Display for HerdrFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HerdrFailure {}

pub type HerdrResult<T> = Result<T, HerdrFailure>;

#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub type Runner = Arc<dyn Fn(&[String]) -> io::Result<RunOutput> + Send + Sync>;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Workspace {
    pub workspace_id: String,
    pub label: String,
    pub raw: Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Pane {
    pub pane_id: String,
    pub workspace_id: Option<String>,
    pub label: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub tokens: BTreeMap<String, String>,
    pub raw: Value,
}

impl Pane {
    pub fn token(&self, name: &str) -> Option<&str> {
        self.tokens.get(name).map(String::as_str)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ForegroundProcess {
    pub pid: u32,
    pub name: String,
    pub argv: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProcessInfo {
    pub pane_id: String,
    pub shell_pid: Option<u32>,
    pub foreground_process_group_id: Option<u32>,
    #[serde(default)]
    pub foreground_processes: Vec<ForegroundProcess>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LayoutPane {
    pub pane_id: String,
    pub focused: bool,
    pub rect: Rect,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LayoutSplit {
    pub id: String,
    pub direction: String,
    pub ratio: f64,
    pub rect: Rect,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PaneLayout {
    pub workspace_id: String,
    pub tab_id: String,
    pub zoomed: bool,
    pub area: Rect,
    pub focused_pane_id: String,
    pub panes: Vec<LayoutPane>,
    pub splits: Vec<LayoutSplit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Viewport {
    pub ansi: String,
    pub cols: u32,
    pub rows: u32,
}

/// Display-only pane hints. See the module comment about durability.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetadataReport {
    pub pane_id: String,
    pub source: String,
    pub agent: Option<String>,
    pub applies_to_source: Option<String>,
    pub title: Option<String>,
    pub clear_title: bool,
    pub display_agent: Option<String>,
    pub clear_display_agent: bool,
    pub state_labels: Vec<(String, String)>,
    pub clear_state_labels: bool,
    pub tokens: Vec<(String, String)>,
    pub clear_tokens: Vec<String>,
    pub seq: Option<u64>,
    pub ttl_ms: Option<u64>,
}

#[derive(Clone)]
pub struct Herdr {
    pub binary: String,
    runner: Runner,
}

impl Default for Herdr {
    fn default() -> Self {
        Self::new(DEFAULT_BINARY)
    }
}

impl fmt::Debug for Herdr {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Herdr")
            .field("binary", &self.binary)
            .finish()
    }
}

fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

fn object<'a>(raw: &'a Value, key: &str) -> HerdrResult<&'a Value> {
    if !raw.is_object() {
        return Err(HerdrFailure::invalid("Herdr returned an invalid response"));
    }
    raw.get(key)
        .filter(|found| found.is_object() || found.is_array())
        .ok_or_else(|| HerdrFailure::invalid("Herdr response was missing required data"))
}

fn identifier(raw: &Value, keys: &[&str]) -> HerdrResult<String> {
    keys.iter()
        .find_map(|key| raw[*key].as_str().filter(|value| !value.is_empty()))
        .map(str::to_owned)
        .ok_or_else(|| HerdrFailure::invalid("Herdr response had no identifier"))
}

fn text(raw: &Value, key: &str) -> Option<String> {
    raw[key].as_str().map(str::to_owned)
}

fn workspace(raw: &Value) -> HerdrResult<Workspace> {
    Ok(Workspace {
        workspace_id: identifier(raw, &["workspace_id", "workspaceId"])?,
        label: raw["label"].as_str().unwrap_or_default().to_owned(),
        raw: raw.clone(),
    })
}

fn pane(raw: &Value) -> HerdrResult<Pane> {
    let tokens = raw["tokens"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
        .collect();
    Ok(Pane {
        pane_id: identifier(raw, &["pane_id", "paneId"])?,
        workspace_id: text(raw, "workspace_id"),
        label: text(raw, "label"),
        title: text(raw, "title"),
        cwd: text(raw, "cwd"),
        foreground_cwd: text(raw, "foreground_cwd"),
        tokens,
        raw: raw.clone(),
    })
}

fn classify(status: Option<i32>, stdout: &str, stderr: &str) -> HerdrFailure {
    let bodies = [stdout, stderr]
        .into_iter()
        .filter_map(parse_json)
        .filter(Value::is_object)
        .collect::<Vec<_>>();
    let body = bodies
        .iter()
        .find(|candidate| {
            candidate
                .get("error")
                .is_some_and(|error| error.is_object() || error.is_null())
                || candidate["code"].is_string()
        })
        .or(bodies.first());
    let nested = body
        .and_then(|body| body.get("error"))
        .filter(|error| error.is_object());
    let code = if status == Some(2) {
        "syntax".to_owned()
    } else {
        nested
            .and_then(|error| error["code"].as_str())
            .or_else(|| body.and_then(|body| body["code"].as_str()))
            .unwrap_or("unavailable")
            .to_owned()
    };
    let message = nested
        .and_then(|error| error["message"].as_str())
        .or_else(|| body.and_then(|body| body["message"].as_str()));
    let retryable = status != Some(2)
        && code != "syntax"
        && !["invalid_argument", "invalid_request"].contains(&code.as_str());
    let message = if MISSING.contains(&code.as_str()) {
        "Herdr resource is unavailable".to_owned()
    } else {
        message.map_or_else(
            || "Herdr command failed".to_owned(),
            |message| format!("Herdr command failed: {message}"),
        )
    };
    HerdrFailure {
        code,
        retryable,
        message,
    }
}

/// East Asian wide characters take two terminal cells. Escape sequences take none.
// ponytail: small wide-character table instead of the full Unicode width data; add unicode-width when a terminal view shows misaligned columns.
fn display_width(line: &str) -> usize {
    let mut width = 0;
    let mut chars = line.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}'
                            || (next == '\u{1b}' && chars.next_if_eq(&'\\').is_some())
                        {
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let code = character as u32;
        width += match code {
            0..=0x1f | 0x7f..=0x9f | 0x300..=0x36f | 0x200b..=0x200f | 0xfe00..=0xfe0f => 0,
            0x1100..=0x115f
            | 0x2e80..=0x303e
            | 0x3041..=0x33ff
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xa000..=0xa4cf
            | 0xac00..=0xd7a3
            | 0xf900..=0xfaff
            | 0xfe30..=0xfe4f
            | 0xff00..=0xff60
            | 0xffe0..=0xffe6
            | 0x1f300..=0x1f64f
            | 0x1f900..=0x1f9ff
            | 0x20000..=0x3fffd => 2,
            _ => 1,
        };
    }
    width
}

impl Herdr {
    pub fn new(binary: impl Into<String>) -> Self {
        let binary = binary.into();
        let program = binary.clone();
        Self {
            binary,
            runner: Arc::new(move |args: &[String]| {
                let output = Command::new(&program)
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .output()?;
                Ok(RunOutput {
                    status: output.status.code(),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                })
            }),
        }
    }

    pub fn with_runner(binary: impl Into<String>, runner: Runner) -> Self {
        Self {
            binary: binary.into(),
            runner,
        }
    }

    fn run(&self, args: &[&str]) -> HerdrResult<RunOutput> {
        let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
        match (self.runner)(&args) {
            Ok(output) if output.status == Some(0) => Ok(output),
            Ok(output) => Err(classify(output.status, &output.stdout, &output.stderr)),
            Err(_) => Err(classify(None, "", "")),
        }
    }

    fn call_allowing_empty(&self, args: &[&str], allowing_empty: bool) -> HerdrResult<Value> {
        let output = self.run(args)?;
        if allowing_empty && output.stdout.trim().is_empty() {
            return Ok(Value::Null);
        }
        let response = parse_json(&output.stdout)
            .filter(Value::is_object)
            .ok_or_else(|| HerdrFailure::invalid("Invalid Herdr JSON response"))?;
        let envelope = object(&response, "result")?.clone();
        if !response["id"].is_string() {
            return Err(HerdrFailure::invalid("Herdr response had no request id"));
        }
        Ok(envelope)
    }

    fn call(&self, args: &[&str]) -> HerdrResult<Value> {
        self.call_allowing_empty(args, false)
    }

    fn optional<T>(result: HerdrResult<T>) -> HerdrResult<Option<T>> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(failure) if failure.missing() => Ok(None),
            Err(failure) => Err(failure),
        }
    }

    fn list(result: &Value, key: &str) -> Vec<Value> {
        result[key].as_array().cloned().unwrap_or_default()
    }

    pub fn list_workspaces(&self) -> HerdrResult<Vec<Workspace>> {
        Self::list(&self.call(&["workspace", "list"])?, "workspaces")
            .iter()
            .map(workspace)
            .collect()
    }

    pub fn create_workspace(&self, label: &str, cwd: &str) -> HerdrResult<(Workspace, Pane)> {
        let result = self.call(&[
            "workspace",
            "create",
            "--label",
            label,
            "--cwd",
            cwd,
            "--no-focus",
        ])?;
        let created = workspace(object(&result, "workspace")?)?;
        identifier(object(&result, "tab")?, &["tab_id", "tabId"])?;
        Ok((created, pane(object(&result, "root_pane")?)?))
    }

    pub fn get_workspace(&self, id: &str) -> HerdrResult<Option<Workspace>> {
        Self::optional(
            self.call(&["workspace", "get", id])
                .and_then(|result| workspace(object(&result, "workspace")?)),
        )
    }

    pub fn close_workspace(&self, id: &str) -> HerdrResult<()> {
        self.call(&["workspace", "close", id]).map(|_| ())
    }

    pub fn get_pane(&self, id: &str) -> HerdrResult<Option<Pane>> {
        Self::optional(
            self.call(&["pane", "get", id])
                .and_then(|result| pane(object(&result, "pane")?)),
        )
    }

    pub fn list_panes(&self, workspace_id: &str) -> HerdrResult<Vec<Pane>> {
        Self::list(
            &self.call(&["pane", "list", "--workspace", workspace_id])?,
            "panes",
        )
        .iter()
        .map(pane)
        .collect()
    }

    pub fn get_pane_layout(&self, id: &str) -> HerdrResult<PaneLayout> {
        let result = self.call(&["pane", "layout", "--pane", id])?;
        serde_json::from_value(result["layout"].clone())
            .map_err(|_| HerdrFailure::invalid("Herdr returned an invalid pane layout"))
    }

    pub fn get_pane_process_info(&self, id: &str) -> HerdrResult<ProcessInfo> {
        let result = self.call(&["pane", "process-info", "--pane", id])?;
        let info: ProcessInfo = serde_json::from_value(result["process_info"].clone())
            .ok()
            .filter(|info: &ProcessInfo| !info.pane_id.is_empty())
            .ok_or_else(|| HerdrFailure::invalid("Herdr returned invalid process information"))?;
        if info.pane_id != id {
            return Err(HerdrFailure::invalid(
                "Herdr returned another pane's process information",
            ));
        }
        Ok(info)
    }

    pub fn read_pane_viewport(&self, id: &str) -> HerdrResult<Viewport> {
        let current = self.get_pane(id)?;
        let layout = self.get_pane_layout(id).ok();
        let visible = self
            .run(&["pane", "read", id, "--source", "visible", "--ansi"])
            .map_err(|failure| HerdrFailure {
                message: "Herdr command failed".into(),
                ..failure
            })?;
        let current = current.ok_or_else(|| {
            HerdrFailure::new("pane_not_found", true, "Herdr resource is unavailable")
        })?;
        let viewport_rows = current.raw["scroll"]["viewport_rows"]
            .as_u64()
            .filter(|rows| (1..=65_535).contains(rows));
        let mut lines = visible
            .stdout
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .collect::<Vec<_>>();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        let content_cols = lines
            .iter()
            .map(|line| display_width(line))
            .max()
            .unwrap_or(0) as u64;
        let line_count = lines.len() as u64;
        let cols = 1
            .max(
                layout
                    .as_ref()
                    .map_or(0, |layout| u64::from(layout.area.width)),
            )
            .max(content_cols);
        let rows = match viewport_rows {
            Some(rows) => 1.max(rows).max(line_count),
            None => 1
                .max(
                    layout
                        .as_ref()
                        .map_or(0, |layout| u64::from(layout.area.height)),
                )
                .max(line_count),
        };
        if cols > 65_535 || rows > 65_535 {
            return Err(HerdrFailure::invalid(
                "Herdr terminal dimensions exceeded the protocol range",
            ));
        }
        Ok(Viewport {
            ansi: visible.stdout,
            cols: cols as u32,
            rows: rows as u32,
        })
    }

    pub fn split_pane(
        &self,
        pane_id: &str,
        direction: &str,
        ratio: Option<f64>,
        cwd: &str,
    ) -> HerdrResult<Pane> {
        let ratio = ratio.map(|ratio| ratio.to_string());
        let mut args = vec!["pane", "split", pane_id, "--direction", direction];
        if let Some(ratio) = &ratio {
            args.extend(["--ratio", ratio]);
        }
        args.extend(["--cwd", cwd, "--no-focus"]);
        pane(object(&self.call(&args)?, "pane")?)
    }

    pub fn resize_pane(&self, pane_id: &str, direction: &str, amount: f64) -> HerdrResult<()> {
        let amount = amount.to_string();
        self.call(&[
            "pane",
            "resize",
            "--pane",
            pane_id,
            "--direction",
            direction,
            "--amount",
            &amount,
        ])
        .map(|_| ())
    }

    pub fn rename_pane(&self, id: &str, label: &str) -> HerdrResult<()> {
        self.call(&["pane", "rename", id, label]).map(|_| ())
    }

    pub fn run_pane_command(&self, id: &str, command: &str) -> HerdrResult<()> {
        self.call_allowing_empty(&["pane", "run", id, command], true)
            .map(|_| ())
    }

    pub fn close_pane(&self, id: &str) -> HerdrResult<()> {
        self.call(&["pane", "close", id]).map(|_| ())
    }

    pub fn report_pane_metadata(&self, input: &MetadataReport) -> HerdrResult<()> {
        let mut args = vec![
            "pane".to_owned(),
            "report-metadata".to_owned(),
            input.pane_id.clone(),
            "--source".to_owned(),
            input.source.clone(),
        ];
        let mut value =
            |flag: &str, value: &Option<String>, clear: Option<(bool, &str)>| match value {
                Some(value) => args.extend([flag.to_owned(), value.clone()]),
                None if clear.is_some_and(|(clear, _)| clear) => {
                    args.push(clear.map(|(_, name)| name).unwrap_or_default().to_owned());
                }
                None => {}
            };
        value("--agent", &input.agent, None);
        value("--applies-to-source", &input.applies_to_source, None);
        value(
            "--title",
            &input.title,
            Some((input.clear_title, "--clear-title")),
        );
        value(
            "--display-agent",
            &input.display_agent,
            Some((input.clear_display_agent, "--clear-display-agent")),
        );
        if input.clear_state_labels {
            args.push("--clear-state-labels".into());
        }
        for (status, label) in &input.state_labels {
            args.extend(["--state-label".into(), format!("{status}={label}")]);
        }
        for name in &input.clear_tokens {
            args.extend(["--clear-token".into(), name.clone()]);
        }
        for (name, value) in &input.tokens {
            args.extend(["--token".into(), format!("{name}={value}")]);
        }
        if let Some(seq) = input.seq {
            args.extend(["--seq".into(), seq.to_string()]);
        }
        if let Some(ttl) = input.ttl_ms {
            args.extend(["--ttl-ms".into(), ttl.to_string()]);
        }
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        self.call_allowing_empty(&args, true).map(|_| ())
    }
}

/// Test support: a scripted Herdr CLI keyed on argv.
#[cfg(test)]
pub mod fake {
    use std::sync::{Arc, Mutex};

    use serde_json::Map;

    use super::*;

    pub fn ok(value: Value) -> io::Result<RunOutput> {
        Ok(RunOutput {
            status: Some(0),
            stdout: value.to_string(),
            stderr: String::new(),
        })
    }

    pub fn envelope(result: Value) -> io::Result<RunOutput> {
        ok(serde_json::json!({"id": "request", "result": result}))
    }

    pub fn failed(stderr: Value) -> io::Result<RunOutput> {
        Ok(RunOutput {
            status: Some(1),
            stdout: String::new(),
            stderr: stderr.to_string(),
        })
    }

    pub fn herdr(
        respond: impl Fn(&[String]) -> io::Result<RunOutput> + Send + Sync + 'static,
    ) -> (Herdr, Arc<Mutex<Vec<Vec<String>>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let runner: Runner = Arc::new(move |args: &[String]| {
            recorded.lock().unwrap().push(args.to_vec());
            respond(args)
        });
        (Herdr::with_runner("herdr", runner), calls)
    }

    pub fn pane_value(pane: &Pane) -> Value {
        let mut value = Map::new();
        value.insert("pane_id".into(), pane.pane_id.clone().into());
        for (key, field) in [
            ("workspace_id", &pane.workspace_id),
            ("label", &pane.label),
            ("title", &pane.title),
            ("cwd", &pane.cwd),
            ("foreground_cwd", &pane.foreground_cwd),
        ] {
            if let Some(field) = field {
                value.insert(key.into(), field.clone().into());
            }
        }
        if !pane.tokens.is_empty() {
            value.insert("tokens".into(), serde_json::json!(pane.tokens));
        }
        Value::Object(value)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{fake::*, *};

    fn layout_value(width: u32, height: u32) -> Value {
        json!({"layout": {"workspace_id":"w1","tab_id":"w1:t1","zoomed":false,"focused_pane_id":"w1:p1",
            "area":{"x":0,"y":0,"width":width,"height":height},
            "panes":[{"pane_id":"w1:p1","focused":true,"rect":{"x":0,"y":0,"width":width,"height":height}}],"splits":[]}})
    }

    #[test]
    fn process_observations_retain_foreground_argv_and_reject_another_panes_identity() {
        let (client, calls) = herdr(|_| {
            envelope(
                json!({"process_info":{"pane_id":"w1:p2","shell_pid":10,"foreground_process_group_id":11,
                "foreground_processes":[{"pid":11,"name":"opencode","argv":["/bin/opencode","attach"]}]}}),
            )
        });
        assert_eq!(
            client
                .get_pane_process_info("w1:p2")
                .unwrap()
                .foreground_processes[0]
                .argv,
            Some(vec!["/bin/opencode".to_owned(), "attach".to_owned()])
        );
        assert_eq!(
            calls.lock().unwrap()[0],
            ["pane", "process-info", "--pane", "w1:p2"]
        );
        assert!(
            client
                .get_pane_process_info("w1:p3")
                .unwrap_err()
                .message
                .contains("another pane")
        );
    }

    #[test]
    fn client_validates_json_envelopes_and_passes_unambiguous_argv() {
        let (client, calls) =
            herdr(|_| envelope(json!({"workspace":{"workspace_id":"w1","label":"suplex"}})));
        assert_eq!(
            client
                .get_workspace("w1; rm -rf /")
                .unwrap()
                .unwrap()
                .workspace_id,
            "w1"
        );
        assert_eq!(
            calls.lock().unwrap()[0],
            ["workspace", "get", "w1; rm -rf /"]
        );
    }

    #[test]
    fn pane_layout_and_sizing_methods_validate_geometry_and_pass_exact_argv() {
        let (client, calls) = herdr(|args| match args[1].as_str() {
            "layout" => envelope(layout_value(120, 60)),
            "resize" => envelope(json!({"resize":{}})),
            _ => envelope(json!({"pane":{"pane_id":"w1:p2"}})),
        });
        let layout = client.get_pane_layout("w1:p1").unwrap();
        assert_eq!((layout.tab_id.as_str(), layout.area.width), ("w1:t1", 120));
        assert_eq!(layout.panes[0].pane_id, "w1:p1");
        client.resize_pane("w1:p1", "down", 1.0 / 6.0).unwrap();
        client
            .split_pane("w1:p1", "down", Some(0.5), "/repo")
            .unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                vec!["pane", "layout", "--pane", "w1:p1"],
                vec![
                    "pane",
                    "resize",
                    "--pane",
                    "w1:p1",
                    "--direction",
                    "down",
                    "--amount",
                    "0.16666666666666666"
                ],
                vec![
                    "pane",
                    "split",
                    "w1:p1",
                    "--direction",
                    "down",
                    "--ratio",
                    "0.5",
                    "--cwd",
                    "/repo",
                    "--no-focus"
                ],
            ]
        );
    }

    #[test]
    fn read_only_viewport_snapshots_use_native_rows_and_the_widest_unicode_content() {
        let ansi = format!("\u{1b}[31m{}界\u{1b}[0m\r\nshort", "x".repeat(90));
        let expected = ansi.clone();
        let (client, _) = herdr(move |args| match args[1].as_str() {
            "get" => envelope(
                json!({"pane":{"pane_id":"w1:p1","scroll":{"offset_from_bottom":0,"max_offset_from_bottom":0,"viewport_rows":49}}}),
            ),
            "layout" => envelope(layout_value(80, 12)),
            "read" => Ok(RunOutput {
                status: Some(0),
                stdout: ansi.clone(),
                stderr: String::new(),
            }),
            _ => panic!("unexpected command"),
        });
        assert_eq!(
            client.read_pane_viewport("w1:p1").unwrap(),
            Viewport {
                ansi: expected,
                cols: 92,
                rows: 49
            }
        );
        let (client, _) = herdr(|args| match args[1].as_str() {
            "get" => envelope(json!({"pane":{"pane_id":"w1:p1","scroll":{"viewport_rows":25}}})),
            "layout" => envelope(layout_value(120, 49)),
            _ => Ok(RunOutput {
                status: Some(0),
                stdout: "first\nsecond\nbottom".into(),
                stderr: String::new(),
            }),
        });
        assert_eq!(client.read_pane_viewport("w1:p1").unwrap().rows, 25);
    }

    #[test]
    fn client_fails_closed_for_malformed_output_and_classifies_syntax_failures() {
        let (malformed, _) = herdr(|_| {
            Ok(RunOutput {
                status: Some(0),
                stdout: "not-json".into(),
                stderr: String::new(),
            })
        });
        let failure = malformed.list_workspaces().unwrap_err();
        assert_eq!(
            (failure.code.as_str(), failure.retryable),
            ("invalid_response", false)
        );
        let (syntax, _) = herdr(|_| {
            Ok(RunOutput {
                status: Some(2),
                stdout: String::new(),
                stderr: r#"{"error":{"code":"invalid_argument"}}"#.into(),
            })
        });
        let failure = syntax.list_workspaces().unwrap_err();
        assert_eq!(
            (failure.code.as_str(), failure.retryable),
            ("syntax", false)
        );
    }

    #[test]
    fn client_recognizes_missing_resources_from_stdout_and_stderr() {
        let body = json!({"error":{"code":"workspace_not_found","message":"workspace w2E not found"},"id":"cli:workspace:get"});
        let from_stderr = body.clone();
        let (client, _) = herdr(move |_| failed(from_stderr.clone()));
        assert_eq!(client.get_workspace("w2E").unwrap(), None);
        let (client, _) = herdr(move |_| {
            Ok(RunOutput {
                status: Some(1),
                stdout: body.to_string(),
                stderr: String::new(),
            })
        });
        assert_eq!(client.get_workspace("w2E").unwrap(), None);
        let (client, _) = herdr(|_| failed(json!({"error":{"code":"pane_not_found"}})));
        assert_eq!(client.get_pane("missing-pane").unwrap(), None);
    }

    #[test]
    fn client_preserves_non_missing_error_details_and_retryable_timeouts() {
        let (client, _) = herdr(|_| {
            Ok(RunOutput {
                status: Some(1),
                stdout:
                    json!({"error":{"code":"workspace_busy","message":"workspace w2E is busy"}})
                        .to_string(),
                stderr: String::new(),
            })
        });
        let failure = client.list_workspaces().unwrap_err();
        assert_eq!(failure.code, "workspace_busy");
        assert_eq!(
            failure.message,
            "Herdr command failed: workspace w2E is busy"
        );
        let (client, _) = herdr(|_| {
            failed(
                json!({"error":{"code":"timeout","message":"timed out waiting for output match"}}),
            )
        });
        let failure = client.get_pane("w9:p2").unwrap_err();
        assert_eq!(
            (
                failure.code.as_str(),
                failure.retryable,
                failure.message.as_str()
            ),
            (
                "timeout",
                true,
                "Herdr command failed: timed out waiting for output match"
            )
        );
        let (client, _) = herdr(|_| Err(io::Error::from(io::ErrorKind::NotFound)));
        let failure = client.get_pane("w9:p2").unwrap_err();
        assert_eq!(
            (failure.code.as_str(), failure.retryable),
            ("unavailable", true)
        );
    }

    #[test]
    fn pane_run_accepts_empty_success_but_classifies_error_envelopes() {
        let (client, _) = herdr(|_| {
            Ok(RunOutput {
                status: Some(0),
                ..RunOutput::default()
            })
        });
        client.run_pane_command("w9:p2", "printf ready").unwrap();
        let (client, _) = herdr(|_| failed(json!({"error":{"code":"workspace_not_found"}})));
        let failure = client
            .run_pane_command("w9:p2", "printf ready")
            .unwrap_err();
        assert_eq!(
            (failure.code.as_str(), failure.message.as_str()),
            ("workspace_not_found", "Herdr resource is unavailable")
        );
        let (client, _) = herdr(|_| {
            Ok(RunOutput {
                status: Some(0),
                stdout: " ".into(),
                stderr: String::new(),
            })
        });
        let failure = client.list_workspaces().unwrap_err();
        assert_eq!(
            (failure.code.as_str(), failure.retryable),
            ("invalid_response", false)
        );
    }

    #[test]
    fn pane_metadata_reports_use_unambiguous_argv_for_values_and_clears() {
        let (client, calls) = herdr(|_| {
            Ok(RunOutput {
                status: Some(0),
                ..RunOutput::default()
            })
        });
        client
            .report_pane_metadata(&MetadataReport {
                pane_id: "w9:p2; echo unsafe".into(),
                source: "suplex".into(),
                agent: Some("codex --verbose".into()),
                applies_to_source: Some("herdr:codex".into()),
                title: Some("Review = now; still one arg".into()),
                display_agent: Some("Codex worker".into()),
                state_labels: vec![
                    ("working".into(), "Reviewing=logs".into()),
                    ("blocked".into(), "Needs input".into()),
                ],
                tokens: vec![
                    ("suplex_binding_id".into(), "binding-1".into()),
                    ("suplex_task_id".into(), "task=1".into()),
                ],
                seq: Some(42),
                ttl_ms: Some(60_000),
                ..MetadataReport::default()
            })
            .unwrap();
        client
            .report_pane_metadata(&MetadataReport {
                pane_id: "w9:p2".into(),
                source: "suplex".into(),
                clear_title: true,
                clear_display_agent: true,
                clear_state_labels: true,
                clear_tokens: vec!["suplex_binding_id".into(), "suplex_task_id".into()],
                ..MetadataReport::default()
            })
            .unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                vec![
                    "pane",
                    "report-metadata",
                    "w9:p2; echo unsafe",
                    "--source",
                    "suplex",
                    "--agent",
                    "codex --verbose",
                    "--applies-to-source",
                    "herdr:codex",
                    "--title",
                    "Review = now; still one arg",
                    "--display-agent",
                    "Codex worker",
                    "--state-label",
                    "working=Reviewing=logs",
                    "--state-label",
                    "blocked=Needs input",
                    "--token",
                    "suplex_binding_id=binding-1",
                    "--token",
                    "suplex_task_id=task=1",
                    "--seq",
                    "42",
                    "--ttl-ms",
                    "60000"
                ],
                vec![
                    "pane",
                    "report-metadata",
                    "w9:p2",
                    "--source",
                    "suplex",
                    "--clear-title",
                    "--clear-display-agent",
                    "--clear-state-labels",
                    "--clear-token",
                    "suplex_binding_id",
                    "--clear-token",
                    "suplex_task_id"
                ],
            ]
        );
    }
}
