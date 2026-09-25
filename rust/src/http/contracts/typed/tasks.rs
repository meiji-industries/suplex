use garde::Validate;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::{
    ContractFailure, ContractResult, delivery_target as check_delivery_target, finding,
    garde_findings, id_1_256 as check_task_id, object, visual_evidence as check_visual_evidence,
};

const MAX_TASK_IMAGES: usize = 8;
const MAX_TASK_IMAGE_BASE64_LENGTH: usize = 11_184_812;
const MAX_TASK_DEPENDENCIES: usize = 50;

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
    #[garde(custom(check_delivery_target))]
    pub delivery_target: String,
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
    #[garde(custom(check_workflow))]
    pub workflow: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
pub struct TaskIdParams {
    #[garde(custom(check_task_id))]
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDetailsBody {
    #[serde(
        default,
        deserialize_with = "optional_trimmed",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(length(utf16, min = 1)))]
    pub title: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_trimmed",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(skip)]
    pub description: Option<String>,
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
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_delivery_target)))]
    pub delivery_target: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(skip)]
    pub run_project_tests: Option<bool>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_visual_evidence)))]
    pub visual_evidence: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(check_workflow)))]
    pub workflow: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(dive)]
    pub advisor_profile_ids: Option<AdvisorProfileIds>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
pub struct TaskRenameBody {
    #[serde(deserialize_with = "trimmed")]
    #[garde(length(utf16, min = 1))]
    pub title: String,
}

fn optional_trimmed<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    trimmed(deserializer).map(Some)
}

pub(crate) fn optional_nonnull<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn safe_positive_integer(number: &serde_json::Number) -> Option<u64> {
    let value = number.as_f64()?;
    if value.is_finite() && value.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&value)
    {
        Some(value as u64)
    } else {
        None
    }
}

fn js_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    value
        .as_number()
        .and_then(safe_positive_integer)
        .filter(|value| *value > 0)
        .ok_or_else(|| serde::de::Error::custom("expected positive safe integer"))
}

pub(crate) fn trimmed<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Ok(value
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_owned())
}

fn check_idempotency_key(value: &str, _: &()) -> garde::Result {
    let bytes = value.as_bytes();
    if (8..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(garde::Error::new("invalid_format"))
    }
}
fn image_filename(value: &str, _: &()) -> garde::Result {
    if value.contains(['/', '\\']) || value.contains("..") {
        return Err(garde::Error::new("custom"));
    }
    Ok(())
}
fn image_mime(value: &str, _: &()) -> garde::Result {
    if ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&value) {
        Ok(())
    } else {
        Err(garde::Error::new("invalid_value"))
    }
}
fn positive_safe_integer(value: &u64, _: &()) -> garde::Result {
    if (1..=9_007_199_254_740_991).contains(value) {
        Ok(())
    } else {
        Err(garde::Error::new("invalid_number"))
    }
}
pub(crate) fn check_workflow(value: &str, _: &()) -> garde::Result {
    if [
        "standard",
        "direct_build",
        "independent_review",
        "competing_plans",
        "refine_pull_request",
    ]
    .contains(&value)
    {
        Ok(())
    } else {
        Err(garde::Error::new("invalid_value"))
    }
}
pub(crate) fn default_delivery_target() -> String {
    "pull_request_draft".into()
}
pub(crate) fn default_run_project_tests() -> bool {
    true
}
pub(crate) fn default_visual_evidence() -> String {
    "off".into()
}
pub(crate) fn default_workflow() -> String {
    "standard".into()
}

pub fn parse_task_create(input: Option<&Value>) -> ContractResult<TaskCreateBody> {
    let fields = object(input)?;
    let shape = task_shape_findings(fields)?;
    if !shape.is_empty() {
        return Err(ContractFailure::Issues(shape));
    }
    let parsed: TaskCreateBody = serde_path_to_error::deserialize(Value::Object(fields.clone()))
        .map_err(|error| {
            ContractFailure::Issues(vec![finding(
                "invalid_type",
                &[Value::String(error.path().to_string())],
            )])
        })?;
    parsed
        .validate()
        .map_err(|report| ContractFailure::Issues(garde_findings(&report)))?;
    Ok(parsed)
}

fn issue(code: &str, field: &str) -> Value {
    serde_json::json!({"code": format!("invalid-{code}"), "field": field, "message": "Request value is invalid"})
}

