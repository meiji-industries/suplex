//! Authenticated stdio MCP transport for implemented Standard Root operations.

use std::{collections::HashSet, path::PathBuf};

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};

use crate::{
    delivery,
    http::contracts::typed::tasks::TaskWorkerReplacementBody,
    identity::auth::js_trim,
    platform::database::{OpenMode, SuplexDatabase},
};

use super::{
    root_bridge::{self, RootIdentity},
    root_controller::{self, StandardWorkerAssignment, WorkerEvidenceRequest},
    root_session_store,
    worker_evidence::{EvidenceField, EvidencePosition, EvidenceQuery},
};

pub struct RootBridgeServer {
    root: RootIdentity,
    database_path: PathBuf,
    artifact_root: PathBuf,
}

enum RootCall {
    Observe,
    ReadImage(String),
    ReadWorkerEvidence(WorkerEvidenceRequest),
    DelegateWorker(StandardWorkerAssignment),
    ReplaceWorker(TaskWorkerReplacementBody),
    InspectDeliveryDiff,
    RequestDelivery { expected_head: Option<String> },
    AskHuman { question: String, options: Value },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WireCall {
    Observe(Empty),
    ReadImage {
        #[serde(rename = "artifactId")]
        artifact_id: String,
    },
    ReadWorkerEvidence(WorkerEvidenceInput),
    DelegateWorker(Box<WorkerInput>),
    ReplaceWorker {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
        #[serde(default, deserialize_with = "present")]
        handoff: Option<String>,
    },
    RequestDelivery(DeliveryInput),
    AskHuman {
        question: String,
        options: Vec<HumanOption>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerInput {
    plan: String,
    #[serde(rename = "acceptanceCriteria")]
    acceptance_criteria: Vec<String>,
    instruction: String,
    #[serde(default = "planned")]
    mode: String,
    #[serde(default = "implementation")]
    purpose: String,
    #[serde(rename = "advisorTurnId", default, deserialize_with = "present")]
    advisor_turn_id: Option<String>,
    #[serde(rename = "candidateTurnIds", default, deserialize_with = "present")]
    candidate_turn_ids: Option<[String; 2]>,
    #[serde(rename = "advisorSessionId", default, deserialize_with = "present")]
    advisor_session_id: Option<String>,
    #[serde(rename = "candidateSessionIds", default, deserialize_with = "present")]
    candidate_session_ids: Option<[String; 2]>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerEvidenceInput {
    turn_id: String,
    #[serde(default, deserialize_with = "present")]
    tool_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    field: Option<EvidenceField>,
    #[serde(default, deserialize_with = "present")]
    position: Option<EvidencePosition>,
    #[serde(default, deserialize_with = "present")]
    cursor: Option<String>,
    #[serde(default, deserialize_with = "js_positive_integer")]
    max_characters: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryInput {
    operation: LocalDeliveryOperation,
    #[serde(default, deserialize_with = "present")]
    expected_head: Option<String>,
    #[serde(default, deserialize_with = "present")]
    review: Option<DeliveryReview>,
    #[serde(default, deserialize_with = "present")]
    pull_request_title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pull_request_body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum LocalDeliveryOperation {
    InspectDeliveryDiff,
    CompleteLocalWork,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryReview {
    base_sha: String,
    head_sha: String,
    files: Vec<String>,
    commits: Vec<String>,
    #[serde(default, deserialize_with = "present")]
    patch_digest: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HumanOption {
    label: String,
    description: String,
    recommended: bool,
}

fn planned() -> String {
    "planned".into()
}

fn implementation() -> String {
    "implementation".into()
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn js_positive_integer<'de, D>(deserializer: D) -> Result<Option<usize>, D::Error>
where
    D: Deserializer<'de>,
{
    let number = f64::deserialize(deserializer)?;
    if !number.is_finite() || number.fract() != 0.0 || number < 0.0 || number > usize::MAX as f64 {
        return Err(serde::de::Error::custom("expected a nonnegative integer"));
    }
    Ok(Some(number as usize))
}

fn valid_sha(value: &str) -> bool {
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_delivery_extras(input: &DeliveryInput) -> Result<(), String> {
    if input.expected_head.as_deref().is_some_and(str::is_empty) {
        return Err("expectedHead: expected nonempty text".into());
    }
    if let Some(review) = &input.review {
        if !valid_sha(&review.base_sha)
            || !valid_sha(&review.head_sha)
            || review.files.iter().any(String::is_empty)
            || review.commits.iter().any(|sha| !valid_sha(sha))
        {
            return Err("review: invalid source revision or file".into());
        }
        let _ = &review.patch_digest;
    }
    if let Some(title) = &input.pull_request_title {
        let trimmed = js_trim(title);
        let length = trimmed.encode_utf16().count();
        if title.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}') || !(1..=120).contains(&length)
        {
            return Err("pullRequestTitle: invalid title".into());
        }
    }
    if let Some(body) = &input.pull_request_body {
        let trimmed = js_trim(body);
        if !(1..=20_000).contains(&trimmed.encode_utf16().count()) {
            return Err("pullRequestBody: invalid description".into());
        }
        let headings = ["## Summary", "## Why", "## Validation", "## Review notes"];
        let lines = trimmed.lines().collect::<Vec<_>>();
        let mut previous = None;
        for heading in headings {
            let position = lines
                .iter()
                .position(|line| *line == heading)
                .ok_or_else(|| "pullRequestBody: missing required headings".to_owned())?;
            if previous.is_some_and(|before| position <= before) {
                return Err("pullRequestBody: headings are out of order".into());
            }
            previous = Some(position);
        }
    }
    Ok(())
}

fn parse_call(mut input: Map<String, Value>) -> Result<RootCall, String> {
    input.remove("_meta");
    let call: WireCall =
        serde_json::from_value(Value::Object(input)).map_err(|error| error.to_string())?;
    match call {
        WireCall::Observe(_) => Ok(RootCall::Observe),
        WireCall::ReplaceWorker {
            session_id,
            reason,
            handoff,
        } => {
            let reason = js_trim(&reason).to_owned();
            if session_id.is_empty() || reason.is_empty() {
                return Err("Worker replacement requires sessionId and reason".into());
            }
            Ok(RootCall::ReplaceWorker(TaskWorkerReplacementBody {
                session_id,
                reason,
                handoff: handoff.map(|text| js_trim(&text).to_owned()),
                worker_profile_id: None,
            }))
        }
        WireCall::ReadImage { artifact_id } => {
            if !root_bridge::valid_opaque_id(&artifact_id) {
                return Err("Task image artifact id is invalid".into());
            }
            Ok(RootCall::ReadImage(artifact_id))
        }
        WireCall::ReadWorkerEvidence(input) => {
            if !root_bridge::valid_opaque_id(&input.turn_id)
                || input
                    .tool_id
                    .as_deref()
                    .is_some_and(|id| !root_bridge::valid_opaque_id(id))
            {
                return Err("Worker evidence turn or tool id is invalid".into());
            }
            let max_characters = input.max_characters.unwrap_or(12_000);
            if !(1_000..=20_000).contains(&max_characters) {
                return Err("maxCharacters: expected 1000 to 20000".into());
            }
            if input.tool_id.is_none() && (input.field.is_some() || input.position.is_some()) {
                return Err("field and position require toolId".into());
            }
            if let Some(cursor) = &input.cursor {
                if cursor.starts_with("field:") && input.tool_id.is_none() {
                    return Err("A field cursor requires toolId".into());
                }
                if cursor.starts_with("index:") && input.tool_id.is_some() {
                    return Err("An index cursor cannot select a tool field".into());
                }
                if input.tool_id.is_some() && input.position != Some(EvidencePosition::Head) {
                    return Err("A field cursor is valid only with position head".into());
                }
                let Some((prefix, value)) = cursor.split_once(':') else {
                    return Err("Worker evidence cursor is invalid".into());
                };
                if !matches!(prefix, "field" | "index")
                    || value.is_empty()
                    || !value.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err("Worker evidence cursor is invalid".into());
                }
            }
            Ok(RootCall::ReadWorkerEvidence(WorkerEvidenceRequest {
                turn_id: input.turn_id,
                query: EvidenceQuery {
                    tool_id: input.tool_id,
                    field: input.field,
                    position: input.position,
                    cursor: input.cursor,
                    max_characters,
                },
            }))
        }
        WireCall::RequestDelivery(input) => {
            validate_delivery_extras(&input)?;
            match input.operation {
                LocalDeliveryOperation::InspectDeliveryDiff => Ok(RootCall::InspectDeliveryDiff),
                LocalDeliveryOperation::CompleteLocalWork => Ok(RootCall::RequestDelivery {
                    expected_head: input.expected_head,
                }),
            }
        }
        WireCall::DelegateWorker(input) => {
            let WorkerInput {
                plan,
                acceptance_criteria,
                instruction,
                mode,
                purpose,
                advisor_turn_id,
                candidate_turn_ids,
                advisor_session_id,
                candidate_session_ids,
            } = *input;
            if mode != "planned" {
                return Err("mode: only planned Standard delegation is implemented".into());
            }
            if purpose != "implementation" {
                return Err("purpose: only implementation delegation is implemented".into());
            }
            if advisor_turn_id
                .as_deref()
                .is_some_and(|id| !root_bridge::valid_opaque_id(id))
                || advisor_session_id
                    .as_deref()
                    .is_some_and(|id| !root_bridge::valid_opaque_id(id))
                || candidate_turn_ids
                    .as_ref()
                    .is_some_and(|ids| ids.iter().any(|id| !root_bridge::valid_opaque_id(id)))
                || candidate_session_ids
                    .as_ref()
                    .is_some_and(|ids| ids.iter().any(|id| !root_bridge::valid_opaque_id(id)))
            {
                return Err("Worker Advisor reference is invalid".into());
            }
            let plan = js_trim(&plan).to_owned();
            let instruction = js_trim(&instruction).to_owned();
            let criteria = acceptance_criteria
                .into_iter()
                .map(|value| {
                    let text = js_trim(&value);
                    if text.is_empty() {
                        Err("acceptanceCriteria: expected nonempty text")
                    } else {
                        Ok(text.to_owned())
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            if plan.is_empty() || instruction.is_empty() || criteria.is_empty() {
                return Err(
                    "A planned assignment requires a plan, acceptance criteria, and instruction"
                        .into(),
                );
            }
            Ok(RootCall::DelegateWorker(StandardWorkerAssignment {
                plan,
                acceptance_criteria: criteria,
                instruction,
                purpose: "implementation".into(),
            }))
        }
        WireCall::AskHuman {
            question,
            mut options,
        } => {
            if question.is_empty() {
                return Err("question: expected nonempty text".into());
            }
            if !(2..=4).contains(&options.len()) {
                return Err("options: expected two to four choices".into());
            }
            let mut labels = HashSet::new();
            let mut recommended = 0;
            for option in &mut options {
                option.label = js_trim(&option.label).to_owned();
                option.description = js_trim(&option.description).to_owned();
                if option.label.is_empty() || option.description.is_empty() {
                    return Err("options: label and description must be nonempty".into());
                }
                let lower = option.label.to_lowercase();
                if lower == "other" || !labels.insert(lower) {
                    return Err("options: use unique labels; Suplex adds Other".into());
                }
                recommended += usize::from(option.recommended);
            }
            if recommended != 1 {
                return Err("options: provide exactly one recommended choice".into());
            }
            Ok(RootCall::AskHuman {
                question,
                options: serde_json::to_value(options).expect("typed question options"),
            })
        }
    }
}

fn tool() -> Tool {
    Tool::new(
        "suplex_root",
        "Observe this task, read an image or native Worker evidence, delegate a Standard Worker, inspect the delivery diff, complete local work, or ask a specific human question.",
        serde_json::from_value::<Map<String, Value>>(json!({
            "type":"object",
            "properties":{
                "kind":{"type":"string","enum":["observe","read_image","read_worker_evidence","delegate_worker","replace_worker","request_delivery","ask_human"],"description":"Fields per kind. observe: no other fields. read_image: required artifactId. read_worker_evidence: required turnId; optional toolId, field (input/output/error), position (head/tail), cursor, maxCharacters (1000..20000). delegate_worker: required plan, acceptanceCriteria, instruction; optional mode (planned), purpose (implementation), Advisor references (unused in Standard). replace_worker: required sessionId and reason; optional handoff. request_delivery: required operation (inspect_delivery_diff or complete_local_work); optional expectedHead and source review fields. ask_human: required question, options."},
                "sessionId":{"type":"string","minLength":1},
                "reason":{"type":"string","minLength":1},
                "handoff":{"type":"string"},
                "artifactId":{"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "operation":{"type":"string","enum":["inspect_delivery_diff","complete_local_work"],"description":"Inspect the published-base-to-head patch or complete reviewed Standard local work."},
                "expectedHead":{"type":"string","minLength":1},
                "review":{"type":"object","description":"Optional source review metadata; ignored for Standard local completion."},
                "pullRequestTitle":{"type":"string","description":"Optional pull request title; ignored for Standard local completion."},
                "pullRequestBody":{"type":"string","description":"Optional pull request body; ignored for Standard local completion."},
                "turnId":{"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "toolId":{"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "field":{"type":"string","enum":["input","output","error"],"description":"Selected-tool field. Defaults to output. Valid only with toolId."},
                "position":{"type":"string","enum":["head","tail"],"description":"Selected-tool position. Defaults to tail; head supports continuation cursors. Valid only with toolId."},
                "cursor":{"type":"string","pattern":"^(index|field):[0-9]+$"},
                "maxCharacters":{"type":"integer","minimum":1000,"maximum":20000,"description":"Maximum evidence characters; defaults to 12000."},
                "plan":{"type":"string","minLength":1},
                "acceptanceCriteria":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}},
                "instruction":{"type":"string","minLength":1},
                "mode":{"type":"string","enum":["planned"]},
                "purpose":{"type":"string","enum":["implementation"]},
                "advisorTurnId":{"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "candidateTurnIds":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"}},
                "advisorSessionId":{"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "candidateSessionIds":{"type":"array","minItems":2,"maxItems":2,"items":{"type":"string","minLength":1,"maxLength":256,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"}},
                "question":{"type":"string","minLength":1},
                "options":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"object","properties":{"label":{"type":"string"},"description":{"type":"string"},"recommended":{"type":"boolean"}},"required":["label","description","recommended"],"additionalProperties":false}}
            },
            "required":["kind"],
            "additionalProperties":false
        }))
        .expect("static Root tool schema"),
    )
}

impl RootBridgeServer {
    async fn call(&self, call: RootCall) -> Result<Value, String> {
        let database_path = self.database_path.clone();
        let artifact_root = self.artifact_root.clone();
        let root = self.root.clone();
        let runtime = tokio::runtime::Handle::current();
        // The blocking worker owns claim, operation, and release together. Dropping
        // the MCP request future cannot strand a token held by this live process.
        tokio::task::spawn_blocking(move || -> Result<Value, String> {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite)
                .map_err(|error| error.to_string())?;
            root_session_store::assert_current_root(&database, &root.task_id, &root.session_id, root.generation)
                .map_err(|error| error.to_string())?;
            let token = root_session_store::claim_tool_owner(&mut database, &root.task_id, chrono::Utc::now())
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Another Suplex tool call for this task is still in progress. Retry after it finishes.".to_owned())?;
            let result = match call {
                RootCall::Observe => root_controller::observe(&database_path, &root)
                    .map_err(|error| error.to_string()),
                RootCall::ReadImage(artifact_id) => root_controller::read_image(&database_path, &artifact_root, &root, &artifact_id)
                    .map_err(|error| error.to_string()),
                RootCall::ReadWorkerEvidence(request) => {
                    root_controller::read_worker_evidence(&database_path, &root, &request)
                        .map_err(|error| error.to_string())
                }
                RootCall::DelegateWorker(assignment) => {
                    root_controller::delegate_worker(&database_path, &root, &assignment)
                        .map_err(|error| error.to_string())
                }
                RootCall::ReplaceWorker(request) => root_controller::replace_worker(
                    &database_path, &root, &token, &request,
                ).map_err(|error| error.to_string()),
                RootCall::InspectDeliveryDiff => runtime
                    .block_on(delivery::inspection::inspect_standard_delivery_diff(
                        &database_path,
                        &root,
                    ))
                    .map_err(|error| error.to_string()),
                RootCall::RequestDelivery { expected_head } => runtime
                    .block_on(delivery::operations::complete_local_work(
                        &database_path,
                        &root,
                        &token,
                        expected_head.as_deref(),
                    ))
                    .map_err(|error| error.to_string()),
                RootCall::AskHuman { question, options } => {
                    root_controller::ask_human(&database_path, &root, &question, &options)
                        .map_err(|error| error.to_string())
                }
            };
            root_session_store::release_tool_owner(&mut database, &root.task_id, &token)
                .map_err(|error| error.to_string())?;
            result
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

impl ServerHandler for RootBridgeServer {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.server_info.name = "suplex-root-bridge".into();
        info.server_info.version = "1".into();
        info.capabilities.tools = Some(Default::default());
        info
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        (name == "suplex_root").then(tool)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(vec![tool()]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if request.name != "suplex_root" {
            return Err(McpError::method_not_found::<
                rmcp::model::CallToolRequestMethod,
            >());
        }
        let result = match parse_call(request.arguments.unwrap_or_default()) {
            Ok(call) => match self.call(call).await {
                Ok(value) if value["kind"] == "image" => {
                    let (Some(filename), Some(mime_type), Some(data)) = (
                        value["filename"].as_str(),
                        value["mimeType"].as_str(),
                        value["data"].as_str(),
                    ) else {
                        return Ok(CallToolResult::error(vec![ContentBlock::text(
                            "Task image result is invalid",
                        )])
                        .into());
                    };
                    CallToolResult::success(vec![
                        ContentBlock::text(filename),
                        ContentBlock::image(data, mime_type),
                    ])
                }
                Ok(value) => CallToolResult::structured(value),
                Err(error) => CallToolResult::error(vec![ContentBlock::text(error)]),
            },
            Err(error) => CallToolResult::error(vec![ContentBlock::text(format!(
                "Coordinator bridge request is invalid: {error}"
            ))]),
        };
        Ok(result.into())
    }
}

pub async fn serve_from_environment() -> Result<(), Box<dyn std::error::Error>> {
    let binding = root_bridge::authenticated_binding()?;
    let server = RootBridgeServer {
        root: binding.root,
        database_path: binding.database_path,
        artifact_root: binding.artifact_root,
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

    #[test]
    fn advertised_kinds_are_only_the_implemented_standard_operations() {
        let schema = tool().input_schema;
        assert_eq!(
            schema["properties"]["kind"]["enum"],
            json!([
                "observe",
                "read_image",
                "read_worker_evidence",
                "delegate_worker",
                "replace_worker",
                "request_delivery",
                "ask_human"
            ])
        );
        assert!(
            parse_call(
                json!({"kind":"request_delivery"})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_err()
        );
        assert!(
            parse_call(
                json!({"kind":"observe","extra":1})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_err()
        );
        assert!(parse_call(json!({"kind":"delegate_worker","plan":"Plan","acceptanceCriteria":["Done"],"instruction":"Build","extra":1}).as_object().unwrap().clone()).is_err());
        assert!(parse_call(json!({"kind":"delegate_worker","plan":"Plan","acceptanceCriteria":["Done"],"instruction":"Build","mode":null}).as_object().unwrap().clone()).is_err());
        assert!(parse_call(json!({"kind":"delegate_worker","plan":"Plan","acceptanceCriteria":["Done"],"instruction":"Build","advisorTurnId":"report_1","candidateSessionIds":["a","b"]}).as_object().unwrap().clone()).is_ok());
        assert!(parse_call(json!({"kind":"delegate_worker","plan":"Plan","acceptanceCriteria":["Done"],"instruction":"Build","advisorTurnId":null}).as_object().unwrap().clone()).is_err());
        let replaced = parse_call(json!({"kind":"replace_worker","sessionId":"worker_1","reason":"  Change strategy  ","handoff":"  Continue work  "}).as_object().unwrap().clone()).unwrap();
        assert!(
            matches!(replaced, RootCall::ReplaceWorker(request) if request.session_id == "worker_1" && request.reason == "Change strategy" && request.handoff.as_deref() == Some("Continue work") && request.worker_profile_id.is_none())
        );
        assert!(
            parse_call(
                json!({"kind":"replace_worker","sessionId":"worker_1","reason":"  "})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_err()
        );
        assert!(parse_call(json!({"kind":"replace_worker","sessionId":"worker_1","reason":"Change","workerProfileId":"other"}).as_object().unwrap().clone()).is_err());
        assert!(parse_call(json!({"kind":"ask_human","question":"Choose","options":[{"label":"One","description":"First","recommended":true},{"label":"Two","description":"Second","recommended":false}],"extra":1}).as_object().unwrap().clone()).is_err());
        assert!(
            parse_call(
                json!({"kind":"read_worker_evidence","turnId":"msg_1"})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_ok()
        );
        assert!(parse_call(json!({"kind":"read_worker_evidence","turnId":"msg_1","toolId":"item_1","field":"output","position":"head","maxCharacters":1000.0}).as_object().unwrap().clone()).is_ok());
        assert!(parse_call(json!({"kind":"request_delivery","operation":"complete_local_work","expectedHead":"abc"}).as_object().unwrap().clone()).is_ok());
        assert!(matches!(
            parse_call(
                json!({"kind":"request_delivery","operation":"inspect_delivery_diff"})
                    .as_object()
                    .unwrap()
                    .clone()
            ),
            Ok(RootCall::InspectDeliveryDiff)
        ));
        assert!(
            parse_call(
                json!({"kind":"request_delivery","operation":"merge_pull_request"})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_err()
        );
        assert!(parse_call(json!({"kind":"request_delivery","operation":"complete_local_work","expectedHead":null}).as_object().unwrap().clone()).is_err());
        assert!(
            parse_call(
                json!({"kind":"read_worker_evidence","turnId":"msg_1","toolId":null})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_err()
        );
        assert!(
            parse_call(
                json!({"kind":"read_worker_evidence","turnId":"msg_1","field":"input"})
                    .as_object()
                    .unwrap()
                    .clone()
            )
            .is_err()
        );
        assert!(parse_call(json!({"kind":"read_worker_evidence","turnId":"msg_1","toolId":"item_1","cursor":"index:1"}).as_object().unwrap().clone()).is_err());
    }
}
