//! Move request contracts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    Contract, ContractResult, Fields, MAX, choice, flag, int, list, nullable, record, text, trimmed,
};
use crate::{
    coordination::workflows::Workflow,
    moves::{MoveRunner, prompt::MAX_TEXT_INPUT},
    tasks::{control::DeliveryTarget, response::VisualEvidence},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveBody {
    pub project_id: String,
    pub name: String,
    pub prompt: String,
    pub runner: MoveRunner,
    /// The agent profile for a prompt. None means the project's Worker.
    #[serde(default)]
    pub profile_id: Option<String>,
    pub confirm: bool,
    /// The settings of the task that a `task` move starts.
    #[serde(default)]
    pub workflow: Option<Workflow>,
    #[serde(default)]
    pub delivery_target: Option<DeliveryTarget>,
    pub run_project_tests: bool,
    pub visual_evidence: VisualEvidence,
}

impl Contract for MoveBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("projectId", text(1, 256))
            .req("name", trimmed(1, MAX))
            .req("prompt", text(0, 20_000))
            .req("runner", choice::<MoveRunner>)
            .opt("profileId", nullable(text(1, 256)))
            .req("confirm", flag)
            .opt("workflow", nullable(choice::<Workflow>))
            .opt("deliveryTarget", nullable(choice::<DeliveryTarget>))
            .or("runProjectTests", json!(true), flag)
            .or("visualEvidence", json!("off"), choice::<VisualEvidence>)
            .strict()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRunBody {
    pub inputs: BTreeMap<String, String>,
    pub excluded_pull_requests: Vec<i64>,
    pub idempotency_key: String,
}

fn input_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64
}

impl Contract for MoveRunBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req(
                "inputs",
                record(input_name, "invalid_key", text(0, MAX_TEXT_INPUT * 2)),
            )
            .req(
                "excludedPullRequests",
                list(int(1.0, 9_007_199_254_740_991.0), 0, 200),
            )
            .req("idempotencyKey", text(1, 256))
            .strict()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyMovesParams {
    pub company_id: String,
}

impl Contract for CompanyMovesParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        super::params(input, &["companyId"], (1, 256))
    }
}
