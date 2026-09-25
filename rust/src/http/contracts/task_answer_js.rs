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
    if contract != "tasks.TaskAnswerBodySchema" {
        return None;
    }
    let Some(source) = input else {
        let missing = vec![json!({"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received undefined"})].into();
        return Some(Err(JsContractFailure::Issues(issue_document(IssueList::union(vec![missing, vec![json!({"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received undefined"})].into()], &[])))));
    };
    let mut parser = Parser {
        source,
        output: source.clone(),
    };
    let first = parser.answer(source.root(), &[]);
    let second = parser.decision(source.root(), &[]);
    let result = match (first, second) {
        (Ok(root), _) | (_, Ok(root)) => Ok(root),
        (Err(first), Err(second)) if first.is_continuable() && !second.is_continuable() => {
            Err(first)
        }
        (Err(first), Err(second)) if second.is_continuable() && !first.is_continuable() => {
            Err(second)
        }
        (Err(first), Err(second)) => Err(IssueList::union(vec![first, second], &[])),
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
    fn answer(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.core().string(
            self.field(object, "questionId"),
            &child(path, "questionId"),
            1,
            None,
        ) {
            Ok(value) => fields.push(("questionId", value)),
            Err(error) => issues.extend(error),
        }
        let answer = self.field(object, "answer");
        match JsIssueContext::new(self.source).trimmed_string(
            &mut self.output,
            answer,
            &child(path, "answer"),
            1,
            None,
        ) {
            Ok(value) => fields.push(("answer", value)),
            Err(error) => issues.extend(error),
        }
        if let Some(value) = self.field(object, "confirmCommandsStopped") {
            match self
                .core()
                .boolean(Some(value), &child(path, "confirmCommandsStopped"))
            {
                Ok(value) => fields.push(("confirmCommandsStopped", value)),
                Err(error) => issues.extend(error),
            }
        }
        issues.extend(self.core().strict(
            object,
            path,
            &["questionId", "answer", "confirmCommandsStopped"],
        ));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn decision(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        match self.core().string(
            self.field(object, "questionId"),
            &child(path, "questionId"),
            1,
            None,
        ) {
            Ok(value) => fields.push(("questionId", value)),
            Err(error) => issues.extend(error),
        }
        match self.field(object, "limitDecision") {
            Some(value) => match self.limit_decision(value, &child(path, "limitDecision")) {
                Ok(value) => fields.push(("limitDecision", value)),
                Err(error) => issues.extend(error),
            },
            None => issues.push(json!({
                "code":"invalid_type","expected":"object","path":child(path,"limitDecision"),
                "message":"Invalid input: expected object, received undefined"
            })),
        }
        issues.extend(
            self.core()
                .strict(object, path, &["questionId", "limitDecision"]),
        );
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn limit_decision(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let kind = self
            .field(object, "kind")
            .and_then(|index| match self.source.node(index) {
                JsNode::String(value) => Some(String::from_utf16_lossy(value)),
                _ => None,
            });
        let Some(kind @ ("add_allowance" | "change_limits" | "cancel_task")) = kind.as_deref()
        else {
            return Err(vec![json!({"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":"kind","options":["add_allowance","change_limits","cancel_task"],"path":child(path,"kind"),"message":"Invalid discriminator value. Expected 'add_allowance' | 'change_limits' | 'cancel_task'"})].into());
        };
        let mut fields = vec![("kind", self.field(object, "kind").unwrap())];
        let mut issues = IssueList::new();
        if kind == "change_limits" {
            match self.field(object, "limits") {
                Some(value) => match self.limits(value, &child(path, "limits")) {
                    Ok(value) => fields.push(("limits", value)),
                    Err(error) => issues.extend(error),
                },
                None => issues.push(self.core().invalid_type(
                    "object",
                    None,
                    &child(path, "limits"),
                )),
            }
        }
        let known = if kind == "change_limits" {
            &["kind", "limits"][..]
        } else {
            &["kind"][..]
        };
        issues.extend(self.core().strict(object, path, known));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn limits(&mut self, node: usize, path: &[Value]) -> NodeResult {
        let object = self.core().object(Some(node), path)?;
        let mut fields = Vec::new();
        let mut issues = IssueList::new();
        for (name, integer) in [("budgetUsd", false), ("maxTurns", true)] {
            match self.nonnegative(self.field(object, name), &child(path, name), integer) {
                Ok(value) => fields.push((name, value)),
                Err(error) => issues.extend(error),
            }
        }
        issues.extend(self.core().strict(object, path, &["budgetUsd", "maxTurns"]));
        if issues.is_empty() {
            Ok(object_node(&mut self.output, fields))
        } else {
            Err(issues)
        }
    }
    fn nonnegative(&self, node: Option<usize>, path: &[Value], integer: bool) -> NodeResult {
        let Some(index) = node else {
            return Err(vec![self.core().invalid_type("number", None, path)].into());
        };
        let JsNode::Number(value) = self.source.node(index) else {
            return Err(vec![self.core().invalid_type("number", node, path)].into());
        };
        if !value.is_finite() {
            return Err(vec![json!({"expected":"number","code":"invalid_type","received":"Infinity","path":path,"message":"Invalid input: expected number, received number"})].into());
        }
        if integer && value.fract() != 0.0 {
            return Err(vec![json!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"})].into());
        }
        let mut issues = IssueList::new();
        if integer && *value > 9_007_199_254_740_991.0 {
            issues.push(json!({"origin":"int","code":"too_big","maximum":9_007_199_254_740_991_u64,"note":"Integers must be within the safe integer range.","inclusive":true,"path":path,"message":"Too big: expected int to be <=9007199254740991"}));
        }
        if integer && *value < -9_007_199_254_740_991.0 {
            issues.push(json!({"origin":"int","code":"too_small","minimum":-9_007_199_254_740_991_i64,"note":"Integers must be within the safe integer range.","inclusive":true,"path":path,"message":"Too small: expected int to be >=-9007199254740991"}));
        }
        if *value < 0.0 {
            issues.push(json!({"origin":"number","code":"too_small","minimum":0,"inclusive":true,"path":path,"message":"Too small: expected number to be >=0"}));
        }
        if issues.is_empty() {
            Ok(index)
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
