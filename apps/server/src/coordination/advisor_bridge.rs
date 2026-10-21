use super::CoordinationError;
use std::{io, path::PathBuf};

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::identity::auth::js_trim;

use super::bridge_auth::{self, ADVISOR_BINDING_ENV, ADVISOR_RESULT_ENV, ADVISOR_TOKEN_ENV};

crate::shared::wire_enum! {
    pub enum AdvisorRole {
        Reviewer = "reviewer",
        PlannerA = "planner_a",
        PlannerB = "planner_b",
        Rater = "rater",
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    version: u8,
    token: String,
    role: AdvisorRole,
    server: ServerCommand,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ServerCommand {
    command: String,
    args: Vec<String>,
}

pub struct AdvisorBridge {
    role: AdvisorRole,
    result_path: Option<PathBuf>,
}

pub struct AdvisorLaunchBinding {
    pub binding_path: PathBuf,
    pub token: String,
}

pub fn advisor_result_path(
    runtime_directory: &std::path::Path,
    turn_id: &str,
) -> io::Result<PathBuf> {
    let mut characters = turn_id.chars();
    if !characters
        .next()
        .is_some_and(|ch| ch.is_ascii_alphanumeric())
        || !characters.all(|ch| ch.is_ascii_alphanumeric() || "._:-".contains(ch))
    {
        return Err(io::Error::other("Invalid Advisor turn identity"));
    }
    Ok(runtime_directory.join(format!("turn-{turn_id}.advisor-report.json")))
}

pub fn write_binding(
    runtime_directory: &std::path::Path,
    role: AdvisorRole,
    executable: &str,
) -> io::Result<AdvisorLaunchBinding> {
    if executable.is_empty() {
        return Err(io::Error::other("Advisor bridge executable is empty"));
    }
    bridge_auth::prepare_runtime_directory(runtime_directory)?;
    let binding_path = runtime_directory.join("advisor.binding.json");
    let token = bridge_auth::existing_token(&binding_path)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let binding = Binding {
        version: 1,
        token: token.clone(),
        role,
        server: ServerCommand {
            command: executable.to_owned(),
            args: vec!["mcp".into(), "advisor".into()],
        },
    };
    crate::shared::fs::write_private(
        &binding_path,
        &serde_json::to_vec(&binding).map_err(io::Error::other)?,
    )?;
    Ok(AdvisorLaunchBinding {
        binding_path,
        token,
    })
}

enum SubmitFailure {
    Invalid(String),
    Capture(io::Error),
}

impl AdvisorBridge {
    fn tool(&self) -> Tool {
        let mut properties = Map::new();
        let mut required = Vec::new();
        match self.role {
            AdvisorRole::Reviewer => {
                properties.insert("approved".into(), json!({"type":"boolean"}));
                properties.insert(
                    "blockingFindings".into(),
                    json!({"type":"array","items":{"type":"string","minLength":1}}),
                );
                properties.insert(
                    "verification".into(),
                    json!({"type":"string","enum":["passed","not_applicable","pending","missing","failed"]}),
                );
                properties.insert(
                    "verificationSummary".into(),
                    json!({"type":"string","minLength":1}),
                );
                properties.insert("summary".into(), json!({"type":"string","minLength":1}));
                required.extend([
                    "approved",
                    "blockingFindings",
                    "verification",
                    "verificationSummary",
                    "summary",
                ]);
            }
            AdvisorRole::Rater => {
                properties.insert(
                    "rating".into(),
                    json!({"type":"integer","minimum":1,"maximum":10}),
                );
                properties.insert(
                    "blockingFindings".into(),
                    json!({"type":"array","items":{"type":"string","minLength":1}}),
                );
                properties.insert(
                    "verification".into(),
                    json!({"type":"string","enum":["passed","not_applicable","pending","missing","failed"]}),
                );
                properties.insert(
                    "verificationSummary".into(),
                    json!({"type":"string","minLength":1}),
                );
                properties.insert("summary".into(), json!({"type":"string","minLength":1}));
                required.extend([
                    "rating",
                    "blockingFindings",
                    "verification",
                    "verificationSummary",
                    "summary",
                ]);
            }
            AdvisorRole::PlannerA | AdvisorRole::PlannerB => {
                properties.insert("summary".into(), json!({"type":"string","minLength":1}));
                required.push("summary");
            }
        }
        Tool::new("submit_report", "Submit the complete structured result for this Advisor assignment.",
            serde_json::from_value::<Map<String, Value>>(json!({
                "$schema":"https://json-schema.org/draft/2020-12/schema",
                "type":"object", "properties": properties, "required": required, "additionalProperties": false
            })).expect("static tool schema"))
    }

    fn submit(&self, mut input: Map<String, Value>) -> Result<Value, SubmitFailure> {
        input.remove("_meta");
        let report =
            validate_submission(self.role, Value::Object(input)).map_err(SubmitFailure::Invalid)?;
        if let Some(path) = &self.result_path {
            capture(path, &report).map_err(SubmitFailure::Capture)?;
        }
        Ok(report)
    }
}

impl ServerHandler for AdvisorBridge {
    fn supported_protocol_versions(
        &self,
    ) -> std::borrow::Cow<'static, [rmcp::model::ProtocolVersion]> {
        crate::coordination::root_stdio::session_protocol_versions()
    }

    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.server_info.name = "suplex-advisor-report".into();
        info.server_info.version = "1".into();
        info.capabilities.tools = Some(Default::default());
        info
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        (name == "submit_report").then(|| self.tool())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(vec![self.tool()]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if request.name != "submit_report" {
            return Err(McpError::method_not_found::<
                rmcp::model::CallToolRequestMethod,
            >());
        }
        let input = request.arguments.unwrap_or_default();
        let result = match self.submit(input) {
            Ok(report) => CallToolResult::structured(report),
            Err(SubmitFailure::Invalid(message)) => {
                CallToolResult::error(vec![ContentBlock::text(message)])
            }
            Err(SubmitFailure::Capture(error)) => {
                return Err(McpError::internal_error(error.to_string(), None));
            }
        };
        Ok(result.into())
    }
}

fn text_field<'a>(input: &'a Map<String, Value>, field: &str) -> Result<&'a str, String> {
    let value = input
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}: expected string"))?;
    if js_trim(value).is_empty() {
        Err(format!("{field}: expected nonempty text"))
    } else {
        Ok(js_trim(value))
    }
}

