//! Workflow record request contracts from `http/contracts/workflows.ts`.

use serde_json::{Map, Value};

use super::{
    ContractResult, DELIVERY_TARGETS, Field, Rule, VISUAL_EVIDENCE, WORKFLOW_IDS, optional,
    parse_object,
};

const NAME: Rule = Rule::Text {
    trim: true,
    min: 1,
    max: Some(80),
};
const DESCRIPTION: Rule = Rule::Text {
    trim: true,
    min: 0,
    max: None,
};
const PROFILE_ID: Rule = Rule::Text {
    trim: false,
    min: 1,
    max: None,
};

const INPUT: &[Field] = &[
    Field {
        required: true,
        ..optional("name", NAME)
    },
    Field {
        default: Some("\"\""),
        ..optional("description", DESCRIPTION)
    },
    Field {
        required: true,
        ..optional("engine", WORKFLOW_IDS)
    },
    optional("rootProfileId", PROFILE_ID),
    optional("workerProfileId", PROFILE_ID),
    Field {
        default: Some("{}"),
        ..optional("advisorProfileIds", Rule::Advisors)
    },
    optional("deliveryTarget", DELIVERY_TARGETS),
    optional("runProjectTests", Rule::Flag),
    optional("visualEvidence", VISUAL_EVIDENCE),
];

// A patch carries no defaults; null clears an optional setting.
const PATCH: &[Field] = &[
    optional("name", NAME),
    optional("description", DESCRIPTION),
    optional("engine", WORKFLOW_IDS),
    Field {
        nullable: true,
        ..optional("rootProfileId", PROFILE_ID)
    },
    Field {
        nullable: true,
        ..optional("workerProfileId", PROFILE_ID)
    },
    optional("advisorProfileIds", Rule::Advisors),
    Field {
        nullable: true,
        ..optional("deliveryTarget", DELIVERY_TARGETS)
    },
    Field {
        nullable: true,
        ..optional("runProjectTests", Rule::Flag)
    },
    Field {
        nullable: true,
        ..optional("visualEvidence", VISUAL_EVIDENCE)
    },
    optional("archived", Rule::Flag),
];

/// `WorkflowRecordInputSchema` with its defaults applied.
pub fn parse_input(input: Option<&Value>) -> ContractResult<Map<String, Value>> {
    parse_object(input, INPUT, true)
}

/// `WorkflowRecordPatchSchema`: only the present fields.
pub fn parse_patch(input: Option<&Value>) -> ContractResult<Map<String, Value>> {
    parse_object(input, PATCH, true)
}

/// `WorkflowRecordInputSchema.strip()`: drop fields the input schema lacks.
pub fn strip_input(input: &Map<String, Value>) -> ContractResult<Map<String, Value>> {
    parse_object(Some(&Value::Object(input.clone())), INPUT, false)
}

pub fn validate(contract: &str, input: Option<&Value>) -> Option<ContractResult<Value>> {
    Some(match contract {
        "workflows.WorkflowRecordInputSchema" => parse_input(input).map(Value::Object),
        "workflows.WorkflowRecordPatchSchema" => parse_patch(input).map(Value::Object),
        _ => return None,
    })
}
