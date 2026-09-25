use std::sync::LazyLock;

use serde_json::{Value, json};

use crate::shared::js_json::{JsDocument, JsNode};

use super::js_issues::{
    IssueList, JsIssueContext, advisor_profile_ids, issue_document, object_node,
};
use super::{DetailedJsParseResult, JsContractFailure, JsThrown};

type NodeResult = Result<usize, IssueList>;
type Path = Vec<Value>;

const DELIVERY_TARGETS: &[&str] = &[
    "local_worktree",
    "remote_branch",
    "pull_request_draft",
    "pull_request_ready",
    "merged",
];
const VISUAL_EVIDENCE: &[&str] = &["off", "capture", "required"];
const WORKFLOWS: &[&str] = &[
    "standard",
    "direct_build",
    "independent_review",
    "competing_plans",
    "refine_pull_request",
];
const MIMES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BASE64_LENGTH: usize = 11_184_812;
static IDEMPOTENCY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$").unwrap());
static GITHUB_REPOSITORY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").unwrap());
static JIRA_ID: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[0-9]+$").unwrap());
static JIRA_KEY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Z][A-Z0-9_]*-[0-9]+$").unwrap());

pub(super) fn validate_detailed(
    contract: &str,
    input: Option<&JsDocument>,
) -> Option<DetailedJsParseResult> {
    if contract != "tasks.TaskBodySchema" {
        return None;
    }
    let Some(source) = input else {
        return Some(Err(JsContractFailure::Issues(issue_document(
            vec![json!({
                "expected":"object", "code":"invalid_type", "path":[],
                "message":"Invalid input: expected object, received undefined"
            })]
            .into(),
        ))));
    };
    let mut parser = Parser {
        source,
        output: source.clone(),
        thrown: None,
    };
    let result = parser.body(source.root(), &[]);
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
enum IssueUrlField {
    GithubUrl,
    JiraSite,
    JiraUrl,
}

impl Parser<'_> {
    fn core(&self) -> JsIssueContext<'_> {
        JsIssueContext::new(self.source)
    }
    fn field(&self, object: usize, name: &str) -> Option<usize> {
        self.source.get(object, name)
    }
    fn string(
        &self,
        node: Option<usize>,
        path: &[Value],
        min: usize,
        max: Option<usize>,
    ) -> NodeResult {
        self.core().string(node, path, min, max)
    }
    fn enum_value(&self, node: Option<usize>, path: &[Value], options: &[&str]) -> NodeResult {
        self.core().enumeration(node, path, options)
    }
    fn default_string(&mut self, value: &str) -> usize {
        self.output
            .append_node(JsNode::String(value.encode_utf16().collect()))
    }
    fn default_array(&mut self) -> usize {
        self.output.append_node(JsNode::Array(Vec::new()))
    }
    fn body(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.string(
            self.field(object, "projectId"),
            &child(path, "projectId"),
            1,
            Some(256),
        ) {
            Ok(value) => fields.push(("projectId", value)),
            Err(error) => issues.extend(error),
        }
        let title = self.field(object, "title");
        match JsIssueContext::new(self.source).trimmed_string(
            &mut self.output,
            title,
            &child(path, "title"),
            1,
            None,
        ) {
            Ok(value) => fields.push(("title", value)),
            Err(error) => issues.extend(error),
        }
        match self.field(object, "description") {
            Some(value) => match JsIssueContext::new(self.source).trimmed_string(
                &mut self.output,
                Some(value),
                &child(path, "description"),
                0,
                None,
            ) {
                Ok(value) => fields.push(("description", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push(("description", self.default_string(""))),
        }
        match self.idempotency(
            self.field(object, "idempotencyKey"),
            &child(path, "idempotencyKey"),
        ) {
            Ok(value) => fields.push(("idempotencyKey", value)),
            Err(error) => issues.extend(error),
        }
        match self.field(object, "images") {
            Some(value) => match self.images(value, &child(path, "images")) {
                Ok(value) => fields.push(("images", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push(("images", self.default_array())),
        }
        for name in ["rootProfileId", "workerProfileId"] {
            if let Some(value) = self.field(object, name) {
                match self.string(Some(value), &child(path, name), 1, Some(256)) {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        match self.field(object, "startImmediately") {
            Some(value) => match self
                .core()
                .boolean(Some(value), &child(path, "startImmediately"))
            {
                Ok(value) => fields.push(("startImmediately", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push((
                "startImmediately",
                self.output.append_node(JsNode::Bool(false)),
            )),
        }
        for (name, options, default) in [
            ("deliveryTarget", DELIVERY_TARGETS, "pull_request_draft"),
            ("visualEvidence", VISUAL_EVIDENCE, "off"),
        ] {
            match self.field(object, name) {
                Some(value) => match self.enum_value(Some(value), &child(path, name), options) {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                },
                None => fields.push((name, self.default_string(default))),
            }
            if name == "deliveryTarget" {
                match self.field(object, "runProjectTests") {
                    Some(value) => match self
                        .core()
                        .boolean(Some(value), &child(path, "runProjectTests"))
                    {
                        Ok(value) => fields.push(("runProjectTests", value)),
                        Err(error) => issues.extend(error),
                    },
                    None => fields.push((
                        "runProjectTests",
                        self.output.append_node(JsNode::Bool(true)),
                    )),
                }
            }
        }
        if let Some(value) = self.field(object, "source") {
            match self.source_input(value, &child(path, "source")) {
                Ok(value) => fields.push(("source", value)),
                Err(error) => issues.extend(error),
            }
        }
        if let Some(value) = self.field(object, "issue") {
            if matches!(self.source.node(value), JsNode::Null) {
                fields.push(("issue", value));
            } else {
                match self.issue(value, &child(path, "issue")) {
                    Ok(value) => fields.push(("issue", value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        match self.field(object, "workflow") {
            Some(value) => {
                match self.enum_value(Some(value), &child(path, "workflow"), WORKFLOWS) {
                    Ok(value) => fields.push(("workflow", value)),
                    Err(error) => issues.extend(error),
                }
            }
            None => fields.push(("workflow", self.default_string("standard"))),
        }
        match self.field(object, "advisorProfileIds") {
            Some(value) => match advisor_profile_ids(
                self.source,
                &mut self.output,
                value,
                &child(path, "advisorProfileIds"),
            ) {
                Ok(value) => fields.push(("advisorProfileIds", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push((
                "advisorProfileIds",
                object_node(&mut self.output, Vec::new()),
            )),
        }
        match self.field(object, "dependsOn") {
            Some(value) => match self.depends_on(value, &child(path, "dependsOn")) {
                Ok(value) => fields.push(("dependsOn", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push(("dependsOn", self.default_array())),
        }
        match self.field(object, "blockedByPullRequests") {
            Some(value) => match self.blocked_prs(value, &child(path, "blockedByPullRequests")) {
                Ok(value) => fields.push(("blockedByPullRequests", value)),
                Err(error) => issues.extend(error),
            },
            None => fields.push(("blockedByPullRequests", self.default_array())),
        }
        issues.extend(self.core().strict(
            object,
            path,
            &[
                "projectId",
                "title",
                "description",
                "idempotencyKey",
                "images",
                "rootProfileId",
                "workerProfileId",
                "startImmediately",
                "deliveryTarget",
                "runProjectTests",
                "visualEvidence",
                "source",
                "issue",
                "workflow",
                "advisorProfileIds",
                "dependsOn",
                "blockedByPullRequests",
            ],
        ));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }

    fn idempotency(&self, node: Option<usize>, path: &[Value]) -> NodeResult {
        let index = self.string(node, path, 0, None)?;
        let JsNode::String(value) = self.source.node(index) else {
            unreachable!()
        };
        let text = String::from_utf16_lossy(value);
        if IDEMPOTENCY.is_match(&text) {
            Ok(index)
        } else {
            Err(vec![regex_issue(path, r"/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/")].into())
        }
    }
    fn source_input(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let kind = self
            .field(object, "kind")
            .and_then(|index| match self.source.node(index) {
                JsNode::String(text) => Some(String::from_utf16_lossy(text)),
                _ => None,
            });
        let Some(kind @ ("issue" | "branch" | "pull_request")) = kind.as_deref() else {
            return Err(vec![discriminator_issue(
                &child(path, "kind"),
                "kind",
                &["issue", "branch", "pull_request"],
            )]
            .into());
        };
        let mut fields = vec![("kind", self.field(object, "kind").unwrap())];
        let mut issues = IssueList::new();
        if kind == "branch" {
            match self.string(
                self.field(object, "branch"),
                &child(path, "branch"),
                1,
                None,
            ) {
                Ok(value) => fields.push(("branch", value)),
                Err(error) => issues.extend(error),
            }
            issues.extend(self.core().strict(object, path, &["kind", "branch"]));
        } else {
            match self.positive_integer(self.field(object, "number"), &child(path, "number")) {
                Ok(value) => fields.push(("number", value)),
                Err(error) => issues.extend(error),
            }
            issues.extend(self.core().strict(object, path, &["kind", "number"]));
        }
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn positive_integer(&self, node: Option<usize>, path: &[Value]) -> NodeResult {
        let Some(index) = node else {
            return Err(vec![self.core().invalid_type("number", None, path)].into());
        };
        let JsNode::Number(value) = self.source.node(index) else {
            return Err(vec![self.core().invalid_type("number", node, path)].into());
        };
        if !value.is_finite() {
            return Err(vec![json!({"expected":"number","code":"invalid_type","received":"Infinity","path":path,"message":"Invalid input: expected number, received number"})].into());
        }
        if value.fract() != 0.0 {
            return Err(vec![json!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"})].into());
        }
        let mut issues = IssueList::new();
        if *value > 9_007_199_254_740_991.0 {
            issues.push(json!({"code":"too_big","maximum":9_007_199_254_740_991_u64,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":path,"message":"Too big: expected int to be <=9007199254740991"}));
        }
        if *value < -9_007_199_254_740_991.0 {
            issues.push(json!({"code":"too_small","minimum":-9_007_199_254_740_991_i64,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":path,"message":"Too small: expected int to be >=-9007199254740991"}));
        }
        if *value <= 0.0 {
            issues.push(json!({"origin":"number","code":"too_small","minimum":0,"inclusive":false,"path":path,"message":"Too small: expected number to be >0"}));
        }
        if issues.is_empty() {
            Ok(index)
        } else {
            Err(issues)
        }
    }
    fn images(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let JsNode::Array(items) = self.source.node(node) else {
            return Err(vec![self.core().invalid_type("array", Some(node), path)].into());
        };
        let mut parsed = Vec::new();
        let mut issues = IssueList::new();
        for (position, item) in items.iter().copied().enumerate() {
            let item_path = indexed(path, position);
            match self.image(item, &item_path) {
                Ok(value) => parsed.push(value),
                Err(error) => issues.extend(error),
            }
        }
        if items.len() > 8 {
            issues.push(array_max_issue(path, 8));
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::Array(parsed)))
        } else {
            Err(issues)
        }
    }
    fn image(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        let filename_path = child(path, "filename");
        let filename = self.field(object, "filename");
        match self.string(filename, &filename_path, 1, Some(255)) {
            Ok(value) => fields.push(("filename", value)),
            Err(error) => issues.extend(error),
        }
        if let Some(value) = filename
            && let JsNode::String(name) = self.source.node(value)
            && (name
                .windows(2)
                .any(|pair| pair == [b'.' as u16, b'.' as u16])
                || name
                    .iter()
                    .any(|unit| *unit == b'/' as u16 || *unit == b'\\' as u16))
        {
            issues.push(json!({"code":"custom","path":filename_path,"message":"Invalid input"}));
        }
        match self.enum_value(
            self.field(object, "mimeType"),
            &child(path, "mimeType"),
            MIMES,
        ) {
            Ok(value) => fields.push(("mimeType", value)),
            Err(error) => issues.extend(error),
        }
        match self.string(
            self.field(object, "base64"),
            &child(path, "base64"),
            1,
            Some(MAX_IMAGE_BASE64_LENGTH),
        ) {
            Ok(value) => fields.push(("base64", value)),
            Err(error) => issues.extend(error),
        }
        issues.extend(
            self.core()
                .strict(object, path, &["filename", "mimeType", "base64"]),
        );
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn depends_on(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let JsNode::Array(items) = self.source.node(node) else {
            return Err(vec![self.core().invalid_type("array", Some(node), path)].into());
        };
        let mut parsed = Vec::new();
        let mut issues = IssueList::new();
        for (position, item) in items.iter().copied().enumerate() {
            match self.string(Some(item), &indexed(path, position), 1, Some(256)) {
                Ok(value) => parsed.push(value),
                Err(error) => issues.extend(error),
            }
        }
        if items.len() > 50 {
            issues.push(array_max_issue(path, 50));
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::Array(parsed)))
        } else {
            Err(issues)
        }
    }
    fn blocked_prs(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let JsNode::Array(items) = self.source.node(node) else {
            return Err(vec![self.core().invalid_type("array", Some(node), path)].into());
        };
        let mut parsed = Vec::new();
        let mut issues = IssueList::new();
        for (position, item) in items.iter().copied().enumerate() {
            let item_path = indexed(path, position);
            let result = (|| {
                let object = self.core().object(Some(item), &item_path)?;
                let number = self
                    .positive_integer(self.field(object, "number"), &child(&item_path, "number"));
                let mut inner = IssueList::new();
                let mut fields = Vec::new();
                match number {
                    Ok(value) => fields.push(("number", value)),
                    Err(error) => inner.extend(error),
                }
                inner.extend(self.core().strict(object, &item_path, &["number"]));
                if inner.is_empty() {
                    Ok(object_node(&mut self.output, fields))
                } else {
                    Err(inner)
                }
            })();
            match result {
                Ok(value) => parsed.push(value),
                Err(error) => issues.extend(error),
            }
        }
        if items.len() > 50 {
            issues.push(array_max_issue(path, 50));
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::Array(parsed)))
        } else {
            Err(issues)
        }
    }
    fn issue(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let kind = self
            .field(object, "kind")
            .and_then(|index| match self.source.node(index) {
                JsNode::String(text) => Some(String::from_utf16_lossy(text)),
                _ => None,
            });
        let Some(kind @ ("github" | "jira")) = kind.as_deref() else {
            return Err(vec![discriminator_issue(
                &child(path, "kind"),
                "kind",
                &["github", "jira"],
            )]
            .into());
        };
        let mut fields = vec![("kind", self.field(object, "kind").unwrap())];
        let mut issues = IssueList::new();
        let mut textual = std::collections::HashMap::new();
        let mut number = None;
        if kind == "github" {
            let name = "repository";
            let field_path = child(path, name);
            match self.string(self.field(object, name), &field_path, 0, None) {
                Ok(value) => {
                    fields.push((name, value));
                    if let JsNode::String(raw) = self.source.node(value) {
                        let text = String::from_utf16_lossy(raw);
                        if !GITHUB_REPOSITORY.is_match(&text) {
                            issues.push(regex_issue(&field_path, r"/^[\w.-]+\/[\w.-]+$/"));
                        }
                        textual.insert(name, text);
                    }
                }
                Err(error) => issues.extend(error),
            }
            let field_path = child(path, "number");
            match self.positive_integer(self.field(object, "number"), &field_path) {
                Ok(value) => fields.push(("number", value)),
                Err(error) => issues.extend(error),
            }
            if let Some(value) = self.field(object, "number")
                && let JsNode::Number(value) = self.source.node(value)
                && value.is_finite()
                && value.fract() == 0.0
                && value.abs() <= 9_007_199_254_740_991.0
            {
                number = Some(*value);
            }
        } else {
            self.issue_url_field(
                object,
                IssueUrlField::JiraSite,
                path,
                &mut fields,
                &mut textual,
                &mut issues,
            );
            for (name, regex, pattern) in [
                ("id", &*JIRA_ID, r"/^\d+$/"),
                ("key", &*JIRA_KEY, r"/^[A-Z][A-Z0-9_]*-\d+$/"),
            ] {
                let field_path = child(path, name);
                match self.string(self.field(object, name), &field_path, 0, None) {
                    Ok(value) => {
                        fields.push((name, value));
                        if let JsNode::String(raw) = self.source.node(value) {
                            let text = String::from_utf16_lossy(raw);
                            if !regex.is_match(&text) {
                                issues.push(regex_issue(&field_path, pattern));
                            }
                            textual.insert(name, text);
                        }
                    }
                    Err(error) => issues.extend(error),
                }
            }
        }
        for name in ["id", "key", "title"] {
            if kind == "jira" && (name == "id" || name == "key") {
                continue;
            }
            let field_path = child(path, name);
            match self.string(self.field(object, name), &field_path, 0, None) {
                Ok(value) => fields.push((name, value)),
                Err(error) => issues.extend(error),
            }
        }
        let url_field = if kind == "github" {
            IssueUrlField::GithubUrl
        } else {
            IssueUrlField::JiraUrl
        };
        self.issue_url_field(
            object,
            url_field,
            path,
            &mut fields,
            &mut textual,
            &mut issues,
        );
        let known = if kind == "github" {
            &["kind", "repository", "number", "id", "key", "title", "url"][..]
        } else {
            &["kind", "site", "id", "key", "title", "url"][..]
        };
        issues.extend(self.core().strict(object, path, known));
        if self.thrown.is_none() {
            let url = textual
                .get("url")
                .and_then(|value| url::Url::parse(value).ok());
            let required_text = ["id", "key", "title"].iter().all(|name| {
                self.field(object, name)
                    .is_some_and(|index| matches!(self.source.node(index), JsNode::String(_)))
            });
            if kind == "jira"
                && required_text
                && textual.contains_key("site")
                && textual.contains_key("url")
            {
                for name in ["url", "site"] {
                    if textual
                        .get(name)
                        .is_some_and(|value| url::Url::parse(value).is_err())
                    {
                        let index = self.field(object, name).expect("parsed Jira URL field");
                        let JsNode::String(raw) = self.source.node(index) else {
                            unreachable!()
                        };
                        self.thrown = Some(JsThrown {
                            name: "TypeError",
                            code: "ERR_INVALID_URL",
                            message: "Invalid URL",
                            input: String::from_utf16_lossy(raw).encode_utf16().collect(),
                        });
                        break;
                    }
                }
            }
            if kind == "github" && required_text {
                if let (Some(url), Some(repository), Some(number)) =
                    (url, textual.get("repository"), number)
                {
                    let expected = format!("https://github.com/{repository}/issues/{number}");
                    if !url.as_str().eq_ignore_ascii_case(&expected)
                        || !url.username().is_empty()
                        || url.password().is_some()
                    {
                        issues.push(custom_issue(
                            &child(path, "url"),
                            "Issue URL must match its tracker identity",
                        ));
                    }
                }
            } else if kind == "jira"
                && required_text
                && let (Some(url), Some(site), Some(key)) =
                    (url, textual.get("site"), textual.get("key"))
                && let Ok(site_url) = url::Url::parse(site)
            {
                let expected = format!("{}/browse/{key}", site_url.origin().ascii_serialization());
                if url.as_str() != expected
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    issues.push(custom_issue(
                        &child(path, "url"),
                        "Issue URL must match its tracker identity",
                    ));
                }
                if site_url.scheme() != "https"
                    || !site_url
                        .host_str()
                        .is_some_and(|host| host.ends_with(".atlassian.net"))
                    || !site_url.username().is_empty()
                    || site_url.password().is_some()
                    || site_url.query().is_some()
                    || site_url.fragment().is_some()
                    || site_url.path() != "/"
                {
                    issues.push(custom_issue(&child(path, "site"), "Use a Jira Cloud site"));
                }
            }
        }
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }

    fn issue_url_field(
        &mut self,
        object: usize,
        field: IssueUrlField,
        path: &[Value],
        fields: &mut Vec<(&'static str, usize)>,
        textual: &mut std::collections::HashMap<&'static str, String>,
        issues: &mut IssueList,
    ) {
        let name = match field {
            IssueUrlField::JiraSite => "site",
            IssueUrlField::GithubUrl | IssueUrlField::JiraUrl => "url",
        };
        let github_refine = matches!(field, IssueUrlField::GithubUrl);
        let field_path = child(path, name);
        match self.string(self.field(object, name), &field_path, 0, None) {
            Ok(value) => {
                fields.push((name, value));
                let JsNode::String(raw) = self.source.node(value) else {
                    unreachable!()
                };
                let text = String::from_utf16_lossy(raw);
                match url::Url::parse(&text) {
                    Ok(url) => {
                        if github_refine
                            && url.origin().ascii_serialization() != "https://github.com"
                        {
                            issues.push(custom_issue(&field_path, "Invalid input"));
                        }
                    }
                    Err(_) => {
                        issues.push(json!({"code":"invalid_format","format":"url","path":field_path,"message":"Invalid URL"}));
                        if github_refine {
                            self.thrown = Some(JsThrown {
                                name: "TypeError",
                                code: "ERR_INVALID_URL",
                                message: "Invalid URL",
                                input: text.encode_utf16().collect(),
                            });
                        }
                    }
                }
                textual.insert(name, text);
            }
            Err(error) => issues.extend(error),
        }
    }
}

fn child(path: &[Value], name: &str) -> Path {
    let mut output = path.to_vec();
    output.push(json!(name));
    output
}
fn indexed(path: &[Value], index: usize) -> Path {
    let mut output = path.to_vec();
    output.push(json!(index));
    output
}
fn array_max_issue(path: &[Value], max: usize) -> Value {
    json!({"origin":"array","code":"too_big","maximum":max,"inclusive":true,"path":path,"message":format!("Too big: expected array to have <={max} items")})
}
fn regex_issue(path: &[Value], pattern: &str) -> Value {
    json!({"origin":"string","code":"invalid_format","format":"regex","pattern":pattern,"path":path,"message":format!("Invalid string: must match pattern {pattern}")})
}
fn custom_issue(path: &[Value], message: &str) -> Value {
    json!({"code":"custom","message":message,"path":path})
}
fn discriminator_issue(path: &[Value], name: &str, options: &[&str]) -> Value {
    json!({"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":name,"options":options,"path":path,"message":format!("Invalid discriminator value. Expected {}",options.iter().map(|option|format!("'{option}'")).collect::<Vec<_>>().join(" | "))})
}
