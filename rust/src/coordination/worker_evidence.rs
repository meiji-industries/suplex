//! Compact, cursor-based excerpts of native Worker tool evidence.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{runtimes::codex::tool_evidence::NativeTool, shared::js_json};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceField {
    Input,
    Output,
    Error,
}

impl EvidenceField {
    fn name(self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::Output => "output",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EvidencePosition {
    Head,
    Tail,
}

impl EvidencePosition {
    fn name(self) -> &'static str {
        match self {
            Self::Head => "head",
            Self::Tail => "tail",
        }
    }
}

pub struct EvidenceQuery {
    pub tool_id: Option<String>,
    pub field: Option<EvidenceField>,
    pub position: Option<EvidencePosition>,
    pub cursor: Option<String>,
    pub max_characters: usize,
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn utf16_slice(value: &str, start: usize, count: usize) -> String {
    String::from_utf16_lossy(
        &value
            .encode_utf16()
            .skip(start)
            .take(count)
            .collect::<Vec<_>>(),
    )
}

fn excerpt(
    value: &str,
    position: EvidencePosition,
    max: usize,
    offset: usize,
) -> Result<Value, String> {
    let total = utf16_len(value);
    let start = if position == EvidencePosition::Tail {
        total.saturating_sub(max)
    } else {
        offset
    };
    if start > total {
        return Err("Worker evidence cursor is out of range".into());
    }
    let text = utf16_slice(value, start, max);
    let end = start + utf16_len(&text);
    Ok(json!({
        "text":text, "totalCharacters":total, "offset":start,
        "complete":start == 0 && end == total,
        "truncatedBefore":start > 0, "truncatedAfter":end < total,
    }))
}

fn index_excerpt(value: &str, position: EvidencePosition, max: usize) -> Value {
    let item = excerpt(value, position, max, 0).expect("zero offset");
    json!({
        "text":item["text"], "totalCharacters":item["totalCharacters"],
        "truncated":!item["complete"].as_bool().unwrap_or(false),
    })
}

fn cursor_offset(cursor: Option<&str>, prefix: &str) -> Result<usize, String> {
    let Some(cursor) = cursor else { return Ok(0) };
    let Some(rest) = cursor
        .strip_prefix(prefix)
        .and_then(|value| value.strip_prefix(':'))
    else {
        return Err(format!(
            "Worker evidence cursor is invalid for {prefix} access"
        ));
    };
    if rest.is_empty() || !rest.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "Worker evidence cursor is invalid for {prefix} access"
        ));
    }
    let value = rest
        .parse::<u64>()
        .map_err(|_| "Worker evidence cursor is invalid")?;
    if value > 9_007_199_254_740_991 {
        return Err("Worker evidence cursor is invalid".into());
    }
    usize::try_from(value).map_err(|_| "Worker evidence cursor is invalid".into())
}

fn index_tool(tool: &NativeTool, preview: usize) -> Value {
    let input = js_json::stringify(&Value::Object(tool.input.clone()));
    let command = tool.input.get("command").and_then(Value::as_str);
    json!({
        "toolId":tool.id, "name":tool.name, "status":tool.status,
        "inputPreview":index_excerpt(&input, EvidencePosition::Head, 240.min(preview)),
        "command":command.map(|value| index_excerpt(value, EvidencePosition::Head, 240.min(preview))),
        "outputTail":index_excerpt(tool.output.as_deref().unwrap_or(""), EvidencePosition::Tail, 240.min(preview)),
        "errorTail":index_excerpt(tool.error.as_deref().unwrap_or(""), EvidencePosition::Tail, 240.min(preview)),
    })
}

fn index_result(tools: Vec<Value>, next: Option<usize>) -> Value {
    let cursor = next.map(|index| format!("index:{index}"));
    json!({
        "kind":"index", "tools":tools, "nextCursor":cursor,
        "readMore":cursor.map(|value| format!("Continue the compact tool index with cursor {value}.")),
    })
}

fn index(tools: &[NativeTool], query: &EvidenceQuery) -> Result<Value, String> {
    let start = cursor_offset(query.cursor.as_deref(), "index")?;
    if start > tools.len() {
        return Err("Worker evidence cursor is out of range".into());
    }
    let mut indexed = Vec::new();
    let mut tool_index = start;
    while tool_index < tools.len() {
        let next = (tool_index + 1 < tools.len()).then_some(tool_index + 1);
        let mut candidate = index_tool(&tools[tool_index], usize::MAX);
        if indexed.is_empty() {
            let mut preview = 200;
            while utf16_len(&js_json::stringify(&index_result(
                vec![candidate.clone()],
                next,
            ))) > query.max_characters
            {
                candidate = index_tool(&tools[tool_index], preview);
                if preview == 0 {
                    break;
                }
                preview = preview.saturating_sub(20);
            }
            if utf16_len(&js_json::stringify(&index_result(
                vec![candidate.clone()],
                next,
            ))) > query.max_characters
            {
                return Err("Worker evidence budget is too small for tool index metadata".into());
            }
        }
        let mut proposed = indexed.clone();
        proposed.push(candidate.clone());
        if utf16_len(&js_json::stringify(&index_result(proposed, next))) > query.max_characters {
            break;
        }
        indexed.push(candidate);
        tool_index += 1;
    }
    Ok(index_result(
        indexed,
        (tool_index < tools.len()).then_some(tool_index),
    ))
}

