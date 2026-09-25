use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

pub mod auth;
pub mod projects;

#[derive(Debug)]
pub enum ContractFailure {
    Issues(Vec<Value>),
    Unhandled,
    Internal(String),
}

pub type ContractResult<T> = Result<T, ContractFailure>;

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
                "repository_name" => "repositoryName",
                "base_branch" => "baseBranch",
                "repository_path" => "repositoryPath",
                "worktree_root" => "worktreeRoot",
                "root_profile_id" => "rootProfileId",
                "worker_profile_id" => "workerProfileId",
                "skill_directories" => "skillDirectories",
                other => other,
            }};
            field.push_str(name);
            parent = name;
        }
        let message = error.message();
        let code = if message == "too_small" || message.contains("lower than") { "too_small" }
            else if message == "too_big" || message.contains("greater than") { "too_big" }
            else if message == "invalid_value" { "invalid_value" }
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
