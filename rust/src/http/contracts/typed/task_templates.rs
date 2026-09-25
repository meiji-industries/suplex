//! Task-template request contracts and stored configuration.

use garde::Validate;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    ContractFailure, ContractResult, DELIVERY_TARGETS, Field, ID, Rule, TRIMMED_NAME,
    VISUAL_EVIDENCE, WORKFLOW_IDS, delivery_target as check_delivery_target, id_1_256, optional,
    parse_object, serialized, tasks, visual_evidence as check_visual_evidence,
};

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateConfiguration {
    #[serde(deserialize_with = "tasks::trimmed")]
    #[garde(length(min = 1))]
    pub name: String,
    #[serde(default, deserialize_with = "tasks::trimmed")]
    #[garde(skip)]
    pub description: String,
    #[serde(
        default,
        deserialize_with = "tasks::optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(id_1_256)))]
    pub root_profile_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "tasks::optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(custom(id_1_256)))]
    pub worker_profile_id: Option<String>,
    #[serde(default = "tasks::default_delivery_target")]
    #[garde(custom(check_delivery_target))]
    pub delivery_target: String,
    #[serde(default = "tasks::default_run_project_tests")]
    #[garde(skip)]
    pub run_project_tests: bool,
    #[serde(default = "tasks::default_visual_evidence")]
    #[garde(custom(check_visual_evidence))]
    pub visual_evidence: String,
    #[serde(default = "tasks::default_workflow")]
    #[garde(custom(tasks::check_workflow))]
    pub workflow: String,
    #[serde(default)]
    #[garde(dive)]
    pub advisor_profile_ids: tasks::AdvisorProfileIds,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateResponse {
    #[serde(flatten)]
    pub configuration: TemplateConfiguration,
    pub id: String,
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// The stored create schema is strict and applies its request defaults again.
pub fn parse_stored_configuration(value: Value) -> Result<TemplateConfiguration, String> {
    let configuration: TemplateConfiguration =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    configuration
        .validate()
        .map_err(|error| error.to_string())?;
    Ok(configuration)
}

const DESCRIPTION: Rule = Rule::Text {
    trim: true,
    min: 0,
    max: None,
};
const PATCH_PROFILE_ID: Rule = Rule::Text {
    trim: false,
    min: 1,
    max: None,
};

const CREATE: &[Field] = &[
    Field {
        default: Some("\"\""),
        ..optional("description", DESCRIPTION)
    },
    optional("rootProfileId", ID),
    optional("workerProfileId", ID),
    Field {
        default: Some("\"pull_request_draft\""),
        ..optional("deliveryTarget", DELIVERY_TARGETS)
    },
    Field {
        default: Some("true"),
        ..optional("runProjectTests", Rule::Flag)
    },
    Field {
        default: Some("\"off\""),
        ..optional("visualEvidence", VISUAL_EVIDENCE)
    },
    Field {
        default: Some("\"standard\""),
        ..optional("workflow", WORKFLOW_IDS)
    },
    Field {
        default: Some("{}"),
        ..optional("advisorProfileIds", Rule::Advisors)
    },
    Field {
        required: true,
        ..optional("name", TRIMMED_NAME)
    },
];

// A patch carries no defaults: the service merges it with the stored template first.
const UPDATE: &[Field] = &[
    optional("name", TRIMMED_NAME),
    optional("description", TRIMMED_NAME),
    Field {
        nullable: true,
        ..optional("rootProfileId", PATCH_PROFILE_ID)
    },
    Field {
        nullable: true,
        ..optional("workerProfileId", PATCH_PROFILE_ID)
    },
    optional("deliveryTarget", DELIVERY_TARGETS),
    optional("runProjectTests", Rule::Flag),
    optional("visualEvidence", VISUAL_EVIDENCE),
    optional("workflow", WORKFLOW_IDS),
    optional("advisorProfileIds", Rule::Advisors),
];

const SAVE: &[Field] = &[Field {
    required: true,
    ..optional("name", TRIMMED_NAME)
}];

/// `CreateTaskTemplateBodySchema`.
pub fn parse_create(input: Option<&Value>) -> ContractResult<TemplateConfiguration> {
    let value = parse_object(input, CREATE, true)?;
    parse_stored_configuration(Value::Object(value)).map_err(ContractFailure::Internal)
}

/// `UpdateTaskTemplateBodySchema`: only the present fields.
pub fn parse_update(input: Option<&Value>) -> ContractResult<Map<String, Value>> {
    parse_object(input, UPDATE, true)
}

/// `SaveTaskAsTemplateBodySchema`: the trimmed template name.
pub fn parse_save(input: Option<&Value>) -> ContractResult<String> {
    let mut value = parse_object(input, SAVE, true)?;
    Ok(value
        .remove("name")
        .and_then(|name| name.as_str().map(str::to_owned))
        .unwrap_or_default())
}

pub fn validate(contract: &str, input: Option<&Value>) -> Option<ContractResult<Value>> {
    Some(match contract {
        "task-templates.CreateTaskTemplateBodySchema" => serialized(parse_create(input)),
        "task-templates.UpdateTaskTemplateBodySchema" => parse_update(input).map(Value::Object),
        "task-templates.SaveTaskAsTemplateBodySchema" => {
            parse_save(input).map(|name| serde_json::json!({ "name": name }))
        }
        _ => return None,
    })
}