fn selected(tools: &[NativeTool], query: &EvidenceQuery) -> Result<Value, String> {
    let id = query.tool_id.as_deref().expect("selected tool");
    let tool = tools
        .iter()
        .find(|tool| tool.id == id)
        .ok_or_else(|| format!("Worker evidence tool {id} does not exist"))?;
    let field = query.field.unwrap_or(EvidenceField::Output);
    let position = query.position.unwrap_or(EvidencePosition::Tail);
    if position == EvidencePosition::Tail && query.cursor.is_some() {
        return Err("Worker evidence cursor is only valid for head access".into());
    }
    let offset = if position == EvidencePosition::Head {
        cursor_offset(query.cursor.as_deref(), "field")?
    } else {
        0
    };
    let (available, value) = match field {
        EvidenceField::Input => (true, js_json::stringify(&Value::Object(tool.input.clone()))),
        EvidenceField::Output => (
            tool.output.is_some(),
            tool.output.clone().unwrap_or_default(),
        ),
        EvidenceField::Error => (tool.error.is_some(), tool.error.clone().unwrap_or_default()),
    };
    let evidence = excerpt(&value, position, query.max_characters, offset)?;
    let next = if position == EvidencePosition::Head && evidence["truncatedAfter"] == true {
        Some(format!(
            "field:{}",
            evidence["offset"].as_u64().unwrap_or(0)
                + utf16_len(evidence["text"].as_str().unwrap_or("")) as u64
        ))
    } else {
        None
    };
    let read_more = next
        .as_ref()
        .map(|cursor| {
            format!(
                "Continue this {} field with position head and cursor {cursor}.",
                field.name()
            )
        })
        .or_else(|| {
            (evidence["truncatedBefore"] == true).then(|| {
                format!(
                    "Read this {} field from the beginning with position head.",
                    field.name()
                )
            })
        });
    Ok(json!({
        "kind":"tool", "tool":{"toolId":tool.id,"name":tool.name,"status":tool.status},
        "field":field.name(), "position":position.name(), "available":available,
        "evidence":evidence, "nextCursor":next, "readMore":read_more,
    }))
}

pub fn read(tools: &[NativeTool], query: &EvidenceQuery) -> Result<Value, String> {
    if query.tool_id.is_some() {
        selected(tools, query)
    } else {
        index(tools, query)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn tool(id: &str, command: &str, output: &str) -> NativeTool {
        let mut input = Map::new();
        input.insert("command".into(), json!(command));
        NativeTool {
            id: id.into(),
            name: "command_execution".into(),
            status: "completed",
            input,
            output: Some(output.into()),
            error: None,
        }
    }

    fn query(max_characters: usize) -> EvidenceQuery {
        EvidenceQuery {
            tool_id: None,
            field: None,
            position: None,
            cursor: None,
            max_characters,
        }
    }

    #[test]
    fn compact_index_uses_serialized_budget_and_continuation() {
        let tools = (0..1000)
            .map(|index| tool(&format!("tool-{index}"), "", ""))
            .collect::<Vec<_>>();
        let first = read(&tools, &query(1000)).unwrap();
        assert_eq!(first["kind"], "index");
        assert!(!first["tools"].as_array().unwrap().is_empty());
        assert!(first["nextCursor"].as_str().unwrap().starts_with("index:"));
        assert!(utf16_len(&js_json::stringify(&first)) <= 1000);
        let mut next = query(1000);
        next.cursor = first["nextCursor"].as_str().map(str::to_owned);
        let second = read(&tools, &next).unwrap();
        assert_ne!(first["tools"][0]["toolId"], second["tools"][0]["toolId"]);
    }

    #[test]
    fn selected_tail_and_head_cursors_preserve_native_failure_text() {
        let output = format!("{}\nFAIL tests/tasks.test.ts", "x".repeat(120_000));
        let tools = vec![tool("pnpm-test", "pnpm test", &output)];
        let mut selected = query(1000);
        selected.tool_id = Some("pnpm-test".into());
        let tail = read(&tools, &selected).unwrap();
        assert_eq!(tail["kind"], "tool");
        assert!(
            tail["evidence"]["text"]
                .as_str()
                .unwrap()
                .contains("FAIL tests/tasks.test.ts")
        );
        assert_eq!(tail["evidence"]["totalCharacters"], output.len());
        assert_eq!(tail["evidence"]["truncatedBefore"], true);
        selected.position = Some(EvidencePosition::Head);
        let first = read(&tools, &selected).unwrap();
        assert_eq!(first["nextCursor"], "field:1000");
        selected.cursor = first["nextCursor"].as_str().map(str::to_owned);
        let second = read(&tools, &selected).unwrap();
        assert_eq!(second["evidence"]["offset"], 1000);
        selected.position = Some(EvidencePosition::Tail);
        assert!(
            read(&tools, &selected)
                .unwrap_err()
                .contains("only valid for head")
        );
    }
}