fn integer_finding(value: Option<&Value>, field: &str) -> Option<Value> {
    let Some(Value::Number(number)) = value else {
        return Some(issue("invalid_type", field));
    };
    if number.as_f64().is_some_and(|value| value <= 0.0) {
        return Some(issue("too_small", field));
    }
    if number
        .as_f64()
        .is_some_and(|value| value > 9_007_199_254_740_991.0)
    {
        return Some(issue("too_big", field));
    }
    if safe_positive_integer(number).is_some_and(|value| value > 0) {
        None
    } else {
        Some(issue("invalid_type", field))
    }
}

fn task_shape_findings(fields: &Map<String, Value>) -> ContractResult<Vec<Value>> {
    let mut errors = Vec::new();
    for name in ["projectId", "title", "idempotencyKey"] {
        if !fields.get(name).is_some_and(Value::is_string) {
            errors.push(issue("invalid_type", &format!(".{name}")));
        }
    }
    for name in ["description", "rootProfileId", "workerProfileId"] {
        if fields.get(name).is_some_and(|value| !value.is_string()) {
            errors.push(issue("invalid_type", &format!(".{name}")));
        }
    }
    if let Some(images) = fields.get("images") {
        if let Some(images) = images.as_array() {
            for (index, image) in images.iter().enumerate() {
                let prefix = format!(".images.{index}");
                if let Some(image) = image.as_object() {
                    if let Some(filename) = image.get("filename").and_then(Value::as_str) {
                        let size = filename.encode_utf16().count();
                        if size == 0 {
                            errors.push(issue("too_small", &format!("{prefix}.filename")));
                        }
                        if size > 255 {
                            errors.push(issue("too_big", &format!("{prefix}.filename")));
                        }
                        if filename.contains(['/', '\\']) || filename.contains("..") {
                            errors.push(issue("custom", &format!("{prefix}.filename")));
                        }
                    } else {
                        errors.push(issue("invalid_type", &format!("{prefix}.filename")));
                    }
                    if !image
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .is_some_and(|value| {
                            ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&value)
                        })
                    {
                        errors.push(issue("invalid_value", &format!("{prefix}.mimeType")));
                    }
                    if !image.get("base64").is_some_and(Value::is_string) {
                        errors.push(issue("invalid_type", &format!("{prefix}.base64")));
                    }
                    if image
                        .keys()
                        .any(|name| !["filename", "mimeType", "base64"].contains(&name.as_str()))
                    {
                        errors.push(issue("unrecognized_keys", &prefix));
                    }
                } else {
                    errors.push(issue("invalid_type", &prefix));
                }
            }
        } else {
            errors.push(issue("invalid_type", ".images"));
        }
    }
    for name in ["startImmediately", "runProjectTests"] {
        if fields.get(name).is_some_and(|value| !value.is_boolean()) {
            errors.push(issue("invalid_type", &format!(".{name}")));
        }
    }
    if let Some(source) = fields.get("source") {
        errors.extend(source_findings(source));
    }
    if let Some(issue) = fields.get("issue").filter(|issue| !issue.is_null()) {
        errors.extend(issue_findings(issue)?);
    }
    if let Some(advisors) = fields.get("advisorProfileIds") {
        if let Some(advisors) = advisors.as_object() {
            for role in ["reviewer", "planner_a", "planner_b", "rater"] {
                if let Some(value) = advisors.get(role) {
                    if let Some(value) = value.as_str() {
                        let size = value.encode_utf16().count();
                        if size == 0 {
                            errors.push(issue("too_small", &format!(".advisorProfileIds.{role}")));
                        }
                        if size > 256 {
                            errors.push(issue("too_big", &format!(".advisorProfileIds.{role}")));
                        }
                    } else {
                        errors.push(issue("invalid_type", &format!(".advisorProfileIds.{role}")));
                    }
                }
            }
            if advisors.keys().any(|name| {
                !["reviewer", "planner_a", "planner_b", "rater"].contains(&name.as_str())
            }) {
                errors.push(issue("unrecognized_keys", ".advisorProfileIds"));
            }
        } else {
            errors.push(issue("invalid_type", ".advisorProfileIds"));
        }
    }
    dependency_findings(fields, &mut errors);
    if fields.keys().any(|name| {
        ![
            "projectId",
            "title",
            "description",
            "idempotencyKey",
            "images",
            "rootProfileId",
            "workerProfileId",
            "startImmediately",
            "deliveryTarget",
            "runProjectTests",
            "visualEvidence",
            "source",
            "issue",
            "workflow",
            "advisorProfileIds",
            "dependsOn",
            "blockedByPullRequests",
        ]
        .contains(&name.as_str())
    }) {
        errors.push(issue("unrecognized_keys", "."));
    }
    Ok(errors)
}

