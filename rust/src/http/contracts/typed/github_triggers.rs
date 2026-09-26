//! GitHub trigger request contracts (`src/http/contracts/github-triggers.ts`).

use crate::tasks::control::DeliveryTarget;

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{ContractFailure, ContractResult, delivery_target, finding, object, serialized};
use crate::identity::auth::js_trim;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTriggerCreate {
    pub project_id: String,
    pub name: String,
    pub label: String,
    pub workflow_id: String,
    pub delivery_target: DeliveryTarget,
    pub protected_paths: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTriggerPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_target: Option<DeliveryTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTriggerParams {
    pub company_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
}

struct Fields<'a> {
    fields: &'a Map<String, Value>,
    issues: Vec<Value>,
}

impl Fields<'_> {
    fn issue(&mut self, code: &str, path: &[Value]) {
        self.issues.push(finding(code, path));
    }

    /// A string with optional trim and UTF-16 length bounds.
    fn string(&mut self, name: &str, trim: bool, max: usize) -> Option<String> {
        let at = [json!(name)];
        let Some(Value::String(value)) = self.fields.get(name) else {
            self.issue("invalid_type", &at);
            return None;
        };
        let value = if trim { js_trim(value) } else { value.as_str() };
        match value.encode_utf16().count() {
            0 => self.issue("too_small", &at),
            length if length > max => self.issue("too_big", &at),
            _ => return Some(value.to_owned()),
        }
        None
    }

    fn target(&mut self) -> Option<String> {
        match self.fields.get("deliveryTarget").and_then(Value::as_str) {
            Some(value) if delivery_target(value, &()).is_ok() => Some(value.to_owned()),
            _ => {
                self.issue("invalid_value", &[json!("deliveryTarget")]);
                None
            }
        }
    }

    fn paths(&mut self) -> Option<Vec<String>> {
        let Some(Value::Array(values)) = self.fields.get("protectedPaths") else {
            self.issue("invalid_type", &[json!("protectedPaths")]);
            return None;
        };
        let before = self.issues.len();
        let mut paths = Vec::new();
        for (index, value) in values.iter().enumerate() {
            let at = [json!("protectedPaths"), json!(index)];
            match value {
                Value::String(path) => match path.encode_utf16().count() {
                    0 => self.issue("too_small", &at),
                    513.. => self.issue("too_big", &at),
                    _ => paths.push(path.clone()),
                },
                _ => self.issue("invalid_type", &at),
            }
        }
        if values.len() > 100 {
            self.issue("too_big", &[json!("protectedPaths")]);
        }
        (self.issues.len() == before).then_some(paths)
    }

    fn optional<T>(&mut self, name: &str, read: impl FnOnce(&mut Self) -> Option<T>) -> Option<T> {
        if self.fields.contains_key(name) {
            read(self)
        } else {
            None
        }
    }

    fn boolean(&mut self, name: &str) -> Option<bool> {
        match self.fields.get(name) {
            None => None,
            Some(Value::Bool(value)) => Some(*value),
            Some(_) => {
                self.issue("invalid_type", &[json!(name)]);
                None
            }
        }
    }

    fn strict(&mut self, allowed: &[&str]) {
        if self
            .fields
            .keys()
            .any(|key| !allowed.contains(&key.as_str()))
        {
            self.issue("unrecognized_keys", &[]);
        }
    }

    fn finish<T>(self, value: Option<T>) -> ContractResult<T> {
        match value {
            Some(value) if self.issues.is_empty() => Ok(value),
            _ => Err(ContractFailure::Issues(self.issues)),
        }
    }
}

const CREATE_FIELDS: &[&str] = &[
    "projectId",
    "name",
    "label",
    "workflowId",
    "deliveryTarget",
    "protectedPaths",
];

