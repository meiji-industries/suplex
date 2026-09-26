//! Agent API request contracts with the public Zod finding envelope.
//!
//! Zod reports issues in schema-shape order. Type and enum mismatches abort
//! an object's refinements; length and format checks do not.

use crate::tasks::control::{DeliveryTarget, TaskStatus};

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{
    ContractFailure, ContractResult, finding,
    tasks::{AdvisorProfileIds, PullRequestDependency, TaskImage, TaskSource},
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
const TASK_STATUSES: [&str; 6] = [
    "backlog",
    "queued",
    "active",
    "waiting_human",
    "cancelled",
    "delivered",
];
const DELIVERY_TARGETS: [&str; 5] = [
    "local_worktree",
    "remote_branch",
    "pull_request_draft",
    "pull_request_ready",
    "merged",
];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_DEPENDENCIES: usize = 50;
const MAX_TASK_IMAGES: usize = 8;
const MAX_TASK_IMAGE_BASE64_LENGTH: usize = 11_184_812;

/// Collects Zod-shaped findings for one parse.
#[derive(Default)]
pub(crate) struct Check {
    pub issues: Vec<Value>,
    aborted: bool,
}

pub(crate) fn path(parts: &[&str]) -> Vec<Value> {
    parts.iter().map(|part| json!(part)).collect()
}

fn child(parent: &[Value], name: impl Into<Value>) -> Vec<Value> {
    let mut path = parent.to_vec();
    path.push(name.into());
    path
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

impl Check {
    pub(crate) fn fail(&mut self, code: &str, at: &[Value]) {
        if matches!(
            code,
            "invalid_type" | "invalid_value" | "unrecognized_keys" | "invalid_union"
        ) {
            self.aborted = true;
        }
        self.issues.push(finding(code, at));
    }

    pub(crate) fn finish<T>(self, value: Option<T>) -> ContractResult<T> {
        match value {
            Some(value) if self.issues.is_empty() => Ok(value),
            _ => Err(ContractFailure::Issues(self.issues)),
        }
    }

    pub(crate) fn object(input: Option<&Value>) -> ContractResult<&Map<String, Value>> {
        match input {
            Some(Value::Object(fields)) => Ok(fields),
            _ => Err(ContractFailure::Issues(vec![finding("invalid_type", &[])])),
        }
    }

    /// `z.string()` with optional trim and UTF-16 length bounds.
    pub(crate) fn string(
        &mut self,
        value: Option<&Value>,
        at: &[Value],
        trim: bool,
        min: usize,
        max: usize,
    ) -> Option<String> {
        let Some(Value::String(raw)) = value else {
            self.fail("invalid_type", at);
            return None;
        };
        let value = if trim {
            crate::identity::auth::js_trim(raw).to_owned()
        } else {
            raw.clone()
        };
        let length = utf16_len(&value);
        if length < min {
            self.fail("too_small", at);
            return None;
        }
        if length > max {
            self.fail("too_big", at);
            return None;
        }
        Some(value)
    }

    pub(crate) fn optional_string(
        &mut self,
        fields: &Map<String, Value>,
        name: &str,
        trim: bool,
        min: usize,
        max: usize,
    ) -> Option<Option<String>> {
        match fields.get(name) {
            None => Some(None),
            value => self.string(value, &path(&[name]), trim, min, max).map(Some),
        }
    }

    pub(crate) fn enumeration(
        &mut self,
        value: Option<&Value>,
        at: &[Value],
        options: &[&str],
    ) -> Option<String> {
        match value.and_then(Value::as_str) {
            Some(value) if options.contains(&value) => Some(value.to_owned()),
            _ => {
                self.fail("invalid_value", at);
                None
            }
        }
    }

    fn optional_enumeration(
        &mut self,
        fields: &Map<String, Value>,
        name: &str,
        options: &[&str],
    ) -> Option<Option<String>> {
        match fields.get(name) {
            None => Some(None),
            value => self.enumeration(value, &path(&[name]), options).map(Some),
        }
    }

    fn optional_boolean(
        &mut self,
        fields: &Map<String, Value>,
        name: &str,
    ) -> Option<Option<bool>> {
        match fields.get(name) {
            None => Some(None),
            Some(Value::Bool(value)) => Some(Some(*value)),
            Some(_) => {
                self.fail("invalid_type", &path(&[name]));
                None
            }
        }
    }

    /// `z.number().int()` with a lower bound; Zod keeps integers in the safe range.
    pub(crate) fn integer(&mut self, number: Option<f64>, at: &[Value], min: f64) -> Option<u64> {
        let Some(number) = number.filter(|number| number.is_finite() && number.fract() == 0.0)
        else {
            self.fail("invalid_type", at);
            return None;
        };
        if number > MAX_SAFE_INTEGER {
            self.fail("too_big", at);
            return None;
        }
        if number < min || number < -MAX_SAFE_INTEGER {
            self.fail("too_small", at);
            return None;
        }
        Some(number as u64)
    }

    pub(crate) fn string_array(
        &mut self,
        value: Option<&Value>,
        at: &[Value],
        (item_min, item_max): (usize, usize),
        (min, max): (usize, usize),
    ) -> Option<Vec<String>> {
        let Some(Value::Array(items)) = value else {
            self.fail("invalid_type", at);
            return None;
        };
        let before = self.issues.len();
        let values = items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                self.string(Some(item), &child(at, index), false, item_min, item_max)
            })
            .collect::<Vec<_>>();
        if items.len() < min {
            self.fail("too_small", at);
        } else if items.len() > max {
            self.fail("too_big", at);
        }
        (self.issues.len() == before).then_some(values)
    }

    pub(crate) fn unknown_keys(
        &mut self,
        fields: &Map<String, Value>,
        at: &[Value],
        allowed: &[&str],
    ) {
        if fields.keys().any(|name| !allowed.contains(&name.as_str())) {
            self.fail("unrecognized_keys", at);
        }
    }

    fn pull_requests(
        &mut self,
        value: Option<&Value>,
        at: &[Value],
    ) -> Option<Vec<PullRequestDependency>> {
        let Some(Value::Array(items)) = value else {
            self.fail("invalid_type", at);
            return None;
        };
        let before = self.issues.len();
        let mut values = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let item_path = child(at, index);
            let Some(fields) = item.as_object() else {
                self.fail("invalid_type", &item_path);
                continue;
            };
            let number = self.integer(
                fields
                    .get("number")
                    .and_then(Value::as_f64)
                    .filter(|_| fields.get("number").is_some_and(Value::is_number)),
                &child(&item_path, "number"),
                1.0,
            );
            self.unknown_keys(fields, &item_path, &["number"]);
            if let Some(number) = number {
                values.push(PullRequestDependency { number });
            }
        }
        if items.len() > MAX_DEPENDENCIES {
            self.fail("too_big", at);
        }
        (self.issues.len() == before).then_some(values)
    }

    fn images(&mut self, value: Option<&Value>) -> Option<Vec<TaskImage>> {
        let at = path(&["images"]);
        let Some(value) = value else {
            return Some(Vec::new());
        };
        let Value::Array(items) = value else {
            self.fail("invalid_type", &at);
            return None;
        };
        let before = self.issues.len();
        let mut images = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let item_path = child(&at, index);
            let Some(fields) = item.as_object() else {
                self.fail("invalid_type", &item_path);
                continue;
            };
            let filename_path = child(&item_path, "filename");
            let filename = self.string(fields.get("filename"), &filename_path, false, 1, 255);
            if let Some(name) = &filename
                && (name.contains(['/', '\\']) || name.contains(".."))
            {
                self.fail("custom", &filename_path);
            }
            let mime_type = self.enumeration(
                fields.get("mimeType"),
                &child(&item_path, "mimeType"),
                &["image/png", "image/jpeg", "image/webp", "image/gif"],
            );
            let base64 = self.string(
                fields.get("base64"),
                &child(&item_path, "base64"),
                false,
                1,
                MAX_TASK_IMAGE_BASE64_LENGTH,
            );
            self.unknown_keys(fields, &item_path, &["filename", "mimeType", "base64"]);
            if let (Some(filename), Some(mime_type), Some(base64)) = (filename, mime_type, base64) {
                images.push(TaskImage {
                    filename,
                    mime_type,
                    base64,
                });
            }
        }
        if items.len() > MAX_TASK_IMAGES {
            self.fail("too_big", &at);
        }
        (self.issues.len() == before).then_some(images)
    }

    fn source(&mut self, value: &Value) -> Option<TaskSource> {
        let at = path(&["source"]);
        let Some(fields) = value.as_object() else {
            self.fail("invalid_type", &at);
            return None;
        };
        let kind = fields.get("kind").and_then(Value::as_str);
        let before = self.issues.len();
        let source = match kind {
            Some("issue" | "pull_request") => {
                let number = self.integer(
                    fields
                        .get("number")
                        .filter(|value| value.is_number())
                        .and_then(Value::as_f64),
                    &child(&at, "number"),
                    1.0,
                );
                self.unknown_keys(fields, &at, &["kind", "number"]);
                number.map(|number| {
                    if kind == Some("issue") {
                        TaskSource::Issue { number }
                    } else {
                        TaskSource::PullRequest { number }
                    }
                })
            }
            Some("branch") => {
                let branch = self.string(
                    fields.get("branch"),
                    &child(&at, "branch"),
                    false,
                    1,
                    usize::MAX,
                );
                self.unknown_keys(fields, &at, &["kind", "branch"]);
                branch.map(|branch| TaskSource::Branch { branch })
            }
            _ => {
                self.fail("invalid_union", &child(&at, "kind"));
                None
            }
        };
        (self.issues.len() == before).then_some(source).flatten()
    }

    fn advisors(&mut self, value: Option<&Value>) -> Option<AdvisorProfileIds> {
        let at = path(&["advisorProfileIds"]);
        let Some(value) = value else {
            return Some(AdvisorProfileIds::default());
        };
        let Some(fields) = value.as_object() else {
            self.fail("invalid_type", &at);
            return None;
        };
        let before = self.issues.len();
        let mut role = |name: &str| match fields.get(name) {
            None => None,
            value => self.string(value, &child(&at, name), false, 1, 256),
        };
        let advisors = AdvisorProfileIds {
            reviewer: role("reviewer"),
            planner_a: role("planner_a"),
            planner_b: role("planner_b"),
            rater: role("rater"),
        };
        self.unknown_keys(
            fields,
            &at,
            &["reviewer", "planner_a", "planner_b", "rater"],
        );
        (self.issues.len() == before).then_some(advisors)
    }

    fn dry_run(&mut self, fields: &Map<String, Value>) -> Option<Option<bool>> {
        match fields.get("dryRun") {
            None => Some(None),
            Some(Value::Bool(true)) => Some(Some(true)),
            Some(_) => {
                self.fail("invalid_value", &path(&["dryRun"]));
                None
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdParams {
    pub agent_id: String,
}

pub fn parse_agent_id_params(input: Option<&Value>) -> ContractResult<AgentIdParams> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let agent_id = check.string(fields.get("agentId"), &path(&["agentId"]), false, 1, 128);
    check.finish(agent_id.map(|agent_id| AgentIdParams { agent_id }))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCreateBody {
    pub name: String,
    pub company_id: String,
    pub project_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_seed: Option<String>,
}

pub fn parse_admin_create(input: Option<&Value>) -> ContractResult<AdminCreateBody> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let name = check.string(fields.get("name"), &path(&["name"]), true, 1, usize::MAX);
    let company_id = check.string(
        fields.get("companyId"),
        &path(&["companyId"]),
        false,
        1,
        128,
    );
    let project_ids = check.string_array(
        fields.get("projectIds"),
        &path(&["projectIds"]),
        (1, 128),
        (1, usize::MAX),
    );
    let avatar_seed = check.optional_string(fields, "avatarSeed", false, 0, 128);
    check.finish(match (name, company_id, project_ids, avatar_seed) {
        (Some(name), Some(company_id), Some(project_ids), Some(avatar_seed)) => {
            Some(AdminCreateBody {
                name,
                company_id,
                project_ids,
                avatar_seed,
            })
        }
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_id: Option<String>,
}

pub fn parse_admin_list(input: Option<&Value>) -> ContractResult<AdminListQuery> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let company_id = check.optional_string(fields, "companyId", false, 0, usize::MAX);
    check.finish(company_id.map(|company_id| AdminListQuery { company_id }))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminProjectsBody {
    pub project_ids: Vec<String>,
}

pub fn parse_admin_projects(input: Option<&Value>) -> ContractResult<AdminProjectsBody> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let project_ids = check.string_array(
        fields.get("projectIds"),
        &path(&["projectIds"]),
        (1, 128),
        (0, usize::MAX),
    );
    check.finish(project_ids.map(|project_ids| AdminProjectsBody { project_ids }))
}

#[derive(Debug, Clone, Serialize)]
pub struct DeliveryDecisionBody {
    pub decision: String,
}

pub fn parse_delivery_decision(input: Option<&Value>) -> ContractResult<DeliveryDecisionBody> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let decision = check.enumeration(
        fields.get("decision"),
        &path(&["decision"]),
        &["wait_for_dependency", "resume"],
    );
    check.unknown_keys(fields, &[], &["decision"]);
    check.finish(decision.map(|decision| DeliveryDecisionBody { decision }))
}

fn sha(check: &mut Check, value: Option<&Value>, name: &str) -> Option<String> {
    let at = path(&[name]);
    let value = check.string(value, &at, false, 0, usize::MAX)?;
    if (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Some(value)
    } else {
        check.fail("invalid_format", &at);
        None
    }
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    value
        .filter(|value| value.is_number())
        .and_then(Value::as_f64)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeApprovalBody {
    pub pull_request_number: u64,
    pub head_sha: String,
    pub base_sha: String,
}

pub fn parse_merge_approval(input: Option<&Value>) -> ContractResult<MergeApprovalBody> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let number = check.integer(
        number_value(fields.get("pullRequestNumber")),
        &path(&["pullRequestNumber"]),
        1.0,
    );
    let head_sha = sha(&mut check, fields.get("headSha"), "headSha");
    let base_sha = sha(&mut check, fields.get("baseSha"), "baseSha");
    check.unknown_keys(fields, &[], &["pullRequestNumber", "headSha", "baseSha"]);
    check.finish(match (number, head_sha, base_sha) {
        (Some(pull_request_number), Some(head_sha), Some(base_sha)) => Some(MergeApprovalBody {
            pull_request_number,
            head_sha,
            base_sha,
        }),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBody {
    pub pull_request_number: u64,
    pub expected_head_sha: String,
    pub expected_base_sha: String,
    pub approval_receipt: String,
}

pub fn parse_merge(input: Option<&Value>) -> ContractResult<MergeBody> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let number = check.integer(
        number_value(fields.get("pullRequestNumber")),
        &path(&["pullRequestNumber"]),
        1.0,
    );
    let head = sha(&mut check, fields.get("expectedHeadSha"), "expectedHeadSha");
    let base = sha(&mut check, fields.get("expectedBaseSha"), "expectedBaseSha");
    let receipt = check.string(
        fields.get("approvalReceipt"),
        &path(&["approvalReceipt"]),
        false,
        1,
        128,
    );
    check.unknown_keys(
        fields,
        &[],
        &[
            "pullRequestNumber",
            "expectedHeadSha",
            "expectedBaseSha",
            "approvalReceipt",
        ],
    );
    check.finish(match (number, head, base, receipt) {
        (
            Some(pull_request_number),
            Some(expected_head_sha),
            Some(expected_base_sha),
            Some(approval_receipt),
        ) => Some(MergeBody {
            pull_request_number,
            expected_head_sha,
            expected_base_sha,
            approval_receipt,
        }),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTrainQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

pub fn parse_merge_train(input: Option<&Value>) -> ContractResult<MergeTrainQuery> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let project_id = check.optional_string(fields, "projectId", false, 1, 128);
    check.finish(project_id.map(|project_id| MergeTrainQuery { project_id }))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingExchangeBody {
    pub pairing_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

pub fn parse_pairing_exchange(input: Option<&Value>) -> ContractResult<PairingExchangeBody> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let pairing_code = check.string(
        fields.get("pairingCode"),
        &path(&["pairingCode"]),
        false,
        0,
        usize::MAX,
    );
    let profile_id = check.optional_string(fields, "profileId", true, 1, 128);
    check.finish(match (pairing_code, profile_id) {
        (Some(pairing_code), Some(profile_id)) => Some(PairingExchangeBody {
            pairing_code,
            profile_id,
        }),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiscoveryQuery {
    pub project_id: String,
}

pub fn parse_project_discovery(input: Option<&Value>) -> ContractResult<ProjectDiscoveryQuery> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let project_id = check.string(
        fields.get("projectId"),
        &path(&["projectId"]),
        false,
        1,
        128,
    );
    check.unknown_keys(fields, &[], &["projectId"]);
    check.finish(project_id.map(|project_id| ProjectDiscoveryQuery { project_id }))
}

pub fn parse_task_command_name(input: Option<&Value>) -> ContractResult<String> {
    let mut check = Check::default();
    let command = check.enumeration(input, &[], &TASK_COMMANDS);
    check.finish(command)
}

pub fn parse_task_filter(input: Option<&Value>) -> ContractResult<String> {
    let mut check = Check::default();
    let filter = check.enumeration(input, &[], &TASK_FILTERS);
    check.finish(filter)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommandBody {
    pub command: String,
    pub revision: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub fn parse_task_command(input: Option<&Value>) -> ContractResult<TaskCommandBody> {
    let fields = Check::object(input)?;
    task_command_fields(fields, &["command", "revision", "idempotencyKey", "note"])
}

/// Shared by the HTTP body and the MCP tool, which adds `taskId` to the strict key set.
pub(crate) fn task_command_fields(
    fields: &Map<String, Value>,
    allowed: &[&str],
) -> ContractResult<TaskCommandBody> {
    let mut check = Check::default();
    let command = check.enumeration(fields.get("command"), &path(&["command"]), &TASK_COMMANDS);
    let revision = check.string(fields.get("revision"), &path(&["revision"]), false, 1, 256);
    let key = check.string(
        fields.get("idempotencyKey"),
        &path(&["idempotencyKey"]),
        true,
        1,
        128,
    );
    let note = check.optional_string(fields, "note", true, 1, usize::MAX);
    check.unknown_keys(fields, &[], allowed);
    if !check.aborted {
        let raw_command = fields.get("command").and_then(Value::as_str);
        let raw_note = fields.get("note");
        let note_value = raw_note
            .and_then(Value::as_str)
            .map(crate::identity::auth::js_trim);
        if raw_command == Some("send_task_note") && note_value.is_none_or(str::is_empty) {
            check.fail("custom", &path(&["note"]));
        }
        if raw_command != Some("send_task_note") && raw_note.is_some() {
            check.fail("custom", &path(&["note"]));
        }
    }
    check.finish(match (command, revision, key, note) {
        (Some(command), Some(revision), Some(idempotency_key), Some(note)) => {
            Some(TaskCommandBody {
                command,
                revision,
                idempotency_key,
                note,
            })
        }
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize)]
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

const CREATE_FIELDS: [&str; 18] = [
    "projectId",
    "title",
    "description",
    "idempotencyKey",
    "dependsOn",
    "blockedByPullRequests",
    "queue",
    "images",
    "source",
    "workflowId",
    "templateId",
    "rootProfileId",
    "workerProfileId",
    "advisorProfileIds",
    "deliveryTarget",
    "runProjectTests",
    "visualEvidence",
    "dryRun",
];

pub fn parse_task_create(input: Option<&Value>) -> ContractResult<TaskCreateBody> {
    let fields = Check::object(input)?;
    task_create_fields(fields, &[])
}

/// `ignored` names keys another schema layer owns, such as the MCP `taskId`.
pub(crate) fn task_create_fields(
    fields: &Map<String, Value>,
    ignored: &[&str],
) -> ContractResult<TaskCreateBody> {
    let mut check = Check::default();
    let project_id = check.string(
        fields.get("projectId"),
        &path(&["projectId"]),
        false,
        1,
        128,
    );
    let title = check.string(fields.get("title"), &path(&["title"]), true, 1, usize::MAX);
    let description = check.optional_string(fields, "description", true, 0, usize::MAX);
    let key = check.string(
        fields.get("idempotencyKey"),
        &path(&["idempotencyKey"]),
        true,
        1,
        128,
    );
    let depends_on = match fields.get("dependsOn") {
        None => Some(None),
        value => check
            .string_array(
                value,
                &path(&["dependsOn"]),
                (1, 128),
                (0, MAX_DEPENDENCIES),
            )
            .map(Some),
    };
    let pull_requests = match fields.get("blockedByPullRequests") {
        None => Some(None),
        value => check
            .pull_requests(value, &path(&["blockedByPullRequests"]))
            .map(Some),
    };
    let queue = check.optional_boolean(fields, "queue");
    let images = check.images(fields.get("images"));
    let source = match fields.get("source") {
        None => Some(None),
        Some(value) => check.source(value).map(Some),
    };
    let workflow_id = check.optional_string(fields, "workflowId", false, 1, 256);
    let template_id = check.optional_string(fields, "templateId", false, 1, 256);
    let root_profile_id = check.optional_string(fields, "rootProfileId", false, 1, 256);
    let worker_profile_id = check.optional_string(fields, "workerProfileId", false, 1, 256);
    let advisors = check.advisors(fields.get("advisorProfileIds"));
    let delivery_target = check.optional_enumeration(fields, "deliveryTarget", &DELIVERY_TARGETS);
    let run_project_tests = check.optional_boolean(fields, "runProjectTests");
    let visual_evidence =
        check.optional_enumeration(fields, "visualEvidence", &["off", "capture", "required"]);
    let dry_run = check.dry_run(fields);
    if !check.aborted
        && fields
            .get("workflowId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && fields
            .get("templateId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
    {
        check.fail("custom", &[]);
    }
    let extra = fields
        .iter()
        .filter(|(name, _)| {
            !CREATE_FIELDS.contains(&name.as_str()) && !ignored.contains(&name.as_str())
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let body = (|| {
        Some(TaskCreateBody {
            project_id: project_id?,
            title: title?,
            description: description?,
            idempotency_key: key?,
            depends_on: depends_on?,
            blocked_by_pull_requests: pull_requests?,
            queue: queue?,
            images: images?,
            source: source?,
            workflow_id: workflow_id?,
            template_id: template_id?,
            root_profile_id: root_profile_id?,
            worker_profile_id: worker_profile_id?,
            advisor_profile_ids: advisors?,
            delivery_target: delivery_target?
                .map(|target| DeliveryTarget::parse(&target).expect("validated target")),
            run_project_tests: run_project_tests?,
            visual_evidence: visual_evidence?,
            dry_run: dry_run?,
            extra,
        })
    })();
    check.finish(body)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDependenciesBody {
    pub depends_on: Vec<String>,
    pub blocked_by_pull_requests: Vec<PullRequestDependency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

pub fn parse_task_dependencies(input: Option<&Value>) -> ContractResult<TaskDependenciesBody> {
    let fields = Check::object(input)?;
    task_dependencies_fields(fields, &["dependsOn", "blockedByPullRequests", "dryRun"])
}

pub(crate) fn task_dependencies_fields(
    fields: &Map<String, Value>,
    allowed: &[&str],
) -> ContractResult<TaskDependenciesBody> {
    let mut check = Check::default();
    let depends_on = check.string_array(
        fields.get("dependsOn"),
        &path(&["dependsOn"]),
        (1, 128),
        (0, MAX_DEPENDENCIES),
    );
    let pull_requests = match fields.get("blockedByPullRequests") {
        None => Some(Vec::new()),
        value => check.pull_requests(value, &path(&["blockedByPullRequests"])),
    };
    let dry_run = check.dry_run(fields);
    check.unknown_keys(fields, &[], allowed);
    check.finish(match (depends_on, pull_requests, dry_run) {
        (Some(depends_on), Some(blocked_by_pull_requests), Some(dry_run)) => {
            Some(TaskDependenciesBody {
                depends_on,
                blocked_by_pull_requests,
                dry_run,
            })
        }
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIdParams {
    pub task_id: String,
}

pub fn parse_task_id_params(input: Option<&Value>) -> ContractResult<TaskIdParams> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let task_id = check.string(fields.get("taskId"), &path(&["taskId"]), false, 1, 100);
    check.finish(task_id.map(|task_id| TaskIdParams { task_id }))
}

#[derive(Debug, Clone, Default, Serialize)]
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

/// `Number(value)` for the string and number inputs `z.coerce.number()` sees.
fn js_number(value: &Value) -> f64 {
    let text = match value {
        Value::Number(number) => return number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => crate::identity::auth::js_trim(text),
        Value::Bool(value) => return f64::from(u8::from(*value)),
        Value::Null => return 0.0,
        _ => return f64::NAN,
    };
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |value| value as f64);
        }
    }
    let unsigned = text.trim_start_matches(['+', '-']);
    if unsigned == "Infinity" && text.len() - unsigned.len() <= 1 {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        text.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
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

pub fn parse_task_list(input: Option<&Value>) -> ContractResult<TaskListQuery> {
    let fields = Check::object(input)?;
    task_list_fields(
        fields,
        &[
            "projectId",
            "status",
            "pullRequestNumber",
            "sourceBranch",
            "titleContains",
            "archived",
            "attention",
            "blocker",
            "updatedSince",
            "cursor",
            "limit",
            "filter",
            "view",
        ],
    )
}

pub(crate) fn task_list_fields(
    fields: &Map<String, Value>,
    allowed: &[&str],
) -> ContractResult<TaskListQuery> {
    let mut check = Check::default();
    let flag = ["true", "false"];
    let project_id = check.optional_string(fields, "projectId", false, 1, 128);
    let status = check.optional_enumeration(fields, "status", &TASK_STATUSES);
    let pull_request_number = match fields.get("pullRequestNumber") {
        None => Some(None),
        Some(value) => check
            .integer(Some(js_number(value)), &path(&["pullRequestNumber"]), 1.0)
            .map(Some),
    };
    let source_branch = check.optional_string(fields, "sourceBranch", false, 1, usize::MAX);
    let title_contains = check.optional_string(fields, "titleContains", false, 1, usize::MAX);
    let archived = check.optional_enumeration(fields, "archived", &flag);
    let attention = check.optional_enumeration(fields, "attention", &flag);
    let blocker = check.optional_enumeration(fields, "blocker", &flag);
    let updated_since = match check.optional_string(fields, "updatedSince", false, 0, usize::MAX) {
        Some(Some(value)) if !zod_datetime(&value) => {
            check.fail("invalid_format", &path(&["updatedSince"]));
            None
        }
        value => value,
    };
    let cursor = check.optional_string(fields, "cursor", false, 1, 2048);
    let limit = match fields.get("limit") {
        None => Some(50),
        Some(value) => {
            let at = path(&["limit"]);
            match check.integer(Some(js_number(value)), &at, 1.0) {
                Some(limit) if limit > 100 => {
                    check.fail("too_big", &at);
                    None
                }
                limit => limit,
            }
        }
    };
    let filter = check.optional_enumeration(fields, "filter", &TASK_FILTERS);
    let view = check.optional_enumeration(fields, "view", &["summary", "full"]);
    check.unknown_keys(fields, &[], allowed);
    let query = (|| {
        Some(TaskListQuery {
            project_id: project_id?,
            status: status?.map(|status| TaskStatus::parse(&status).expect("validated status")),
            pull_request_number: pull_request_number?,
            source_branch: source_branch?,
            title_contains: title_contains?,
            archived: archived?,
            attention: attention?,
            blocker: blocker?,
            updated_since: updated_since?,
            cursor: cursor?,
            limit: limit?,
            filter: filter?,
            view: view?,
        })
    })();
    check.finish(query)
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

    pub(crate) fn assert_fixtures<T: Serialize>(
        name: &str,
        parse: fn(Option<&Value>) -> ContractResult<T>,
    ) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/parity")
            .join(name);
        let mut tested = 0;
        for entry in std::fs::read_dir(&root).unwrap() {
            let path = entry.unwrap().path();
            let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let actual = match parse(fixture.get("input")) {
                Ok(value) => json!({"accepted": true, "value": value}),
                Err(ContractFailure::Issues(error)) => json!({"accepted": false, "error": error}),
                Err(other) => panic!("{}: {other:?}", path.display()),
            };
            assert_eq!(actual, fixture["expected"], "{}", path.display());
            tested += 1;
        }
        assert!(tested > 0, "{name}");
    }

    #[test]
    fn agent_api_request_fixtures_match_public_zod_contracts() {
        assert_fixtures(
            "agent-api.AgentApiAdminAgentParamsSchema",
            parse_agent_id_params,
        );
        assert_fixtures(
            "agent-api.AgentApiAdminCreateBodySchema",
            parse_admin_create,
        );
        assert_fixtures("agent-api.AgentApiAdminListQuerySchema", parse_admin_list);
        assert_fixtures(
            "agent-api.AgentApiAdminProjectsBodySchema",
            parse_admin_projects,
        );
        assert_fixtures(
            "agent-api.AgentApiDeliveryDecisionBodySchema",
            parse_delivery_decision,
        );
        assert_fixtures(
            "agent-api.AgentApiMergeApprovalBodySchema",
            parse_merge_approval,
        );
        assert_fixtures("agent-api.AgentApiMergeBodySchema", parse_merge);
        assert_fixtures("agent-api.AgentApiMergeTrainQuerySchema", parse_merge_train);
        assert_fixtures(
            "agent-api.AgentApiPairingExchangeBodySchema",
            parse_pairing_exchange,
        );
        assert_fixtures(
            "agent-api.AgentApiProjectDiscoveryQuerySchema",
            parse_project_discovery,
        );
        assert_fixtures(
            "agent-api.AgentApiTaskCommandBodySchema",
            parse_task_command,
        );
        assert_fixtures(
            "agent-api.AgentApiTaskCommandSchema",
            parse_task_command_name,
        );
        assert_fixtures("agent-api.AgentApiTaskCreateBodySchema", parse_task_create);
        assert_fixtures(
            "agent-api.AgentApiTaskDependenciesBodySchema",
            parse_task_dependencies,
        );
        assert_fixtures("agent-api.AgentApiTaskFilterSchema", parse_task_filter);
        assert_fixtures("agent-api.AgentApiTaskIdParamsSchema", parse_task_id_params);
        assert_fixtures("agent-api.AgentApiTaskListQuerySchema", parse_task_list);
    }

    fn findings<T>(result: ContractResult<T>) -> Vec<String> {
        match result {
            Ok(_) => vec![],
            Err(ContractFailure::Issues(issues)) => issues
                .iter()
                .map(|issue| {
                    format!(
                        "{} {}",
                        issue["code"].as_str().unwrap(),
                        issue["field"].as_str().unwrap()
                    )
                })
                .collect(),
            Err(other) => panic!("{other:?}"),
        }
    }

    /// Expected values come from the TypeScript Zod schemas.
    #[test]
    fn nested_and_coerced_findings_follow_zod_order() {
        assert_eq!(
            findings(parse_task_command(Some(
                &json!({"command":"start_task","revision":"","idempotencyKey":"k","note":"n"})
            ))),
            ["invalid-too_small .revision", "invalid-custom .note"]
        );
        assert_eq!(
            findings(parse_task_command(Some(
                &json!({"command":"start_task","revision":"x","idempotencyKey":"k","note":"n","z":1})
            ))),
            ["invalid-unrecognized_keys ."]
        );
        assert_eq!(
            findings(parse_task_create(Some(
                &json!({"projectId":"","title":"t","idempotencyKey":"k","workflowId":"w","templateId":"t"})
            ))),
            ["invalid-too_small .projectId", "invalid-custom ."]
        );
        assert_eq!(
            findings(parse_task_create(Some(
                &json!({"projectId":"p","title":"t","idempotencyKey":"k","images":[{"filename":"a/b","mimeType":"image/png","base64":""}],"source":{"kind":"branch","branch":"","x":1}})
            ))),
            [
                "invalid-custom .images.0.filename",
                "invalid-too_small .images.0.base64",
                "invalid-too_small .source.branch",
                "invalid-unrecognized_keys .source"
            ]
        );
        assert_eq!(
            findings(parse_task_create(Some(
                &json!({"projectId":"p","title":"t","idempotencyKey":"k","source":{"kind":"issue","number":0},"images":[1],"dependsOn":"x","blockedByPullRequests":[1]})
            ))),
            [
                "invalid-invalid_type .dependsOn",
                "invalid-invalid_type .blockedByPullRequests.0",
                "invalid-invalid_type .images.0",
                "invalid-too_small .source.number"
            ]
        );
        let full = parse_task_create(Some(&json!({"x":1,"projectId":"p","title":" t ","idempotencyKey":" k ","description":" d ","dryRun":true,"queue":true,"source":{"kind":"pull_request","number":3},"advisorProfileIds":{"reviewer":"r"},"dependsOn":["a"],"blockedByPullRequests":[{"number":2}],"images":[{"filename":"a.png","mimeType":"image/png","base64":"AA=="}],"workflowId":"w","rootProfileId":"r","workerProfileId":"w","deliveryTarget":"merged","runProjectTests":false,"visualEvidence":"off"}))).unwrap();
        assert_eq!(
            crate::shared::js_json::stringify(&serde_json::to_value(full).unwrap()),
            r#"{"projectId":"p","title":"t","description":"d","idempotencyKey":"k","dependsOn":["a"],"blockedByPullRequests":[{"number":2}],"queue":true,"images":[{"filename":"a.png","mimeType":"image/png","base64":"AA=="}],"source":{"kind":"pull_request","number":3},"workflowId":"w","rootProfileId":"r","workerProfileId":"w","advisorProfileIds":{"reviewer":"r"},"deliveryTarget":"merged","runProjectTests":false,"visualEvidence":"off","dryRun":true,"x":1}"#
        );
        assert_eq!(
            findings(parse_task_list(Some(
                &json!({"limit":"0","pullRequestNumber":"1.5","updatedSince":"x","status":"bad","archived":"yes","filter":"x","view":"x","cursor":"","projectId":""})
            ))),
            [
                "invalid-too_small .projectId",
                "invalid-invalid_value .status",
                "invalid-invalid_type .pullRequestNumber",
                "invalid-invalid_value .archived",
                "invalid-invalid_format .updatedSince",
                "invalid-too_small .cursor",
                "invalid-too_small .limit",
                "invalid-invalid_value .filter",
                "invalid-invalid_value .view"
            ]
        );
        for (limit, expected) in [
            ("0x10", Some(16)),
            ("1e1", Some(10)),
            (" 5 ", Some(5)),
            ("Infinity", None),
            ("", None),
        ] {
            assert_eq!(
                parse_task_list(Some(&json!({"limit": limit})))
                    .ok()
                    .map(|query| query.limit),
                expected,
                "{limit}"
            );
        }
        assert_eq!(
            findings(parse_task_list(Some(
                &json!({"limit":"101","pullRequestNumber":"9007199254740993"})
            ))),
            [
                "invalid-too_big .pullRequestNumber",
                "invalid-too_big .limit"
            ]
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
            findings(parse_task_dependencies(Some(
                &json!({"dependsOn":["","a"],"blockedByPullRequests":[{"number":1.5}],"dryRun":false})
            ))),
            [
                "invalid-too_small .dependsOn.0",
                "invalid-invalid_type .blockedByPullRequests.0.number",
                "invalid-invalid_value .dryRun"
            ]
        );
        assert_eq!(
            findings(parse_admin_create(Some(
                &json!({"name":" ","companyId":"","projectIds":[],"avatarSeed":1})
            ))),
            [
                "invalid-too_small .name",
                "invalid-too_small .companyId",
                "invalid-too_small .projectIds",
                "invalid-invalid_type .avatarSeed"
            ]
        );
        assert_eq!(
            findings(parse_merge_approval(Some(
                &json!({"pullRequestNumber":0,"headSha":"x","baseSha":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
            ))),
            [
                "invalid-too_small .pullRequestNumber",
                "invalid-invalid_format .headSha",
                "invalid-invalid_format .baseSha"
            ]
        );
        assert_eq!(
            query_object(Some("limit=1&limit=2&view=summary")),
            json!({"limit":["1","2"],"view":"summary"})
        );
    }
}