fn flatten_finding(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !js_trim(text).is_empty() => Some(js_trim(text).to_owned()),
        Value::Object(fields) => {
            let text = fields
                .values()
                .filter_map(Value::as_str)
                .filter(|text| !js_trim(text).is_empty())
                .collect::<Vec<_>>()
                .join(": ");
            (!js_trim(&text).is_empty()).then(|| js_trim(&text).to_owned())
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => {
            None
        }
    }
}

pub fn validate_submission(role: AdvisorRole, raw: Value) -> Result<Value, String> {
    validate_report(role, raw, true)
}

/// TypeScript `validateAdvisorSubmission`. Field issues are reported together,
/// in schema order, before the approval and rating rules.
pub fn validate_report(
    role: AdvisorRole,
    raw: Value,
    reject_mismatched_role: bool,
) -> Result<Value, String> {
    let Value::Object(mut fields) = raw else {
        return Err("The report is not an object".into());
    };
    if reject_mismatched_role
        && let Some(submitted) = fields.get("role")
        && submitted.as_str() != Some(role.as_str())
    {
        let submitted_text = submitted
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| submitted.to_string());
        return Err(format!(
            "The submitted report role {submitted_text} does not match the assigned role {}",
            role.as_str()
        ));
    }
    fields.insert("role".into(), Value::String(role.as_str().into()));
    let allowed: &[&str] = match role {
        AdvisorRole::Reviewer => &[
            "approved",
            "blockingFindings",
            "verification",
            "verificationSummary",
            "summary",
            "role",
        ],
        AdvisorRole::Rater => &[
            "rating",
            "blockingFindings",
            "verification",
            "verificationSummary",
            "summary",
            "role",
        ],
        AdvisorRole::PlannerA | AdvisorRole::PlannerB => &["summary", "role"],
    };
    let mut issues = Vec::new();
    let (mut verified, mut empty, mut approved, mut rating) = (false, false, false, 0);
    if role == AdvisorRole::Reviewer {
        match fields.get("approved").and_then(Value::as_bool) {
            Some(value) => approved = value,
            None => issues.push("approved: expected boolean".to_owned()),
        }
    }
    if role == AdvisorRole::Rater {
        match fields
            .get("rating")
            .and_then(Value::as_f64)
            .filter(|number| number.fract() == 0.0 && (1.0..=10.0).contains(number))
        {
            Some(value) => {
                rating = value as u64;
                fields.insert("rating".into(), json!(rating));
            }
            None => issues.push("rating: expected 1 through 10".to_owned()),
        }
    }
    if matches!(role, AdvisorRole::Reviewer | AdvisorRole::Rater) {
        let flattened = fields.get("blockingFindings").map(|value| {
            value.as_array().map(|findings| {
                findings
                    .iter()
                    .map(flatten_finding)
                    .collect::<Option<Vec<_>>>()
            })
        });
        match flattened {
            Some(Some(Some(flattened))) => {
                empty = flattened.is_empty();
                fields.insert(
                    "blockingFindings".into(),
                    serde_json::to_value(flattened).expect("strings serialize"),
                );
            }
            Some(Some(None)) => issues.push("blockingFindings: expected text".to_owned()),
            _ => issues.push("blockingFindings: expected array".to_owned()),
        }
        match fields.get("verification").and_then(Value::as_str) {
            None => issues.push("verification: expected value".to_owned()),
            Some(value)
                if !["passed", "not_applicable", "pending", "missing", "failed"]
                    .contains(&value) =>
            {
                issues.push("verification: invalid value".to_owned());
            }
            Some(value) => verified = ["passed", "not_applicable", "pending"].contains(&value),
        }
        match text_field(&fields, "verificationSummary").map(str::to_owned) {
            Ok(text) => {
                fields.insert("verificationSummary".into(), Value::String(text));
            }
            Err(issue) => issues.push(issue),
        }
    }
    match text_field(&fields, "summary").map(str::to_owned) {
        Ok(text) => {
            fields.insert("summary".into(), Value::String(text));
        }
        Err(issue) => issues.push(issue),
    }
    if fields
        .keys()
        .any(|field| !allowed.contains(&field.as_str()))
    {
        issues.push("report: unrecognized field".to_owned());
    }
    if !issues.is_empty() {
        return Err(issues.join("; "));
    }
    if approved && (!empty || !verified) {
        return Err("An approval cannot carry blocking findings or missing verification".into());
    }
    if rating >= 9 && (!empty || !verified) {
        return Err(
            "A rating of 9 or more cannot carry blocking findings or missing verification".into(),
        );
    }
    Ok(Value::Object(fields))
}

