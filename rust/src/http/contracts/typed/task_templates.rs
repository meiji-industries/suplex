//! Stored task-template configuration used by the project template list.

use garde::Validate;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    delivery_target as check_delivery_target, id_1_256, tasks,
    visual_evidence as check_visual_evidence,
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
