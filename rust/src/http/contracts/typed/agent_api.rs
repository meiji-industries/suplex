//! Agent API request contracts.

use crate::tasks::control::{DeliveryTarget, TaskStatus};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{
    Contract, ContractResult, Fields, MAX, advisors, choice, coerced, fail, flag, formatted, int,
    list, one_of, rule,
    tasks::{
        AdvisorProfileIds, MAX_SAFE, PullRequestDependency, TaskImage, TaskSource, VISUAL_EVIDENCE,
        image, pull_request, source,
    },
    text, trimmed,
};

pub const TASK_COMMANDS: [&str; 8] = [
    "start_task",
    "disarm_task",
    "cancel_task",
    "archive_task",
    "unarchive_task",
    "duplicate_task",
    "send_task_note",
    "recheck_delivery_wait",
];
pub const TASK_FILTERS: [&str; 6] = [
    "stale_delivery",
    "conflicting_pull_request",
    "failed_checks",
    "pending_review",
    "blocked_by_dependency",
    "not_integrated",
];
const MAX_DEPENDENCIES: usize = 50;
const MAX_TASK_IMAGES: usize = 8;
const FLAG: &[&str] = &["true", "false"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdParams {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCreateBody {
    pub name: String,
    pub company_id: String,
    pub project_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_seed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminProjectsBody {
    pub project_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryDecisionBody {
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeApprovalBody {
    pub pull_request_number: u64,
    pub head_sha: String,
    pub base_sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBody {
    pub pull_request_number: u64,
    pub expected_head_sha: String,
    pub expected_base_sha: String,
    pub approval_receipt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTrainQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingExchangeBody {
    pub pairing_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiscoveryQuery {
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommandBody {
    pub command: String,
    pub revision: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateBody {
    pub project_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_by_pull_requests: Option<Vec<PullRequestDependency>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<bool>,
    pub images: Vec<TaskImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TaskSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_profile_id: Option<String>,
    pub advisor_profile_ids: AdvisorProfileIds,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_target: Option<DeliveryTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_project_tests: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visual_evidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
    /// The schema passes unknown keys through; the service rejects them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDependenciesBody {
    pub depends_on: Vec<String>,
    pub blocked_by_pull_requests: Vec<PullRequestDependency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIdParams {
    pub task_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_request_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_contains: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
}
/// A tool call's `taskId` with the arguments of the matching HTTP body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTool<T> {
    pub task_id: String,
    #[serde(flatten)]
    pub body: T,
}

/// The `suplex_get_task` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTaskTool {
    pub task_id: String,
    pub known_revision: Option<String>,
}

fn task_id() -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    text(1, 100)
}

fn sha(value: &str, _: &()) -> garde::Result {
    rule(
        (40..=64).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid_format",
    )
}

fn dry_run(input: Option<&Value>) -> ContractResult<Value> {
    match input {
        Some(Value::Bool(true)) => Ok(json!(true)),
        _ => fail("invalid_value"),
    }
}

fn pull_requests() -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    list(pull_request, 0, MAX_DEPENDENCIES)
}

impl Contract for AgentIdParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("agentId", text(1, 128)).finish()
    }
}

impl Contract for AdminCreateBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("name", trimmed(1, MAX))
            .req("companyId", text(1, 128))
            .req("projectIds", list(text(1, 128), 1, MAX))
            .opt("avatarSeed", text(0, 128))
            .finish()
    }
}

impl Contract for AdminListQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.opt("companyId", text(0, MAX)).finish()
    }
}

impl Contract for AdminProjectsBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("projectIds", list(text(1, 128), 0, MAX))
            .finish()
    }
}

impl Contract for DeliveryDecisionBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("decision", one_of(&["wait_for_dependency", "resume"]))
            .strict()
    }
}

impl Contract for MergeApprovalBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("pullRequestNumber", int(1.0, MAX_SAFE))
            .req("headSha", formatted(0, MAX, sha))
            .req("baseSha", formatted(0, MAX, sha))
            .strict()
    }
}

impl Contract for MergeBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("pullRequestNumber", int(1.0, MAX_SAFE))
            .req("expectedHeadSha", formatted(0, MAX, sha))
            .req("expectedBaseSha", formatted(0, MAX, sha))
            .req("approvalReceipt", text(1, 128))
            .strict()
    }
}

impl Contract for MergeTrainQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.opt("projectId", text(1, 128)).finish()
    }
}

impl Contract for PairingExchangeBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("pairingCode", text(0, MAX))
            .opt("profileId", trimmed(1, 128))
            .finish()
    }
}

