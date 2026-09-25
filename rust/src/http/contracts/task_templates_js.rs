use serde_json::{Value, json};

use crate::shared::js_json::{JsDocument, JsNode};

use super::js_issues::{
    IssueList, JsIssueContext, advisor_profile_ids, issue_document, object_node,
};
use super::{DetailedJsParseResult, JsContractFailure};

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

pub(super) fn validate_detailed(
    contract: &str,
    input: Option<&JsDocument>,
) -> Option<DetailedJsParseResult> {
    if !matches!(
        contract,
        "task-templates.TaskTemplateParamsSchema"
            | "task-templates.ProjectTaskTemplatesParamsSchema"
            | "task-templates.SaveTaskAsTemplateParamsSchema"
            | "task-templates.SaveTaskAsTemplateBodySchema"
            | "task-templates.CreateTaskTemplateBodySchema"
            | "task-templates.UpdateTaskTemplateBodySchema"
            | "task-templates.TaskTemplateResponseSchema"
            | "task-templates.TaskTemplateListResponseSchema"
    ) {
        return None;
    }
    let Some(source) = input else {
        return Some(Err(JsContractFailure::Issues(issue_document(
            vec![json!({"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received undefined"})].into(),
        ))));
    };
    let mut parser = Parser {
        source,
        output: source.clone(),
    };
    let result = match contract {
        "task-templates.TaskTemplateParamsSchema" => {
            parser.params(source.root(), &[], "templateId")
        }
        "task-templates.ProjectTaskTemplatesParamsSchema" => {
            parser.params(source.root(), &[], "projectId")
        }
        "task-templates.SaveTaskAsTemplateParamsSchema" => {
            parser.params(source.root(), &[], "taskId")
        }
        "task-templates.SaveTaskAsTemplateBodySchema" => parser.save(source.root(), &[]),
        "task-templates.CreateTaskTemplateBodySchema" => {
            parser.template(source.root(), &[], Mode::Create)
        }
        "task-templates.UpdateTaskTemplateBodySchema" => {
            parser.template(source.root(), &[], Mode::Patch)
        }
        "task-templates.TaskTemplateResponseSchema" => {
            parser.template(source.root(), &[], Mode::Response)
        }
        "task-templates.TaskTemplateListResponseSchema" => parser.list(source.root(), &[]),
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
    Create,
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
    fn default_string(&mut self, value: &str) -> usize {
        self.output
            .append_node(JsNode::String(value.encode_utf16().collect()))
    }
    fn params(&mut self, node: usize, path: &[Value], name: &'static str) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let value = self
            .core()
            .string(self.field(object, name), &child(path, name), 1, None)?;
        Ok(object_node(&mut self.output, vec![(name, value)]))
    }
    fn save(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        let name = self.field(object, "name");
        match JsIssueContext::new(self.source).trimmed_string(
            &mut self.output,
            name,
            &child(path, "name"),
            1,
            None,
        ) {
            Ok(value) => fields.push(("name", value)),
            Err(error) => issues.extend(error),
        }
        issues.extend(self.core().strict(object, path, &["name"]));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn template(&mut self, node: usize, path: &[Value], mode: Mode) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        let patch = mode == Mode::Patch;
        // TaskInputSchema.pick keeps TaskInput's field order. extend appends name and response fields.
        if patch {
            self.name(object, path, false, &mut fields, &mut issues);
        }
        if !patch || self.field(object, "description").is_some() {
            let value = self.field(object, "description");
            match value {
                Some(value) => match JsIssueContext::new(self.source).trimmed_string(
                    &mut self.output,
                    Some(value),
                    &child(path, "description"),
                    if patch { 1 } else { 0 },
                    None,
                ) {
                    Ok(value) => fields.push(("description", value)),
                    Err(error) => issues.extend(error),
                },
                None => fields.push(("description", self.default_string(""))),
            }
        }
        for name in ["rootProfileId", "workerProfileId"] {
            if let Some(value) = self.field(object, name) {
                let result = if patch && matches!(self.source.node(value), JsNode::Null) {
                    Ok(value)
                } else {
                    self.core().string(
                        Some(value),
                        &child(path, name),
                        1,
                        if patch { None } else { Some(256) },
                    )
                };
                match result {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        self.enum_field(
            object,
            path,
            "deliveryTarget",
            DELIVERY_TARGETS,
            if patch {
                None
            } else {
                Some("pull_request_draft")
            },
            &mut fields,
            &mut issues,
        );
        if let Some(value) = self.field(object, "runProjectTests") {
            match self
                .core()
                .boolean(Some(value), &child(path, "runProjectTests"))
            {
                Ok(value) => fields.push(("runProjectTests", value)),
                Err(error) => issues.extend(error),
            }
        } else if !patch {
            fields.push((
                "runProjectTests",
                self.output.append_node(JsNode::Bool(true)),
            ));
        }
        self.enum_field(
            object,
            path,
            "visualEvidence",
            VISUAL_EVIDENCE,
            if patch { None } else { Some("off") },
            &mut fields,
            &mut issues,
        );
        self.enum_field(
            object,
            path,
            "workflow",
            WORKFLOWS,
            if patch { None } else { Some("standard") },
            &mut fields,
            &mut issues,
        );
        if let Some(value) = self.field(object, "advisorProfileIds") {
            match advisor_profile_ids(
                self.source,
                &mut self.output,
                value,
                &child(path, "advisorProfileIds"),
            ) {
                Ok(value) => fields.push(("advisorProfileIds", value)),
                Err(error) => issues.extend(error),
            }
        } else if !patch {
            fields.push((
                "advisorProfileIds",
                object_node(&mut self.output, Vec::new()),
            ));
        }
        if !patch {
            self.name(object, path, true, &mut fields, &mut issues);
        }
        if mode == Mode::Response {
            for name in ["id", "projectId", "createdAt", "updatedAt"] {
                match self
                    .core()
                    .string(self.field(object, name), &child(path, name), 0, None)
                {
                    Ok(value) => fields.push((name, value)),
                    Err(error) => issues.extend(error),
                }
            }
        }
        let known: &[&str] = if mode == Mode::Response {
            &[
                "description",
                "rootProfileId",
                "workerProfileId",
                "deliveryTarget",
                "runProjectTests",
                "visualEvidence",
                "workflow",
                "advisorProfileIds",
                "name",
                "id",
                "projectId",
                "createdAt",
                "updatedAt",
            ]
        } else {
            &[
                "description",
                "rootProfileId",
                "workerProfileId",
                "deliveryTarget",
                "runProjectTests",
                "visualEvidence",
                "workflow",
                "advisorProfileIds",
                "name",
            ]
        };
        issues.extend(self.core().strict(object, path, known));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn name(
        &mut self,
        object: usize,
        path: &[Value],
        required: bool,
        fields: &mut Vec<(&'static str, usize)>,
        issues: &mut IssueList,
    ) {
        if required || self.field(object, "name").is_some() {
            let name = self.field(object, "name");
            match JsIssueContext::new(self.source).trimmed_string(
                &mut self.output,
                name,
                &child(path, "name"),
                1,
                None,
            ) {
                Ok(value) => fields.push(("name", value)),
                Err(error) => issues.extend(error),
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn enum_field(
        &mut self,
        object: usize,
        path: &[Value],
        name: &'static str,
        options: &[&str],
        default: Option<&str>,
        fields: &mut Vec<(&'static str, usize)>,
        issues: &mut IssueList,
    ) {
        if let Some(value) = self.field(object, name) {
            match self
                .core()
                .enumeration(Some(value), &child(path, name), options)
            {
                Ok(value) => fields.push((name, value)),
                Err(error) => issues.extend(error),
            }
        } else if let Some(default) = default {
            fields.push((name, self.default_string(default)));
        }
    }
    fn list(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let array_path = child(path, "templates");
        let Some(array) = self.field(object, "templates") else {
            return Err(vec![self.core().invalid_type("array", None, &array_path)].into());
        };
        let JsNode::Array(items) = self.source.node(array) else {
            return Err(vec![self.core().invalid_type("array", Some(array), &array_path)].into());
        };
        let mut values = Vec::new();
        let mut issues = IssueList::new();
        for (position, item) in items.iter().copied().enumerate() {
            match self.template(item, &index(&array_path, position), Mode::Response) {
                Ok(value) => values.push(value),
                Err(error) => issues.extend(error),
            }
        }
        if issues.is_empty() {
            let array = self.output.append_node(JsNode::Array(values));
            Ok(object_node(&mut self.output, vec![("templates", array)]))
        } else {
            Err(issues)
        }
    }
}

fn child(path: &[Value], segment: &str) -> Path {
    let mut result = path.to_vec();
    result.push(json!(segment));
    result
}
fn index(path: &[Value], position: usize) -> Path {
    let mut result = path.to_vec();
    result.push(json!(position));
    result
}