pub type AdvisorReportOutcome = Result<Value, String>;

const SUBMIT_REPORT_TOOL_NAMES: [&str; 3] = [
    "submit_report",
    "suplex_advisor_submit_report",
    "mcp__suplex_advisor__submit_report",
];

fn fenced_json_values(report: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    for line in report.split('\n') {
        match current.as_mut() {
            None if js_trim(line) == "```json" => current = Some(Vec::new()),
            None => {}
            Some(lines) if js_trim(line) == "```" => {
                values.push(lines.join("\n"));
                current = None;
            }
            Some(lines) => lines.push(line),
        }
    }
    if let Some(lines) = current {
        values.push(lines.join("\n"));
    }
    values
}

/// TypeScript `parseAdvisorReport`: the last fenced json block, else raw JSON.
pub fn parse_advisor_report(role: AdvisorRole, report: &str) -> AdvisorReportOutcome {
    let fenced = fenced_json_values(report);
    let candidate = fenced
        .last()
        .cloned()
        .unwrap_or_else(|| js_trim(report).to_owned());
    if candidate.is_empty() {
        return Err("The report has no JSON object".into());
    }
    match serde_json::from_str::<Value>(&candidate) {
        Ok(value) => validate_report(role, value, false),
        Err(error) => Err(format!(
            "{}: {error}",
            if fenced.is_empty() {
                "The report has no fenced json block or valid raw JSON object"
            } else {
                "The report JSON is not valid JSON"
            }
        )),
    }
}

/// `None` is an MCP error envelope, which is never a submission.
fn tool_output_value(output: &str) -> Option<Value> {
    let Ok(parsed) = serde_json::from_str::<Value>(output) else {
        return Some(Value::Null);
    };
    let Some(envelope) = parsed.as_object() else {
        return Some(parsed);
    };
    if envelope.get("isError") == Some(&Value::Bool(true)) {
        return None;
    }
    if let Some(structured) = envelope.get("structuredContent") {
        return Some(structured.clone());
    }
    if let Some([item]) = envelope
        .get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        && item["type"] == "text"
        && let Some(Ok(nested)) = item["text"].as_str().map(serde_json::from_str::<Value>)
    {
        return Some(nested);
    }
    Some(parsed)
}