impl Contract for ProjectDiscoveryQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("projectId", text(1, 128)).strict()
    }
}

pub fn task_command(input: Option<&Value>) -> ContractResult<Value> {
    one_of(&TASK_COMMANDS)(input)
}

pub fn task_filter(input: Option<&Value>) -> ContractResult<Value> {
    one_of(&TASK_FILTERS)(input)
}

/// A note belongs to `send_task_note` and only to it.
fn task_command_fields(fields: Fields) -> ContractResult<Value> {
    let mut fields = fields
        .req("command", one_of(&TASK_COMMANDS))
        .req("revision", text(1, 256))
        .req("idempotencyKey", trimmed(1, 128))
        .opt("note", trimmed(1, MAX));
    fields.strict_keys();
    if fields.refinable() {
        let note = fields.raw("note");
        let sends_note = fields.raw("command") == Some(&json!("send_task_note"));
        let blank = note
            .and_then(Value::as_str)
            .is_none_or(|note| crate::identity::auth::js_trim(note).is_empty());
        if (sends_note && blank) || (!sends_note && note.is_some()) {
            fields.fail("custom", ".note");
        }
    }
    fields.finish()
}

impl Contract for TaskCommandBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        task_command_fields(Fields::new(input)?)
    }
}

impl Contract for TaskTool<TaskCommandBody> {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        task_command_fields(Fields::new(input)?.req("taskId", task_id()))
    }
}

/// Unknown keys pass through; the service rejects them.
impl Contract for TaskCreateBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let mut fields = Fields::new(input)?
            .req("projectId", text(1, 128))
            .req("title", trimmed(1, MAX))
            .opt("description", trimmed(0, MAX))
            .req("idempotencyKey", trimmed(1, 128))
            .opt("dependsOn", list(text(1, 128), 0, MAX_DEPENDENCIES))
            .opt("blockedByPullRequests", pull_requests())
            .opt("queue", flag)
            .or("images", json!([]), list(image, 0, MAX_TASK_IMAGES))
            .opt("source", source)
            .opt("workflowId", text(1, 256))
            .opt("templateId", text(1, 256))
            .opt("rootProfileId", text(1, 256))
            .opt("workerProfileId", text(1, 256))
            .or("advisorProfileIds", json!({}), advisors)
            .opt("deliveryTarget", choice::<DeliveryTarget>)
            .opt("runProjectTests", flag)
            .opt("visualEvidence", one_of(VISUAL_EVIDENCE))
            .opt("dryRun", dry_run);
        let named = |name| {
            fields
                .raw(name)
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        };
        if fields.refinable() && named("workflowId") && named("templateId") {
            fields.fail("custom", ".");
        }
        fields.passthrough()
    }
}

fn task_dependencies_fields(fields: Fields) -> ContractResult<Value> {
    fields
        .req("dependsOn", list(text(1, 128), 0, MAX_DEPENDENCIES))
        .or("blockedByPullRequests", json!([]), pull_requests())
        .opt("dryRun", dry_run)
        .strict()
}

impl Contract for TaskDependenciesBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        task_dependencies_fields(Fields::new(input)?)
    }
}

impl Contract for TaskTool<TaskDependenciesBody> {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        task_dependencies_fields(Fields::new(input)?.req("taskId", task_id()))
    }
}

impl Contract for TaskIdParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("taskId", task_id()).finish()
    }
}

impl Contract for GetTaskTool {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("taskId", task_id())
            .opt("knownRevision", text(1, 256))
            .strict()
    }
}

/// `{ taskId }` tool arguments, strict.
pub fn task_tool(input: Option<&Value>) -> ContractResult<String> {
    let value = Fields::new(input)?.req("taskId", task_id()).strict()?;
    Ok(value["taskId"].as_str().unwrap_or_default().to_owned())
}

