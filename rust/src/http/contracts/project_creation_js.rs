use std::sync::LazyLock;

use serde_json::{Value, json};

use crate::shared::js_json::{self, JsDocument, JsNode};

use super::{DetailedJsParseResult, JsContractFailure, JsThrown};

type Path = Vec<Value>;
type NodeResult = Result<usize, IssueList>;

#[derive(Default)]
struct IssueList {
    values: Vec<Value>,
    metadata: Vec<IssueMeta>,
}

#[derive(Default)]
struct IssueMeta {
    raw_record_key: Option<Vec<u16>>,
    raw_strict_keys: Option<Vec<Vec<u16>>>,
    union_branches: Option<Vec<IssueList>>,
}

impl IssueList {
    fn new() -> Self {
        Self::default()
    }
    fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
    fn push(&mut self, value: Value) {
        self.values.push(value);
        self.metadata.push(IssueMeta::default());
    }
    fn push_record(&mut self, value: Value, key: &[u16]) {
        self.values.push(value);
        self.metadata.push(IssueMeta {
            raw_record_key: Some(key.to_vec()),
            ..IssueMeta::default()
        });
    }
    fn push_strict(&mut self, value: Value, keys: Vec<Vec<u16>>) {
        self.values.push(value);
        self.metadata.push(IssueMeta {
            raw_strict_keys: Some(keys),
            ..IssueMeta::default()
        });
    }
    fn mark_record(&mut self, key: &[u16]) {
        for meta in &mut self.metadata {
            meta.raw_record_key = Some(key.to_vec());
        }
    }
    fn extend(&mut self, other: Self) {
        self.values.extend(other.values);
        self.metadata.extend(other.metadata);
    }
    fn union(branches: Vec<Self>, path: &[Value]) -> Self {
        let values = branches
            .iter()
            .map(|branch| branch.values.clone())
            .collect::<Vec<_>>();
        Self {
            values: vec![
                json!({"code":"invalid_union", "errors":values, "path":path, "message":"Invalid input"}),
            ],
            metadata: vec![IssueMeta {
                union_branches: Some(branches),
                ..IssueMeta::default()
            }],
        }
    }
}

impl From<Vec<Value>> for IssueList {
    fn from(values: Vec<Value>) -> Self {
        let metadata = (0..values.len()).map(|_| IssueMeta::default()).collect();
        Self { values, metadata }
    }
}
static JIRA_PROJECT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Z][A-Z0-9_]*$").unwrap());
static JIRA_HOST: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-z0-9-]+\.atlassian\.net$").unwrap());
static ENVIRONMENT_KEY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap());
static TOOL_NAME: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());

pub(super) fn validate_detailed(
    contract: &str,
    input: Option<&JsDocument>,
) -> Option<DetailedJsParseResult> {
    if !matches!(
        contract,
        "projects.ProjectRepositoryBodySchema"
            | "projects.ProjectIntegrationSchema"
            | "projects.ProjectExecutionSchema"
            | "projects.ProjectProviderPolicySchema"
            | "projects.ProjectAgentTaskPolicySchema"
            | "projects.ProjectNewRepositoryBodySchema"
            | "projects.ProjectBodySchema"
            | "projects.ProjectPatchBodySchema"
            | "projects.ProjectCreateBodySchema"
            | "projects.ProjectResponseSchema"
            | "projects.ProjectListResponseSchema"
    ) {
        return None;
    }
    let Some(document) = input else {
        let invalid = json!({
            "expected":"object", "code":"invalid_type", "path":[],
            "message":"Invalid input: expected object, received undefined"
        });
        if contract == "projects.ProjectCreateBodySchema" {
            return Some(Err(JsContractFailure::Issues(issue_document(
                vec![json!({
                    "code":"invalid_union", "errors":[[invalid.clone()],[invalid.clone()],[invalid]],
                    "path":[], "message":"Invalid input"
                })].into(),
            ))));
        }
        return Some(Err(JsContractFailure::Issues(issue_document(
            vec![invalid].into(),
        ))));
    };
    let mut parser = Parser {
        source: document,
        output: document.clone(),
        thrown: None,
    };
    let root = document.root();
    let result = match contract {
        "projects.ProjectRepositoryBodySchema" => parser.repository_body(root, &[]),
        "projects.ProjectIntegrationSchema" => parser.integration(root, &[]),
        "projects.ProjectExecutionSchema" => parser.execution(root, &[], false),
        "projects.ProjectProviderPolicySchema" => parser.provider_policy(root, &[]),
        "projects.ProjectAgentTaskPolicySchema" => parser.agent_policy(root, &[]),
        "projects.ProjectNewRepositoryBodySchema" => parser.new_repository_body(root, &[]),
        "projects.ProjectBodySchema" => parser.project_body(root, &[], BodyMode::Full),
        "projects.ProjectPatchBodySchema" => parser.project_body(root, &[], BodyMode::Patch),
        "projects.ProjectCreateBodySchema" => parser.project_create(root, &[]),
        "projects.ProjectResponseSchema" => parser.project_body(root, &[], BodyMode::Response),
        "projects.ProjectListResponseSchema" => parser.project_list(root, &[]),
        _ => unreachable!(),
    };
    if let Some(thrown) = parser.thrown {
        return Some(Err(JsContractFailure::Thrown(thrown)));
    }
    Some(match result {
        Ok(root) => {
            parser.output.set_root(root);
            Ok(parser.output)
        }
        Err(issues) => Err(JsContractFailure::Issues(issue_document(issues))),
    })
}

