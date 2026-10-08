//! Project, profile, and provider request contracts (`projects.ts`,
//! `providers.ts`, and the stored project schemas).

use crate::tasks::control::DeliveryTarget;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

pub use super::ContractResult;
use super::{
    Contract, ContractFailure, Fields, MAX, Parse, choice, fail, flag, formatted, int, list,
    nested, nullable, one_of, params, present, rule, tagged, tasks::VISUAL_EVIDENCE, text, trimmed,
    union, url,
};
pub use crate::profiles::agent_profiles::{
    ProfileInput as ProfileBody, ProfilePatch as ProfilePatchBody,
};

pub(crate) const HARNESSES: &[&str] = &["opencode", "claude-code", "devin", "codex"];
const ADVISOR_ROLES: [&str; 4] = ["reviewer", "planner_a", "planner_b", "rater"];

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
        #[ts(optional)]
        username_environment: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
    Linear {
        team: String,
        #[serde(rename = "tokenEnvironment")]
        token_environment: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: IndexMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: IndexMap<String, String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct McpGrants {
    pub root: Vec<String>,
    pub advisor: Vec<String>,
    pub worker: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct McpServer {
    pub name: String,
    pub transport: McpTransport,
    pub grants: McpGrants,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectExecution {
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub skill_directories: Vec<String>,
    #[serde(default)]
    pub environment: IndexMap<String, String>,
    #[serde(default)]
    pub mcp: Vec<McpServer>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorProfilePolicy {
    #[serde(default)]
    pub reviewer: Vec<String>,
    #[serde(default, rename = "planner_a")]
    pub planner_a: Vec<String>,
    #[serde(default, rename = "planner_b")]
    pub planner_b: Vec<String>,
    #[serde(default)]
    pub rater: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAgentTaskPolicy {
    pub workflow_ids: Vec<String>,
    pub default_workflow_id: String,
    #[serde(default)]
    pub template_ids: Vec<String>,
    pub root_profile_ids: Vec<String>,
    pub worker_profile_ids: Vec<String>,
    #[serde(default)]
    pub advisor_profile_ids: AdvisorProfilePolicy,
    #[serde(default = "default_delivery_target")]
    pub delivery_target: DeliveryTarget,
    #[serde(default = "default_run_project_tests")]
    pub run_project_tests: bool,
    #[serde(default = "default_visual_evidence")]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExistingRepositoryCreate {
    pub repository_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration: Option<ProjectIntegration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewRepositoryCreate {
    pub repository_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration: Option<ProjectIntegration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalProjectCreate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration: Option<ProjectIntegration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ProjectExecution>,
    pub name: String,
    pub repository_path: String,
    pub worktree_root: String,
    pub repository: String,
    pub base_branch: String,
    pub setup_command: String,
    pub verification_command: String,
    pub root_profile_id: String,
    pub worker_profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_task_policy: Option<ProjectAgentTaskPolicy>,
    #[serde(
        default,
        deserialize_with = "super::present_nullable",
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
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectResponse {
    pub repository_settings: Option<crate::projects::repository_settings::RepositorySettings>,
    pub alt_profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub integration: Option<ProjectIntegration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub execution: Option<ProjectExecution>,
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub repository_path: String,
    pub worktree_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository: Option<String>,
    pub base_branch: String,
    pub setup_command: String,
    pub verification_command: String,
    pub root_profile_id: String,
    pub worker_profile_id: String,
    pub agent_task_policy: ProjectAgentTaskPolicy,
    pub provider_policy: Option<ProjectProviderPolicy>,
    /// The most tasks that run at one time; `None` means no limit.
    pub task_concurrency: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// `ProjectPatchBodySchema` output: only the fields the caller sent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub alt_profile_id: Option<String>,
    pub integration: Option<ProjectIntegration>,
    /// Present execution fields without defaults; the service merges them.
    pub execution: Option<Map<String, Value>>,
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
    #[serde(default, deserialize_with = "super::present_nullable")]
    pub provider_policy: Option<Option<ProjectProviderPolicy>>,
    #[serde(default, deserialize_with = "super::present_nullable")]
    pub task_concurrency: Option<Option<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdParams {
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSourceQuery {
    pub kind: String,
}

/// `includeArchived=true` for the profile and workflow lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeArchivedQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_archived: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInstanceCreateBody {
    pub provider: String,
    pub label: String,
}

fn environment_reference(value: &str, _: &()) -> garde::Result {
    let mut chars = value.chars();
    rule(
        chars.next().is_some_and(|c| c.is_ascii_uppercase())
            && value.len() <= 128
            && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
        "invalid_format",
    )
}

fn identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn environment_value(value: &str, _: &()) -> garde::Result {
    rule(identifier(value), "invalid_format")
}

fn tool_name(value: &str, _: &()) -> garde::Result {
    rule(
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
        "invalid_format",
    )
}

fn server_name(value: &str, _: &()) -> garde::Result {
    tool_name(value, &())?;
    rule(!value.starts_with("suplex_"), "custom")
}

fn tracker_repository(value: &str, _: &()) -> garde::Result {
    let parts = value.split('/').collect::<Vec<_>>();
    rule(
        parts.len() == 2
            && parts.iter().all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
            }),
        "invalid_format",
    )
}

fn jira_project(value: &str, _: &()) -> garde::Result {
    let mut chars = value.chars();
    rule(
        chars.next().is_some_and(|c| c.is_ascii_uppercase())
            && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
        "invalid_format",
    )
}

fn linear_team(value: &str, _: &()) -> garde::Result {
    jira_project(value, &())
}

/// A Jira Cloud site; `new URL` in the refinement throws on a malformed one.
fn jira_site(input: Option<&Value>) -> ContractResult<Value> {
    let site = text(0, MAX)(input)?;
    let parsed = url::Url::parse(site.as_str().unwrap_or_default())
        .map_err(|_| ContractFailure::Unhandled)?;
    let host = parsed.host_str().unwrap_or_default();
    let tenant = host.strip_suffix(".atlassian.net").unwrap_or_default();
    if parsed.scheme() == "https"
        && !tenant.is_empty()
        && tenant
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.path() == "/"
        && parsed.query().is_none()
        && parsed.fragment().is_none()
    {
        Ok(site)
    } else {
        fail("custom")
    }
}

/// `ProjectIntegrationSchema`.
impl Contract for ProjectIntegration {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .or("repository", json!({"kind": "github"}), |input| {
                tagged(input, "kind", |kind| {
                    let fields = Fields::new(input).ok()?.req("kind", present);
                    Some(match kind.as_str()? {
                        "github" => fields.strict(),
                        "bitbucket" => fields
                            .req("tokenEnvironment", formatted(0, MAX, environment_reference))
                            .opt(
                                "usernameEnvironment",
                                formatted(0, MAX, environment_reference),
                            )
                            .strict(),
                        _ => return None,
                    })
                })
            })
            .or("tracker", Value::Null, nullable(tracker))
            .strict()
    }
}

fn tracker(input: Option<&Value>) -> ContractResult<Value> {
    tagged(input, "kind", |kind| {
        let fields = Fields::new(input).ok()?.req("kind", present);
        let reference = formatted(0, MAX, environment_reference);
        Some(match kind.as_str()? {
            "github" => fields
                .req("repository", formatted(0, MAX, tracker_repository))
                .strict(),
            "jira" => fields
                .req("site", jira_site)
                .req("project", formatted(0, MAX, jira_project))
                .req("emailEnvironment", reference)
                .req("tokenEnvironment", reference)
                .strict(),
            "linear" => fields
                .req("team", formatted(0, MAX, linear_team))
                .req("tokenEnvironment", reference)
                .strict(),
            _ => return None,
        })
    })
}

fn environment_key(key: &str) -> bool {
    identifier(key)
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
        .any(|prefix| key.starts_with(prefix))
}

/// `ProjectMcpSchema`: loose server objects with unique names.
fn mcp(input: Option<&Value>) -> ContractResult<Value> {
    let tools = list(formatted(0, MAX, tool_name), 0, MAX);
    let references = super::record(
        |_| true,
        "invalid_key",
        formatted(0, MAX, environment_value),
    );
    let servers = list(
        |input| {
            Fields::new(input)?
                .req("name", formatted(0, MAX, server_name))
                .req("transport", |input| {
                    tagged(input, "type", |kind| {
                        let fields = Fields::new(input).ok()?.req("type", present);
                        Some(match kind.as_str()? {
                            "stdio" => fields
                                .req("command", text(1, MAX))
                                .or("args", json!([]), list(text(0, MAX), 0, MAX))
                                .or("env", json!({}), references)
                                .finish(),
                            "http" => fields
                                .req("url", formatted(0, MAX, url))
                                .or("headers", json!({}), references)
                                .finish(),
                            _ => return None,
                        })
                    })
                })
                .req("grants", |input| {
                    Fields::new(input)?
                        .req("root", tools)
                        .req("advisor", tools)
                        .req("worker", tools)
                        .finish()
                })
                .finish()
        },
        0,
        MAX,
    )(input)?;
    let names = servers
        .as_array()
        .into_iter()
        .flatten()
        .map(|server| &server["name"])
        .collect::<std::collections::HashSet<_>>();
    if names.len() == servers.as_array().map_or(0, Vec::len) {
        Ok(servers)
    } else {
        fail("custom")
    }
}

fn execution_fields(input: Option<&Value>, defaults: bool) -> ContractResult<Value> {
    let parsers: [(&'static str, Value, Parse); 4] = [
        ("instructions", json!(""), &text(0, MAX)),
        ("skillDirectories", json!([]), &list(text(1, MAX), 0, 50)),
        (
            "environment",
            json!({}),
            &super::record(environment_key, "invalid_key", text(0, MAX)),
        ),
        ("mcp", json!([]), &mcp),
    ];
    parsers
        .into_iter()
        .fold(Fields::new(input)?, |fields, (name, default, parse)| {
            if defaults {
                fields.or(name, default, parse)
            } else {
                fields.opt(name, parse)
            }
        })
        .strict()
}

/// `ProjectExecutionSchema`.
impl Contract for ProjectExecution {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        execution_fields(input, true)
    }
}

fn profile_ids(min: usize) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    list(text(1, 256), min, MAX)
}

/// `ProjectAgentTaskPolicySchema`.
impl Contract for ProjectAgentTaskPolicy {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let advisors = |input: Option<&Value>| {
            ADVISOR_ROLES
                .into_iter()
                .fold(Fields::new(input)?, |fields, role| {
                    fields.or(role, json!([]), profile_ids(0))
                })
                .finish()
        };
        Fields::new(input)?
            .req("workflowIds", profile_ids(1))
            .req("defaultWorkflowId", text(1, 256))
            .or("templateIds", json!([]), profile_ids(0))
            .req("rootProfileIds", profile_ids(1))
            .req("workerProfileIds", profile_ids(1))
            .or(
                "advisorProfileIds",
                json!({"reviewer": [], "planner_a": [], "planner_b": [], "rater": []}),
                advisors,
            )
            .or(
                "deliveryTarget",
                json!("pull_request_draft"),
                choice::<DeliveryTarget>,
            )
            .or("runProjectTests", json!(true), flag)
            .or("visualEvidence", json!("off"), one_of(VISUAL_EVIDENCE))
            .strict()
    }
}

/// `ProjectProviderPolicySchema`.
impl Contract for ProjectProviderPolicy {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("allowedProviders", list(one_of(HARNESSES), 0, MAX))
            .req("allowedInstanceIds", list(text(1, MAX), 0, MAX))
            .strict()
    }
}

pub fn parse_integration(input: Option<&Value>) -> ContractResult<ProjectIntegration> {
    ProjectIntegration::parse(input)
}
pub fn parse_execution(input: Option<&Value>) -> ContractResult<ProjectExecution> {
    ProjectExecution::parse(input)
}
pub fn parse_agent_policy(input: Option<&Value>) -> ContractResult<ProjectAgentTaskPolicy> {
    ProjectAgentTaskPolicy::parse(input)
}
pub fn parse_provider_policy(input: Option<&Value>) -> ContractResult<ProjectProviderPolicy> {
    ProjectProviderPolicy::parse(input)
}

/// `ProjectBodySchema` or, without defaults and required fields, the patch.
fn project_fields(input: Option<&Value>, patch: bool) -> ContractResult<Fields<'_>> {
    let required = !patch;
    let mut fields = Fields::new(input)?
        .opt("integration", nested::<ProjectIntegration>)
        .opt("execution", |input| execution_fields(input, required));
    for (name, min) in [
        ("name", 1),
        ("repositoryPath", 1),
        ("worktreeRoot", 1),
        ("repository", 1),
        ("baseBranch", 1),
        ("setupCommand", 0),
        ("verificationCommand", 0),
        ("rootProfileId", 1),
        ("workerProfileId", 1),
    ] {
        fields = if required {
            fields.req(name, text(min, MAX))
        } else {
            fields.opt(name, text(min, MAX))
        };
    }
    Ok(fields
        .opt("altProfileId", text(1, MAX))
        .opt("agentTaskPolicy", nested::<ProjectAgentTaskPolicy>)
        .opt("providerPolicy", nullable(nested::<ProjectProviderPolicy>)))
}

impl Contract for LocalProjectCreate {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        project_fields(input, false)?.strict()
    }
}