/// Zod's default `z.string().datetime()`: UTC `Z` only, optional seconds and fraction.
pub(crate) fn zod_datetime(value: &str) -> bool {
    let Some((date, time)) = value.split_once('T') else {
        return false;
    };
    let Some(time) = time.strip_suffix('Z') else {
        return false;
    };
    let digits = |text: &str, count: usize| {
        text.len() == count && text.bytes().all(|byte| byte.is_ascii_digit())
    };
    let parts = date.split('-').collect::<Vec<_>>();
    let [year, month, day] = parts.as_slice() else {
        return false;
    };
    if !digits(year, 4) || !digits(month, 2) || !digits(day, 2) {
        return false;
    }
    let (year, month, day) = (
        year.parse::<u32>().unwrap_or(0),
        month.parse::<u32>().unwrap_or(0),
        day.parse::<u32>().unwrap_or(0),
    );
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days {
        return false;
    }
    let (clock, fraction) = match time.split_once('.') {
        Some((clock, fraction)) => (clock, Some(fraction)),
        None => (time, None),
    };
    if fraction.is_some_and(|fraction| {
        fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return false;
    }
    let pieces = clock.split(':').collect::<Vec<_>>();
    let in_range = |text: &str, max: u32| {
        digits(text, 2) && text.parse::<u32>().is_ok_and(|value| value <= max)
    };
    match pieces.as_slice() {
        [hour, minute] => fraction.is_none() && in_range(hour, 23) && in_range(minute, 59),
        [hour, minute, second] => {
            in_range(hour, 23) && in_range(minute, 59) && in_range(second, 59)
        }
        _ => false,
    }
}

fn datetime(value: &str, _: &()) -> garde::Result {
    rule(zod_datetime(value), "invalid_format")
}

impl Contract for TaskListQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("projectId", text(1, 128))
            .opt("status", choice::<TaskStatus>)
            .opt("pullRequestNumber", coerced(1.0, MAX_SAFE))
            .opt("sourceBranch", text(1, MAX))
            .opt("titleContains", text(1, MAX))
            .opt("archived", one_of(FLAG))
            .opt("attention", one_of(FLAG))
            .opt("blocker", one_of(FLAG))
            .opt("updatedSince", formatted(0, MAX, datetime))
            .opt("cursor", text(1, 2048))
            .or("limit", json!(50), coerced(1.0, 100.0))
            .opt("filter", one_of(&TASK_FILTERS))
            .opt("view", one_of(&["summary", "full"]))
            .strict()
    }
}