struct Parser<'a> {
    source: &'a JsDocument,
    output: JsDocument,
    thrown: Option<JsThrown>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum BodyMode {
    Full,
    Patch,
    Response,
}

impl Parser<'_> {
    fn field(&self, object: usize, name: &str) -> Option<usize> {
        self.source.get(object, name)
    }

    fn object(&self, node: Option<usize>, path: &[Value]) -> Result<usize, IssueList> {
        match node {
            Some(index) if matches!(self.source.node(index), JsNode::Object(_)) => Ok(index),
            _ => Err(vec![self.invalid_type("object", node, path)].into()),
        }
    }

    fn invalid_type(&self, expected: &str, node: Option<usize>, path: &[Value]) -> Value {
        let received = node.map_or("undefined", |index| self.source.value_type(index));
        json!({
            "expected": expected,
            "code": "invalid_type",
            "path": path,
            "message": format!("Invalid input: expected {expected}, received {received}")
        })
    }

    fn string(
        &self,
        node: Option<usize>,
        path: &[Value],
        min: usize,
        max: Option<usize>,
    ) -> NodeResult {
        let Some(index) = node else {
            return Err(vec![self.invalid_type("string", None, path)].into());
        };
        let JsNode::String(value) = self.source.node(index) else {
            return Err(vec![self.invalid_type("string", node, path)].into());
        };
        let mut issues = IssueList::new();
        if value.len() < min {
            issues.push(json!({
                "origin": "string", "code": "too_small", "minimum": min,
                "inclusive": true, "path": path,
                "message": format!("Too small: expected string to have >={min} characters")
            }));
        }
        if let Some(max) = max
            && value.len() > max
        {
            issues.push(json!({
                "origin": "string", "code": "too_big", "maximum": max,
                "inclusive": true, "path": path,
                "message": format!("Too big: expected string to have <={max} characters")
            }));
        }
        if issues.is_empty() {
            Ok(index)
        } else {
            Err(issues)
        }
    }

    fn strict(&self, object: usize, path: &[Value], known: &[&str]) -> IssueList {
        let JsNode::Object(fields) = self.source.node(object) else {
            return IssueList::new();
        };
        let raw = fields
            .iter()
            .filter(|(key, _)| {
                !known
                    .iter()
                    .any(|name| key.iter().copied().eq(name.encode_utf16()))
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        if raw.is_empty() {
            return IssueList::new();
        }
        let unknown = raw
            .iter()
            .map(|key| String::from_utf16_lossy(key))
            .collect::<Vec<_>>();
        let quoted = unknown
            .iter()
            .map(|name| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let mut issues = IssueList::new();
        issues.push_strict(json!({
            "code": "unrecognized_keys", "keys": unknown, "path": path,
            "message": format!("Unrecognized key{}: {quoted}", if unknown.len() == 1 { "" } else { "s" })
        }), raw);
        issues
    }

    fn object_node(&mut self, fields: Vec<(&str, usize)>) -> usize {
        self.output.append_node(JsNode::Object(
            fields
                .into_iter()
                .map(|(name, index)| (name.encode_utf16().collect(), index))
                .collect(),
        ))
    }

    fn required_string(
        &self,
        object: usize,
        name: &'static str,
        path: &[Value],
        bounds: (usize, Option<usize>),
        output: &mut Vec<(&'static str, usize)>,
        issues: &mut IssueList,
    ) {
        let field_path = child(path, name);
        match self.string(self.field(object, name), &field_path, bounds.0, bounds.1) {
            Ok(value) => output.push((name, value)),
            Err(error) => issues.extend(error),
        }
    }

    fn repository_body(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        self.required_string(
            object,
            "repositoryUrl",
            path,
            (1, None),
            &mut fields,
            &mut issues,
        );
        if let Some(integration) = self.field(object, "integration") {
            match self.integration(integration, &child(path, "integration")) {
                Ok(value) => fields.push(("integration", value)),
                Err(error) => issues.extend(error),
            }
        }
        if self.field(object, "baseBranch").is_some() {
            self.required_string(
                object,
                "baseBranch",
                path,
                (1, None),
                &mut fields,
                &mut issues,
            );
        }
        issues.extend(self.strict(
            object,
            path,
            &["repositoryUrl", "integration", "baseBranch"],
        ));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn new_repository_body(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        self.required_string(
            object,
            "repositoryName",
            path,
            (1, Some(200)),
            &mut fields,
            &mut issues,
        );
        if let Some(integration) = self.field(object, "integration") {
            match self.integration(integration, &child(path, "integration")) {
                Ok(value) => fields.push(("integration", value)),
                Err(error) => issues.extend(error),
            }
        }
        if self.field(object, "baseBranch").is_some() {
            self.required_string(
                object,
                "baseBranch",
                path,
                (1, None),
                &mut fields,
                &mut issues,
            );
        }
        issues.extend(self.strict(
            object,
            path,
            &["repositoryName", "integration", "baseBranch"],
        ));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn project_body(&mut self, node: usize, path: &[Value], mode: BodyMode) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        if let Some(value) = self.field(object, "integration") {
            match self.integration(value, &child(path, "integration")) {
                Ok(value) => fields.push(("integration", value)),
                Err(error) => issues.extend(error),
            }
        }
        if let Some(value) = self.field(object, "execution") {
            match self.execution(value, &child(path, "execution"), mode == BodyMode::Patch) {
                Ok(value) => fields.push(("execution", value)),
                Err(error) => issues.extend(error),
            }
        }
        for name in [
            "name",
            "repositoryPath",
            "worktreeRoot",
            "repository",
            "baseBranch",
            "setupCommand",
            "verificationCommand",
            "rootProfileId",
            "workerProfileId",
        ] {
            let optional =
                mode == BodyMode::Patch || (mode == BodyMode::Response && name == "repository");
            if optional && self.field(object, name).is_none() {
                continue;
            }
            let minimum = if matches!(name, "setupCommand" | "verificationCommand")
                || (mode == BodyMode::Response && name == "repository")
            {
                0
            } else {
                1
            };
            match self.string(self.field(object, name), &child(path, name), minimum, None) {
                Ok(value) => fields.push((name, value)),
                Err(error) => issues.extend(error),
            }
        }
        if let Some(value) = self.field(object, "agentTaskPolicy") {
            match self.agent_policy(value, &child(path, "agentTaskPolicy")) {
                Ok(value) => fields.push(("agentTaskPolicy", value)),
                Err(error) => issues.extend(error),
            }
        }
        if let Some(value) = self.field(object, "providerPolicy") {
            if matches!(self.source.node(value), JsNode::Null) {
                fields.push(("providerPolicy", value));
            } else {
                match self.provider_policy(value, &child(path, "providerPolicy")) {
                    Ok(value) => fields.push(("providerPolicy", value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        if mode == BodyMode::Response {
            for name in ["id", "companyId", "createdAt", "updatedAt"] {
                match self.string(self.field(object, name), &child(path, name), 0, None) {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
        } else {
            issues.extend(self.strict(
                object,
                path,
                &[
                    "integration",
                    "execution",
                    "name",
                    "repositoryPath",
                    "worktreeRoot",
                    "repository",
                    "baseBranch",
                    "setupCommand",
                    "verificationCommand",
                    "rootProfileId",
                    "workerProfileId",
                    "agentTaskPolicy",
                    "providerPolicy",
                ],
            ));
        }
        if issues.is_empty() && mode == BodyMode::Patch && fields.is_empty() {
            issues.push(json!({"code":"custom", "path":path, "message":"Provide at least one project field"}));
        }
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn project_create(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let mut errors = Vec::new();
        for branch in [0, 1, 2] {
            let result = match branch {
                0 => self.repository_body(node, path),
                1 => self.new_repository_body(node, path),
                _ => self.project_body(node, path, BodyMode::Full),
            };
            if self.thrown.is_some() {
                return Err(IssueList::new());
            }
            match result {
                Ok(value) => return Ok(value),
                Err(error) => errors.push(error),
            }
        }
        Err(IssueList::union(errors, path))
    }

    fn project_list(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        let field_path = child(path, "projects");
        match self.field(object, "projects") {
            Some(index) if matches!(self.source.node(index), JsNode::Array(_)) => {
                let JsNode::Array(projects) = self.source.node(index) else {
                    unreachable!()
                };
                let mut output = Vec::new();
                for (position, project) in projects.iter().copied().enumerate() {
                    let mut item_path = field_path.clone();
                    item_path.push(json!(position));
                    match self.project_body(project, &item_path, BodyMode::Response) {
                        Ok(value) => output.push(value),
                        Err(error) => issues.extend(error),
                    }
                }
                fields.push(("projects", self.output.append_node(JsNode::Array(output))));
            }
            actual => issues.push(self.invalid_type("array", actual, &field_path)),
        }
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn integration(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.field(object, "repository") {
            Some(repository) => {
                match self.repository_connection(repository, &child(path, "repository")) {
                    Ok(value) => fields.push(("repository", value)),
                    Err(error) => issues.extend(error),
                }
            }
            None => {
                let kind = self
                    .output
                    .append_node(JsNode::String("github".encode_utf16().collect()));
                let repository = self.object_node(vec![("kind", kind)]);
                fields.push(("repository", repository));
            }
        }
        match self.field(object, "tracker") {
            Some(index) if matches!(self.source.node(index), JsNode::Null) => {
                fields.push(("tracker", index))
            }
            Some(index) => match self.tracker_connection(index, &child(path, "tracker")) {
                Ok(value) => fields.push(("tracker", value)),
                Err(error) => issues.extend(error),
            },
            None => {
                let value = self.output.append_node(JsNode::Null);
                fields.push(("tracker", value));
            }
        }
        issues.extend(self.strict(object, path, &["repository", "tracker"]));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn repository_connection(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let Some(kind) = self.field(object, "kind") else {
            return Err(vec![discriminator_issue(
                &child(path, "kind"),
                &["github", "bitbucket"],
            )]
            .into());
        };
        let JsNode::String(value) = self.source.node(kind) else {
            return Err(vec![discriminator_issue(
                &child(path, "kind"),
                &["github", "bitbucket"],
            )]
            .into());
        };
        match String::from_utf16(value).ok().as_deref() {
            Some("github") => {
                let issues = self.strict(object, path, &["kind"]);
                if issues.is_empty() {
                    Ok(self.object_node(vec![("kind", kind)]))
                } else {
                    Err(issues)
                }
            }
            Some("bitbucket") => {
                let mut fields = vec![("kind", kind)];
                let mut issues = IssueList::new();
                for name in ["tokenEnvironment", "usernameEnvironment"] {
                    if name == "usernameEnvironment" && self.field(object, name).is_none() {
                        continue;
                    }
                    match self.environment_reference(self.field(object, name), &child(path, name)) {
                        Ok(value) => fields.push((name, value)),
                        Err(error) => issues.extend(error),
                    }
                }
                issues.extend(self.strict(
                    object,
                    path,
                    &["kind", "tokenEnvironment", "usernameEnvironment"],
                ));
                if issues.is_empty() {
                    Ok(self.object_node(fields))
                } else {
                    Err(issues)
                }
            }
            _ => Err(vec![discriminator_issue(
                &child(path, "kind"),
                &["github", "bitbucket"],
            )]
            .into()),
        }
    }

    fn tracker_connection(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let Some(kind) = self.field(object, "kind") else {
            return Err(vec![discriminator_issue(
                &child(path, "kind"),
                &["github", "jira"],
            )]
            .into());
        };
        let JsNode::String(value) = self.source.node(kind) else {
            return Err(vec![discriminator_issue(
                &child(path, "kind"),
                &["github", "jira"],
            )]
            .into());
        };
        match String::from_utf16(value).ok().as_deref() {
            Some("github") => {
                let mut fields = vec![("kind", kind)];
                let mut issues = IssueList::new();
                match self.string(
                    self.field(object, "repository"),
                    &child(path, "repository"),
                    0,
                    None,
                ) {
                    Ok(index) => {
                        fields.push(("repository", index));
                        if let JsNode::String(value) = self.source.node(index) {
                            let text = String::from_utf16_lossy(value);
                            if !regex::Regex::new(r"^[\w.-]+/[\w.-]+$")
                                .unwrap()
                                .is_match(&text)
                            {
                                issues.push(regex_issue(
                                    &child(path, "repository"),
                                    r"/^[\w.-]+\/[\w.-]+$/",
                                ));
                            }
                        }
                    }
                    Err(error) => issues.extend(error),
                }
                issues.extend(self.strict(object, path, &["kind", "repository"]));
                if issues.is_empty() {
                    Ok(self.object_node(fields))
                } else {
                    Err(issues)
                }
            }
            Some("jira") => self.jira_tracker(object, kind, path),
            _ => Err(vec![discriminator_issue(
                &child(path, "kind"),
                &["github", "jira"],
            )]
            .into()),
        }
    }

    fn jira_tracker(&mut self, object: usize, kind: usize, path: &[Value]) -> NodeResult {
        let mut fields = vec![("kind", kind)];
        let mut issues = IssueList::new();
        for name in ["site", "project", "emailEnvironment", "tokenEnvironment"] {
            let field_path = child(path, name);
            let result = if name.ends_with("Environment") {
                self.environment_reference(self.field(object, name), &field_path)
            } else {
                self.string(self.field(object, name), &field_path, 0, None)
            };
            match result {
                Ok(index) => {
                    fields.push((name, index));
                    if let JsNode::String(value) = self.source.node(index) {
                        let text = String::from_utf16_lossy(value);
                        if name == "project" && !JIRA_PROJECT.is_match(&text) {
                            issues.push(regex_issue(&field_path, r"/^[A-Z][A-Z0-9_]*$/"));
                        }
                        if name == "site" {
                            match url::Url::parse(&text) {
                                Ok(url) if url.scheme() == "https" && url.host_str().is_some_and(|host| JIRA_HOST.is_match(host)) && url.username().is_empty() && url.password().is_none() && url.path() == "/" && url.query().is_none() && url.fragment().is_none() => {}
                                Ok(_) => issues.push(json!({"code":"custom","path":field_path,"message":"Invalid input"})),
                                Err(_) => {
                                    self.thrown = Some(JsThrown { name: "TypeError", code: "ERR_INVALID_URL", message: "Invalid URL", input: value.clone() });
                                }
                            }
                        }
                    }
                }
                Err(error) => issues.extend(error),
            }
        }
        issues.extend(self.strict(
            object,
            path,
            &[
                "kind",
                "site",
                "project",
                "emailEnvironment",
                "tokenEnvironment",
            ],
        ));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn environment_reference(&self, node: Option<usize>, path: &[Value]) -> NodeResult {
        let index = self.string(node, path, 0, None)?;
        let JsNode::String(value) = self.source.node(index) else {
            unreachable!()
        };
        let text = String::from_utf16_lossy(value);
        if regex::Regex::new(r"^[A-Z][A-Z0-9_]{0,127}$")
            .unwrap()
            .is_match(&text)
        {
            Ok(index)
        } else {
            Err(vec![regex_issue(path, r"/^[A-Z][A-Z0-9_]{0,127}$/")].into())
        }
    }

    fn string_array(
        &mut self,
        node: Option<usize>,
        path: &[Value],
        item_bounds: (usize, Option<usize>),
        minimum: usize,
        maximum: Option<usize>,
    ) -> NodeResult {
        let Some(index) = node else {
            return Err(vec![self.invalid_type("array", None, path)].into());
        };
        let JsNode::Array(items) = self.source.node(index) else {
            return Err(vec![self.invalid_type("array", node, path)].into());
        };
        let mut output = Vec::new();
        let mut issues = IssueList::new();
        for (position, item) in items.iter().copied().enumerate() {
            let mut item_path = path.to_vec();
            item_path.push(json!(position));
            match self.string(Some(item), &item_path, item_bounds.0, item_bounds.1) {
                Ok(value) => output.push(value),
                Err(error) => {
                    issues.extend(error);
                    if minimum > 0
                        && matches!(self.source.node(item), JsNode::Array(values) if values.is_empty())
                    {
                        issues.push(json!({
                            "origin":"array", "code":"too_small", "minimum":minimum,
                            "inclusive":true, "path":item_path,
                            "message":format!("Too small: expected array to have >={minimum} items")
                        }));
                    }
                }
            }
        }
        if items.len() < minimum {
            issues.push(json!({
                "origin":"array", "code":"too_small", "minimum":minimum,
                "inclusive":true, "path":path,
                "message":format!("Too small: expected array to have >={minimum} items")
            }));
        }
        if let Some(maximum) = maximum
            && items.len() > maximum
        {
            issues.push(json!({
                "origin":"array", "code":"too_big", "maximum":maximum,
                "inclusive":true, "path":path,
                "message":format!("Too big: expected array to have <={maximum} items")
            }));
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::Array(output)))
        } else {
            Err(issues)
        }
    }

    fn enum_string(&self, node: Option<usize>, path: &[Value], options: &[&str]) -> NodeResult {
        if let Some(index) = node
            && let JsNode::String(value) = self.source.node(index)
            && options
                .iter()
                .any(|option| value.iter().copied().eq(option.encode_utf16()))
        {
            return Ok(index);
        }
        Err(vec![json!({
            "code":"invalid_value", "values":options, "path":path,
            "message":format!("Invalid option: expected one of {}", options.iter().map(|option| format!("\"{option}\"")).collect::<Vec<_>>().join("|"))
        })].into())
    }

    fn boolean(&self, node: Option<usize>, path: &[Value]) -> NodeResult {
        match node {
            Some(index) if matches!(self.source.node(index), JsNode::Bool(_)) => Ok(index),
            _ => Err(vec![self.invalid_type("boolean", node, path)].into()),
        }
    }

    fn empty_array(&mut self) -> usize {
        self.output.append_node(JsNode::Array(Vec::new()))
    }

    fn profile_ids(&mut self, node: Option<usize>, path: &[Value], minimum: usize) -> NodeResult {
        self.string_array(node, path, (1, Some(256)), minimum, None)
    }

    fn advisors(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        for name in ["reviewer", "planner_a", "planner_b", "rater"] {
            let result = match self.field(object, name) {
                Some(value) => self.profile_ids(Some(value), &child(path, name), 0),
                None => Ok(self.empty_array()),
            };
            match result {
                Ok(value) => fields.push((name, value)),
                Err(error) => issues.extend(error),
            }
        }
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn agent_policy(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        self.policy_array_field(object, "workflowIds", 1, path, &mut fields, &mut issues);
        match self.string(
            self.field(object, "defaultWorkflowId"),
            &child(path, "defaultWorkflowId"),
            1,
            Some(256),
        ) {
            Ok(value) => fields.push(("defaultWorkflowId", value)),
            Err(error) => issues.extend(error),
        }
        self.policy_array_field(object, "templateIds", 0, path, &mut fields, &mut issues);
        self.policy_array_field(object, "rootProfileIds", 1, path, &mut fields, &mut issues);
        self.policy_array_field(
            object,
            "workerProfileIds",
            1,
            path,
            &mut fields,
            &mut issues,
        );
        match self.field(object, "advisorProfileIds") {
            Some(value) => match self.advisors(value, &child(path, "advisorProfileIds")) {
                Ok(value) => fields.push(("advisorProfileIds", value)),
                Err(error) => issues.extend(error),
            },
            None => {
                let arrays = ["reviewer", "planner_a", "planner_b", "rater"]
                    .into_iter()
                    .map(|name| (name, self.empty_array()))
                    .collect();
                fields.push(("advisorProfileIds", self.object_node(arrays)));
            }
        }
        let delivery = [
            "local_worktree",
            "remote_branch",
            "pull_request_draft",
            "pull_request_ready",
            "merged",
        ];
        match self.field(object, "deliveryTarget") {
            Some(value) => {
                match self.enum_string(Some(value), &child(path, "deliveryTarget"), &delivery) {
                    Ok(value) => fields.push(("deliveryTarget", value)),
                    Err(error) => issues.extend(error),
                }
            }
            None => fields.push((
                "deliveryTarget",
                self.output.append_node(JsNode::String(
                    "pull_request_draft".encode_utf16().collect(),
                )),
            )),
        }
        match self.field(object, "runProjectTests") {
            Some(value) => match self.boolean(Some(value), &child(path, "runProjectTests")) {
                Ok(value) => fields.push(("runProjectTests", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push((
                "runProjectTests",
                self.output.append_node(JsNode::Bool(true)),
            )),
        }
        match self.field(object, "visualEvidence") {
            Some(value) => match self.enum_string(
                Some(value),
                &child(path, "visualEvidence"),
                &["off", "capture", "required"],
            ) {
                Ok(value) => fields.push(("visualEvidence", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push((
                "visualEvidence",
                self.output
                    .append_node(JsNode::String("off".encode_utf16().collect())),
            )),
        }
        issues.extend(self.strict(
            object,
            path,
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
        ));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn policy_array_field(
        &mut self,
        object: usize,
        name: &'static str,
        minimum: usize,
        path: &[Value],
        fields: &mut Vec<(&'static str, usize)>,
        issues: &mut IssueList,
    ) {
        let result = match self.field(object, name) {
            Some(value) => self.profile_ids(Some(value), &child(path, name), minimum),
            None if minimum == 0 => Ok(self.empty_array()),
            None => self.profile_ids(None, &child(path, name), minimum),
        };
        match result {
            Ok(value) => fields.push((name, value)),
            Err(error) => issues.extend(error),
        }
    }

    fn provider_policy(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.field(object, "allowedProviders") {
            Some(index) if matches!(self.source.node(index), JsNode::Array(_)) => {
                let JsNode::Array(items) = self.source.node(index) else {
                    unreachable!()
                };
                let mut output = Vec::new();
                for (position, item) in items.iter().copied().enumerate() {
                    let mut item_path = child(path, "allowedProviders");
                    item_path.push(json!(position));
                    match self.enum_string(
                        Some(item),
                        &item_path,
                        &["opencode", "claude-code", "devin", "codex"],
                    ) {
                        Ok(value) => output.push(value),
                        Err(error) => issues.extend(error),
                    }
                }
                fields.push((
                    "allowedProviders",
                    self.output.append_node(JsNode::Array(output)),
                ));
            }
            actual => {
                issues.push(self.invalid_type("array", actual, &child(path, "allowedProviders")))
            }
        }
        match self.string_array(
            self.field(object, "allowedInstanceIds"),
            &child(path, "allowedInstanceIds"),
            (1, None),
            0,
            None,
        ) {
            Ok(value) => fields.push(("allowedInstanceIds", value)),
            Err(error) => issues.extend(error),
        }
        issues.extend(self.strict(object, path, &["allowedProviders", "allowedInstanceIds"]));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn execution(&mut self, node: usize, path: &[Value], partial: bool) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.field(object, "instructions") {
            Some(value) => match self.string(Some(value), &child(path, "instructions"), 0, None) {
                Ok(value) => fields.push(("instructions", value)),
                Err(error) => issues.extend(error),
            },
            None if !partial => fields.push((
                "instructions",
                self.output.append_node(JsNode::String(Vec::new())),
            )),
            None => {}
        }
        match self.field(object, "skillDirectories") {
            Some(value) => match self.string_array(
                Some(value),
                &child(path, "skillDirectories"),
                (1, None),
                0,
                Some(50),
            ) {
                Ok(value) => fields.push(("skillDirectories", value)),
                Err(error) => issues.extend(error),
            },
            None if !partial => fields.push(("skillDirectories", self.empty_array())),
            None => {}
        }
        match self.field(object, "environment") {
            Some(value) => match self.environment(value, &child(path, "environment")) {
                Ok(value) => fields.push(("environment", value)),
                Err(error) => issues.extend(error),
            },
            None if !partial => fields.push(("environment", self.object_node(Vec::new()))),
            None => {}
        }
        match self.field(object, "mcp") {
            Some(value) => match self.mcp(value, &child(path, "mcp")) {
                Ok(value) => fields.push(("mcp", value)),
                Err(error) => issues.extend(error),
            },
            None if !partial => fields.push(("mcp", self.empty_array())),
            None => {}
        }
        issues.extend(self.strict(
            object,
            path,
            &["instructions", "skillDirectories", "environment", "mcp"],
        ));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn environment(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let JsNode::Object(fields) = self.source.node(object) else {
            unreachable!()
        };
        let mut output = Vec::new();
        let mut issues = IssueList::new();
        for (key, value) in fields {
            let name = String::from_utf16_lossy(key);
            let mut field_path = path.to_vec();
            field_path.push(json!(name));
            let key_issue = if !ENVIRONMENT_KEY.is_match(&name) {
                Some(regex_issue(&[], r"/^[A-Za-z_][A-Za-z0-9_]*$/"))
            } else if [
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
            .any(|prefix| name.starts_with(prefix))
            {
                Some(
                    json!({"code":"custom", "path":[], "message":"Provider routing variables are not project environment values"}),
                )
            } else {
                None
            };
            if let Some(key_issue) = key_issue {
                issues.push_record(
                    json!({
                        "code":"invalid_key", "origin":"record", "issues":[key_issue],
                        "path":field_path, "message":"Invalid key in record"
                    }),
                    key,
                );
                continue;
            }
            match self.string(Some(*value), &field_path, 0, None) {
                Ok(value) => output.push((key.clone(), value)),
                Err(mut error) => {
                    error.mark_record(key);
                    issues.extend(error);
                }
            }
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::Object(output)))
        } else {
            Err(issues)
        }
    }

    fn mcp(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let JsNode::Array(servers) = self.source.node(node) else {
            return Err(vec![self.invalid_type("array", Some(node), path)].into());
        };
        let mut output = Vec::new();
        let mut issues = IssueList::new();
        for (position, server) in servers.iter().copied().enumerate() {
            let mut server_path = path.to_vec();
            server_path.push(json!(position));
            match self.mcp_server(server, &server_path) {
                Ok(value) => output.push(value),
                Err(error) => issues.extend(error),
            }
        }
        if issues.is_empty() {
            let mut seen = std::collections::HashSet::new();
            if output.iter().any(|server| {
                let name = self
                    .output
                    .get(*server, "name")
                    .expect("parsed MCP server name");
                let JsNode::String(name) = self.output.node(name) else {
                    unreachable!()
                };
                !seen.insert(name.clone())
            }) {
                issues.push(json!({"code":"custom", "path":path, "message":"MCP server names must be unique"}));
            }
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::Array(output)))
        } else {
            Err(issues)
        }
    }

    fn mcp_server(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.tool_name(self.field(object, "name"), &child(path, "name"), true) {
            Ok(value) => fields.push(("name", value)),
            Err(error) => issues.extend(error),
        }
        match self.field(object, "transport") {
            Some(value) => match self.mcp_transport(value, &child(path, "transport")) {
                Ok(value) => fields.push(("transport", value)),
                Err(error) => issues.extend(error),
            },
            None => issues.push(self.invalid_type("object", None, &child(path, "transport"))),
        }
        match self.field(object, "grants") {
            Some(value) => match self.mcp_grants(value, &child(path, "grants")) {
                Ok(value) => fields.push(("grants", value)),
                Err(error) => issues.extend(error),
            },
            None => issues.push(self.invalid_type("object", None, &child(path, "grants"))),
        }
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn tool_name(&self, node: Option<usize>, path: &[Value], server: bool) -> NodeResult {
        let value = self.string(node, path, 0, None)?;
        let JsNode::String(raw) = self.source.node(value) else {
            unreachable!()
        };
        let name = String::from_utf16_lossy(raw);
        let mut issues = IssueList::new();
        if !TOOL_NAME.is_match(&name) {
            issues.push(regex_issue(path, r"/^[A-Za-z0-9_-]+$/"));
        }
        if server && name.starts_with("suplex_") {
            issues.push(
                json!({"code":"custom", "path":path, "message":"Suplex server names are reserved"}),
            );
        }
        if issues.is_empty() {
            Ok(value)
        } else {
            Err(issues)
        }
    }

    fn mcp_transport(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let Some(kind) = self.field(object, "type") else {
            return Err(vec![discriminator_issue_for(path, "type", &["stdio", "http"])].into());
        };
        let JsNode::String(raw) = self.source.node(kind) else {
            return Err(vec![discriminator_issue_for(path, "type", &["stdio", "http"])].into());
        };
        let mut fields = vec![("type", kind)];
        let mut issues = IssueList::new();
        match String::from_utf16(raw).ok().as_deref() {
            Some("stdio") => {
                match self.string(
                    self.field(object, "command"),
                    &child(path, "command"),
                    1,
                    None,
                ) {
                    Ok(value) => fields.push(("command", value)),
                    Err(error) => issues.extend(error),
                }
                match self.field(object, "args") {
                    Some(value) => match self.string_array(
                        Some(value),
                        &child(path, "args"),
                        (0, None),
                        0,
                        None,
                    ) {
                        Ok(value) => fields.push(("args", value)),
                        Err(error) => issues.extend(error),
                    },
                    None => fields.push(("args", self.empty_array())),
                }
                match self.field(object, "env") {
                    Some(value) => match self.mcp_record(value, &child(path, "env")) {
                        Ok(value) => fields.push(("env", value)),
                        Err(error) => issues.extend(error),
                    },
                    None => fields.push(("env", self.object_node(Vec::new()))),
                }
            }
            Some("http") => {
                match self.string(self.field(object, "url"), &child(path, "url"), 0, None) {
                    Ok(value) => {
                        fields.push(("url", value));
                        if let JsNode::String(raw) = self.source.node(value) {
                            let text = String::from_utf16_lossy(raw);
                            if url::Url::parse(&text).is_err() {
                                issues.push(json!({"code":"invalid_format", "format":"url", "path":child(path,"url"), "message":"Invalid URL"}));
                            }
                        }
                    }
                    Err(error) => issues.extend(error),
                }
                match self.field(object, "headers") {
                    Some(value) => match self.mcp_record(value, &child(path, "headers")) {
                        Ok(value) => fields.push(("headers", value)),
                        Err(error) => issues.extend(error),
                    },
                    None => fields.push(("headers", self.object_node(Vec::new()))),
                }
            }
            _ => {
                return Err(vec![discriminator_issue_for(path, "type", &["stdio", "http"])].into());
            }
        }
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }

    fn mcp_record(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let JsNode::Object(fields) = self.source.node(object) else {
            unreachable!()
        };
        let mut output = Vec::new();
        let mut issues = IssueList::new();
        for (key, value) in fields {
            let name = String::from_utf16_lossy(key);
            let field_path = child(path, &name);
            match self.environment_reference(Some(*value), &field_path) {
                Ok(value) => output.push((key.clone(), value)),
                Err(mut error) => {
                    error.mark_record(key);
                    issues.extend(error);
                }
            }
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::Object(output)))
        } else {
            Err(issues)
        }
    }

    fn mcp_grants(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        for name in ["root", "advisor", "worker"] {
            let field_path = child(path, name);
            let Some(index) = self.field(object, name) else {
                issues.push(self.invalid_type("array", None, &field_path));
                continue;
            };
            let JsNode::Array(items) = self.source.node(index) else {
                issues.push(self.invalid_type("array", Some(index), &field_path));
                continue;
            };
            let mut parsed = Vec::new();
            for (position, item) in items.iter().copied().enumerate() {
                let mut item_path = field_path.clone();
                item_path.push(json!(position));
                match self.tool_name(Some(item), &item_path, false) {
                    Ok(value) => parsed.push(value),
                    Err(error) => issues.extend(error),
                }
            }
            fields.push((name, self.output.append_node(JsNode::Array(parsed))));
        }
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }
}

fn child(path: &[Value], name: &str) -> Path {
    let mut output = path.to_vec();
    output.push(json!(name));
    output
}

fn regex_issue(path: &[Value], pattern: &str) -> Value {
    json!({
        "origin":"string", "code":"invalid_format", "format":"regex", "pattern":pattern,
        "path":path, "message":format!("Invalid string: must match pattern {pattern}")
    })
}

fn discriminator_issue(path: &[Value], options: &[&str]) -> Value {
    json!({
        "code":"invalid_union", "errors":[], "note":"No matching discriminator",
        "discriminator":"kind", "options":options, "path":path,
        "message":format!("Invalid discriminator value. Expected {}", options.iter().map(|option| format!("'{option}'")).collect::<Vec<_>>().join(" | "))
    })
}

fn discriminator_issue_for(path: &[Value], discriminator: &str, options: &[&str]) -> Value {
    let mut field_path = path.to_vec();
    field_path.push(json!(discriminator));
    json!({
        "code":"invalid_union", "errors":[], "note":"No matching discriminator",
        "discriminator":discriminator, "options":options, "path":field_path,
        "message":format!("Invalid discriminator value. Expected {}", options.iter().map(|option| format!("'{option}'")).collect::<Vec<_>>().join(" | "))
    })
}

fn issue_document(issues: IssueList) -> JsDocument {
    let mut output = JsDocument::parse(&js_json::stringify(&Value::Array(issues.values)))
        .expect("ordinary issue fields serialize as JSON");
    let original_root = output.root();
    let root = restore_issue_list(&mut output, original_root, &issues.metadata);
    output.set_root(root);
    output
}

fn restore_issue_list(document: &mut JsDocument, index: usize, metadata: &[IssueMeta]) -> usize {
    let JsNode::Array(items) = document.node(index).clone() else {
        unreachable!("issue list")
    };
    assert_eq!(items.len(), metadata.len(), "issue metadata cardinality");
    let restored = items
        .into_iter()
        .zip(metadata)
        .map(|(item, meta)| restore_issue_strings(document, item, Some(meta)))
        .collect();
    document.append_node(JsNode::Array(restored))
}

fn restore_issue_strings(
    document: &mut JsDocument,
    index: usize,
    metadata: Option<&IssueMeta>,
) -> usize {
    match document.node(index).clone() {
        JsNode::Array(items) => {
            let items = items
                .into_iter()
                .map(|item| restore_issue_strings(document, item, None))
                .collect();
            document.append_node(JsNode::Array(items))
        }
        JsNode::Object(fields) => {
            let raw = metadata.and_then(|meta| meta.raw_strict_keys.as_ref());
            let raw_path = metadata.and_then(|meta| meta.raw_record_key.as_ref());
            let fields = fields
                .into_iter()
                .map(|(name, value)| {
                    let replacement = if name.iter().copied().eq("path".encode_utf16()) {
                        if let Some(raw_path) = &raw_path {
                            let JsNode::Array(mut items) = document.node(value).clone() else {
                                unreachable!()
                            };
                            let key = document.append_node(JsNode::String(raw_path.to_vec()));
                            *items.last_mut().expect("record issue path contains key") = key;
                            document.append_node(JsNode::Array(items))
                        } else {
                            value
                        }
                    } else if name.iter().copied().eq("errors".encode_utf16())
                        && metadata
                            .and_then(|meta| meta.union_branches.as_ref())
                            .is_some()
                    {
                        let branches = metadata
                            .and_then(|meta| meta.union_branches.as_ref())
                            .unwrap();
                        let JsNode::Array(items) = document.node(value).clone() else {
                            unreachable!("union branches")
                        };
                        assert_eq!(items.len(), branches.len());
                        let restored = items
                            .into_iter()
                            .zip(branches)
                            .map(|(item, branch)| {
                                restore_issue_list(document, item, &branch.metadata)
                            })
                            .collect();
                        document.append_node(JsNode::Array(restored))
                    } else if let Some(raw) = &raw {
                        if name.iter().copied().eq("keys".encode_utf16()) {
                            let values = raw
                                .iter()
                                .map(|key| document.append_node(JsNode::String(key.clone())))
                                .collect();
                            document.append_node(JsNode::Array(values))
                        } else if name.iter().copied().eq("message".encode_utf16()) {
                            let mut message = if raw.len() == 1 {
                                "Unrecognized key: ".encode_utf16().collect::<Vec<_>>()
                            } else {
                                "Unrecognized keys: ".encode_utf16().collect::<Vec<_>>()
                            };
                            for (position, key) in raw.iter().enumerate() {
                                if position > 0 {
                                    message.extend(", ".encode_utf16());
                                }
                                message.push(b'"' as u16);
                                message.extend(key);
                                message.push(b'"' as u16);
                            }
                            document.append_node(JsNode::String(message))
                        } else {
                            restore_issue_strings(document, value, None)
                        }
                    } else {
                        restore_issue_strings(document, value, None)
                    };
                    (name, replacement)
                })
                .collect();
            document.append_node(JsNode::Object(fields))
        }
        _ => index,
    }
}
