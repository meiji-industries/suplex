use serde_json::{Map, Value, json};

use super::{ParseResult, value_type};
use crate::shared::js_json::utf16_len;

type Path = Vec<Value>;

pub(super) fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "tasks.TaskRenameBodySchema" => Some(rename(input, &[])),
        "tasks.TaskNoteBodySchema" => Some(note(input, &[])),
        "tasks.TaskArchiveBodySchema" => Some(archive(input, &[])),
        "tasks.TaskContinueDeliveryBodySchema" => Some(continue_delivery(input, &[])),
        "tasks.TaskSessionHistoryParamsSchema" => Some(history_params(input, &[])),
        "tasks.TaskSessionHistoryQuerySchema" => Some(history_query(input, &[])),
        "tasks.TaskDiffResponseSchema" => Some(diff(input, &[])),
        "tasks.TaskDiffSummaryResponseSchema" => Some(diff_summary(input, &[])),
        "tasks.TaskAgentStatusSchema" => Some(agent_status(input, &[])),
        "tasks.TaskHarnessKindSchema" => Some(harness_kind(input, &[])),
        "tasks.WorktreeAppSchema" => Some(worktree_app(input, &[])),
        "tasks.WorktreeAppsResponseSchema" => Some(worktree_apps(input, &[])),
        _ => None,
    }
}

fn child(path: &[Value], segment: impl Into<Value>) -> Path {
    let mut result = path.to_vec();
    result.push(segment.into());
    result
}

fn invalid_type(expected: &str, input: Option<&Value>, path: &[Value]) -> Value {
    json!({
        "expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", value_type(input))
    })
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

fn harness_kind(input: Option<&Value>, path: &[Value]) -> ParseResult {
    enumeration(input, path, &["opencode", "claude-code", "devin", "codex"])
}

fn agent_status(input: Option<&Value>, path: &[Value]) -> ParseResult {
    enumeration(
        input,
        path,
        &[
            "queued",
            "working",
            "retrying",
            "idle",
            "waiting_human",
            "stopped",
            "unknown",
        ],
    )
}

fn worktree_app(input: Option<&Value>, path: &[Value]) -> ParseResult {
    enumeration(
        input,
        path,
        &["finder", "cursor", "vscode", "ghostty", "terminal"],
    )
}

fn string(
    input: Option<&Value>,
    path: &[Value],
    minimum: usize,
    maximum: Option<usize>,
    trim: bool,
) -> ParseResult {
    let Some(Value::String(value)) = input else {
        let mut issues = vec![invalid_type("string", input, path)];
        if let Some(Value::Array(values)) = input {
            if values.len() < minimum {
                issues.push(json!({
                    "origin": "array", "code": "too_small", "minimum": minimum, "inclusive": true,
                    "path": path, "message": format!("Too small: expected array to have >={minimum} items")
                }));
            }
            if let Some(maximum) = maximum
                && values.len() > maximum
            {
                issues.push(json!({
                    "origin": "array", "code": "too_big", "maximum": maximum, "inclusive": true,
                    "path": path, "message": format!("Too big: expected array to have <={maximum} items")
                }));
            }
        }
        return Err(issues);
    };
    let value = if trim {
        value.trim_matches(|character: char| {
            character == '\u{feff}' || (character.is_whitespace() && character != '\u{0085}')
        })
    } else {
        value.as_str()
    };
    let length = utf16_len(value);
    let mut issues = Vec::new();
    if length < minimum {
        issues.push(json!({
            "origin": "string", "code": "too_small", "minimum": minimum, "inclusive": true,
            "path": path, "message": format!("Too small: expected string to have >={minimum} characters")
        }));
    }
    if let Some(maximum) = maximum
        && length > maximum
    {
        issues.push(json!({
            "origin": "string", "code": "too_big", "maximum": maximum, "inclusive": true,
            "path": path, "message": format!("Too big: expected string to have <={maximum} characters")
        }));
    }
    if issues.is_empty() {
        Ok(json!(value))
    } else {
        Err(issues)
    }
}

fn boolean(input: Option<&Value>, path: &[Value]) -> ParseResult {
    match input {
        Some(Value::Bool(_)) => Ok(input.cloned().expect("present boolean")),
        _ => Err(vec![invalid_type("boolean", input, path)]),
    }
}

