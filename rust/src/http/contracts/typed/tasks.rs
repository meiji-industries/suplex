use crate::coordination::workflows::Workflow;
use crate::tasks::control::DeliveryTarget;
pub(crate) use crate::tasks::control::trimmed;
use garde::Validate;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use super::{
    Contract, ContractFailure, ContractResult, Fields, MAX, advisors, choice, flag, formatted,
    id_1_256 as check_task_id, int, list, nullable, one_of, optional_nonnull, params, present,
    present_nullable, rule, tagged, text, trimmed as trimmed_text, union, url,
    visual_evidence as check_visual_evidence,
};

const MAX_TASK_IMAGES: usize = 8;
const MAX_TASK_IMAGE_BASE64_LENGTH: usize = 11_184_812;
const MAX_TASK_DEPENDENCIES: usize = 50;
pub(crate) const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
pub(crate) const VISUAL_EVIDENCE: &[&str] = &["off", "capture", "required"];
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];
pub const WORKTREE_APPS: &[&str] = &["finder", "cursor", "vscode", "ghostty", "terminal"];

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCreateBody {
    #[garde(custom(check_task_id))]
    pub project_id: String,
    #[serde(deserialize_with = "trimmed")]
    #[garde(length(min = 1))]
    pub title: String,
    #[serde(default, deserialize_with = "trimmed")]
    #[garde(skip)]
    pub description: String,
    #[garde(custom(check_idempotency_key))]
    pub idempotency_key: String,
    #[serde(default)]
    #[garde(length(max = MAX_TASK_IMAGES), dive)]
    pub images: Vec<TaskImage>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_task_id)))]
    pub root_profile_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_task_id)))]
    pub worker_profile_id: Option<String>,
    #[serde(default)]
    #[garde(skip)]
    pub start_immediately: bool,
    #[serde(default = "default_delivery_target")]
    #[garde(skip)]
    pub delivery_target: DeliveryTarget,
    #[serde(default = "default_run_project_tests")]
    #[garde(skip)]
    pub run_project_tests: bool,
    #[serde(default = "default_visual_evidence")]
    #[garde(custom(check_visual_evidence))]
    pub visual_evidence: String,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(dive)]
    pub source: Option<TaskSource>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(skip)]
    pub issue: Option<Option<IssueAssociation>>,
    #[serde(default = "default_workflow")]
    #[garde(skip)]
    pub workflow: Workflow,
    #[serde(default)]
    #[garde(dive)]
    pub advisor_profile_ids: AdvisorProfileIds,
    #[serde(default)]
    #[garde(length(max = MAX_TASK_DEPENDENCIES), inner(custom(check_task_id)))]
    pub depends_on: Vec<String>,
    #[serde(default)]
    #[garde(length(max = MAX_TASK_DEPENDENCIES), dive)]
    pub blocked_by_pull_requests: Vec<PullRequestDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskImage {
    #[garde(length(utf16, min = 1, max = 255), custom(image_filename))]
    pub filename: String,
    #[garde(custom(image_mime))]
    pub mime_type: String,
    #[garde(length(utf16, min = 1, max = MAX_TASK_IMAGE_BASE64_LENGTH))]
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskSource {
    Issue {
        #[serde(deserialize_with = "js_u64")]
        number: u64,
    },
    Branch {
        branch: String,
    },
    PullRequest {
        #[serde(deserialize_with = "js_u64")]
        number: u64,
    },
}

impl Validate for TaskSource {
    type Context = ();
    fn validate_into(
        &self,
        context: &Self::Context,
        path: &mut dyn FnMut() -> garde::Path,
        report: &mut garde::Report,
    ) {
        let _ = context;
        match self {
            Self::Issue { number } | Self::PullRequest { number }
                if *number == 0 || *number > 9_007_199_254_740_991 =>
            {
                report.append(path().join("number"), garde::Error::new("invalid_number"));
            }
            Self::Branch { branch } if branch.is_empty() => {
                report.append(path().join("branch"), garde::Error::new("too_small"));
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct AdvisorProfileIds {
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_task_id)))]
    pub reviewer: Option<String>,
    #[serde(
        default,
        rename = "planner_a",
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_task_id)))]
    pub planner_a: Option<String>,
    #[serde(
        default,
        rename = "planner_b",
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_task_id)))]
    pub planner_b: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_task_id)))]
    pub rater: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct PullRequestDependency {
    #[serde(deserialize_with = "js_u64")]
    #[garde(custom(positive_safe_integer))]
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum IssueAssociation {
    Github {
        repository: String,
        #[serde(deserialize_with = "js_u64")]
        number: u64,
        id: String,
        key: String,
        title: String,
        url: String,
    },
    Jira {
        site: String,
        id: String,
        key: String,
        title: String,
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIdParams {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactParams {
    pub task_id: String,
    pub artifact_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSessionParams {
    pub task_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskHistoryQuery {
    pub before: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentsBatchQuery {
    pub task_id: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDetailsBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_target: Option<DeliveryTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_project_tests: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_evidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<Workflow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advisor_profile_ids: Option<AdvisorProfileIds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskRenameBody {
    pub title: String,
}

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArchiveBody {
    #[serde(default)]
    pub confirm_discard_dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNoteBody {
    pub note: String,
}

pub use crate::tasks::control::{TaskCoordinatorReplacementBody, TaskWorkerReplacementBody};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentSelectionBody {
    pub role: String,
    pub expected_profile_id: String,
    pub expected_session_id: Option<String>,
    pub profile_id: String,
    pub direction: String,
    pub resume: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDependenciesBody {
    #[serde(default)]
    #[garde(length(max = MAX_TASK_DEPENDENCIES), inner(custom(check_task_id)))]
    pub depends_on: Vec<String>,
    #[serde(default)]
    #[garde(length(max = MAX_TASK_DEPENDENCIES), dive)]
    pub blocked_by_pull_requests: Vec<PullRequestDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskIssueBody {
    pub issue: Option<IssueAssociation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContinueDeliveryBody {
    pub delivery_target: DeliveryTarget,
}

fn js_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if value.fract() == 0.0 && (1.0..=MAX_SAFE).contains(&value) {
        Ok(value as u64)
    } else {
        Err(serde::de::Error::custom("expected positive safe integer"))
    }
}

fn check_idempotency_key(value: &str, _: &()) -> garde::Result {
    let bytes = value.as_bytes();
    rule(
        (8..=128).contains(&bytes.len())
            && bytes[0].is_ascii_alphanumeric()
            && bytes[1..].iter().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-')
            }),
        "invalid_format",
    )
}
fn image_filename(value: &str, _: &()) -> garde::Result {
    rule(
        !value.contains(['/', '\\']) && !value.contains(".."),
        "custom",
    )
}
fn image_mime(value: &str, _: &()) -> garde::Result {
    rule(IMAGE_TYPES.contains(&value), "invalid_value")
}
fn positive_safe_integer(value: &u64, _: &()) -> garde::Result {
    rule(
        (1..=9_007_199_254_740_991).contains(value),
        "invalid_number",
    )
}
pub(crate) fn default_delivery_target() -> DeliveryTarget {
    DeliveryTarget::PullRequestDraft
}
pub(crate) fn default_run_project_tests() -> bool {
    true
}
pub(crate) fn default_visual_evidence() -> String {
    "off".into()
}
pub(crate) fn default_workflow() -> Workflow {
    Workflow::Standard
}

pub(crate) fn id() -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    text(1, 256)
}

/// `TaskImageInputSchema`.
pub(crate) fn image(input: Option<&Value>) -> ContractResult<Value> {
    Fields::new(input)?
        .req("filename", formatted(1, 255, image_filename))
        .req("mimeType", one_of(IMAGE_TYPES))
        .req("base64", text(1, MAX_TASK_IMAGE_BASE64_LENGTH))
        .strict()
}

/// `PullRequestDependencyInputSchema`.
pub(crate) fn pull_request(input: Option<&Value>) -> ContractResult<Value> {
    Fields::new(input)?
        .req("number", int(1.0, MAX_SAFE))
        .strict()
}

/// `TaskSourceInputSchema`.
pub(crate) fn source(input: Option<&Value>) -> ContractResult<Value> {
    tagged(input, "kind", |kind| {
        let fields = Fields::new(input).ok()?.req("kind", present);
        Some(match kind.as_str()? {
            "issue" | "pull_request" => fields.req("number", int(1.0, MAX_SAFE)).strict(),
            "branch" => fields.req("branch", text(1, MAX)).strict(),
            _ => return None,
        })
    })
}

fn github_repository(value: &str, _: &()) -> garde::Result {
    let parts = value.split('/').collect::<Vec<_>>();
    rule(
        parts.len() == 2
            && parts.iter().all(|part| {
                !part.is_empty()
                    && part.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
                    })
            }),
        "invalid_format",
    )
}

fn digits(value: &str, _: &()) -> garde::Result {
    rule(
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
        "invalid_format",
    )
}

fn jira_key(value: &str, _: &()) -> garde::Result {
    let (prefix, number) = value.rsplit_once('-').unwrap_or_default();
    let mut prefix = prefix.bytes();
    rule(
        digits(number, &()).is_ok()
            && prefix.next().is_some_and(|byte| byte.is_ascii_uppercase())
            && prefix
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
        "invalid_format",
    )
}

fn parsed_url(value: Option<&Value>) -> ContractResult<url::Url> {
    url::Url::parse(value.and_then(Value::as_str).unwrap_or_default())
        .map_err(|_| ContractFailure::Unhandled)
}

/// The issue URL's own refinement: a GitHub URL. `new URL` throws on a bad one.
fn github_url(input: Option<&Value>) -> ContractResult<Value> {
    let value = formatted(0, MAX, url)(input)?;
    if parsed_url(Some(&value))?.origin().ascii_serialization() == "https://github.com" {
        Ok(value)
    } else {
        super::fail("custom")
    }
}

/// `IssueAssociationSchema`, with its URL refinement.
pub(crate) fn issue_association(input: Option<&Value>) -> ContractResult<Value> {
    tagged(input, "kind", |kind| {
        let fields = Fields::new(input).ok()?.req("kind", present);
        let mut fields = match kind.as_str()? {
            "github" => fields
                .req("repository", formatted(0, MAX, github_repository))
                .req("number", int(1.0, MAX_SAFE))
                .req("id", text(0, MAX))
                .req("key", text(0, MAX))
                .req("title", text(0, MAX))
                .req("url", github_url),
            "jira" => fields
                .req("site", formatted(0, MAX, url))
                .req("id", formatted(0, MAX, digits))
                .req("key", formatted(0, MAX, jira_key))
                .req("title", text(0, MAX))
                .req("url", formatted(0, MAX, url)),
            _ => return None,
        };
        fields.strict_keys();
        if fields.refinable() {
            Some(refine_issue(&mut fields, kind).and_then(|()| fields.finish()))
        } else {
            Some(fields.finish())
        }
    })
}

fn refine_issue(fields: &mut Fields, kind: &Value) -> ContractResult<()> {
    let url = parsed_url(fields.raw("url"))?;
    let raw = |name| fields.raw(name).and_then(Value::as_str).unwrap_or_default();
    let matches = if kind == "github" {
        let number = fields
            .raw("number")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        let expected = format!(
            "https://github.com/{}/issues/{}",
            raw("repository"),
            js_number(number)
        );
        url.as_str().eq_ignore_ascii_case(&expected)
    } else {
        let site = parsed_url(fields.raw("site"))?;
        let expected = format!(
            "{}/browse/{}",
            site.origin().ascii_serialization(),
            raw("key")
        );
        if site.scheme() != "https"
            || !site
                .host_str()
                .is_some_and(|host| host.ends_with(".atlassian.net"))
            || !site.username().is_empty()
            || site.password().is_some()
            || site.query().is_some()
            || site.fragment().is_some()
            || site.path() != "/"
        {
            fields.fail("custom", ".site");
        }
        url.as_str() == expected
    };
    if !matches || !url.username().is_empty() || url.password().is_some() {
        fields.fail("custom", ".url");
    }
    Ok(())
}

/// JavaScript's rendering of a finite number in a template string.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

fn dependencies(fields: Fields) -> Fields {
    fields
        .or("dependsOn", json!([]), list(id(), 0, MAX_TASK_DEPENDENCIES))
        .or(
            "blockedByPullRequests",
            json!([]),
            list(pull_request, 0, MAX_TASK_DEPENDENCIES),
        )
}

/// `TaskInputSchema`.
impl Contract for TaskCreateBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let fields = Fields::new(input)?
            .req("projectId", id())
            .req("title", trimmed_text(1, MAX))
            .or("description", json!(""), trimmed_text(0, MAX))
            .req("idempotencyKey", formatted(0, MAX, check_idempotency_key))
            .or("images", json!([]), list(image, 0, MAX_TASK_IMAGES))
            .opt("rootProfileId", id())
            .opt("workerProfileId", id())
            .or("startImmediately", json!(false), flag)
            .or(
                "deliveryTarget",
                json!("pull_request_draft"),
                choice::<DeliveryTarget>,
            )
            .or("runProjectTests", json!(true), flag)
            .or("visualEvidence", json!("off"), one_of(VISUAL_EVIDENCE))
            .opt("source", source)
            .opt("issue", nullable(issue_association))
            .or("workflow", json!("standard"), choice::<Workflow>)
            .or("advisorProfileIds", json!({}), advisors);
        dependencies(fields).strict()
    }
}

pub fn parse_task_create(input: Option<&Value>) -> ContractResult<TaskCreateBody> {
    TaskCreateBody::parse(input)
}

pub fn parse_task_dependencies(input: Option<&Value>) -> ContractResult<TaskDependenciesBody> {
    TaskDependenciesBody::parse(input)
}

pub fn parse_task_agent_selection(input: Option<&Value>) -> ContractResult<TaskAgentSelectionBody> {
    TaskAgentSelectionBody::parse(input)
}

impl Contract for TaskIdParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["taskId"], (1, 256))
    }
}

impl Contract for TaskArtifactParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["taskId", "artifactId"], (1, 256))
    }
}