/// At least one project field.
impl Contract for ProjectPatch {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let mut fields =
            project_fields(input, true)?.opt("taskConcurrency", nullable(int(1.0, f64::MAX)));
        fields.strict_keys();
        if fields.refinable() && input.and_then(Value::as_object).is_some_and(Map::is_empty) {
            fields.fail("custom", ".");
        }
        fields.finish()
    }
}

fn repository_fields(fields: Fields) -> ContractResult<Value> {
    fields
        .opt("integration", nested::<ProjectIntegration>)
        .opt("baseBranch", text(1, MAX))
        .strict()
}

impl Contract for ExistingRepositoryCreate {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        repository_fields(Fields::new(input)?.req("repositoryUrl", text(1, MAX)))
    }
}

impl Contract for NewRepositoryCreate {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        repository_fields(Fields::new(input)?.req("repositoryName", text(1, 200)))
    }
}

impl Contract for ProjectCreateBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        union(
            input,
            &[
                &nested::<ExistingRepositoryCreate>,
                &nested::<NewRepositoryCreate>,
                &nested::<LocalProjectCreate>,
            ],
        )
    }
}

impl Contract for ProjectIdParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["projectId"], (1, 256))
    }
}

/// The issue search query, at most 200 UTF-16 units.
#[derive(Debug, Clone, Deserialize)]
pub struct IssueSearchQuery {
    pub query: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecentRepositoriesQuery {
    pub page: u32,
}

impl Contract for RecentRepositoriesQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let mut input = input.cloned().unwrap_or_else(|| json!({}));
        if let Some(page) = input.get_mut("page")
            && let Some(number) = page.as_str().and_then(|value| value.parse::<u32>().ok())
        {
            *page = json!(number);
        }
        Fields::new(Some(&input))?
            .or("page", json!(1), int(1.0, f64::from(u32::MAX) - 1.0))
            .finish()
    }
}

