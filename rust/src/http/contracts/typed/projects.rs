use crate::tasks::control::DeliveryTarget;
use garde::Validate;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use super::ContractResult;
use super::{
    ContractFailure, Field, Rule, delivery_target as valid_delivery_target, finding,
    garde_findings, id_1_256 as profile_id, object, optional, optional_nonnull, parse_object,
    present_nullable, serialized, visual_evidence as valid_visual_evidence,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RepositoryConnection {
    Github,
    Bitbucket {
        #[serde(rename = "tokenEnvironment")]
        token_environment: String,
        #[serde(
            rename = "usernameEnvironment",
            skip_serializing_if = "Option::is_none"
        )]
        username_environment: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TrackerConnection {
    Github {
        repository: String,
    },
    Jira {
        site: String,
        project: String,
        #[serde(rename = "emailEnvironment")]
        email_environment: String,
        #[serde(rename = "tokenEnvironment")]
        token_environment: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[garde(allow_unvalidated)]
#[serde(deny_unknown_fields)]
pub struct ProjectIntegration {
    #[serde(default = "github_repository")]
    pub repository: RepositoryConnection,
    #[serde(default)]
    pub tracker: Option<TrackerConnection>,
}
fn github_repository() -> RepositoryConnection {
    RepositoryConnection::Github
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: serde_json::Map<String, Value>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: serde_json::Map<String, Value>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpGrants {
    pub root: Vec<String>,
    pub advisor: Vec<String>,
    pub worker: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub transport: McpTransport,
    pub grants: McpGrants,
}
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[garde(allow_unvalidated)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectExecution {
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub skill_directories: Vec<String>,
    #[serde(default)]
    pub environment: serde_json::Map<String, Value>,
    #[serde(default)]
    pub mcp: Vec<McpServer>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, Validate)]
#[garde(allow_unvalidated)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorProfilePolicy {
    #[serde(default)]
    #[garde(inner(custom(profile_id)))]
    pub reviewer: Vec<String>,
    #[serde(default, rename = "planner_a")]
    #[garde(inner(custom(profile_id)))]
    pub planner_a: Vec<String>,
    #[serde(default, rename = "planner_b")]
    #[garde(inner(custom(profile_id)))]
    pub planner_b: Vec<String>,
    #[serde(default)]
    #[garde(inner(custom(profile_id)))]
    pub rater: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[garde(allow_unvalidated)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAgentTaskPolicy {
    #[garde(length(min = 1), inner(custom(profile_id)))]
    pub workflow_ids: Vec<String>,
    #[garde(custom(profile_id))]
    pub default_workflow_id: String,
    #[serde(default)]
    #[garde(inner(custom(profile_id)))]
    pub template_ids: Vec<String>,
    #[garde(length(min = 1), inner(custom(profile_id)))]
    pub root_profile_ids: Vec<String>,
    #[garde(length(min = 1), inner(custom(profile_id)))]
    pub worker_profile_ids: Vec<String>,
    #[serde(default)]
    #[garde(dive)]
    pub advisor_profile_ids: AdvisorProfilePolicy,
    #[serde(default = "default_delivery_target")]
    #[garde(skip)]
    pub delivery_target: DeliveryTarget,
    #[serde(default = "default_run_project_tests")]
    pub run_project_tests: bool,
    #[serde(default = "default_visual_evidence")]
    #[garde(custom(valid_visual_evidence))]
    pub visual_evidence: String,
}
fn default_delivery_target() -> DeliveryTarget {
    DeliveryTarget::PullRequestDraft
}
fn default_run_project_tests() -> bool {
    true
}
fn default_visual_evidence() -> String {
    "off".into()
}
pub use crate::projects::ProjectProviderPolicy;
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[garde(allow_unvalidated)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistingRepositoryCreate {
    #[garde(length(min = 1))]
    pub repository_url: String,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(dive)]
    pub integration: Option<ProjectIntegration>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(length(min = 1))]
    pub base_branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[garde(allow_unvalidated)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewRepositoryCreate {
    #[garde(custom(valid_repository_name))]
    pub repository_name: String,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(dive)]
    pub integration: Option<ProjectIntegration>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(length(min = 1))]
    pub base_branch: Option<String>,
}
fn valid_repository_name(value: &str, _: &()) -> garde::Result {
    let length = value.encode_utf16().count();
    if length == 0 {
        Err(garde::Error::new("too_small"))
    } else if length > 200 {
        Err(garde::Error::new("too_big"))
    } else {
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[garde(allow_unvalidated)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalProjectCreate {
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(dive)]
    pub integration: Option<ProjectIntegration>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(dive)]
    pub execution: Option<ProjectExecution>,
    #[garde(length(min = 1))]
    pub name: String,
    #[garde(length(min = 1))]
    pub repository_path: String,
    #[garde(length(min = 1))]
    pub worktree_root: String,
    #[garde(length(min = 1))]
    pub repository: String,
    #[garde(length(min = 1))]
    pub base_branch: String,
    pub setup_command: String,
    pub verification_command: String,
    #[garde(length(min = 1))]
    pub root_profile_id: String,
    #[garde(length(min = 1))]
    pub worker_profile_id: String,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(dive)]
    pub agent_task_policy: Option<ProjectAgentTaskPolicy>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_policy: Option<Option<ProjectProviderPolicy>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProjectCreateBody {
    ExistingRepository(ExistingRepositoryCreate),
    NewRepository(NewRepositoryCreate),
    Local(Box<LocalProjectCreate>),
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integration: Option<ProjectIntegration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ProjectExecution>,
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub repository_path: String,
    pub worktree_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub base_branch: String,
    pub setup_command: String,
    pub verification_command: String,
    pub root_profile_id: String,
    pub worker_profile_id: String,
    pub agent_task_policy: ProjectAgentTaskPolicy,
    pub provider_policy: Option<ProjectProviderPolicy>,
    pub created_at: String,
    pub updated_at: String,
}

fn issue(code: &str, path: &str) -> Value {
    serde_json::json!({"code": format!("invalid-{code}"), "field": path, "message": "Request value is invalid"})
}

fn strict_fields(
    fields: &serde_json::Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Vec<Value> {
    if fields.keys().any(|name| !allowed.contains(&name.as_str())) {
        vec![issue(
            "unrecognized_keys",
            if path.is_empty() { "." } else { path },
        )]
    } else {
        Vec::new()
    }
}

fn typed_string(
    fields: &serde_json::Map<String, Value>,
    name: &str,
    path: &str,
    required: bool,
) -> Vec<Value> {
    match fields.get(name) {
        Some(Value::String(_)) => Vec::new(),
        None if !required => Vec::new(),
        _ => vec![issue("invalid_type", path)],
    }
}

fn typed_array(
    fields: &serde_json::Map<String, Value>,
    name: &str,
    path: &str,
    required: bool,
) -> Vec<Value> {
    match fields.get(name) {
        Some(Value::Array(_)) => Vec::new(),
        None if !required => Vec::new(),
        _ => vec![issue("invalid_type", path)],
    }
}

fn profile_array_errors(value: &Value, path: &str) -> Vec<Value> {
    let Value::Array(values) = value else {
        return vec![issue("invalid_type", path)];
    };
    let mut errors = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if !value.is_string() {
            let item_path = format!("{path}.{index}");
            errors.push(issue("invalid_type", &item_path));
            if value.as_array().is_some_and(Vec::is_empty) {
                errors.push(issue("too_small", &item_path));
            }
        }
    }
    errors
}

fn checked<T: serde::de::DeserializeOwned + Serialize + Validate<Context = ()>>(
    input: &Value,
    errors: Vec<Value>,
) -> ContractResult<T> {
    if !errors.is_empty() {
        return Err(ContractFailure::Issues(errors));
    }
    let value: T = serde_json::from_value(input.clone())
        .map_err(|_| ContractFailure::Issues(vec![issue("invalid_type", ".")]))?;
    value
        .validate()
        .map_err(|report| ContractFailure::Issues(garde_findings(&report, &value)))?;
    Ok(value)
}

fn valid_env_reference(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('A'..='Z'))
        && chars.count() <= 127
        && value
            .chars()
            .skip(1)
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn valid_mcp_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn mcp_errors(value: &Value) -> Vec<Value> {
    let Value::Array(servers) = value else {
        return vec![issue("invalid_type", ".mcp")];
    };
    let mut errors = Vec::new();
    let mut names = std::collections::HashSet::new();
    for (index, server) in servers.iter().enumerate() {
        let Some(server) = server.as_object() else {
            errors.push(issue("invalid_type", &format!(".mcp.{index}")));
            continue;
        };
        let prefix = format!(".mcp.{index}");
        if let Some(name) = server.get("name").and_then(Value::as_str) {
            if !valid_mcp_name(name) {
                errors.push(issue("invalid_format", &format!("{prefix}.name")));
            } else if name.starts_with("suplex_") {
                errors.push(issue("custom", &format!("{prefix}.name")));
            }
            names.insert(name);
        } else {
            errors.push(issue("invalid_type", &format!("{prefix}.name")));
        }
        if let Some(transport) = server.get("transport").and_then(Value::as_object) {
            let transport_prefix = format!("{prefix}.transport");
            match transport.get("type").and_then(Value::as_str) {
                Some("stdio") => {
                    match transport.get("command").and_then(Value::as_str) {
                        Some("") => {
                            errors.push(issue("too_small", &format!("{transport_prefix}.command")))
                        }
                        None => errors.push(issue(
                            "invalid_type",
                            &format!("{transport_prefix}.command"),
                        )),
                        _ => {}
                    }
                    if let Some(env) = transport.get("env").and_then(Value::as_object) {
                        for (key, value) in env {
                            let path = format!("{transport_prefix}.env.{key}");
                            if !value.is_string() {
                                errors.push(issue("invalid_type", &path));
                            } else if !value.as_str().is_some_and(|value| {
                                let mut chars = value.chars();
                                chars
                                    .next()
                                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                                    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                            }) {
                                errors.push(issue("invalid_format", &path));
                            }
                        }
                    }
                }
                Some("http") => {
                    match transport.get("url").and_then(Value::as_str) {
                        Some(url) if url::Url::parse(url).is_err() => {
                            errors.push(issue("invalid_format", &format!("{transport_prefix}.url")))
                        }
                        None => {
                            errors.push(issue("invalid_type", &format!("{transport_prefix}.url")))
                        }
                        _ => {}
                    }
                    if let Some(headers) = transport.get("headers").and_then(Value::as_object) {
                        for (key, value) in headers {
                            let path = format!("{transport_prefix}.headers.{key}");
                            if !value.is_string() {
                                errors.push(issue("invalid_type", &path));
                            } else if !value.as_str().is_some_and(|value| {
                                let mut chars = value.chars();
                                chars
                                    .next()
                                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                                    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                            }) {
                                errors.push(issue("invalid_format", &path));
                            }
                        }
                    }
                }
                _ => {}
            }
        } else {
            errors.push(issue("invalid_type", &format!("{prefix}.transport")));
        }
        if let Some(grants) = server.get("grants").and_then(Value::as_object) {
            for role in ["root", "advisor", "worker"] {
                if let Some(values) = grants.get(role).and_then(Value::as_array) {
                    for (item, value) in values.iter().enumerate() {
                        if !value.is_string() {
                            errors.push(issue(
                                "invalid_type",
                                &format!("{prefix}.grants.{role}.{item}"),
                            ));
                        } else if value.as_str().is_some_and(|value| !valid_mcp_name(value)) {
                            errors.push(issue(
                                "invalid_format",
                                &format!("{prefix}.grants.{role}.{item}"),
                            ));
                        }
                    }
                } else {
                    errors.push(issue("invalid_type", &format!("{prefix}.grants.{role}")));
                }
            }
        } else {
            errors.push(issue("invalid_type", &format!("{prefix}.grants")));
        }
    }
    if errors.is_empty() && names.len() != servers.len() {
        errors.push(issue("custom", ".mcp"));
    }
    errors
}

fn integration_errors(
    fields: &serde_json::Map<String, Value>,
    prefix: &str,
) -> ContractResult<Vec<Value>> {
    let mut errors = Vec::new();
    if let Some(repository) = fields.get("repository") {
        let Value::Object(repository) = repository else {
            return Ok(vec![issue("invalid_type", &format!("{prefix}.repository"))]);
        };
        let allowed = match repository.get("kind").and_then(Value::as_str) {
            Some("github") => &["kind"][..],
            Some("bitbucket") => &["kind", "tokenEnvironment", "usernameEnvironment"][..],
            _ => {
                return Ok(vec![issue(
                    "invalid_union",
                    &format!("{prefix}.repository"),
                )]);
            }
        };
        if allowed.len() > 1 {
            for name in ["tokenEnvironment", "usernameEnvironment"] {
                if let Some(value) = repository.get(name) {
                    let path = format!("{prefix}.repository.{name}");
                    if let Some(value) = value.as_str() {
                        if !valid_env_reference(value) {
                            errors.push(issue("invalid_format", &path));
                        }
                    } else {
                        errors.push(issue("invalid_type", &path));
                    }
                } else if name == "tokenEnvironment" {
                    errors.push(issue(
                        "invalid_type",
                        &format!("{prefix}.repository.{name}"),
                    ));
                }
            }
        }
        errors.extend(strict_fields(
            repository,
            allowed,
            &format!("{prefix}.repository"),
        ));
    }
    if let Some(tracker) = fields.get("tracker").filter(|value| !value.is_null()) {
        let Value::Object(tracker) = tracker else {
            return Ok(vec![issue("invalid_type", &format!("{prefix}.tracker"))]);
        };
        match tracker.get("kind").and_then(Value::as_str) {
            Some("github") => {
                let path = format!("{prefix}.tracker.repository");
                errors.extend(typed_string(tracker, "repository", &path, true));
                if let Some(value) = tracker.get("repository").and_then(Value::as_str) {
                    let parts = value.split('/').collect::<Vec<_>>();
                    if parts.len() != 2
                        || parts.iter().any(|part| {
                            part.is_empty()
                                || !part.chars().all(|c| {
                                    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
                                })
                        })
                    {
                        errors.push(issue("invalid_format", &path));
                    }
                }
                errors.extend(strict_fields(
                    tracker,
                    &["kind", "repository"],
                    &format!("{prefix}.tracker"),
                ));
            }
            Some("jira") => {
                for name in ["site", "project", "emailEnvironment", "tokenEnvironment"] {
                    let path = format!("{prefix}.tracker.{name}");
                    errors.extend(typed_string(tracker, name, &path, true));
                    if let Some(value) = tracker.get(name).and_then(Value::as_str) {
                        if name == "site" {
                            let url =
                                url::Url::parse(value).map_err(|_| ContractFailure::Unhandled)?;
                            if url.scheme() != "https"
                                || !url.host_str().is_some_and(|host| {
                                    host.ends_with(".atlassian.net")
                                        && host.trim_end_matches(".atlassian.net").chars().all(
                                            |c| {
                                                c.is_ascii_lowercase()
                                                    || c.is_ascii_digit()
                                                    || c == '-'
                                            },
                                        )
                                        && host.len() > ".atlassian.net".len()
                                })
                                || !url.username().is_empty()
                                || url.password().is_some()
                                || url.path() != "/"
                                || url.query().is_some()
                                || url.fragment().is_some()
                            {
                                errors.push(issue("custom", &path));
                            }
                        } else if name == "project" {
                            let mut chars = value.chars();
                            if !matches!(chars.next(), Some('A'..='Z'))
                                || !chars.all(|c| {
                                    c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'
                                })
                            {
                                errors.push(issue("invalid_format", &path));
                            }
                        } else if !valid_env_reference(value) {
                            errors.push(issue("invalid_format", &path));
                        }
                    }
                }
                errors.extend(strict_fields(
                    tracker,
                    &[
                        "kind",
                        "site",
                        "project",
                        "emailEnvironment",
                        "tokenEnvironment",
                    ],
                    &format!("{prefix}.tracker"),
                ));
            }
            _ => errors.push(issue("invalid_union", &format!("{prefix}.tracker"))),
        }
    }
    errors.extend(strict_fields(fields, &["repository", "tracker"], prefix));
    Ok(errors)
}
pub fn parse_create(input: Option<&Value>) -> ContractResult<ProjectCreateBody> {
    let Some(input) = input else {
        return Err(ContractFailure::Issues(vec![finding("invalid_union", &[])]));
    };
    let nested = || -> ContractResult<()> {
        let Some(fields) = input.as_object() else {
            return Ok(());
        };
        if let Some(value) = fields.get("integration") {
            parse_integration(Some(value))?;
        }
        if let Some(value) = fields.get("execution") {
            parse_execution(Some(value))?;
        }
        if let Some(value) = fields.get("agentTaskPolicy") {
            parse_agent_policy(Some(value))?;
        }
        if let Some(value) = fields
            .get("providerPolicy")
            .filter(|value| !value.is_null())
        {
            parse_provider_policy(Some(value))?;
        }
        Ok(())
    };
    if let Ok(value) = serde_json::from_value::<ExistingRepositoryCreate>(input.clone())
        && value.validate().is_ok()
    {
        match nested() {
            Ok(()) => return Ok(ProjectCreateBody::ExistingRepository(value)),
            Err(ContractFailure::Unhandled) => return Err(ContractFailure::Unhandled),
            Err(_) => {}
        }
    }
    if let Ok(value) = serde_json::from_value::<NewRepositoryCreate>(input.clone())
        && value.validate().is_ok()
    {
        match nested() {
            Ok(()) => return Ok(ProjectCreateBody::NewRepository(value)),
            Err(ContractFailure::Unhandled) => return Err(ContractFailure::Unhandled),
            Err(_) => {}
        }
    }
    if let Ok(value) = serde_json::from_value::<LocalProjectCreate>(input.clone())
        && value.validate().is_ok()
    {
        match nested() {
            Ok(()) => return Ok(ProjectCreateBody::Local(Box::new(value))),
            Err(ContractFailure::Unhandled) => return Err(ContractFailure::Unhandled),
            Err(_) => {}
        }
    }
    Err(ContractFailure::Issues(vec![finding("invalid_union", &[])]))
}
pub fn parse_integration(input: Option<&Value>) -> ContractResult<ProjectIntegration> {
    let fields = object(input)?;
    checked(
        &Value::Object(fields.clone()),
        integration_errors(fields, "")?,
    )
}
pub fn parse_execution(input: Option<&Value>) -> ContractResult<ProjectExecution> {
    let fields = object(input)?;
    let mut errors = Vec::new();
    errors.extend(typed_string(fields, "instructions", ".instructions", false));
    if let Some(directories) = fields.get("skillDirectories") {
        if let Value::Array(directories) = directories {
            for (index, directory) in directories.iter().enumerate() {
                let path = format!(".skillDirectories.{index}");
                match directory.as_str() {
                    Some("") => errors.push(issue("too_small", &path)),
                    None => errors.push(issue("invalid_type", &path)),
                    _ => {}
                }
            }
            if directories.len() > 50 {
                errors.push(issue("too_big", ".skillDirectories"));
            }
        } else {
            errors.push(issue("invalid_type", ".skillDirectories"));
        }
    }
    if let Some(environment) = fields.get("environment") {
        if let Value::Object(environment) = environment {
            for (key, value) in environment {
                let path = format!(".environment.{key}");
                let mut chars = key.chars();
                let valid_key = chars
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                    && ![
                        "HOME",
                        "PATH",
                        "CLAUDE",
                        "ANTHROPIC",
                        "AWS",
                        "GOOGLE",
                        "AZURE",
                        "SUPLEX",
                    ]
                    .iter()
                    .any(|prefix| key.starts_with(prefix));
                if !valid_key {
                    errors.push(issue("invalid_key", &path));
                }
                if !value.is_string() {
                    errors.push(issue("invalid_type", &path));
                }
            }
        } else {
            errors.push(issue("invalid_type", ".environment"));
        }
    }
    if let Some(mcp) = fields.get("mcp") {
        errors.extend(mcp_errors(mcp));
    }
    errors.extend(strict_fields(
        fields,
        &["instructions", "skillDirectories", "environment", "mcp"],
        ".",
    ));
    checked(&Value::Object(fields.clone()), errors)
}
pub fn parse_agent_policy(input: Option<&Value>) -> ContractResult<ProjectAgentTaskPolicy> {
    let fields = object(input)?;
    let mut errors = Vec::new();
    for name in ["workflowIds"] {
        if let Some(value) = fields.get(name) {
            errors.extend(profile_array_errors(value, &format!(".{name}")));
        } else {
            errors.push(issue("invalid_type", &format!(".{name}")));
        }
    }
    errors.extend(typed_string(
        fields,
        "defaultWorkflowId",
        ".defaultWorkflowId",
        true,
    ));
    for name in ["rootProfileIds", "workerProfileIds"] {
        if let Some(value) = fields.get(name) {
            errors.extend(profile_array_errors(value, &format!(".{name}")));
        } else {
            errors.push(issue("invalid_type", &format!(".{name}")));
        }
    }
    if let Some(value) = fields.get("advisorProfileIds") {
        if let Some(advisors) = value.as_object() {
            for name in ["reviewer", "planner_a", "planner_b", "rater"] {
                if let Some(value) = advisors.get(name) {
                    errors.extend(profile_array_errors(
                        value,
                        &format!(".advisorProfileIds.{name}"),
                    ));
                }
            }
        } else {
            errors.push(issue("invalid_type", ".advisorProfileIds"));
        }
    }
    for (name, valid) in [
        (
            "deliveryTarget",
            valid_delivery_target as fn(&str, &()) -> garde::Result,
        ),
        ("visualEvidence", valid_visual_evidence),
    ] {
        if let Some(value) = fields.get(name).and_then(Value::as_str)
            && valid(value, &()).is_err()
        {
            errors.push(issue("invalid_value", &format!(".{name}")));
        }
    }
    errors.extend(strict_fields(
        fields,
        &[
            "workflowIds",
            "defaultWorkflowId",
            "templateIds",
            "rootProfileIds",
            "workerProfileIds",
            "advisorProfileIds",
            "deliveryTarget",
            "runProjectTests",
            "visualEvidence",
        ],
        ".",
    ));
    checked(&Value::Object(fields.clone()), errors).map_err(|failure| match failure {
        ContractFailure::Issues(mut findings) => {
            findings.sort_by_key(|finding| {
                let field = finding["field"].as_str().unwrap_or("");
                [
                    ".workflowIds",
                    ".defaultWorkflowId",
                    ".templateIds",
                    ".rootProfileIds",
                    ".workerProfileIds",
                    ".advisorProfileIds",
                    ".deliveryTarget",
                    ".runProjectTests",
                    ".visualEvidence",
                    ".",
                ]
                .iter()
                .position(|prefix| {
                    field == *prefix
                        || (field.starts_with(prefix)
                            && field.as_bytes().get(prefix.len()) == Some(&b'.'))
                })
                .unwrap_or(10)
            });
            ContractFailure::Issues(findings)
        }
        other => other,
    })
}
pub fn parse_provider_policy(input: Option<&Value>) -> ContractResult<ProjectProviderPolicy> {
    let fields = object(input)?;
    let mut errors = typed_array(fields, "allowedProviders", ".allowedProviders", true);
    errors.extend(typed_array(
        fields,
        "allowedInstanceIds",
        ".allowedInstanceIds",
        true,
    ));
    errors.extend(strict_fields(
        fields,
        &["allowedProviders", "allowedInstanceIds"],
        ".",
    ));
    checked(&Value::Object(fields.clone()), errors)
}

/// `ProjectPatchBodySchema` output: only the fields the caller sent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub integration: Option<ProjectIntegration>,
    /// Present execution fields without defaults; the service merges them.
    pub execution: Option<serde_json::Map<String, Value>>,
    pub name: Option<String>,
    pub repository_path: Option<String>,
    pub worktree_root: Option<String>,
    pub repository: Option<String>,
    pub base_branch: Option<String>,
    pub setup_command: Option<String>,
    pub verification_command: Option<String>,
    pub root_profile_id: Option<String>,
    pub worker_profile_id: Option<String>,
    pub agent_task_policy: Option<ProjectAgentTaskPolicy>,
    #[serde(default, deserialize_with = "present_nullable")]
    pub provider_policy: Option<Option<ProjectProviderPolicy>>,
}

fn nested_integration(input: Option<&Value>) -> ContractResult<Value> {
    serialized(parse_integration(input))
}
fn nested_execution(input: Option<&Value>) -> ContractResult<Value> {
    serialized(parse_execution(input))
}
/// The patch execution schema has no defaults: keep only the sent fields.
fn nested_execution_patch(input: Option<&Value>) -> ContractResult<Value> {
    let Value::Object(mut parsed) = nested_execution(input)? else {
        return Err(ContractFailure::Unhandled);
    };
    let sent = input.and_then(Value::as_object);
    parsed.retain(|name, _| sent.is_some_and(|sent| sent.contains_key(name)));
    Ok(Value::Object(parsed))
}
fn nested_agent_policy(input: Option<&Value>) -> ContractResult<Value> {
    serialized(parse_agent_policy(input))
}
/// Garde reports the policy fields out of shape order; Zod reports providers first.
fn nested_provider_policy(input: Option<&Value>) -> ContractResult<Value> {
    serialized(parse_provider_policy(input)).map_err(|failure| match failure {
        ContractFailure::Issues(mut findings) => {
            findings.sort_by_key(|finding| {
                finding["field"]
                    .as_str()
                    .is_some_and(|field| field.starts_with(".allowedInstanceIds"))
            });
            ContractFailure::Issues(findings)
        }
        other => other,
    })
}

const REQUIRED_TEXT: Rule = Rule::Text {
    trim: false,
    min: 1,
    max: None,
};
const COMMAND: Rule = Rule::Text {
    trim: false,
    min: 0,
    max: None,
};

const fn text(name: &'static str, rule: Rule, required: bool) -> Field {
    Field {
        required,
        ..optional(name, rule)
    }
}

const fn project_fields(execution: Rule, required: bool) -> [Field; 13] {
    [
        optional("integration", Rule::Nested(nested_integration)),
        optional("execution", execution),
        text("name", REQUIRED_TEXT, required),
        text("repositoryPath", REQUIRED_TEXT, required),
        text("worktreeRoot", REQUIRED_TEXT, required),
        text("repository", REQUIRED_TEXT, required),
        text("baseBranch", REQUIRED_TEXT, required),
        text("setupCommand", COMMAND, required),
        text("verificationCommand", COMMAND, required),
        text("rootProfileId", REQUIRED_TEXT, required),
        text("workerProfileId", REQUIRED_TEXT, required),
        optional("agentTaskPolicy", Rule::Nested(nested_agent_policy)),
        Field {
            nullable: true,
            ..optional("providerPolicy", Rule::Nested(nested_provider_policy))
        },
    ]
}
const BODY: [Field; 13] = project_fields(Rule::Nested(nested_execution), true);
const PATCH: [Field; 13] = project_fields(Rule::Nested(nested_execution_patch), false);

fn patch_value(input: Option<&Value>) -> ContractResult<serde_json::Map<String, Value>> {
    let value = parse_object(input, &PATCH, true)?;
    if value.is_empty() {
        return Err(ContractFailure::Issues(vec![issue("custom", ".")]));
    }
    Ok(value)
}

fn typed<T: serde::de::DeserializeOwned>(
    value: serde_json::Map<String, Value>,
) -> ContractResult<T> {
    serde_json::from_value(Value::Object(value))
        .map_err(|error| ContractFailure::Internal(error.to_string()))
}

/// `ProjectBodySchema`: the full project configuration.
pub fn parse_body(input: Option<&Value>) -> ContractResult<LocalProjectCreate> {
    typed(parse_object(input, &BODY, true)?)
}

/// `ProjectPatchBodySchema`: at least one project field.
pub fn parse_patch(input: Option<&Value>) -> ContractResult<ProjectPatch> {
    typed(patch_value(input)?)
}

pub fn validate(contract: &str, input: Option<&Value>) -> Option<ContractResult<Value>> {
    Some(match contract {
        "projects.ProjectBodySchema" => parse_object(input, &BODY, true).map(Value::Object),
        "projects.ProjectPatchBodySchema" => patch_value(input).map(Value::Object),
        "projects.ProjectCreateBodySchema" => serialized(parse_create(input)),
        "projects.ProjectIntegrationSchema" => serialized(parse_integration(input)),
        "projects.ProjectExecutionSchema" => serialized(parse_execution(input)),
        "projects.ProjectAgentTaskPolicySchema" => serialized(parse_agent_policy(input)),
        "projects.ProjectProviderPolicySchema" => serialized(parse_provider_policy(input)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    type FixtureParser = fn(Value) -> Result<Value, serde_json::Error>;

    #[test]
    fn optional_create_fields_reject_explicit_null() {
        let local = serde_json::json!({
            "name":"x","repositoryPath":"/repo","worktreeRoot":"/work",
            "repository":"o/r","baseBranch":"main","setupCommand":"",
            "verificationCommand":"","rootProfileId":"r","workerProfileId":"w"
        });
        for (base, field) in [
            (serde_json::json!({"repositoryUrl":"x"}), "integration"),
            (serde_json::json!({"repositoryUrl":"x"}), "baseBranch"),
            (serde_json::json!({"repositoryName":"x"}), "integration"),
            (local.clone(), "integration"),
            (local.clone(), "execution"),
            (local, "agentTaskPolicy"),
        ] {
            let mut input = base;
            input[field] = Value::Null;
            match parse_create(Some(&input)) {
                Err(ContractFailure::Issues(findings)) => {
                    assert_eq!(findings, vec![issue("invalid_union", ".")]);
                }
                other => panic!("{field} null was accepted: {other:?}"),
            }
        }
    }

    #[test]
    fn serde_dtos_project_all_accepted_project_request_fixtures() {
        let contracts: [(&str, FixtureParser); 5] = [
            ("projects.ProjectCreateBodySchema", |value| {
                serde_json::from_value::<ProjectCreateBody>(value).and_then(serde_json::to_value)
            }),
            ("projects.ProjectIntegrationSchema", |value| {
                serde_json::from_value::<ProjectIntegration>(value).and_then(serde_json::to_value)
            }),
            ("projects.ProjectExecutionSchema", |value| {
                serde_json::from_value::<ProjectExecution>(value).and_then(serde_json::to_value)
            }),
            ("projects.ProjectAgentTaskPolicySchema", |value| {
                serde_json::from_value::<ProjectAgentTaskPolicy>(value)
                    .and_then(serde_json::to_value)
            }),
            ("projects.ProjectProviderPolicySchema", |value| {
                serde_json::from_value::<ProjectProviderPolicy>(value)
                    .and_then(serde_json::to_value)
            }),
        ];
        for (contract, project) in contracts {
            let directory = format!("{}/../tests/parity/{contract}", env!("CARGO_MANIFEST_DIR"));
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                let fixture: Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                if fixture["expected"]["accepted"] == true {
                    let actual = project(fixture["input"].clone())
                        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
                    assert_eq!(actual, fixture["expected"]["value"], "{}", path.display());
                }
            }
        }
    }
}
