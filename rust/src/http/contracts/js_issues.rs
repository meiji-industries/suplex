use serde_json::{Value, json};

use crate::shared::js_json::{self, JsDocument, JsNode};

pub(super) struct JsIssueContext<'a> {
    source: &'a JsDocument,
}

impl<'a> JsIssueContext<'a> {
    pub(super) fn new(source: &'a JsDocument) -> Self {
        Self { source }
    }

    pub(super) fn invalid_type(
        &self,
        expected: &str,
        node: Option<usize>,
        path: &[Value],
    ) -> Value {
        let received = node.map_or("undefined", |index| self.source.value_type(index));
        json!({
            "expected": expected, "code": "invalid_type", "path": path,
            "message": format!("Invalid input: expected {expected}, received {received}")
        })
    }

    pub(super) fn object(&self, node: Option<usize>, path: &[Value]) -> Result<usize, IssueList> {
        match node {
            Some(index) if matches!(self.source.node(index), JsNode::Object(_)) => Ok(index),
            _ => Err(vec![self.invalid_type("object", node, path)].into()),
        }
    }

    pub(super) fn string(
        &self,
        node: Option<usize>,
        path: &[Value],
        min: usize,
        max: Option<usize>,
    ) -> Result<usize, IssueList> {
        let Some(index) = node else {
            return Err(vec![self.invalid_type("string", None, path)].into());
        };
        let JsNode::String(value) = self.source.node(index) else {
            let mut issues = IssueList::new();
            issues.push(self.invalid_type("string", node, path));
            if let JsNode::Array(items) = self.source.node(index) {
                if items.len() < min {
                    issues.push(json!({"origin":"array", "code":"too_small", "minimum":min, "inclusive":true, "path":path, "message":format!("Too small: expected array to have >={min} items")}));
                }
                if let Some(max) = max
                    && items.len() > max
                {
                    issues.push(json!({"origin":"array", "code":"too_big", "maximum":max, "inclusive":true, "path":path, "message":format!("Too big: expected array to have <={max} items")}));
                }
            }
            return Err(issues);
        };
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
            Ok(index)
        } else {
            Err(issues)
        }
    }

    pub(super) fn strict(&self, object: usize, path: &[Value], known: &[&str]) -> IssueList {
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
        issues.push_strict(json!({"code":"unrecognized_keys", "keys":unknown, "path":path,
            "message":format!("Unrecognized key{}: {quoted}", if unknown.len() == 1 { "" } else { "s" })}), raw);
        issues
    }
}

#[derive(Default)]
pub(super) struct IssueList {
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
    pub(super) fn new() -> Self {
        Self::default()
    }
    pub(super) fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
    pub(super) fn push(&mut self, value: Value) {
        self.values.push(value);
        self.metadata.push(IssueMeta::default());
    }
    pub(super) fn push_record(&mut self, value: Value, key: &[u16]) {
        self.values.push(value);
        self.metadata.push(IssueMeta {
            raw_record_key: Some(key.to_vec()),
            ..IssueMeta::default()
        });
    }
    pub(super) fn push_strict(&mut self, value: Value, keys: Vec<Vec<u16>>) {
        self.values.push(value);
        self.metadata.push(IssueMeta {
            raw_strict_keys: Some(keys),
            ..IssueMeta::default()
        });
    }
    pub(super) fn mark_record(&mut self, key: &[u16]) {
        for meta in &mut self.metadata {
            meta.raw_record_key = Some(key.to_vec());
        }
    }
    pub(super) fn extend(&mut self, other: Self) {
        self.values.extend(other.values);
        self.metadata.extend(other.metadata);
    }
    pub(super) fn union(branches: Vec<Self>, path: &[Value]) -> Self {
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
pub(super) fn issue_document(issues: IssueList) -> JsDocument {
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