fn dependency_findings(fields: &Map<String, Value>, errors: &mut Vec<Value>) {
    if let Some(dependencies) = fields.get("dependsOn") {
        if let Some(dependencies) = dependencies.as_array() {
            for (index, dependency) in dependencies.iter().enumerate() {
                if let Some(dependency) = dependency.as_str() {
                    let size = dependency.encode_utf16().count();
                    if size == 0 {
                        errors.push(issue("too_small", &format!(".dependsOn.{index}")));
                    }
                    if size > 256 {
                        errors.push(issue("too_big", &format!(".dependsOn.{index}")));
                    }
                } else {
                    errors.push(issue("invalid_type", &format!(".dependsOn.{index}")));
                }
            }
        } else {
            errors.push(issue("invalid_type", ".dependsOn"));
        }
    }
    if let Some(dependencies) = fields.get("blockedByPullRequests") {
        if let Some(dependencies) = dependencies.as_array() {
            for (index, dependency) in dependencies.iter().enumerate() {
                let prefix = format!(".blockedByPullRequests.{index}");
                if let Some(dependency) = dependency.as_object() {
                    if let Some(finding) =
                        integer_finding(dependency.get("number"), &format!("{prefix}.number"))
                    {
                        errors.push(finding);
                    }
                    if dependency.keys().any(|name| name != "number") {
                        errors.push(issue("unrecognized_keys", &prefix));
                    }
                } else {
                    errors.push(issue("invalid_type", &prefix));
                }
            }
        } else {
            errors.push(issue("invalid_type", ".blockedByPullRequests"));
        }
    }
}

fn source_findings(source: &Value) -> Vec<Value> {
    let Some(fields) = source.as_object() else {
        return vec![issue("invalid_type", ".source")];
    };
    let Some(kind) = fields.get("kind").and_then(Value::as_str) else {
        return vec![issue("invalid_union", ".source.kind")];
    };
    let mut errors = Vec::new();
    match kind {
        "issue" | "pull_request" => {
            if let Some(finding) = integer_finding(fields.get("number"), ".source.number") {
                errors.push(finding);
            }
        }
        "branch" => match fields.get("branch").and_then(Value::as_str) {
            Some("") => errors.push(issue("too_small", ".source.branch")),
            Some(_) => {}
            None => errors.push(issue("invalid_type", ".source.branch")),
        },
        _ => return vec![issue("invalid_union", ".source.kind")],
    }
    if fields
        .keys()
        .any(|name| name != "kind" && name != if kind == "branch" { "branch" } else { "number" })
    {
        errors.push(issue("unrecognized_keys", ".source"));
    }
    errors
}

