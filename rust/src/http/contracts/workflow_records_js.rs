use serde_json::{Value, json};

use crate::shared::js_json::{JsDocument, JsNode};

use super::js_issues::{IssueList, JsIssueContext, issue_document};
use super::{DetailedJsParseResult, JsContractFailure};

type NodeResult = Result<usize, IssueList>;
type Path = Vec<Value>;

const ENGINES: &[&str] = &[
    "standard",
    "direct_build",
    "independent_review",
    "competing_plans",
    "refine_pull_request",
];
const DELIVERY_TARGETS: &[&str] = &[
    "local_worktree",
    "remote_branch",
    "pull_request_draft",
    "pull_request_ready",
    "merged",
];
const VISUAL_EVIDENCE: &[&str] = &["off", "capture", "required"];

pub(super) fn validate_detailed(
    contract: &str,
    input: Option<&JsDocument>,
) -> Option<DetailedJsParseResult> {
    if !matches!(
        contract,
        "workflows.WorkflowRecordInputSchema"
            | "workflows.WorkflowRecordPatchSchema"
            | "workflows.WorkflowRecordSchema"
            | "workflows.WorkflowRecordParamsSchema"
            | "workflows.WorkflowListQuerySchema"
            | "workflows.WorkflowListResponseSchema"
    ) {
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
    };
    let root = source.root();
    let result = match contract {
        "workflows.WorkflowRecordInputSchema" => parser.record(root, &[], Mode::Input),
        "workflows.WorkflowRecordPatchSchema" => parser.record(root, &[], Mode::Patch),
        "workflows.WorkflowRecordSchema" => parser.record(root, &[], Mode::Response),
        "workflows.WorkflowRecordParamsSchema" => parser.params(root, &[]),
        "workflows.WorkflowListQuerySchema" => parser.list_query(root, &[]),
        "workflows.WorkflowListResponseSchema" => parser.list_response(root, &[]),
        _ => unreachable!(),
    };
    Some(match result {
        Ok(root) => {
            parser.output.set_root(root);
            Ok(parser.output)
        }
        Err(issues) => Err(JsContractFailure::Issues(issue_document(issues))),
    })
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Mode {
    Input,
    Patch,
    Response,
}

struct Parser<'a> {
    source: &'a JsDocument,
    output: JsDocument,
}