pub fn parse_create(input: Option<&Value>) -> ContractResult<GithubTriggerCreate> {
    let mut fields = Fields {
        fields: object(input)?,
        issues: Vec::new(),
    };
    let project_id = fields.string("projectId", false, 128);
    let name = fields.string("name", true, 120);
    let label = fields.string("label", true, 100);
    let workflow_id = fields.string("workflowId", false, 128);
    let target = fields.target();
    let paths = fields.paths();
    fields.strict(CREATE_FIELDS);
    let value = (|| {
        Some(GithubTriggerCreate {
            project_id: project_id?,
            name: name?,
            label: label?,
            workflow_id: workflow_id?,
            delivery_target: DeliveryTarget::parse(&target?).expect("validated target"),
            protected_paths: paths?,
        })
    })();
    fields.finish(value)
}

pub fn parse_patch(input: Option<&Value>) -> ContractResult<GithubTriggerPatch> {
    let mut fields = Fields {
        fields: object(input)?,
        issues: Vec::new(),
    };
    let mut patch = GithubTriggerPatch {
        project_id: fields.optional("projectId", |fields| fields.string("projectId", false, 128)),
        name: fields.optional("name", |fields| fields.string("name", true, 120)),
        label: fields.optional("label", |fields| fields.string("label", true, 100)),
        workflow_id: fields.optional("workflowId", |fields| {
            fields.string("workflowId", false, 128)
        }),
        delivery_target: fields
            .optional("deliveryTarget", Fields::target)
            .map(|target| DeliveryTarget::parse(&target).expect("validated target")),
        protected_paths: fields.optional("protectedPaths", Fields::paths),
        enabled: fields.boolean("enabled"),
        archived: fields.boolean("archived"),
        expected_revision: 0,
    };
    let revision = match fields.fields.get("expectedRevision") {
        Some(Value::Number(number)) => match number.as_f64() {
            Some(value) if value.fract() != 0.0 => {
                fields.issue("invalid_type", &[json!("expectedRevision")]);
                None
            }
            Some(value) if value <= 0.0 => {
                fields.issue("too_small", &[json!("expectedRevision")]);
                None
            }
            Some(value) if value > 9_007_199_254_740_991.0 => {
                fields.issue("too_big", &[json!("expectedRevision")]);
                None
            }
            Some(value) => Some(value as i64),
            None => None,
        },
        _ => {
            fields.issue("invalid_type", &[json!("expectedRevision")]);
            None
        }
    };
    let mut allowed = CREATE_FIELDS.to_vec();
    allowed.extend(["enabled", "archived", "expectedRevision"]);
    fields.strict(&allowed);
    let value = revision.map(|revision| {
        patch.expected_revision = revision;
        patch
    });
    fields.finish(value)
}

fn params(input: Option<&Value>, names: &[&str]) -> ContractResult<GithubTriggerParams> {
    let mut fields = Fields {
        fields: object(input)?,
        issues: Vec::new(),
    };
    let values = names
        .iter()
        .map(|name| fields.string(name, false, 128))
        .collect::<Vec<_>>();
    let value = values
        .iter()
        .all(Option::is_some)
        .then(|| GithubTriggerParams {
            company_id: values[0].clone().unwrap_or_default(),
            rule_id: values.get(1).cloned().flatten(),
        });
    fields.finish(value)
}

pub fn parse_company_params(input: Option<&Value>) -> ContractResult<GithubTriggerParams> {
    params(input, &["companyId"])
}

pub fn parse_params(input: Option<&Value>) -> ContractResult<GithubTriggerParams> {
    params(input, &["companyId", "ruleId"])
}

pub fn validate(contract: &str, input: Option<&Value>) -> Option<ContractResult<Value>> {
    Some(match contract {
        "github-triggers.GithubTriggerCreateSchema" => serialized(parse_create(input)),
        "github-triggers.GithubTriggerPatchSchema" => serialized(parse_patch(input)),
        "github-triggers.GithubTriggerParamsSchema" => serialized(parse_params(input)),
        "github-triggers.GithubTriggerCompanyParamsSchema" => {
            serialized(parse_company_params(input))
        }
        _ => return None,
    })
}
