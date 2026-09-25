use serde_json::{Map, Value, json};

use super::{ParseResult, value_type};
use crate::shared::js_json::utf16_len;

type Path = Vec<Value>;

pub(super) fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "projects.ProjectAgentTaskPolicySchema" => Some(agent_task_policy(input, &[])),
        _ => None,
    }
}

fn child(path: &[Value], name: impl Into<Value>) -> Path {
    let mut result = path.to_vec();
    result.push(name.into());
    result
}

fn invalid_type(expected: &str, input: Option<&Value>, path: &[Value]) -> Value {
    json!({
        "expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", value_type(input))
    })
}

fn string(input: Option<&Value>, path: &[Value]) -> ParseResult {
    let Some(Value::String(value)) = input else {
        let mut issues = vec![invalid_type("string", input, path)];
        if let Some(Value::Array(values)) = input
            && values.is_empty()
        {
            issues.push(json!({
                "origin": "array", "code": "too_small", "minimum": 1, "inclusive": true,
                "path": path, "message": "Too small: expected array to have >=1 items"
            }));
        }
        if let Some(Value::Array(values)) = input
            && values.len() > 256
        {
            issues.push(json!({
                "origin": "array", "code": "too_big", "maximum": 256, "inclusive": true,
                "path": path, "message": "Too big: expected array to have <=256 items"
            }));
        }
        return Err(issues);
    };
    let mut issues = Vec::new();
    if value.is_empty() {
        issues.push(json!({
            "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
            "path": path, "message": "Too small: expected string to have >=1 characters"
        }));
    }
    if utf16_len(value) > 256 {
        issues.push(json!({
            "origin": "string", "code": "too_big", "maximum": 256, "inclusive": true,
            "path": path, "message": "Too big: expected string to have <=256 characters"
        }));
    }
    if issues.is_empty() {
        Ok(json!(value))
    } else {
        Err(issues)
    }
}

fn array(input: Option<&Value>, path: &[Value], minimum: usize) -> ParseResult {
    let Some(Value::Array(values)) = input else {
        return Err(vec![invalid_type("array", input, path)]);
    };
    let mut output = Vec::with_capacity(values.len());
    let mut issues = Vec::new();
    for (index, value) in values.iter().enumerate() {
        match string(Some(value), &child(path, json!(index))) {
            Ok(value) => output.push(value),
            Err(error) => issues.extend(error),
        }
    }
    if values.len() < minimum {
        issues.push(json!({
            "origin": "array", "code": "too_small", "minimum": minimum, "inclusive": true,
            "path": path, "message": format!("Too small: expected array to have >={minimum} items")
        }));
    }
    if issues.is_empty() {
        Ok(Value::Array(output))
    } else {
        Err(issues)
    }
}

fn enumeration(input: Option<&Value>, path: &[Value], values: &[&str]) -> ParseResult {
    if let Some(Value::String(value)) = input
        && values.contains(&value.as_str())
    {
        return Ok(json!(value));
    }
    Err(vec![json!({
        "code": "invalid_value", "values": values, "path": path,
        "message": format!("Invalid option: expected one of {}", values.iter().map(|value| format!("\"{value}\"")).collect::<Vec<_>>().join("|"))
    })])
}

struct Record<'a> {
    input: &'a Map<String, Value>,
    output: Map<String, Value>,
    issues: Vec<Value>,
    path: Path,
}

impl Record<'_> {
    fn field(&mut self, name: &str, parser: impl FnOnce(Option<&Value>, &[Value]) -> ParseResult) {
        match parser(self.input.get(name), &child(&self.path, json!(name))) {
            Ok(value) => {
                self.output.insert(name.into(), value);
            }
            Err(error) => self.issues.extend(error),
        }
    }

    fn strict(&mut self, known: &[&str]) {
        let keys = self
            .input
            .keys()
            .filter(|key| !known.contains(&key.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return;
        }
        let message = if keys.len() == 1 {
            format!("Unrecognized key: \"{}\"", keys[0])
        } else {
            format!(
                "Unrecognized keys: {}",
                keys.iter()
                    .map(|key| format!("\"{key}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        self.issues.push(json!({
            "code": "unrecognized_keys", "keys": keys, "path": self.path, "message": message
        }));
    }

    fn finish(self) -> ParseResult {
        if self.issues.is_empty() {
            Ok(Value::Object(self.output))
        } else {
            Err(self.issues)
        }
    }
}

fn record(
    input: Option<&Value>,
    path: &[Value],
    fields: impl FnOnce(&mut Record<'_>),
) -> ParseResult {
    let Some(Value::Object(input)) = input else {
        return Err(vec![invalid_type("object", input, path)]);
    };
    let mut record = Record {
        input,
        output: Map::new(),
        issues: Vec::new(),
        path: path.to_vec(),
    };
    fields(&mut record);
    record.finish()
}

fn advisors(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        for name in ["reviewer", "planner_a", "planner_b", "rater"] {
            record.field(name, |input, path| match input {
                None => Ok(json!([])),
                _ => array(input, path, 0),
            });
        }
    })
}

fn agent_task_policy(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("workflowIds", |value, path| array(value, path, 1));
        record.field("defaultWorkflowId", string);
        record.field("templateIds", |value, path| match value {
            None => Ok(json!([])),
            _ => array(value, path, 0),
        });
        record.field("rootProfileIds", |value, path| array(value, path, 1));
        record.field("workerProfileIds", |value, path| array(value, path, 1));
        record.field("advisorProfileIds", |value, path| match value {
            None => Ok(json!({"reviewer":[],"planner_a":[],"planner_b":[],"rater":[]})),
            _ => advisors(value, path),
        });
        record.field("deliveryTarget", |value, path| match value {
            None => Ok(json!("pull_request_draft")),
            _ => enumeration(
                value,
                path,
                &[
                    "local_worktree",
                    "remote_branch",
                    "pull_request_draft",
                    "pull_request_ready",
                    "merged",
                ],
            ),
        });
        record.field("runProjectTests", |value, path| match value {
            None => Ok(json!(true)),
            Some(Value::Bool(_)) => Ok(value.cloned().expect("present boolean")),
            _ => Err(vec![invalid_type("boolean", value, path)]),
        });
        record.field("visualEvidence", |value, path| match value {
            None => Ok(json!("off")),
            _ => enumeration(value, path, &["off", "capture", "required"]),
        });
        record.strict(&[
            "workflowIds",
            "defaultWorkflowId",
            "templateIds",
            "rootProfileIds",
            "workerProfileIds",
            "advisorProfileIds",
            "deliveryTarget",
            "runProjectTests",
            "visualEvidence",
        ]);
    })
}
