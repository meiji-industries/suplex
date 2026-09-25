use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

pub mod auth;
pub mod github_auth;
pub mod projects;
pub mod system;
pub mod task_answers;
pub mod task_templates;
pub mod tasks;
pub mod workflows;

#[derive(Debug)]
pub enum ContractFailure {
    Issues(Vec<Value>),
    Unhandled,
    Internal(String),
}

pub type ContractResult<T> = Result<T, ContractFailure>;

pub(crate) fn id_1_256(value: &str, _: &()) -> garde::Result {
    match value.encode_utf16().count() {
        0 => Err(garde::Error::new("too_small")),
        1..=256 => Ok(()),
        _ => Err(garde::Error::new("too_big")),
    }
}

pub(crate) fn delivery_target(value: &str, _: &()) -> garde::Result {
    if [
        "local_worktree",
        "remote_branch",
        "pull_request_draft",
        "pull_request_ready",
        "merged",
    ]
    .contains(&value)
    {
        Ok(())
    } else {
        Err(garde::Error::new("invalid_value"))
    }
}

pub(crate) fn visual_evidence(value: &str, _: &()) -> garde::Result {
    if ["off", "capture", "required"].contains(&value) {
        Ok(())
    } else {
        Err(garde::Error::new("invalid_value"))
    }
}

pub(crate) fn invalid_type(_expected: &str, _value: Option<&Value>, path: &[Value]) -> Value {
    finding("invalid_type", path)
}

pub(crate) fn finding(code: &str, path: &[Value]) -> Value {
    let field = path
        .iter()
        .map(|part| {
            part.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| part.to_string())
        })
        .collect::<Vec<_>>()
        .join(".");
    json!({"code":format!("invalid-{code}"),"field":format!(".{field}"),"message":"Request value is invalid"})
}

pub(crate) fn garde_findings(report: &garde::Report) -> Vec<Value> {
    report.iter().map(|(path, error)| {
        let mut field = String::from(".");
        let mut parent = "";
        for (index, (_, segment)) in path.__iter().rev().enumerate() {
            if index > 0 { field.push('.'); }
            // Only serde-renamed struct fields change spelling. Record keys and
            // array indices must retain their exact source spelling.
            let name = if matches!(parent, "environment" | "env" | "headers") {
                segment.as_str()
            } else { match segment.as_str() {
                "workflow_ids" => "workflowIds",
                "default_workflow_id" => "defaultWorkflowId",
                "template_ids" => "templateIds",
                "root_profile_ids" => "rootProfileIds",
                "worker_profile_ids" => "workerProfileIds",
                "advisor_profile_ids" => "advisorProfileIds",
                "delivery_target" => "deliveryTarget",
                "run_project_tests" => "runProjectTests",
                "visual_evidence" => "visualEvidence",
                "allowed_providers" => "allowedProviders",
                "allowed_instance_ids" => "allowedInstanceIds",
                "repository_url" => "repositoryUrl",
                "project_id" => "projectId",
                "repository_name" => "repositoryName",
                "base_branch" => "baseBranch",
                "repository_path" => "repositoryPath",
                "worktree_root" => "worktreeRoot",
                "root_profile_id" => "rootProfileId",
                "worker_profile_id" => "workerProfileId",
                "skill_directories" => "skillDirectories",
                "idempotency_key" => "idempotencyKey",
                "flow_id" => "flowId",
                "mime_type" => "mimeType",
                "start_immediately" => "startImmediately",
                "depends_on" => "dependsOn",
                "blocked_by_pull_requests" => "blockedByPullRequests",
                other => other,
            }};
            field.push_str(name);
            parent = name;
        }
        let message = error.message();
        let code = if message == "too_small" || message.contains("lower than") { "too_small" }
            else if message == "too_big" || message.contains("greater than") { "too_big" }
            else if message == "invalid_value" { "invalid_value" }
            else if message == "custom" { "custom" }
            else if message == "invalid_number" { "invalid_type" }
            else { "invalid_format" };
        json!({"code":format!("invalid-{code}"),"field":field,"message":"Request value is invalid"})
    }).collect()
}

