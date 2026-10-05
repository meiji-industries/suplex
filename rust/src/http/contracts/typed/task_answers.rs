//! Request body for answering the current task question.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    Contract, ContractResult, Fields, MAX, flag, int, number, present, tagged, tasks::MAX_SAFE,
    text, trimmed, union,
};

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

pub use crate::tasks::control::TaskLimitDecision;

/// `TaskLimitDecisionSchema`.
fn limit_decision(input: Option<&Value>) -> ContractResult<Value> {
    tagged(input, "kind", |kind| {
        let fields = Fields::new(input).ok()?.req("kind", present);
        Some(match kind.as_str()? {
            "add_allowance" | "cancel_task" => fields.strict(),
            "change_limits" => fields
                .req("limits", |input| {
                    Fields::new(input)?
                        .req("budgetUsd", number(0.0, f64::MAX))
                        .req("maxTurns", int(0.0, MAX_SAFE))
                        .strict()
                })
                .strict(),
            _ => return None,
        })
    })
}

impl Contract for TaskAnswerBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        union(
            input,
            &[
                &|input| {
                    Fields::new(input)?
                        .req("questionId", text(1, MAX))
                        .req("answer", trimmed(1, MAX))
                        .opt("confirmCommandsStopped", flag)
                        .strict()
                },
                &|input| {
                    Fields::new(input)?
                        .req("questionId", text(1, MAX))
                        .req("limitDecision", limit_decision)
                        .strict()
                },
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::http::contracts::typed::{ContractFailure, issue};

    #[test]
    fn answers_report_every_branch_finding_and_normalize_numbers() {
        let combined = json!({"questionId":"","answer":" "});
        assert!(matches!(
            TaskAnswerBody::parse(Some(&combined)),
            Err(ContractFailure::Issues(issues)) if issues == vec![
                issue("too_small", ".questionId"),
                issue("too_small", ".answer"),
            ]
        ));
        let integral_float = json!({"questionId":"x","limitDecision":{"kind":"change_limits","limits":{"budgetUsd":1.0,"maxTurns":1.0}}});
        assert_eq!(
            serde_json::to_value(TaskAnswerBody::parse(Some(&integral_float)).unwrap()).unwrap(),
            json!({"questionId":"x","limitDecision":{"kind":"change_limits","limits":{"budgetUsd":1,"maxTurns":1}}})
        );
    }
}