fn nonnegative_integer(input: Option<&Value>, path: &[Value]) -> ParseResult {
    let Some(Value::Number(number)) = input else {
        return Err(vec![invalid_type("number", input, path)]);
    };
    let value = number.as_f64().expect("finite JSON number");
    if value.fract() != 0.0 {
        return Err(vec![json!({
            "expected": "int", "format": "safeint", "code": "invalid_type", "path": path,
            "message": "Invalid input: expected int, received number"
        })]);
    }
    if value > 9_007_199_254_740_991.0 {
        return Err(vec![json!({
            "origin": "int", "code": "too_big", "maximum": 9_007_199_254_740_991_u64,
            "note": "Integers must be within the safe integer range.", "inclusive": true,
            "path": path, "message": "Too big: expected int to be <=9007199254740991"
        })]);
    }
    if value < -9_007_199_254_740_991.0 {
        return Err(vec![
            json!({
                "origin": "int", "code": "too_small", "minimum": -9_007_199_254_740_991_i64,
                "note": "Integers must be within the safe integer range.", "inclusive": true,
                "path": path, "message": "Too small: expected int to be >=-9007199254740991"
            }),
            json!({
                "origin": "number", "code": "too_small", "minimum": 0, "inclusive": true,
                "path": path, "message": "Too small: expected number to be >=0"
            }),
        ]);
    }
    if value < 0.0 {
        return Err(vec![json!({
            "origin": "number", "code": "too_small", "minimum": 0, "inclusive": true,
            "path": path, "message": "Too small: expected number to be >=0"
        })]);
    }
    Ok(input.cloned().expect("present number"))
}

struct Record<'a> {
    input: &'a Map<String, Value>,
    output: Map<String, Value>,
    issues: Vec<Value>,
    path: Path,
}

impl Record<'_> {
    fn field(
        &mut self,
        name: &str,
        optional: bool,
        parser: impl FnOnce(Option<&Value>, &[Value]) -> ParseResult,
    ) {
        let input = self.input.get(name);
        if optional && input.is_none() {
            return;
        }
        match parser(input, &child(&self.path, json!(name))) {
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
        self.issues.push(json!({ "code": "unrecognized_keys", "keys": keys, "path": self.path, "message": message }));
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

fn rename(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("title", false, |value, path| {
            string(value, path, 1, None, true)
        });
        record.strict(&["title"]);
    })
}

fn note(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("note", false, |value, path| {
            string(value, path, 1, Some(20_000), true)
        });
        record.strict(&["note"]);
    })
}

fn archive(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("confirmDiscardDirty", true, boolean);
        record.strict(&["confirmDiscardDirty"]);
    })
}

fn continue_delivery(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("deliveryTarget", false, |value, path| {
            enumeration(value, path, &["pull_request_ready", "merged"])
        });
        record.strict(&["deliveryTarget"]);
    })
}

fn history_params(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("taskId", false, |value, path| {
            string(value, path, 1, None, false)
        });
        record.field("sessionId", false, |value, path| {
            string(value, path, 1, None, false)
        });
    })
}

fn history_query(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("before", true, |value, path| {
            string(value, path, 1, Some(512), false)
        });
    })
}

fn diff(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("available", false, boolean);
        record.field("patch", false, |value, path| {
            string(value, path, 0, None, false)
        });
        record.field("truncated", false, boolean);
    })
}

fn diff_summary(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("available", false, boolean);
        record.field("files", false, nonnegative_integer);
    })
}

fn app(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("id", false, worktree_app);
        record.field("label", false, |value, path| {
            string(value, path, 0, None, false)
        });
    })
}

fn apps(input: Option<&Value>, path: &[Value]) -> ParseResult {
    let Some(Value::Array(values)) = input else {
        return Err(vec![invalid_type("array", input, path)]);
    };
    let mut output = Vec::new();
    let mut issues = Vec::new();
    for (index, value) in values.iter().enumerate() {
        match app(Some(value), &child(path, json!(index))) {
            Ok(value) => output.push(value),
            Err(error) => issues.extend(error),
        }
    }
    if issues.is_empty() {
        Ok(Value::Array(output))
    } else {
        Err(issues)
    }
}

fn worktree_apps(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| record.field("apps", false, apps))
}