#[cfg(test)]
mod recent_repository_query_tests {
    use super::*;

    #[test]
    fn page_defaults_and_validates_positive_integers() {
        assert_eq!(
            RecentRepositoriesQuery::schema(Some(&json!({}))).unwrap()["page"],
            1
        );
        assert_eq!(
            RecentRepositoriesQuery::schema(Some(&json!({"page":"2"}))).unwrap()["page"],
            2
        );
        for page in ["0", "-1", "1.5", "bad", "4294967295"] {
            assert!(
                RecentRepositoriesQuery::schema(Some(&json!({"page":page}))).is_err(),
                "{page}"
            );
        }
    }
}

impl Contract for IssueSearchQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .or("query", json!(""), text(0, 200))
            .finish()
    }
}

/// A company id and a GitHub owner login.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerParams {
    pub company_id: String,
    pub owner: String,
}

fn github_owner(value: &str, _: &()) -> garde::Result {
    rule(
        value.len() <= 39
            && value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && value
                .bytes()
                .skip(1)
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
        "invalid_format",
    )
}

impl Contract for OwnerParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("companyId", text(1, 256))
            .req("owner", formatted(0, MAX, github_owner))
            .finish()
    }
}

impl Contract for TaskSourceQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("kind", one_of(&["pull_request", "issue", "branch"]))
            .finish()
    }
}