impl Contract for TaskSessionParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["taskId", "sessionId"], (1, MAX))
    }
}

impl Contract for TaskHistoryQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.opt("before", text(1, 512)).finish()
    }
}

/// One task id or up to ten, sorted by UTF-16 code units without duplicates.
impl Contract for TaskAgentsBatchQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .or("taskId", json!([]), |input| {
                let ids = union(
                    input,
                    &[
                        &|input| id()(input).map(|id| json!([id])),
                        &list(id(), 0, 10),
                    ],
                )?;
                let mut ids = ids.as_array().cloned().unwrap_or_default();
                ids.sort_by(|left, right| {
                    let text = |value: &Value| {
                        value
                            .as_str()
                            .unwrap_or_default()
                            .encode_utf16()
                            .collect::<Vec<_>>()
                    };
                    text(left).cmp(&text(right))
                });
                ids.dedup();
                Ok(Value::Array(ids))
            })
            .finish()
    }
}

/// The task list query: `archived=true` lists archived tasks.
#[derive(Debug, Clone, Deserialize)]
pub struct ArchivedQuery {
    pub archived: Option<String>,
}

impl Contract for ArchivedQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("archived", one_of(&["true", "false"]))
            .finish()
    }
}

pub fn worktree_app(input: Option<&Value>) -> ContractResult<Value> {
    one_of(WORKTREE_APPS)(input)
}