/// TypeScript `advisorReportFromTurn`: the latest valid completed submission
/// wins; report prose is used only when no submission completed.
pub fn advisor_report_from_turn(
    role: AdvisorRole,
    tools: &[Value],
    report: &str,
) -> AdvisorReportOutcome {
    let submissions = tools
        .iter()
        .filter(|tool| {
            tool["name"]
                .as_str()
                .is_some_and(|name| SUBMIT_REPORT_TOOL_NAMES.contains(&name))
                && tool["status"] == "completed"
        })
        .filter_map(|tool| tool["output"].as_str())
        .collect::<Vec<_>>();
    if submissions.is_empty() {
        return parse_advisor_report(role, report);
    }
    let (mut valid, mut invalid) = (None, None);
    for value in submissions.into_iter().filter_map(tool_output_value) {
        match validate_report(role, value, true) {
            Ok(result) => valid = Some(result),
            Err(reason) => invalid = Some(reason),
        }
    }
    match (valid, invalid) {
        (Some(result), _) => Ok(result),
        (None, Some(reason)) => Err(reason),
        (None, None) => parse_advisor_report(role, report),
    }
}

fn capture(path: &std::path::Path, report: &Value) -> io::Result<()> {
    crate::shared::fs::write_private(path, &serde_json::to_vec(report).map_err(io::Error::other)?)
}