fn issue_findings(value: &Value) -> ContractResult<Vec<Value>> {
    let Some(fields) = value.as_object() else {
        return Ok(vec![issue("invalid_type", ".issue")]);
    };
    let Some(kind) = fields.get("kind").and_then(Value::as_str) else {
        return Ok(vec![issue("invalid_union", ".issue.kind")]);
    };
    if kind != "github" && kind != "jira" {
        return Ok(vec![issue("invalid_union", ".issue.kind")]);
    }
    let mut errors = Vec::new();
    if kind == "github" {
        if let Some(repository) = fields.get("repository").and_then(Value::as_str) {
            let parts: Vec<_> = repository.split('/').collect();
            if parts.len() != 2
                || parts.iter().any(|part| {
                    part.is_empty()
                        || !part.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
                        })
                })
            {
                errors.push(issue("invalid_format", ".issue.repository"));
            }
        } else {
            errors.push(issue("invalid_type", ".issue.repository"));
        }
        if let Some(finding) = integer_finding(fields.get("number"), ".issue.number") {
            errors.push(finding);
        }
    } else {
        for name in ["site", "id", "key"] {
            if !fields.get(name).is_some_and(Value::is_string) {
                errors.push(issue("invalid_type", &format!(".issue.{name}")));
            }
        }
        if let Some(id) = fields.get("id").and_then(Value::as_str)
            && (id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()))
        {
            errors.push(issue("invalid_format", ".issue.id"));
        }
        if let Some(key) = fields.get("key").and_then(Value::as_str) {
            let mut parts = key.rsplitn(2, '-');
            let number = parts.next();
            let prefix = parts.next();
            if !number.is_some_and(|number| {
                !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
            }) || !prefix.is_some_and(|prefix| {
                let mut bytes = prefix.bytes();
                bytes.next().is_some_and(|byte| byte.is_ascii_uppercase())
                    && bytes.all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            }) {
                errors.push(issue("invalid_format", ".issue.key"));
            }
        }
    }
    for name in ["id", "key", "title", "url"] {
        if !fields.get(name).is_some_and(Value::is_string)
            && (kind == "github" || !["id", "key"].contains(&name))
        {
            errors.push(issue("invalid_type", &format!(".issue.{name}")));
        }
    }
    let url = fields
        .get("url")
        .and_then(Value::as_str)
        .and_then(|value| url::Url::parse(value).ok());
    if fields.get("url").and_then(Value::as_str).is_some() && url.is_none() {
        return Err(ContractFailure::Unhandled);
    }
    if kind == "github" {
        if let Some(url) = &url {
            if url.origin().ascii_serialization() != "https://github.com" {
                errors.push(issue("custom", ".issue.url"));
            }
            if let (Some(repository), Some(number)) = (
                fields.get("repository").and_then(Value::as_str),
                fields
                    .get("number")
                    .and_then(Value::as_number)
                    .and_then(safe_positive_integer),
            ) {
                let expected = format!("https://github.com/{repository}/issues/{number}");
                if !url.as_str().eq_ignore_ascii_case(&expected)
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    errors.push(issue("custom", ".issue.url"));
                }
            }
        }
    } else {
        let site = fields
            .get("site")
            .and_then(Value::as_str)
            .and_then(|value| url::Url::parse(value).ok());
        if fields.get("site").and_then(Value::as_str).is_some() && site.is_none() {
            return Err(ContractFailure::Unhandled);
        }
        if let (Some(url), Some(site), Some(key)) =
            (&url, &site, fields.get("key").and_then(Value::as_str))
        {
            let expected = format!("{}/browse/{key}", site.origin().ascii_serialization());
            if url.as_str() != expected || !url.username().is_empty() || url.password().is_some() {
                errors.push(issue("custom", ".issue.url"));
            }
        }
        if let Some(site) = &site
            && (site.scheme() != "https"
                || !site
                    .host_str()
                    .is_some_and(|host| host.ends_with(".atlassian.net"))
                || !site.username().is_empty()
                || site.password().is_some()
                || site.query().is_some()
                || site.fragment().is_some()
                || site.path() != "/")
        {
            errors.push(issue("custom", ".issue.site"));
        }
    }
    let allowed: &[&str] = if kind == "github" {
        &["kind", "repository", "number", "id", "key", "title", "url"]
    } else {
        &["kind", "site", "id", "key", "title", "url"]
    };
    if fields.keys().any(|name| !allowed.contains(&name.as_str())) {
        errors.push(issue("unrecognized_keys", ".issue"));
    }
    Ok(errors)
}

pub fn parse_task_id_params(input: Option<&Value>) -> ContractResult<TaskIdParams> {
    let fields = object(input)?;
    let parsed: TaskIdParams =
        serde_json::from_value(Value::Object(fields.clone())).map_err(|_| {
            ContractFailure::Issues(vec![finding(
                "invalid_type",
                &[Value::String("taskId".into())],
            )])
        })?;
    parsed
        .validate()
        .map_err(|report| ContractFailure::Issues(garde_findings(&report)))?;
    Ok(parsed)
}