pub(crate) fn object(input: Option<&Value>) -> ContractResult<&Map<String, Value>> {
    match input {
        Some(Value::Object(fields)) => Ok(fields),
        _ => Err(ContractFailure::Issues(vec![invalid_type(
            "object",
            input,
            &[],
        )])),
    }
}

pub(crate) fn field_path(name: &str) -> Vec<Value> {
    vec![Value::String(name.to_owned())]
}

pub(crate) fn deserialize<T: DeserializeOwned>(value: Value) -> ContractResult<T> {
    serde_json::from_value(value).map_err(|error| ContractFailure::Internal(error.to_string()))
}

pub(crate) fn serialized<T: Serialize>(result: ContractResult<T>) -> ContractResult<Value> {
    result.and_then(|value| {
        serde_json::to_value(value).map_err(|error| ContractFailure::Internal(error.to_string()))
    })
}

/// One field of a Zod object schema, checked in shape order.
#[derive(Clone, Copy)]
pub(crate) enum Rule {
    /// `z.string()`, optionally trimmed, with UTF-16 length bounds.
    Text {
        trim: bool,
        min: usize,
        max: Option<usize>,
    },
    Choice(&'static [&'static str]),
    Flag,
    /// `AdvisorProfileIdsSchema`: strict, each role an optional 1..256 id.
    Advisors,
    /// A nested schema; its findings move under the field path.
    Nested(fn(Option<&Value>) -> ContractResult<Value>),
}

#[derive(Clone, Copy)]
pub(crate) struct Field {
    pub name: &'static str,
    pub rule: Rule,
    pub required: bool,
    pub nullable: bool,
    /// JSON text of the Zod default applied when the field is absent.
    pub default: Option<&'static str>,
}

pub(crate) const fn optional(name: &'static str, rule: Rule) -> Field {
    Field {
        name,
        rule,
        required: false,
        nullable: false,
        default: None,
    }
}

pub(crate) const TRIMMED_NAME: Rule = Rule::Text {
    trim: true,
    min: 1,
    max: None,
};
pub(crate) const ID: Rule = Rule::Text {
    trim: false,
    min: 1,
    max: Some(256),
};
pub(crate) const DELIVERY_TARGETS: Rule = Rule::Choice(&[
    "local_worktree",
    "remote_branch",
    "pull_request_draft",
    "pull_request_ready",
    "merged",
]);
pub(crate) const VISUAL_EVIDENCE: Rule = Rule::Choice(&["off", "capture", "required"]);
pub(crate) const WORKFLOW_IDS: Rule = Rule::Choice(&[
    "standard",
    "direct_build",
    "independent_review",
    "competing_plans",
    "refine_pull_request",
]);

fn public_issue(code: &str, field: &str) -> Value {
    json!({"code":format!("invalid-{code}"),"field":field,"message":"Request value is invalid"})
}

/// Parse a Zod object: findings follow shape order, then unrecognized keys.
/// A strict object rejects unknown keys; otherwise they are stripped.
pub(crate) fn parse_object(
    input: Option<&Value>,
    fields: &[Field],
    strict: bool,
) -> ContractResult<Map<String, Value>> {
    let object = object(input)?;
    let mut errors = Vec::new();
    let mut output = Map::new();
    for field in fields {
        let path = format!(".{}", field.name);
        let value = match object.get(field.name) {
            None if field.required => {
                let code = if matches!(field.rule, Rule::Choice(_)) {
                    "invalid_value"
                } else {
                    "invalid_type"
                };
                errors.push(public_issue(code, &path));
                None
            }
            None => field
                .default
                .map(|default| serde_json::from_str(default).expect("default JSON")),
            Some(Value::Null) if field.nullable => Some(Value::Null),
            Some(value) => rule_value(value, field.rule, &path, &mut errors)?,
        };
        if let Some(value) = value {
            output.insert(field.name.to_owned(), value);
        }
    }
    if strict
        && object
            .keys()
            .any(|key| !fields.iter().any(|field| field.name == key))
    {
        errors.push(public_issue("unrecognized_keys", "."));
    }
    if errors.is_empty() {
        Ok(output)
    } else {
        Err(ContractFailure::Issues(errors))
    }
}