pub async fn serve_from_environment() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let path = bridge_auth::binding_path(ADVISOR_BINDING_ENV, "Advisor report")?;
    let binding: Binding = serde_json::from_slice(&std::fs::read(path)?)?;
    if binding.version != 1 || binding.server.command.is_empty() {
        return Err(CoordinationError::refused("Advisor report bridge binding is invalid").into());
    }
    let _ = binding.server.args;
    let token = std::env::var(ADVISOR_TOKEN_ENV).ok();
    bridge_auth::authenticate_token(
        &binding.token,
        token.as_deref(),
        ADVISOR_TOKEN_ENV,
        "Advisor report",
    )?;
    let server = AdvisorBridge {
        role: binding.role,
        result_path: std::env::var_os(ADVISOR_RESULT_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
    };
    // See session_protocol_versions: skip rmcp's handshake so a discover probe cannot fix the lifecycle.
    rmcp::service::serve_directly(server, rmcp::transport::stdio(), None)
        .waiting()
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn advisor_submission_checks_role_and_recommendation_before_capture() {
        let planner =
            validate_submission(AdvisorRole::PlannerA, json!({"summary":"  Plan  "})).unwrap();
        assert_eq!(planner, json!({"summary":"Plan","role":"planner_a"}));
        assert_eq!(
            validate_submission(
                AdvisorRole::PlannerA,
                json!({"summary":"\u{FEFF}Plan\u{FEFF}"})
            )
            .unwrap()["summary"],
            "Plan"
        );
        assert!(validate_submission(AdvisorRole::PlannerA, json!({"summary":"\u{FEFF}"})).is_err());
        assert_eq!(
            validate_submission(
                AdvisorRole::PlannerA,
                json!({"role":"rater","summary":"Plan"})
            )
            .unwrap_err(),
            "The submitted report role rater does not match the assigned role planner_a"
        );
        let reviewer = validate_submission(AdvisorRole::Reviewer, json!({"approved":true,"blockingFindings":[],"verification":"passed","verificationSummary":" Checked ","summary":" Good "})).unwrap();
        assert_eq!(reviewer["summary"], "Good");
        assert!(validate_submission(AdvisorRole::Reviewer, json!({"approved":true,"blockingFindings":["bad"],"verification":"passed","verificationSummary":"Checked","summary":"Good"})).is_err());
        let rater = validate_submission(AdvisorRole::Rater, json!({"rating":8,"blockingFindings":[{"file":"src/a","reason":"bug"}],"verification":"missing","verificationSummary":"Unknown","summary":"Repair"})).unwrap();
        assert_eq!(rater["blockingFindings"], json!(["src/a: bug"]));
        let spaced = validate_submission(AdvisorRole::Rater, json!({"rating":8,"blockingFindings":[{"file":"  src/a  ","reason":" bug "}],"verification":"missing","verificationSummary":"Unknown","summary":"Repair"})).unwrap();
        assert_eq!(spaced["blockingFindings"], json!(["src/a  :  bug"]));
        let integral = validate_submission(AdvisorRole::Rater, json!({"rating":9.0,"blockingFindings":[],"verification":"passed","verificationSummary":"Checked","summary":"Good"})).unwrap();
        assert!(integral.to_string().contains("\"rating\":9"));
        assert!(!integral.to_string().contains("\"rating\":9.0"));
        assert!(validate_submission(AdvisorRole::Rater, json!({"rating":9,"blockingFindings":[],"verification":"failed","verificationSummary":"Failed","summary":"Repair"})).is_err());
        assert!(validate_submission(AdvisorRole::Rater, json!({"rating":9,"blockingFindings":[],"verification":"missing","verificationSummary":"No checks","summary":"Repair"})).is_err());
        assert!(validate_submission(AdvisorRole::Rater, json!({"rating":9,"blockingFindings":[],"verification":"pending","verificationSummary":"Remote CI running","summary":"Good"})).is_ok());
        assert!(validate_submission(AdvisorRole::Reviewer, json!({"approved":true,"blockingFindings":[],"verification":"pending","verificationSummary":"Remote CI running","summary":"Good"})).is_ok());
    }

    #[test]
    fn valid_report_is_atomically_written_without_stale_pending_file() {
        let directory =
            std::env::temp_dir().join(format!("suplex-advisor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("result.json");
        let bridge = AdvisorBridge {
            role: AdvisorRole::PlannerB,
            result_path: Some(path.clone()),
        };
        assert!(
            bridge
                .submit(serde_json::from_value(json!({"summary":"Plan"})).unwrap())
                .is_ok()
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(),
            json!({"summary":"Plan","role":"planner_b"})
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(
            bridge
                .submit(serde_json::from_value(json!({"summary":"  "})).unwrap())
                .is_err()
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn advisor_binding_reuses_a_canonical_token_and_scopes_result_path() {
        let directory =
            std::env::temp_dir().join(format!("suplex-advisor-binding-{}", uuid::Uuid::new_v4()));
        let first =
            write_binding(&directory, AdvisorRole::Reviewer, "/usr/local/bin/suplex").unwrap();
        let second =
            write_binding(&directory, AdvisorRole::Rater, "/usr/local/bin/suplex").unwrap();
        assert_eq!(first.token, second.token);
        let stored: Value =
            serde_json::from_slice(&std::fs::read(&first.binding_path).unwrap()).unwrap();
        assert_eq!(stored["role"], "rater");
        assert_eq!(stored["server"]["args"], json!(["mcp", "advisor"]));
        assert_eq!(
            advisor_result_path(&directory, "abc").unwrap(),
            directory.join("turn-abc.advisor-report.json")
        );
        assert!(advisor_result_path(&directory, "../escape").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&first.binding_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn mcp_stdio_transport_lists_and_calls_the_assigned_tool() {
        let (client, server) = tokio::io::duplex(8192);
        let (server_reader, server_writer) = tokio::io::split(server);
        let task = tokio::spawn(async move {
            rmcp::service::serve_directly(
                AdvisorBridge {
                    role: AdvisorRole::PlannerA,
                    result_path: None,
                },
                (server_reader, server_writer),
                None,
            )
            .waiting()
            .await
            .unwrap();
        });
        let (reader, mut writer) = tokio::io::split(client);
        let mut reader = BufReader::new(reader);
        async fn exchange(
            writer: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
            reader: &mut BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
            request: Value,
        ) -> Value {
            writer
                .write_all(request.to_string().as_bytes())
                .await
                .unwrap();
            writer.write_all(b"\n").await.unwrap();
            let mut line = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                reader.read_line(&mut line),
            )
            .await
            .unwrap()
            .unwrap();
            serde_json::from_str(&line).unwrap()
        }
        // Claude Code 2.1.283 opens with a 2026-07-28 discover probe; it must fall back to initialize.
        let discover = exchange(&mut writer, &mut reader, json!({
            "jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{
                "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.283"},
                "io.modelcontextprotocol/clientCapabilities":{}
        }}})).await;
        assert_eq!(
            discover,
            json!({"jsonrpc":"2.0","id":"server-discover-probe-1","error":{
                "code":-32022,"message":"Unsupported protocol version",
                "data":{"requested":"2026-07-28","supported":["2024-11-05","2025-03-26","2025-06-18","2025-11-25"]}
            }})
        );
        let initialized = exchange(&mut writer, &mut reader, json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1"}
        }})).await;
        assert_eq!(
            initialized["result"]["serverInfo"]["name"],
            "suplex-advisor-report"
        );
        writer
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
            .await
            .unwrap();
        let tools = exchange(
            &mut writer,
            &mut reader,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        )
        .await;
        assert_eq!(tools["result"]["tools"][0]["name"], "submit_report");
        assert_eq!(
            tools["result"]["tools"][0]["inputSchema"]["properties"]["summary"]["minLength"],
            1
        );
        let accepted = exchange(&mut writer, &mut reader, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"submit_report","arguments":{"summary":" Plan "}}})).await;
        assert_eq!(
            accepted["result"]["structuredContent"],
            json!({"role":"planner_a","summary":"Plan"})
        );
        let rejected = exchange(&mut writer, &mut reader, json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"submit_report","arguments":{"summary":" "}}})).await;
        assert_eq!(rejected["result"]["isError"], true);
        drop(writer);
        drop(reader);
        task.await.unwrap();
    }

    fn report() -> Value {
        json!({"rating":9,"blockingFindings":[],"verification":"passed","verificationSummary":"Focused tests passed","summary":"Ready"})
    }

    fn tool(value: &Value, name: &str, status: &str) -> Value {
        json!({"name":name,"status":status,"output":value.to_string()})
    }

    #[test]
    fn advisor_reports_accept_raw_json_and_an_unclosed_fence_but_not_truncated_json() {
        let rater = AdvisorRole::Rater;
        assert_eq!(
            parse_advisor_report(rater, &report().to_string()).unwrap()["rating"],
            9
        );
        let unclosed = format!("Assessment complete.\n\n```json\n{}\n", report());
        assert_eq!(
            parse_advisor_report(rater, &unclosed).unwrap()["role"],
            "rater"
        );
        let text = report().to_string();
        let truncated = format!("```json\n{}", &text[..text.len() - 2]);
        assert!(
            parse_advisor_report(rater, &truncated)
                .unwrap_err()
                .contains("not valid")
        );
        assert!(
            parse_advisor_report(rater, r#"{"rating":9}"#)
                .unwrap_err()
                .contains("blockingFindings")
        );
        let two = format!(
            "```json\n{}\n```\n```json\n{}\n```",
            report(),
            json!({"rating":10,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"})
        );
        assert_eq!(parse_advisor_report(rater, &two).unwrap()["rating"], 10);
        let broken_last = format!(
            "```json\n{}\n```\n```json\n{}",
            report(),
            &text[..text.len() - 2]
        );
        assert!(
            parse_advisor_report(rater, &broken_last)
                .unwrap_err()
                .contains("not valid")
        );
    }

    #[test]
    fn advisor_reports_parse_the_last_block_and_reject_a_pass_with_blockers_or_missing_checks() {
        let block = |json: &str| {
            format!(
                "Assessment prose.\n```json\n{{\"draft\":true}}\n```\nFinal:\n```json\n{json}\n```\n"
            )
        };
        let rater = AdvisorRole::Rater;
        assert_eq!(parse_advisor_report(rater, &block(r#"{"rating":7,"blockingFindings":["src/a.ts: null deref"],"verification":"passed","verificationSummary":"pnpm test passed","summary":"Needs repair"}"#)).unwrap()["rating"], 7);
        for invalid in [
            r#"{"rating":9,"blockingFindings":["src/a.ts: null deref"],"verification":"passed","verificationSummary":"ok","summary":"ok"}"#,
            r#"{"rating":9,"blockingFindings":[],"verification":"missing","verificationSummary":"no checks ran","summary":"ok"}"#,
            r#"{"rating":9.5,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"}"#,
            r#"{"rating":11,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"}"#,
        ] {
            assert!(
                parse_advisor_report(rater, &block(invalid)).is_err(),
                "{invalid}"
            );
        }
        assert_eq!(parse_advisor_report(rater, &block(r#"{"rating":9,"role":"reviewer","blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"}"#)).unwrap()["role"], "rater");
        let flattened = parse_advisor_report(rater, &block(r#"{"rating":8,"blockingFindings":[{"id":"B1","description":"routes/plans.py rejects saved owners"},{"file":"tests/test_plans.py","defect":"no coverage"}],"verification":"missing","verificationSummary":"no local checks","summary":"repair"}"#)).unwrap();
        assert_eq!(
            flattened["blockingFindings"],
            json!([
                "B1: routes/plans.py rejects saved owners",
                "tests/test_plans.py: no coverage"
            ])
        );
        let reviewer = AdvisorRole::Reviewer;
        assert!(parse_advisor_report(reviewer, &block(r#"{"approved":false,"blockingFindings":[{"note":42}],"verification":"failed","verificationSummary":"x","summary":"y"}"#)).is_err());
        assert!(parse_advisor_report(reviewer, &block(r#"{"approved":true,"blockingFindings":["src/a.ts: bug"],"verification":"passed","verificationSummary":"ok","summary":"ok"}"#)).is_err());
        assert_eq!(parse_advisor_report(reviewer, &block(r#"{"approved":false,"blockingFindings":["src/a.ts: bug"],"verification":"failed","verificationSummary":"tests fail","summary":"reject"}"#)).unwrap()["approved"], false);
        assert_eq!(
            parse_advisor_report(
                AdvisorRole::PlannerA,
                &block(r#"{"summary":"Add a helper"}"#)
            )
            .unwrap(),
            json!({"summary":"Add a helper","role":"planner_a"})
        );
        assert!(
            parse_advisor_report(AdvisorRole::PlannerB, "No json here")
                .unwrap_err()
                .contains("no fenced json")
        );
        assert!(
            parse_advisor_report(rater, &block("{not json"))
                .unwrap_err()
                .contains("not valid JSON")
        );
    }

    #[test]
    fn structured_submissions_outrank_prose_and_error_envelopes() {
        let rater = AdvisorRole::Rater;
        let mut submitted = report();
        submitted["role"] = json!("rater");
        let mut prose = report();
        prose["rating"] = json!(2);
        let tools = [
            json!({"name":"suplex_advisor_submit_report","status":"error","output":null}),
            tool(
                &submitted,
                "mcp__suplex_advisor__submit_report",
                "completed",
            ),
        ];
        assert_eq!(
            advisor_report_from_turn(rater, &tools, &prose.to_string()).unwrap()["rating"],
            9
        );
        let mut ten = submitted.clone();
        ten["rating"] = json!(10);
        let latest = [
            tool(&submitted, "suplex_advisor_submit_report", "completed"),
            tool(&ten, "suplex_advisor_submit_report", "completed"),
        ];
        assert_eq!(
            advisor_report_from_turn(rater, &latest, "No JSON here").unwrap()["rating"],
            10
        );
        let error = json!({"isError":true,"structuredContent":ten});
        let success = json!({"isError":false,"structuredContent":submitted});
        let enveloped = [
            tool(&error, "suplex_advisor_submit_report", "completed"),
            tool(&success, "suplex_advisor_submit_report", "completed"),
        ];
        assert_eq!(
            advisor_report_from_turn(rater, &enveloped, "No JSON here").unwrap()["rating"],
            9
        );
        let reversed = [
            tool(&submitted, "suplex_advisor_submit_report", "completed"),
            tool(&error, "suplex_advisor_submit_report", "completed"),
        ];
        assert_eq!(
            advisor_report_from_turn(rater, &reversed, "No JSON here").unwrap()["rating"],
            9
        );
        assert_eq!(
            advisor_report_from_turn(
                rater,
                &[tool(&report(), "submit_other", "completed")],
                &report().to_string()
            )
            .unwrap()["rating"],
            9
        );
        assert!(
            advisor_report_from_turn(
                AdvisorRole::Reviewer,
                &[tool(
                    &submitted,
                    "suplex_advisor_submit_report",
                    "completed"
                )],
                "Approval prose"
            )
            .is_err()
        );
        let reviewer_prose = json!({"approved":false,"blockingFindings":["src/a.ts: defect"],"verification":"failed","verificationSummary":"Failed","summary":"Repair"});
        assert!(
            advisor_report_from_turn(
                AdvisorRole::Reviewer,
                &[tool(
                    &submitted,
                    "suplex_advisor_submit_report",
                    "completed"
                )],
                &reviewer_prose.to_string()
            )
            .unwrap_err()
            .contains("role")
        );
        assert!(
            advisor_report_from_turn(
                AdvisorRole::PlannerA,
                &[tool(
                    &json!({"role":"planner_b","summary":"Alternate plan"}),
                    "suplex_advisor_submit_report",
                    "completed"
                )],
                r#"{"summary":"Legacy plan"}"#
            )
            .unwrap_err()
            .contains("role")
        );
    }
}