/// `{ app }`: a desktop application or the configured editor.
#[derive(Debug, Clone, Deserialize)]
pub struct WorktreeOpenBody {
    pub app: String,
}

impl Contract for WorktreeOpenBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("app", |input| {
                union(input, &[&worktree_app, &one_of(&["editor"])])
            })
            .finish()
    }
}

/// A task pane: the task and the Coordinator, Worker, or shell pane.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPaneParams {
    pub task_id: String,
    pub role: String,
}

impl Contract for TaskPaneParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("taskId", id())
            .req("role", |input| {
                union(input, &[&one_of(&["root", "worker"]), &one_of(&["shell"])])
            })
            .finish()
    }
}

/// Terminal dimensions from the query, coerced like `z.coerce.number()`.
#[derive(Debug, Clone, Deserialize)]
pub struct TerminalSize {
    pub cols: i64,
    pub rows: i64,
}

impl Contract for TerminalSize {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .or("cols", json!(80), super::coerced(20.0, 300.0))
            .or("rows", json!(24), super::coerced(5.0, 150.0))
            .finish()
    }
}

/// Every field is optional and carries no default.
impl Contract for TaskDetailsBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("title", trimmed_text(1, MAX))
            .opt("description", trimmed_text(0, MAX))
            .opt("rootProfileId", id())
            .opt("workerProfileId", id())
            .opt("deliveryTarget", choice::<DeliveryTarget>)
            .opt("runProjectTests", flag)
            .opt("visualEvidence", one_of(VISUAL_EVIDENCE))
            .opt("workflow", choice::<Workflow>)
            .opt("advisorProfileIds", advisors)
            .strict()
    }
}