fn edit_shape_findings(fields: &Map<String, Value>) -> Vec<Value> {
    let mut issues = Vec::new();
    for name in [
        "title",
        "description",
        "rootProfileId",
        "workerProfileId",
        "deliveryTarget",
    ] {
        if let Some(value) = fields.get(name).filter(|value| !value.is_string()) {
            issues.push(issue("invalid_type", &format!(".{name}")));
            if matches!(name, "rootProfileId" | "workerProfileId")
                && value.as_array().is_some_and(Vec::is_empty)
            {
                issues.push(issue("too_small", &format!(".{name}")));
            }
        }
    }
    if fields
        .get("runProjectTests")
        .is_some_and(|value| !value.is_boolean())
    {
        issues.push(issue("invalid_type", ".runProjectTests"));
    }
    for name in ["visualEvidence", "workflow"] {
        if fields.get(name).is_some_and(|value| !value.is_string()) {
            issues.push(issue("invalid_type", &format!(".{name}")));
        }
    }
    if let Some(advisors) = fields.get("advisorProfileIds") {
        if let Some(advisors) = advisors.as_object() {
            for role in ["reviewer", "planner_a", "planner_b", "rater"] {
                if let Some(value) = advisors.get(role) {
                    if let Some(value) = value.as_str() {
                        match value.encode_utf16().count() {
                            0 => issues
                                .push(issue("too_small", &format!(".advisorProfileIds.{role}"))),
                            257.. => {
                                issues.push(issue("too_big", &format!(".advisorProfileIds.{role}")))
                            }
                            _ => {}
                        }
                    } else {
                        issues.push(issue("invalid_type", &format!(".advisorProfileIds.{role}")));
                    }
                }
            }
            if advisors.keys().any(|name| {
                !["reviewer", "planner_a", "planner_b", "rater"].contains(&name.as_str())
            }) {
                issues.push(issue("unrecognized_keys", ".advisorProfileIds"));
            }
        } else {
            issues.push(issue("invalid_type", ".advisorProfileIds"));
        }
    }
    if fields.keys().any(|name| {
        ![
            "title",
            "description",
            "rootProfileId",
            "workerProfileId",
            "deliveryTarget",
            "runProjectTests",
            "visualEvidence",
            "workflow",
            "advisorProfileIds",
        ]
        .contains(&name.as_str())
    }) {
        issues.push(issue("unrecognized_keys", "."));
    }
    issues
}

pub fn parse_task_details(input: Option<&Value>) -> ContractResult<TaskDetailsBody> {
    let fields = object(input)?;
    let shape = edit_shape_findings(fields);
    if !shape.is_empty() {
        return Err(ContractFailure::Issues(shape));
    }
    let parsed: TaskDetailsBody = serde_path_to_error::deserialize(Value::Object(fields.clone()))
        .map_err(|error| {
        ContractFailure::Issues(vec![finding(
            "invalid_type",
            &[Value::String(error.path().to_string())],
        )])
    })?;
    parsed.validate().map_err(|report| {
        let mut findings = garde_findings(&report);
        for finding in &mut findings {
            if let Some(field) = finding
                .get("field")
                .and_then(Value::as_str)
                .map(str::to_owned)
                && let Some(field) = field.strip_suffix('.')
            {
                finding["field"] = Value::String(field.to_owned());
            }
        }
        ContractFailure::Issues(findings)
    })?;
    Ok(parsed)
}

pub fn parse_task_rename(input: Option<&Value>) -> ContractResult<TaskRenameBody> {
    let fields = object(input)?;
    let mut issues = Vec::new();
    if let Some(title) = fields.get("title").filter(|value| !value.is_string()) {
        issues.push(issue("invalid_type", ".title"));
        if title.as_array().is_some_and(Vec::is_empty) {
            issues.push(issue("too_small", ".title"));
        }
    } else if !fields.contains_key("title") {
        issues.push(issue("invalid_type", ".title"));
    }
    if fields.keys().any(|name| name != "title") {
        issues.push(issue("unrecognized_keys", "."));
    }
    if !issues.is_empty() {
        return Err(ContractFailure::Issues(issues));
    }
    let parsed: TaskRenameBody = serde_json::from_value(Value::Object(fields.clone()))
        .map_err(|_| ContractFailure::Unhandled)?;
    parsed
        .validate()
        .map_err(|report| ContractFailure::Issues(garde_findings(&report)))?;
    Ok(parsed)
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct TaskArchiveBody {
    pub confirm_discard_dirty: bool,
}

/// The archive body is optional, while a supplied body remains a strict object.
pub fn parse_task_archive(input: Option<&Value>) -> ContractResult<TaskArchiveBody> {
    let Some(input) = input else {
        return Ok(TaskArchiveBody {
            confirm_discard_dirty: false,
        });
    };
    let fields = object(Some(input))?;
    let mut issues = Vec::new();
    let confirm_discard_dirty = match fields.get("confirmDiscardDirty") {
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            issues.push(finding(
                "invalid_type",
                &[Value::String("confirmDiscardDirty".into())],
            ));
            false
        }
        None => false,
    };
    if fields.keys().any(|key| key != "confirmDiscardDirty") {
        issues.push(finding("unrecognized_keys", &[]));
    }
    if issues.is_empty() {
        Ok(TaskArchiveBody {
            confirm_discard_dirty,
        })
    } else {
        Err(ContractFailure::Issues(issues))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskNoteBody {
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskWorkerReplacementBody {
    #[garde(length(utf16, min = 1))]
    pub session_id: String,
    #[serde(deserialize_with = "trimmed")]
    #[garde(length(utf16, min = 1))]
    pub reason: String,
    #[serde(
        default,
        deserialize_with = "optional_trimmed",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(skip)]
    pub handoff: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(length(utf16, min = 1)))]
    pub worker_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCoordinatorReplacementBody {
    #[garde(length(utf16, min = 1))]
    pub session_id: String,
    #[garde(length(utf16, min = 1))]
    pub root_profile_id: String,
    #[serde(
        default,
        deserialize_with = "optional_trimmed",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(skip)]
    pub handoff: Option<String>,
    #[garde(skip)]
    pub resume: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[garde(inner(length(utf16, min = 1)))]
    pub question_id: Option<String>,
}