impl Contract for IncludeArchivedQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("includeArchived", one_of(&["true"]))
            .strict()
    }
}

/// A native provider: `{ providerId }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderParams {
    pub provider_id: String,
}

impl Contract for ProviderParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("providerId", one_of(HARNESSES))
            .finish()
    }
}

impl Contract for ProviderInstanceCreateBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("provider", one_of(HARNESSES))
            .req("label", trimmed(1, 128))
            .finish()
    }
}

fn profile_fields(input: Option<&Value>, patch: bool) -> ContractResult<Fields<'_>> {
    fn model(value: &str, _: &()) -> garde::Result {
        let mut chars = value.chars();
        rule(
            chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
                && chars
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-')),
            "invalid_format",
        )
    }
    fn avatar(value: &str, _: &()) -> garde::Result {
        rule(
            value.len() == 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "invalid_format",
        )
    }
    // `providerInstanceId` is always optional; the order is the Zod shape's.
    let parsers: [(&'static str, bool, Parse); 8] = [
        ("provider", patch, &one_of(HARNESSES)),
        ("model", patch, &|input| {
            super::string(input, true, (1, 256), Some(model))
        }),
        (
            "reasoningLevel",
            patch,
            &one_of(&["low", "medium", "high", "xhigh", "max"]),
        ),
        ("serviceTier", patch, &one_of(&["default", "priority"])),
        ("providerInstanceId", true, &nullable(text(1, MAX))),
        ("name", patch, &trimmed(1, MAX)),
        ("role", patch, &one_of(&["root", "worker"])),
        ("avatarSeed", patch, &formatted(0, MAX, avatar)),
    ];
    Ok(parsers
        .into_iter()
        .fold(Fields::new(input)?, |fields, (name, optional, parse)| {
            if optional {
                fields.opt(name, parse)
            } else {
                fields.req(name, parse)
            }
        }))
}