impl Contract for TaskRenameBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("title", trimmed_text(1, MAX))
            .strict()
    }
}

/// The route accepts no body as `Option<TaskArchiveBody>`.
impl Contract for TaskArchiveBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("confirmDiscardDirty", flag)
            .strict()
    }
}

impl Contract for TaskNoteBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("note", trimmed_text(1, 20_000))
            .strict()
    }
}

/// `resume` selects the union branch; only a resumed replacement names its question.
impl Contract for TaskCoordinatorReplacementBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        resumable(input, |fields| {
            fields
                .req("sessionId", text(1, MAX))
                .req("rootProfileId", text(1, MAX))
                .opt("handoff", trimmed_text(0, MAX))
        })
    }
}

fn resumable(
    input: Option<&Value>,
    fields: impl FnOnce(Fields) -> Fields,
) -> ContractResult<Value> {
    tagged(input, "resume", |resume| {
        let parsed = fields(Fields::new(input).ok()?).req("resume", present);
        Some(match resume.as_bool()? {
            true => parsed.req("questionId", text(1, MAX)).strict(),
            false => parsed.strict(),
        })
    })
}

impl Contract for TaskWorkerReplacementBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("sessionId", text(1, MAX))
            .req("reason", trimmed_text(1, MAX))
            .opt("handoff", trimmed_text(0, MAX))
            .opt("workerProfileId", text(1, MAX))
            .strict()
    }
}