impl Parser<'_> {
    fn core(&self) -> JsIssueContext<'_> {
        JsIssueContext::new(self.source)
    }
    fn field(&self, object: usize, name: &str) -> Option<usize> {
        self.source.get(object, name)
    }
    fn object_node(&mut self, fields: Vec<(&str, usize)>) -> usize {
        self.output.append_node(JsNode::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name.encode_utf16().collect(), value))
                .collect(),
        ))
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
    fn trimmed_string(
        &mut self,
        node: Option<usize>,
        path: &[Value],
        min: usize,
        max: Option<usize>,
    ) -> NodeResult {
        if !node.is_some_and(|index| matches!(self.source.node(index), JsNode::String(_))) {
            return self.string(node, path, min, max);
        }
        let index = self.string(node, path, 0, None)?;
        let JsNode::String(raw) = self.source.node(index) else {
            unreachable!()
        };
        let start = raw
            .iter()
            .position(|unit| !js_space(*unit))
            .unwrap_or(raw.len());
        let end = raw
            .iter()
            .rposition(|unit| !js_space(*unit))
            .map_or(start, |index| index + 1);
        let value = raw[start..end].to_vec();
        let mut issues = IssueList::new();
        if value.len() < min {
            issues.push(json!({"origin":"string", "code":"too_small", "minimum":min, "inclusive":true, "path":path, "message":format!("Too small: expected string to have >={min} characters")}));
        }
        if let Some(max) = max
            && value.len() > max
        {
            issues.push(json!({"origin":"string", "code":"too_big", "maximum":max, "inclusive":true, "path":path, "message":format!("Too big: expected string to have <={max} characters")}));
        }
        if issues.is_empty() {
            Ok(self.output.append_node(JsNode::String(value)))
        } else {
            Err(issues)
        }
    }
    fn enumeration(&self, node: Option<usize>, path: &[Value], options: &[&str]) -> NodeResult {
        if let Some(index) = node
            && let JsNode::String(value) = self.source.node(index)
            && options
                .iter()
                .any(|option| value.iter().copied().eq(option.encode_utf16()))
        {
            return Ok(index);
        }
        Err(vec![json!({"code":"invalid_value", "values":options, "path":path,
            "message":format!("Invalid option: expected one of {}", options.iter().map(|option| format!("\"{option}\"")).collect::<Vec<_>>().join("|"))})].into())
    }
    fn boolean(&self, node: Option<usize>, path: &[Value]) -> NodeResult {
        match node {
            Some(index) if matches!(self.source.node(index), JsNode::Bool(_)) => Ok(index),
            _ => Err(vec![self.core().invalid_type("boolean", node, path)].into()),
        }
    }
    fn nullable(
        &self,
        node: Option<usize>,
        path: &[Value],
        parse: impl FnOnce(&Self, Option<usize>, &[Value]) -> NodeResult,
    ) -> NodeResult {
        if let Some(index) = node
            && matches!(self.source.node(index), JsNode::Null)
        {
            Ok(index)
        } else {
            parse(self, node, path)
        }
    }
    fn advisors(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        for name in ["reviewer", "planner_a", "planner_b", "rater"] {
            if let Some(value) = self.field(object, name) {
                match self.string(Some(value), &child(path, name), 1, Some(256)) {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        issues.extend(self.core().strict(
            object,
            path,
            &["reviewer", "planner_a", "planner_b", "rater"],
        ));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }
    fn record(&mut self, node: usize, path: &[Value], mode: Mode) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        let patch = mode == Mode::Patch;
        if !patch || self.field(object, "name").is_some() {
            match self.trimmed_string(
                self.field(object, "name"),
                &child(path, "name"),
                1,
                Some(80),
            ) {
                Ok(value) => fields.push(("name", value)),
                Err(error) => issues.extend(error),
            }
        }
        match self.field(object, "description") {
            Some(value) => {
                match self.trimmed_string(Some(value), &child(path, "description"), 0, None) {
                    Ok(value) => fields.push(("description", value)),
                    Err(error) => issues.extend(error),
                }
            }
            None if !patch => fields.push((
                "description",
                self.output.append_node(JsNode::String(Vec::new())),
            )),
            None => {}
        }
        if !patch || self.field(object, "engine").is_some() {
            match self.enumeration(
                self.field(object, "engine"),
                &child(path, "engine"),
                ENGINES,
            ) {
                Ok(value) => fields.push(("engine", value)),
                Err(error) => issues.extend(error),
            }
        }
        for name in ["rootProfileId", "workerProfileId"] {
            if let Some(value) = self.field(object, name) {
                let field_path = child(path, name);
                let result = if patch {
                    self.nullable(Some(value), &field_path, |parser, node, path| {
                        parser.string(node, path, 1, None)
                    })
                } else {
                    self.string(Some(value), &field_path, 1, None)
                };
                match result {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        match self.field(object, "advisorProfileIds") {
            Some(value) => match self.advisors(value, &child(path, "advisorProfileIds")) {
                Ok(value) => fields.push(("advisorProfileIds", value)),
                Err(error) => issues.extend(error),
            },
            None if !patch => fields.push(("advisorProfileIds", self.object_node(Vec::new()))),
            None => {}
        }
        for (name, options) in [
            ("deliveryTarget", DELIVERY_TARGETS),
            ("visualEvidence", VISUAL_EVIDENCE),
        ] {
            if let Some(value) = self.field(object, name) {
                let path = child(path, name);
                let result = if patch {
                    self.nullable(Some(value), &path, |parser, node, path| {
                        parser.enumeration(node, path, options)
                    })
                } else {
                    self.enumeration(Some(value), &path, options)
                };
                match result {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
            if name == "deliveryTarget"
                && let Some(value) = self.field(object, "runProjectTests")
            {
                let path = child(path, "runProjectTests");
                let result = if patch {
                    self.nullable(Some(value), &path, |parser, node, path| {
                        parser.boolean(node, path)
                    })
                } else {
                    self.boolean(Some(value), &path)
                };
                match result {
                    Ok(value) => fields.push(("runProjectTests", value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        if patch && let Some(value) = self.field(object, "archived") {
            match self.boolean(Some(value), &child(path, "archived")) {
                Ok(value) => fields.push(("archived", value)),
                Err(error) => issues.extend(error),
            }
        }
        if mode == Mode::Response {
            for name in ["id", "archivedAt", "createdAt", "updatedAt"] {
                let node = self.field(object, name);
                let result = if name == "archivedAt" {
                    self.nullable(node, &child(path, name), |parser, node, path| {
                        parser.string(node, path, 0, None)
                    })
                } else {
                    self.string(node, &child(path, name), 0, None)
                };
                match result {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        let known = if mode == Mode::Response {
            vec![
                "name",
                "description",
                "engine",
                "rootProfileId",
                "workerProfileId",
                "advisorProfileIds",
                "deliveryTarget",
                "runProjectTests",
                "visualEvidence",
                "id",
                "archivedAt",
                "createdAt",
                "updatedAt",
            ]
        } else if patch {
            vec![
                "name",
                "description",
                "engine",
                "rootProfileId",
                "workerProfileId",
                "advisorProfileIds",
                "deliveryTarget",
                "runProjectTests",
                "visualEvidence",
                "archived",
            ]
        } else {
            vec![
                "name",
                "description",
                "engine",
                "rootProfileId",
                "workerProfileId",
                "advisorProfileIds",
                "deliveryTarget",
                "runProjectTests",
                "visualEvidence",
            ]
        };
        issues.extend(self.core().strict(object, path, &known));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }
    fn params(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let value = self.string(
            self.field(object, "workflowId"),
            &child(path, "workflowId"),
            1,
            None,
        )?;
        Ok(self.object_node(vec![("workflowId", value)]))
    }
    fn list_query(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        if let Some(value) = self.field(object, "includeArchived") {
            if matches!(self.source.node(value), JsNode::String(text) if text.iter().copied().eq("true".encode_utf16()))
            {
                fields.push(("includeArchived", value));
            } else {
                issues.push(json!({"code":"invalid_value", "values":["true"], "path":child(path,"includeArchived"), "message":"Invalid input: expected \"true\""}));
            }
        }
        issues.extend(self.core().strict(object, path, &["includeArchived"]));
        if issues.is_empty() {
            Ok(self.object_node(fields))
        } else {
            Err(issues)
        }
    }
    fn list_response(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let Some(array) = self.field(object, "workflows") else {
            return Err(vec![
                self.core()
                    .invalid_type("array", None, &child(path, "workflows")),
            ]
            .into());
        };
        let JsNode::Array(items) = self.source.node(array) else {
            return Err(vec![self.core().invalid_type(
                "array",
                Some(array),
                &child(path, "workflows"),
            )]
            .into());
        };
        let mut parsed = Vec::new();
        let mut issues = IssueList::new();
        for (position, item) in items.iter().copied().enumerate() {
            let mut item_path = child(path, "workflows");
            item_path.push(json!(position));
            match self.record(item, &item_path, Mode::Response) {
                Ok(value) => parsed.push(value),
                Err(error) => issues.extend(error),
            }
        }
        if !issues.is_empty() {
            return Err(issues);
        }
        let value = self.output.append_node(JsNode::Array(parsed));
        Ok(self.object_node(vec![("workflows", value)]))
    }
}

fn child(path: &[Value], name: &str) -> Path {
    let mut output = path.to_vec();
    output.push(json!(name));
    output
}

fn js_space(unit: u16) -> bool {
    unit == 0xfeff
        || (char::from_u32(u32::from(unit)).is_some_and(char::is_whitespace) && unit != 0x85)
}
