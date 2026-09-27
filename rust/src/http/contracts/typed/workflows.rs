//! Workflow record request contracts from `http/contracts/workflows.ts`.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{
    Contract, ContractResult, Fields, MAX, advisors, choice, flag, nullable, one_of,
    tasks::VISUAL_EVIDENCE, text, trimmed,
};
use crate::{coordination::workflows::Workflow, tasks::control::DeliveryTarget};

/// `WorkflowRecordInputSchema` output with its defaults applied.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(transparent)]
pub struct WorkflowInput(pub Map<String, Value>);

/// `WorkflowRecordPatchSchema` output: only the present fields.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(transparent)]
pub struct WorkflowPatch(pub Map<String, Value>);

fn input_fields(input: Option<&Value>) -> ContractResult<Fields<'_>> {
    Ok(Fields::new(input)?
        .req("name", trimmed(1, 80))
        .or("description", json!(""), trimmed(0, MAX))
        .req("engine", choice::<Workflow>)
        .opt("rootProfileId", text(1, MAX))
        .opt("workerProfileId", text(1, MAX))
        .or("advisorProfileIds", json!({}), advisors)
        .opt("deliveryTarget", choice::<DeliveryTarget>)
        .opt("runProjectTests", flag)
        .opt("visualEvidence", one_of(VISUAL_EVIDENCE)))
}

impl Contract for WorkflowInput {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        input_fields(input)?.strict()
    }
}

/// A patch carries no defaults; null clears an optional setting.
impl Contract for WorkflowPatch {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("name", trimmed(1, 80))
            .opt("description", trimmed(0, MAX))
            .opt("engine", choice::<Workflow>)
            .opt("rootProfileId", nullable(text(1, MAX)))
            .opt("workerProfileId", nullable(text(1, MAX)))
            .opt("advisorProfileIds", advisors)
            .opt("deliveryTarget", nullable(choice::<DeliveryTarget>))
            .opt("runProjectTests", nullable(flag))
            .opt("visualEvidence", nullable(one_of(VISUAL_EVIDENCE)))
            .opt("archived", flag)
            .strict()
    }
}

/// `WorkflowRecordInputSchema.strip()`: drop fields the input schema lacks.
pub fn strip_input(input: &Map<String, Value>) -> ContractResult<Map<String, Value>> {
    let input = Value::Object(input.clone());
    match input_fields(Some(&input))?.finish()? {
        Value::Object(fields) => Ok(fields),
        _ => Err(super::ContractFailure::Unhandled),
    }
}