impl Contract for TaskAgentSelectionBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        resumable(input, |fields| {
            fields
                .req(
                    "role",
                    one_of(&[
                        "root",
                        "worker",
                        "reviewer",
                        "planner_a",
                        "planner_b",
                        "rater",
                    ]),
                )
                .req("expectedProfileId", text(1, MAX))
                .req("expectedSessionId", nullable(text(1, MAX)))
                .req("profileId", text(1, MAX))
                .req("direction", trimmed_text(0, MAX))
        })
    }
}

/// Both prerequisite lists default to empty; a supplied list replaces the old one.
impl Contract for TaskDependenciesBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        dependencies(Fields::new(input)?).strict()
    }
}

/// The issue link body is strict; `null` clears the link.
impl Contract for TaskIssueBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("issue", nullable(issue_association))
            .strict()
    }
}

/// Delivery can continue only to a ready pull request or a merge.
impl Contract for TaskContinueDeliveryBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req(
                "deliveryTarget",
                one_of(&[
                    "local_worktree",
                    "remote_branch",
                    "pull_request_draft",
                    "pull_request_ready",
                    "merged",
                ]),
            )
            .strict()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_archive_body_is_strict_and_preserves_public_findings() {
        fn parse(input: Option<&Value>) -> ContractResult<TaskArchiveBody> {
            Option::<TaskArchiveBody>::parse(input).map(Option::unwrap_or_default)
        }
        assert!(!parse(None).unwrap().confirm_discard_dirty);
        assert!(!parse(Some(&json!({}))).unwrap().confirm_discard_dirty);
        assert!(
            parse(Some(&json!({"confirmDiscardDirty":true})))
                .unwrap()
                .confirm_discard_dirty
        );
        for (input, code, field) in [
            (Value::Null, "invalid_type", "."),
            (
                json!({"confirmDiscardDirty":"yes"}),
                "invalid_type",
                ".confirmDiscardDirty",
            ),
            (json!({"other":true}), "unrecognized_keys", "."),
        ] {
            assert!(matches!(
                parse(Some(&input)),
                Err(ContractFailure::Issues(issues)) if issues == vec![super::super::issue(code, field)]
            ));
        }
    }

    #[test]
    fn integral_float_tokens_follow_javascript_number_parsing() {
        let value: Value = serde_json::from_str(r#"{
            "projectId":"project","title":"Build","idempotencyKey":"sample-001",
            "source":{"kind":"issue","number":1.0},
            "issue":{"kind":"github","repository":"team/repo","number":1.0,"id":"1","key":"GH-1","title":"Issue","url":"https://github.com/team/repo/issues/1"},
            "blockedByPullRequests":[{"number":1.0}]
        }"#).unwrap();
        let parsed = parse_task_create(Some(&value)).unwrap();
        assert!(matches!(
            parsed.source,
            Some(TaskSource::Issue { number: 1 })
        ));
        assert_eq!(parsed.blocked_by_pull_requests[0].number, 1);
        assert!(matches!(
            parsed.issue,
            Some(Some(IssueAssociation::Github { number: 1, .. }))
        ));
        let fraction: Value = serde_json::from_str(r#"{"projectId":"p","title":"Build","idempotencyKey":"sample-001","source":{"kind":"issue","number":1.5}}"#).unwrap();
        assert!(
            matches!(parse_task_create(Some(&fraction)), Err(ContractFailure::Issues(findings)) if findings == vec![super::super::issue("invalid_type", ".source.number")])
        );
    }

    #[test]
    fn source_create_contract_accepts_only_stable_selectors() {
        assert_eq!(
            source(Some(&json!({"kind":"pull_request","number":7}))).unwrap(),
            json!({"kind":"pull_request","number":7})
        );
        assert!(
            source(Some(
                &json!({"kind":"pull_request","number":7,"headSha":"a".repeat(40)})
            ))
            .is_err()
        );
        assert!(
            source(Some(
                &json!({"kind":"branch","branch":"feature","headSha":"a".repeat(40)})
            ))
            .is_err()
        );
    }

    #[test]
    fn garde_paths_use_request_field_names() {
        let body: TaskCreateBody = serde_json::from_value(json!({
            "projectId": "", "title": "Build", "idempotencyKey": "sample-001",
            "advisorProfileIds": {"planner_a": ""},
            "images": [{"filename": "image.png", "mimeType": "text/plain", "base64": "YQ=="}],
            "blockedByPullRequests": [{"number": 1}]
        }))
        .unwrap();
        let findings = super::super::garde_findings(&body.validate().unwrap_err(), &body);
        let issue = super::super::issue;
        assert_eq!(
            findings,
            vec![
                issue("too_small", ".advisorProfileIds.planner_a"),
                issue("invalid_value", ".images.0.mimeType"),
                issue("too_small", ".projectId"),
            ]
        );
    }
}