pub fn parse_task_coordinator_replacement(
    input: Option<&Value>,
) -> ContractResult<TaskCoordinatorReplacementBody> {
    let fields = object(input)?;
    let Some(resume) = fields.get("resume").and_then(Value::as_bool) else {
        return Err(ContractFailure::Issues(vec![finding(
            "invalid_union",
            &[Value::String("resume".into())],
        )]));
    };
    let mut issues = Vec::new();
    for name in ["sessionId", "rootProfileId", "handoff", "questionId"] {
        if name == "questionId" && !resume {
            continue;
        }
        match fields.get(name) {
            Some(Value::String(value)) => {
                if value.is_empty() && name != "handoff" {
                    issues.push(finding("too_small", &[Value::String(name.into())]));
                }
            }
            None if name == "handoff" => {}
            None if name == "questionId" && !resume => {}
            _ => issues.push(finding("invalid_type", &[Value::String(name.into())])),
        }
    }
    if fields.keys().any(|key| {
        !(matches!(
            key.as_str(),
            "sessionId" | "rootProfileId" | "handoff" | "resume"
        ) || (resume && key == "questionId"))
    }) {
        issues.push(finding("unrecognized_keys", &[]));
    }
    if !issues.is_empty() {
        return Err(ContractFailure::Issues(issues));
    }
    let parsed: TaskCoordinatorReplacementBody =
        serde_json::from_value(Value::Object(fields.clone()))
            .map_err(|_| ContractFailure::Unhandled)?;
    parsed
        .validate()
        .map_err(|report| ContractFailure::Issues(garde_findings(&report)))?;
    Ok(parsed)
}

