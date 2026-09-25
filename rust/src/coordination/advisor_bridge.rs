use std::{io, path::PathBuf};

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler, ServiceExt,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdvisorRole {
    Reviewer,
    PlannerA,
    PlannerB,
    Rater,
}

impl AdvisorRole {
    fn label(self) -> &'static str {
        match self {
            Self::Reviewer => "reviewer",
            Self::PlannerA => "planner_a",
            Self::PlannerB => "planner_b",
            Self::Rater => "rater",
        }
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
    bridge_auth::atomic_write_private(
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
                    json!({"type":"string","enum":["passed","not_applicable","missing","failed"]}),
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
                    json!({"type":"string","enum":["passed","not_applicable","missing","failed"]}),
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
        _ => None,
    }
}

pub fn validate_submission(role: AdvisorRole, raw: Value) -> Result<Value, String> {
    let Value::Object(mut fields) = raw else {
        return Err("The report is not an object".into());
    };
    if let Some(submitted) = fields.get("role")
        && submitted.as_str() != Some(role.label())
    {
        let submitted_text = submitted
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| submitted.to_string());
        return Err(format!(
            "The submitted report role {submitted_text} does not match the assigned role {}",
            role.label()
        ));
    }
    fields.insert("role".into(), Value::String(role.label().into()));
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
    if fields
        .keys()
        .any(|field| !allowed.contains(&field.as_str()))
    {
        return Err("report: unrecognized field".into());
    }
    fields.insert(
        "summary".into(),
        Value::String(text_field(&fields, "summary")?.to_owned()),
    );
    if matches!(role, AdvisorRole::Reviewer | AdvisorRole::Rater) {
        fields.insert(
            "verificationSummary".into(),
            Value::String(text_field(&fields, "verificationSummary")?.to_owned()),
        );
        let verification = fields
            .get("verification")
            .and_then(Value::as_str)
            .ok_or("verification: expected value")?;
        if !["passed", "not_applicable", "missing", "failed"].contains(&verification) {
            return Err("verification: invalid value".into());
        }
        let verified = ["passed", "not_applicable"].contains(&verification);
        let Some(findings) = fields.get("blockingFindings").and_then(Value::as_array) else {
            return Err("blockingFindings: expected array".into());
        };
        let flattened = findings
            .iter()
            .map(flatten_finding)
            .collect::<Option<Vec<_>>>()
            .ok_or("blockingFindings: expected text")?;
        fields.insert(
            "blockingFindings".into(),
            serde_json::to_value(flattened).expect("strings serialize"),
        );
        let empty = fields["blockingFindings"]
            .as_array()
            .is_some_and(Vec::is_empty);
        match role {
            AdvisorRole::Reviewer => {
                let approved = fields
                    .get("approved")
                    .and_then(Value::as_bool)
                    .ok_or("approved: expected boolean")?;
                if approved && (!empty || !verified) {
                    return Err(
                        "An approval cannot carry blocking findings or missing verification".into(),
                    );
                }
            }
            AdvisorRole::Rater => {
                let rating = fields
                    .get("rating")
                    .and_then(Value::as_f64)
                    .filter(|number| number.fract() == 0.0 && (1.0..=10.0).contains(number))
                    .ok_or("rating: expected 1 through 10")? as u64;
                if rating >= 9 && (!empty || !verified) {
                    return Err("A rating of 9 or more cannot carry blocking findings or missing verification".into());
                }
                fields.insert("rating".into(), json!(rating));
            }
            _ => unreachable!(),
        }
    }
    Ok(Value::Object(fields))
}

fn capture(path: &std::path::Path, report: &Value) -> io::Result<()> {
    bridge_auth::atomic_write_private(path, &serde_json::to_vec(report).map_err(io::Error::other)?)
}

pub async fn serve_from_environment() -> Result<(), Box<dyn std::error::Error>> {
    let path = bridge_auth::binding_path(ADVISOR_BINDING_ENV, "Advisor report")?;
    let binding: Binding = serde_json::from_slice(&std::fs::read(path)?)?;
    if binding.version != 1 || binding.server.command.is_empty() {
        return Err(io::Error::other("Advisor report bridge binding is invalid").into());
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
    server
        .serve(rmcp::transport::stdio())
        .await?
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
            AdvisorBridge {
                role: AdvisorRole::PlannerA,
                result_path: None,
            }
            .serve((server_reader, server_writer))
            .await
            .unwrap()
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
}