fn rule_value(
    value: &Value,
    rule: Rule,
    path: &str,
    errors: &mut Vec<Value>,
) -> ContractResult<Option<Value>> {
    let before = errors.len();
    let output = match rule {
        Rule::Text { trim, min, max } => {
            // Zod still applies length checks to an array after its type issue.
            let (text, length) = match value {
                Value::String(text) => {
                    let text = if trim {
                        crate::identity::auth::js_trim(text)
                    } else {
                        text
                    };
                    (Some(text.to_owned()), text.encode_utf16().count())
                }
                Value::Array(items) => {
                    errors.push(public_issue("invalid_type", path));
                    (None, items.len())
                }
                _ => {
                    errors.push(public_issue("invalid_type", path));
                    return Ok(None);
                }
            };
            if length < min {
                errors.push(public_issue("too_small", path));
            }
            if max.is_some_and(|max| length > max) {
                errors.push(public_issue("too_big", path));
            }
            text.map(Value::String)
        }
        Rule::Choice(options) => {
            if !value.as_str().is_some_and(|value| options.contains(&value)) {
                errors.push(public_issue("invalid_value", path));
            }
            Some(value.clone())
        }
        Rule::Flag => {
            if !value.is_boolean() {
                errors.push(public_issue("invalid_type", path));
            }
            Some(value.clone())
        }
        Rule::Advisors => {
            let Some(roles) = value.as_object() else {
                errors.push(public_issue("invalid_type", path));
                return Ok(None);
            };
            const ROLES: [&str; 4] = ["reviewer", "planner_a", "planner_b", "rater"];
            for role in ROLES {
                if let Some(id) = roles.get(role) {
                    rule_value(id, ID, &format!("{path}.{role}"), errors)?;
                }
            }
            if roles.keys().any(|key| !ROLES.contains(&key.as_str())) {
                errors.push(public_issue("unrecognized_keys", path));
            }
            Some(value.clone())
        }
        Rule::Nested(parse) => match parse(Some(value)) {
            Ok(value) => Some(value),
            Err(ContractFailure::Issues(findings)) => {
                errors.extend(findings.into_iter().map(|mut finding| {
                    let field = finding["field"].as_str().unwrap_or(".").to_owned();
                    finding["field"] = if field == "." {
                        json!(path)
                    } else {
                        json!(format!("{path}{field}"))
                    };
                    finding
                }));
                None
            }
            Err(failure) => return Err(failure),
        },
    };
    Ok(if errors.len() == before { output } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garde_paths_preserve_dynamic_record_keys() {
        let mut report = garde::Report::new();
        report.append(
            garde::Path::new("environment").join("FOO_BAR"),
            garde::Error::new("invalid_format"),
        );
        report.append(
            garde::Path::new("environment").join("workflow_ids"),
            garde::Error::new("invalid_format"),
        );
        report.append(
            garde::Path::new("workflow_ids").join(2usize),
            garde::Error::new("too_small"),
        );
        assert_eq!(
            garde_findings(&report),
            vec![
                json!({"code":"invalid-invalid_format","field":".environment.FOO_BAR","message":"Request value is invalid"}),
                json!({"code":"invalid-invalid_format","field":".environment.workflow_ids","message":"Request value is invalid"}),
                json!({"code":"invalid-too_small","field":".workflowIds.2","message":"Request value is invalid"}),
            ]
        );
    }
}