/// Fastify's query parser: a repeated key becomes an array of strings.
pub fn query_object(raw: Option<&str>) -> Value {
    let mut fields = Map::new();
    for (name, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        let value = Value::String(value.into_owned());
        match fields.get_mut(name.as_ref()) {
            Some(Value::Array(values)) => values.push(value),
            Some(existing) => *existing = Value::Array(vec![existing.take(), value]),
            None => {
                fields.insert(name.into_owned(), value);
            }
        }
    }
    Value::Object(fields)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::http::contracts::typed::ContractFailure;

    fn findings<T: Contract>(input: Value) -> Vec<String> {
        match T::parse(Some(&input)) {
            Ok(_) => vec![],
            Err(ContractFailure::Issues(issues)) => {
                let mut found = issues
                    .iter()
                    .map(|issue| {
                        format!(
                            "{} {}",
                            issue["code"].as_str().unwrap(),
                            issue["field"].as_str().unwrap()
                        )
                    })
                    .collect::<Vec<_>>();
                found.sort();
                found.dedup();
                found
            }
            Err(other) => panic!("{other:?}"),
        }
    }

    fn sorted<const N: usize>(expected: [&str; N]) -> Vec<String> {
        let mut expected = expected.map(str::to_owned).to_vec();
        expected.sort();
        expected
    }

    /// Expected values come from the TypeScript Zod schemas; order is free.
    #[test]
    fn nested_and_coerced_findings_follow_zod() {
        assert_eq!(
            findings::<TaskCommandBody>(
                json!({"command":"start_task","revision":"","idempotencyKey":"k","note":"n"})
            ),
            sorted(["invalid-too_small .revision", "invalid-custom .note"])
        );
        assert_eq!(
            findings::<TaskCommandBody>(
                json!({"command":"start_task","revision":"x","idempotencyKey":"k","note":"n","z":1})
            ),
            sorted(["invalid-unrecognized_keys ."])
        );
        assert_eq!(
            findings::<TaskCreateBody>(
                json!({"projectId":"","title":"t","idempotencyKey":"k","workflowId":"w","templateId":"t"})
            ),
            sorted(["invalid-too_small .projectId", "invalid-custom ."])
        );
        assert_eq!(
            findings::<TaskCreateBody>(
                json!({"projectId":"p","title":"t","idempotencyKey":"k","images":[{"filename":"a/b","mimeType":"image/png","base64":""}],"source":{"kind":"branch","branch":"","x":1}})
            ),
            sorted([
                "invalid-custom .images.0.filename",
                "invalid-too_small .images.0.base64",
                "invalid-too_small .source.branch",
                "invalid-unrecognized_keys .source"
            ])
        );
        assert_eq!(
            findings::<TaskCreateBody>(
                json!({"projectId":"p","title":"t","idempotencyKey":"k","source":{"kind":"issue","number":0},"images":[1],"dependsOn":"x","blockedByPullRequests":[1]})
            ),
            sorted([
                "invalid-invalid_type .dependsOn",
                "invalid-invalid_type .blockedByPullRequests.0",
                "invalid-invalid_type .images.0",
                "invalid-too_small .source.number"
            ])
        );
        let full = TaskCreateBody::parse(Some(&json!({"x":1,"projectId":"p","title":" t ","idempotencyKey":" k ","description":" d ","dryRun":true,"queue":true,"source":{"kind":"pull_request","number":3},"advisorProfileIds":{"reviewer":"r"},"dependsOn":["a"],"blockedByPullRequests":[{"number":2}],"images":[{"filename":"a.png","mimeType":"image/png","base64":"AA=="}],"workflowId":"w","rootProfileId":"r","workerProfileId":"w","deliveryTarget":"merged","runProjectTests":false,"visualEvidence":"off"}))).unwrap();
        assert_eq!(
            crate::shared::js_json::stringify(&serde_json::to_value(full).unwrap()),
            r#"{"projectId":"p","title":"t","description":"d","idempotencyKey":"k","dependsOn":["a"],"blockedByPullRequests":[{"number":2}],"queue":true,"images":[{"filename":"a.png","mimeType":"image/png","base64":"AA=="}],"source":{"kind":"pull_request","number":3},"workflowId":"w","rootProfileId":"r","workerProfileId":"w","advisorProfileIds":{"reviewer":"r"},"deliveryTarget":"merged","runProjectTests":false,"visualEvidence":"off","dryRun":true,"x":1}"#
        );
        assert_eq!(
            findings::<TaskListQuery>(
                json!({"limit":"0","pullRequestNumber":"1.5","updatedSince":"x","status":"bad","archived":"yes","filter":"x","view":"x","cursor":"","projectId":""})
            ),
            sorted([
                "invalid-too_small .projectId",
                "invalid-invalid_value .status",
                "invalid-invalid_type .pullRequestNumber",
                "invalid-invalid_value .archived",
                "invalid-invalid_format .updatedSince",
                "invalid-too_small .cursor",
                "invalid-too_small .limit",
                "invalid-invalid_value .filter",
                "invalid-invalid_value .view"
            ])
        );
        for (limit, expected) in [
            ("0x10", Some(16)),
            ("1e1", Some(10)),
            (" 5 ", Some(5)),
            ("Infinity", None),
            ("", None),
        ] {
            assert_eq!(
                TaskListQuery::parse(Some(&json!({"limit": limit})))
                    .ok()
                    .map(|query| query.limit),
                expected,
                "{limit}"
            );
        }
        assert_eq!(
            findings::<TaskListQuery>(
                json!({"limit":"101","pullRequestNumber":"9007199254740993"})
            ),
            sorted([
                "invalid-too_big .pullRequestNumber",
                "invalid-too_big .limit"
            ])
        );
        for (value, valid) in [
            ("2024-01-01T00:00Z", true),
            ("2024-02-29T00:00:00Z", true),
            ("2024-01-01T00:00:00.123456789Z", true),
            ("2023-02-29T00:00:00Z", false),
            ("2024-01-01T24:00:00Z", false),
            ("2024-01-01T00:00:60Z", false),
            ("2024-01-01T00:00:00.Z", false),
            ("2024-01-01T00:00:00z", false),
            ("2024-01-01T00:00:00.123+02:00", false),
        ] {
            assert_eq!(zod_datetime(value), valid, "{value}");
        }
        assert_eq!(
            findings::<TaskDependenciesBody>(
                json!({"dependsOn":["","a"],"blockedByPullRequests":[{"number":1.5}],"dryRun":false})
            ),
            sorted([
                "invalid-too_small .dependsOn.0",
                "invalid-invalid_type .blockedByPullRequests.0.number",
                "invalid-invalid_value .dryRun"
            ])
        );
        assert_eq!(
            findings::<AdminCreateBody>(
                json!({"name":" ","companyId":"","projectIds":[],"avatarSeed":1})
            ),
            sorted([
                "invalid-too_small .name",
                "invalid-too_small .companyId",
                "invalid-too_small .projectIds",
                "invalid-invalid_type .avatarSeed"
            ])
        );
        assert_eq!(
            findings::<MergeApprovalBody>(
                json!({"pullRequestNumber":0,"headSha":"x","baseSha":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
            ),
            sorted([
                "invalid-too_small .pullRequestNumber",
                "invalid-invalid_format .headSha",
                "invalid-invalid_format .baseSha"
            ])
        );
        assert_eq!(
            query_object(Some("limit=1&limit=2&view=summary")),
            json!({"limit":["1","2"],"view":"summary"})
        );
    }
}
