//! Task-template request contracts and stored configuration.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{
    Contract, ContractResult, Fields, MAX, advisors, choice, flag, nullable, one_of,
    tasks::{self, VISUAL_EVIDENCE, id},
    text, trimmed,
};
use crate::{coordination::workflows::Workflow, tasks::control::DeliveryTarget};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateConfiguration {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(
        default,
        deserialize_with = "super::optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    pub root_profile_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "super::optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    pub worker_profile_id: Option<String>,
    #[serde(default = "tasks::default_delivery_target")]
    pub delivery_target: DeliveryTarget,
    #[serde(default = "tasks::default_run_project_tests")]
    pub run_project_tests: bool,
    #[serde(default = "tasks::default_visual_evidence")]
    pub visual_evidence: String,
    #[serde(default = "tasks::default_workflow")]
    pub workflow: Workflow,
    #[serde(default)]
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

/// `UpdateTaskTemplateBodySchema` output: only the present fields.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(transparent)]
pub struct TemplatePatch(pub Map<String, Value>);

#[derive(Debug, Clone, Deserialize)]
pub struct SaveBody {
    pub name: String,
}

/// `CreateTaskTemplateBodySchema`: strict, with its request defaults.
impl Contract for TemplateConfiguration {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .or("description", json!(""), trimmed(0, MAX))
            .opt("rootProfileId", id())
            .opt("workerProfileId", id())
            .or(
                "deliveryTarget",
                json!("pull_request_draft"),
                choice::<DeliveryTarget>,
            )
            .or("runProjectTests", json!(true), flag)
            .or("visualEvidence", json!("off"), one_of(VISUAL_EVIDENCE))
            .or("workflow", json!("standard"), choice::<Workflow>)
            .or("advisorProfileIds", json!({}), advisors)
            .req("name", trimmed(1, MAX))
            .strict()
    }
}

/// A stored configuration passes the create schema again.
pub fn parse_stored_configuration(value: Value) -> Result<TemplateConfiguration, String> {
    TemplateConfiguration::parse(Some(&value)).map_err(|failure| format!("{failure:?}"))
}

/// A patch carries no defaults: the service merges it with the stored template first.
impl Contract for TemplatePatch {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("name", trimmed(1, MAX))
            .opt("description", trimmed(1, MAX))
            .opt("rootProfileId", nullable(text(1, MAX)))
            .opt("workerProfileId", nullable(text(1, MAX)))
            .opt("deliveryTarget", choice::<DeliveryTarget>)
            .opt("runProjectTests", flag)
            .opt("visualEvidence", one_of(VISUAL_EVIDENCE))
            .opt("workflow", choice::<Workflow>)
            .opt("advisorProfileIds", advisors)
            .strict()
    }
}

/// `ProjectTaskTemplatesParamsSchema`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTemplatesParams {
    pub project_id: String,
}

impl Contract for ProjectTemplatesParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        super::params(input, &["projectId"], (1, MAX))
    }
}

impl Contract for SaveBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("name", trimmed(1, MAX)).strict()
    }
}