/// A user may select another allowed Worker profile; the Root MCP contract
/// deliberately omits that field and preserves the outgoing profile.
pub fn parse_task_worker_replacement(
    input: Option<&Value>,
) -> ContractResult<TaskWorkerReplacementBody> {
    let fields = object(input)?;
    let mut issues = Vec::new();
    for (name, trim) in [
        ("sessionId", false),
        ("reason", true),
        ("handoff", false),
        ("workerProfileId", false),
    ] {
        match fields.get(name) {
            Some(Value::String(value)) => {
                let value = if trim {
                    crate::identity::auth::js_trim(value)
                } else {
                    value
                };
                if value.is_empty() && name != "handoff" {
                    issues.push(finding("too_small", &[Value::String(name.into())]));
                }
            }
            None if name == "handoff" || name == "workerProfileId" => {}
            _ => {
                issues.push(finding("invalid_type", &[Value::String(name.into())]));
            }
        }
    }
    if fields.keys().any(|key| {
        !matches!(
            key.as_str(),
            "sessionId" | "reason" | "handoff" | "workerProfileId"
        )
    }) {
        issues.push(finding("unrecognized_keys", &[]));
    }
    if !issues.is_empty() {
        return Err(ContractFailure::Issues(issues));
    }
    let parsed: TaskWorkerReplacementBody = serde_json::from_value(Value::Object(fields.clone()))
        .map_err(|_| ContractFailure::Unhandled)?;
    parsed
        .validate()
        .map_err(|report| ContractFailure::Issues(garde_findings(&report)))?;
    Ok(parsed)
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

/// Both prerequisite lists default to empty; a supplied list replaces the old one.
pub fn parse_task_dependencies(input: Option<&Value>) -> ContractResult<TaskDependenciesBody> {
    let fields = object(input)?;
    let mut findings = Vec::new();
    dependency_findings(fields, &mut findings);
    if fields
        .keys()
        .any(|key| key != "dependsOn" && key != "blockedByPullRequests")
    {
        findings.push(issue("unrecognized_keys", "."));
    }
    if !findings.is_empty() {
        return Err(ContractFailure::Issues(findings));
    }
    let parsed: TaskDependenciesBody = serde_json::from_value(Value::Object(fields.clone()))
        .map_err(|_| ContractFailure::Unhandled)?;
    parsed
        .validate()
        .map_err(|report| ContractFailure::Issues(garde_findings(&report)))?;
    Ok(parsed)
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskIssueBody {
    pub issue: Option<IssueAssociation>,
}

/// The issue link body is strict; `null` clears the link.
pub fn parse_task_issue(input: Option<&Value>) -> ContractResult<TaskIssueBody> {
    let fields = object(input)?;
    let mut findings = match fields.get("issue") {
        Some(Value::Null) => Vec::new(),
        Some(value) => issue_findings(value)?,
        None => vec![issue("invalid_type", ".issue")],
    };
    if fields.keys().any(|key| key != "issue") {
        findings.push(issue("unrecognized_keys", "."));
    }
    if !findings.is_empty() {
        return Err(ContractFailure::Issues(findings));
    }
    let issue = match fields.get("issue") {
        Some(Value::Null) | None => None,
        Some(value) => {
            Some(serde_json::from_value(value.clone()).map_err(|_| ContractFailure::Unhandled)?)
        }
    };
    Ok(TaskIssueBody { issue })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContinueDeliveryBody {
    pub delivery_target: String,
}

/// Delivery can continue only to a ready pull request or a merge.
pub fn parse_task_continue_delivery(
    input: Option<&Value>,
) -> ContractResult<TaskContinueDeliveryBody> {
    let fields = object(input)?;
    let mut issues = Vec::new();
    let target = fields
        .get("deliveryTarget")
        .and_then(Value::as_str)
        .filter(|target| matches!(*target, "pull_request_ready" | "merged"));
    if target.is_none() {
        issues.push(finding(
            "invalid_value",
            &[Value::String("deliveryTarget".into())],
        ));
    }
    if fields.keys().any(|key| key != "deliveryTarget") {
        issues.push(finding("unrecognized_keys", &[]));
    }
    match target {
        Some(target) if issues.is_empty() => Ok(TaskContinueDeliveryBody {
            delivery_target: target.to_owned(),
        }),
        _ => Err(ContractFailure::Issues(issues)),
    }
}

/// The user note body is a strict object; Zod trims before checking UTF-16 length.
pub fn parse_task_note(input: Option<&Value>) -> ContractResult<TaskNoteBody> {
    let fields = object(input)?;
    let mut issues = Vec::new();
    let note = match fields.get("note") {
        Some(Value::String(note)) => {
            let note = crate::identity::auth::js_trim(note);
            match note.encode_utf16().count() {
                0 => issues.push(finding("too_small", &[Value::String("note".into())])),
                20_001.. => issues.push(finding("too_big", &[Value::String("note".into())])),
                _ => {}
            }
            note.to_owned()
        }
        other => {
            issues.push(finding("invalid_type", &[Value::String("note".into())]));
            if other.is_some_and(|value| value.as_array().is_some_and(Vec::is_empty)) {
                issues.push(finding("too_small", &[Value::String("note".into())]));
            }
            String::new()
        }
    };
    if fields.keys().any(|key| key != "note") {
        issues.push(finding("unrecognized_keys", &[]));
    }
    if issues.is_empty() {
        Ok(TaskNoteBody { note })
    } else {
        Err(ContractFailure::Issues(issues))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_worker_replacement_matches_public_zod_contract() {
        assert_request_fixtures(
            "tasks.TaskWorkerReplacementBodySchema",
            13,
            parse_task_worker_replacement,
        );
    }

    #[test]
    fn task_coordinator_replacement_matches_public_zod_contract() {
        assert_request_fixtures(
            "tasks.TaskCoordinatorReplacementBodySchema",
            15,
            parse_task_coordinator_replacement,
        );
    }

    fn assert_request_fixtures<T: Serialize>(
        name: &str,
        count: usize,
        parse: fn(Option<&Value>) -> ContractResult<T>,
    ) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests/parity")
            .join(name);
        let mut tested = 0;
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let actual = match parse(fixture.get("input")) {
                Ok(value) => serde_json::json!({"accepted":true,"value":value}),
                Err(ContractFailure::Issues(issues)) => {
                    serde_json::json!({"accepted":false,"error":issues})
                }
                Err(ContractFailure::Unhandled) => {
                    serde_json::json!({"accepted":false,"error":{"kind":"thrown"}})
                }
                Err(ContractFailure::Internal(error)) => panic!("{}: {error}", path.display()),
            };
            assert_eq!(actual, fixture["expected"], "{}", path.display());
            tested += 1;
        }
        assert_eq!(tested, count);
    }

    #[test]
    fn task_edit_request_fixtures_match_public_zod_contracts() {
        assert_request_fixtures("tasks.TaskDetailsBodySchema", 16, parse_task_details);
        assert_request_fixtures("tasks.TaskRenameBodySchema", 13, parse_task_rename);
    }

    #[test]
    fn task_continue_delivery_request_fixtures_match_public_zod_contract() {
        assert_request_fixtures(
            "tasks.TaskContinueDeliveryBodySchema",
            12,
            parse_task_continue_delivery,
        );
    }

    #[test]
    fn task_dependencies_request_fixtures_match_public_zod_contract() {
        assert_request_fixtures(
            "tasks.TaskDependenciesBodySchema",
            14,
            parse_task_dependencies,
        );
    }

    #[test]
    fn task_issue_request_fixtures_match_public_zod_contract() {
        assert_request_fixtures("tasks.TaskIssueBodySchema", 17, parse_task_issue);
    }

    #[test]
    fn task_note_request_fixtures_match_public_zod_contract() {
        assert_request_fixtures("tasks.TaskNoteBodySchema", 15, parse_task_note);
    }

    #[test]
    fn optional_archive_body_is_strict_and_preserves_public_findings() {
        assert!(!parse_task_archive(None).unwrap().confirm_discard_dirty);
        assert!(
            !parse_task_archive(Some(&serde_json::json!({})))
                .unwrap()
                .confirm_discard_dirty
        );
        assert!(
            parse_task_archive(Some(&serde_json::json!({"confirmDiscardDirty":true})))
                .unwrap()
                .confirm_discard_dirty
        );
        assert!(matches!(
            parse_task_archive(Some(&Value::Null)),
            Err(ContractFailure::Issues(issues)) if issues == vec![finding("invalid_type", &[])]
        ));
        assert!(matches!(
            parse_task_archive(Some(&serde_json::json!({"confirmDiscardDirty":"yes"}))),
            Err(ContractFailure::Issues(issues)) if issues == vec![finding("invalid_type", &[Value::String("confirmDiscardDirty".into())])]
        ));
        assert!(matches!(
            parse_task_archive(Some(&serde_json::json!({"other":true}))),
            Err(ContractFailure::Issues(issues)) if issues == vec![finding("unrecognized_keys", &[])]
        ));
    }

    #[test]
    fn task_create_request_fixtures_match_public_zod_contract() {
        let root = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/parity/tasks.TaskBodySchema"
        );
        let mut failed = Vec::new();
        let mut tested = 0;
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let expected = &fixture["expected"];
            let actual = match parse_task_create(fixture.get("input")) {
                Ok(value) => serde_json::json!({"accepted":true,"value":value}),
                Err(ContractFailure::Issues(issues)) => {
                    serde_json::json!({"accepted":false,"error":issues})
                }
                Err(ContractFailure::Unhandled) => {
                    serde_json::json!({"accepted":false,"error":{"kind":"thrown"}})
                }
                Err(ContractFailure::Internal(error)) => serde_json::json!({"internal":error}),
            };
            if &actual != expected {
                if failed.len() < 5 {
                    eprintln!("{} expected={expected} actual={actual}", path.display());
                }
                failed.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
            tested += 1;
        }
        assert_eq!(tested, 60);
        assert!(
            failed.is_empty(),
            "mismatched task request fixtures: {failed:?}"
        );
    }

    #[test]
    fn task_id_params_match_public_zod_contract() {
        let root = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/parity/common.TaskIdParamsSchema"
        );
        let mut tested = 0;
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let actual = match parse_task_id_params(fixture.get("input")) {
                Ok(value) => serde_json::json!({"accepted":true,"value":value}),
                Err(ContractFailure::Issues(issues)) => {
                    serde_json::json!({"accepted":false,"error":issues})
                }
                Err(other) => panic!("{}: {other:?}", path.display()),
            };
            assert_eq!(actual, fixture["expected"], "{}", path.display());
            tested += 1;
        }
        assert_eq!(tested, 9);
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
            matches!(parse_task_create(Some(&fraction)), Err(ContractFailure::Issues(findings)) if findings == vec![issue("invalid_type", ".source.number")])
        );
    }
}