/// `AgentProfileSchema`: a profile response keeps this shape and key order,
/// or the response fails.
pub fn profile_response(input: &Value) -> ContractResult<Value> {
    profile_fields(Some(input), false)?
        .req("id", text(0, MAX))
        .req("archivedAt", nullable(text(0, MAX)))
        .req("createdAt", text(0, MAX))
        .req("updatedAt", text(0, MAX))
        .finish()
}

impl Contract for ProfileBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        profile_fields(input, false)?.strict()
    }
}

impl Contract for ProfilePatchBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        profile_fields(input, true)?.opt("archived", flag).strict()
    }
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
            match ProjectCreateBody::parse(Some(&input)) {
                Err(ContractFailure::Issues(findings)) => {
                    assert_eq!(findings, vec![super::super::issue("invalid_union", ".")]);
                }
                other => panic!("{field} null was accepted: {other:?}"),
            }
        }
    }

    #[test]
    fn task_concurrency_patch_accepts_a_positive_integer_or_null() {
        let parse = |value: Value| {
            ProjectPatch::parse(Some(&serde_json::json!({ "taskConcurrency": value })))
                .map(|patch| patch.task_concurrency)
        };
        assert_eq!(parse(serde_json::json!(1)).unwrap(), Some(Some(1)));
        assert_eq!(parse(Value::Null).unwrap(), Some(None));
        for invalid in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("1"),
        ] {
            assert!(parse(invalid.clone()).is_err(), "{invalid} was accepted");
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
            let directory = format!(
                "{}/../../tests/parity/{contract}",
                env!("CARGO_MANIFEST_DIR")
            );
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
