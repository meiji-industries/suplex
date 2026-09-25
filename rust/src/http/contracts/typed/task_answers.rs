//! Request body for answering the current task question.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

use super::{ContractFailure, ContractResult, finding, tasks::trimmed};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TaskAnswerBody {
    Answer(AnswerBody),
    LimitDecision(LimitDecisionBody),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnswerBody {
    pub question_id: String,
    #[serde(deserialize_with = "trimmed")]
    pub answer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_commands_stopped: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitDecisionBody {
    pub question_id: String,
    pub limit_decision: TaskLimitDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskLimitDecision {
    AddAllowance,
    ChangeLimits { limits: TaskLimits },
    CancelTask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskLimits {
    #[serde(serialize_with = "serialize_js_number")]
    pub budget_usd: f64,
    #[serde(deserialize_with = "nonnegative_integer")]
    pub max_turns: u64,
}

fn serialize_js_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER as f64 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

fn nonnegative_integer<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    value
        .as_number()
        .and_then(|number| number.as_f64())
        .filter(|number| number.is_finite() && *number >= 0.0 && number.fract() == 0.0)
        .filter(|number| *number <= u64::MAX as f64)
        .map(|number| number as u64)
        .ok_or_else(|| serde::de::Error::custom("expected nonnegative integer"))
}

pub fn parse_task_answer(input: Option<&Value>) -> ContractResult<TaskAnswerBody> {
    // Serde's internally tagged unit variants ignore extra keys even with
    // deny_unknown_fields on the enum; the source decision variants are strict.
    if let Some(decision) = input
        .and_then(|value| value.get("limitDecision"))
        .and_then(Value::as_object)
    {
        let allowed: &[&str] = match decision.get("kind").and_then(Value::as_str) {
            Some("add_allowance" | "cancel_task") => &["kind"],
            Some("change_limits") => &["kind", "limits"],
            _ => &[],
        };
        if decision.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(ContractFailure::Issues(vec![finding("invalid_union", &[])]));
        }
    }
    let value = input.cloned().unwrap_or(Value::Null);
    let body: TaskAnswerBody = serde_json::from_value(value)
        .map_err(|_| ContractFailure::Issues(vec![finding("invalid_union", &[])]))?;
    let mut issues = Vec::new();
    match &body {
        TaskAnswerBody::Answer(answer) => {
            if answer.question_id.is_empty() {
                issues.push(finding("too_small", &[json!("questionId")]));
            }
            if answer.answer.is_empty() {
                issues.push(finding("too_small", &[json!("answer")]));
            }
        }
        TaskAnswerBody::LimitDecision(decision) => {
            if decision.question_id.is_empty() {
                issues.push(finding("too_small", &[json!("questionId")]));
            }
            if let TaskLimitDecision::ChangeLimits { limits } = &decision.limit_decision {
                if !limits.budget_usd.is_finite() || limits.budget_usd < 0.0 {
                    issues.push(finding(
                        "too_small",
                        &[json!("limitDecision"), json!("limits"), json!("budgetUsd")],
                    ));
                }
                if limits.max_turns > MAX_SAFE_INTEGER {
                    issues.push(finding(
                        "too_big",
                        &[json!("limitDecision"), json!("limits"), json!("maxTurns")],
                    ));
                }
            }
        }
    }
    if !issues.is_empty() {
        Err(ContractFailure::Issues(issues))
    } else {
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    #[test]
    fn source_request_corpus_matches_public_findings_and_normalization() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/parity/tasks.TaskAnswerBodySchema");
        let mut count = 0;
        for entry in fs::read_dir(root).unwrap() {
            let fixture: Value =
                serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
            let actual = match parse_task_answer(fixture.get("input")) {
                Ok(value) => {
                    json!({"accepted": true, "value": serde_json::to_value(value).unwrap()})
                }
                Err(ContractFailure::Issues(error)) => json!({"accepted": false, "error": error}),
                Err(other) => panic!("unexpected parser failure: {other:?}"),
            };
            assert_eq!(actual, fixture["expected"], "{}", fixture["case"]);
            count += 1;
        }
        assert_eq!(count, 27);
        let combined = json!({"questionId":"","answer":" "});
        assert!(matches!(
            parse_task_answer(Some(&combined)),
            Err(ContractFailure::Issues(issues)) if issues == vec![
                finding("too_small", &[json!("questionId")]),
                finding("too_small", &[json!("answer")]),
            ]
        ));
        let integral_float = json!({"questionId":"x","limitDecision":{"kind":"change_limits","limits":{"budgetUsd":1.0,"maxTurns":1.0}}});
        assert_eq!(
            serde_json::to_value(parse_task_answer(Some(&integral_float)).unwrap()).unwrap(),
            json!({"questionId":"x","limitDecision":{"kind":"change_limits","limits":{"budgetUsd":1,"maxTurns":1}}})
        );
    }
}
