use serde_json::{Value, json};

use crate::shared::js_json::{JsDocument, JsNode};

use super::js_issues::{IssueList, JsIssueContext, issue_document, object_node};
use super::{DetailedJsParseResult, JsContractFailure};

type NodeResult = Result<usize, IssueList>;
type Path = Vec<Value>;

pub(super) fn validate_detailed(
    contract: &str,
    input: Option<&JsDocument>,
) -> Option<DetailedJsParseResult> {
    if !matches!(
        contract,
        "tasks.TaskWorkerReplacementBodySchema"
            | "tasks.TaskCoordinatorReplacementBodySchema"
            | "tasks.TaskAgentSelectionBodySchema"
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
        "tasks.TaskWorkerReplacementBodySchema" => parser.worker(source.root(), &[]),
        "tasks.TaskCoordinatorReplacementBodySchema" => parser.coordinator(source.root(), &[]),
        "tasks.TaskAgentSelectionBodySchema" => parser.selection(source.root(), &[]),
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

    fn string(&self, node: Option<usize>, path: &[Value]) -> NodeResult {
        self.core().string(node, path, 1, None)
    }

    fn trimmed(&mut self, node: Option<usize>, path: &[Value], min: usize) -> NodeResult {
        JsIssueContext::new(self.source).trimmed_string(&mut self.output, node, path, min, None)
    }

    fn worker(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        for name in ["sessionId", "reason", "handoff", "workerProfileId"] {
            let value = self.field(object, name);
            if value.is_none() && matches!(name, "handoff" | "workerProfileId") {
                continue;
            }
            let field_path = child(path, name);
            let result = if matches!(name, "reason" | "handoff") {
                self.trimmed(value, &field_path, usize::from(name == "reason"))
            } else {
                self.string(value, &field_path)
            };
            match result {
                Ok(value) => fields.push((name, value)),
                Err(error) => issues.extend(error),
            }
        }
        issues.extend(self.core().strict(
            object,
            path,
            &["sessionId", "reason", "handoff", "workerProfileId"],
        ));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }

    fn resume(&self, object: usize, path: &[Value]) -> Result<(usize, bool), IssueList> {
        let field = self.field(object, "resume");
        if let Some(value) = field
            && let JsNode::Bool(resume) = self.source.node(value)
        {
            return Ok((value, *resume));
        }
        Err(vec![json!({
            "code":"invalid_union","errors":[],"note":"No matching discriminator",
            "discriminator":"resume","options":[false,true],"path":child(path,"resume"),
            "message":"Invalid discriminator value. Expected 'false' | 'true'"
        })]
        .into())
    }

    fn coordinator(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let (resume_node, resume) = self.resume(object, path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        for name in ["sessionId", "rootProfileId", "handoff"] {
            let value = self.field(object, name);
            if name == "handoff" && value.is_none() {
                continue;
            }
            let field_path = child(path, name);
            let result = if name == "handoff" {
                self.trimmed(value, &field_path, 0)
            } else {
                self.string(value, &field_path)
            };
            match result {
                Ok(value) => fields.push((name, value)),
                Err(error) => issues.extend(error),
            }
        }
        fields.push(("resume", resume_node));
        if resume {
            match self.string(self.field(object, "questionId"), &child(path, "questionId")) {
                Ok(value) => fields.push(("questionId", value)),
                Err(error) => issues.extend(error),
            }
        }
        let known = if resume {
            &[
                "sessionId",
                "rootProfileId",
                "handoff",
                "resume",
                "questionId",
            ][..]
        } else {
            &["sessionId", "rootProfileId", "handoff", "resume"][..]
        };
        issues.extend(self.core().strict(object, path, known));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }

    fn selection(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let (resume_node, resume) = self.resume(object, path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.core().enumeration(
            self.field(object, "role"),
            &child(path, "role"),
            &[
                "root",
                "worker",
                "reviewer",
                "planner_a",
                "planner_b",
                "rater",
            ],
        ) {
            Ok(value) => fields.push(("role", value)),
            Err(error) => issues.extend(error),
        }
        match self.string(
            self.field(object, "expectedProfileId"),
            &child(path, "expectedProfileId"),
        ) {
            Ok(value) => fields.push(("expectedProfileId", value)),
            Err(error) => issues.extend(error),
        }
        let expected_session = self.field(object, "expectedSessionId");
        if let Some(value) = expected_session
            && matches!(self.source.node(value), JsNode::Null)
        {
            fields.push(("expectedSessionId", value));
        } else {
            match self.string(expected_session, &child(path, "expectedSessionId")) {
                Ok(value) => fields.push(("expectedSessionId", value)),
                Err(error) => issues.extend(error),
            }
        }
        match self.string(self.field(object, "profileId"), &child(path, "profileId")) {
            Ok(value) => fields.push(("profileId", value)),
            Err(error) => issues.extend(error),
        }
        let direction = self.field(object, "direction");
        match self.trimmed(direction, &child(path, "direction"), 0) {
            Ok(value) => fields.push(("direction", value)),
            Err(error) => issues.extend(error),
        }
        fields.push(("resume", resume_node));
        if resume {
            match self.string(self.field(object, "questionId"), &child(path, "questionId")) {
                Ok(value) => fields.push(("questionId", value)),
                Err(error) => issues.extend(error),
            }
        }
        let known = if resume {
            &[
                "role",
                "expectedProfileId",
                "expectedSessionId",
                "profileId",
                "direction",
                "resume",
                "questionId",
            ][..]
        } else {
            &[
                "role",
                "expectedProfileId",
                "expectedSessionId",
                "profileId",
                "direction",
                "resume",
            ][..]
        };
        issues.extend(self.core().strict(object, path, known));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
}

fn child(path: &[Value], segment: &str) -> Path {
    let mut output = path.to_vec();
    output.push(json!(segment));
    output
}
