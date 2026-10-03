//! One request-validation mechanism. `Fields` reads a JSON object one declared
//! field at a time, keeps every finding with its field path, and returns the
//! normalized object (trimmed text, defaults applied) that Zod would output.
//! Serde then builds the typed request from that object (`Contract::parse`).

use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use crate::identity::auth::js_trim;

pub mod account;
pub mod agent_api;
pub mod auth;
pub mod avatars;
pub mod billing;
pub mod github_auth;
pub mod github_triggers;
pub mod moves;
pub mod oauth;
pub mod projects;
pub mod system;
pub mod task_answers;
pub mod task_templates;
pub mod tasks;
pub mod today;
pub mod workflows;

#[derive(Debug)]
pub enum ContractFailure {
    Issues(Vec<Value>),
    Unhandled,
    Internal(String),
}

pub type ContractResult<T> = Result<T, ContractFailure>;

/// A request schema: its normalized JSON output, then the typed request.
pub trait Contract: DeserializeOwned {
    fn schema(input: Option<&Value>) -> ContractResult<Value>;

    fn parse(input: Option<&Value>) -> ContractResult<Self> {
        typed(Self::schema(input))
    }
}

/// `schema.optional()`: an absent input is `None`.
impl<T: Contract> Contract for Option<T> {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        input.map_or(Ok(Value::Null), |input| T::schema(Some(input)))
    }
}

/// Serde builds the typed request from a schema's normalized output.
pub(crate) fn typed<T: DeserializeOwned>(output: ContractResult<Value>) -> ContractResult<T> {
    serde_json::from_value(output?).map_err(|error| ContractFailure::Internal(error.to_string()))
}

pub(crate) const MAX: usize = usize::MAX;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(crate) fn optional_nonnull<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// With `serde(default)`, omission is None and explicit null is Some(None).
pub(crate) fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

pub(crate) fn id_1_256(value: &str, _: &()) -> garde::Result {
    match value.encode_utf16().count() {
        0 => Err(garde::Error::new("too_small")),
        1..=256 => Ok(()),
        _ => Err(garde::Error::new("too_big")),
    }
}

pub(crate) fn delivery_target(value: &str, _: &()) -> garde::Result {
    rule(
        crate::tasks::control::DeliveryTarget::parse(value).is_some(),
        "invalid_value",
    )
}

pub(crate) fn visual_evidence(value: &str, _: &()) -> garde::Result {
    if ["off", "capture", "required"].contains(&value) {
        Ok(())
    } else {
        Err(garde::Error::new("invalid_value"))
    }
}

/// The public finding for one field path such as `.`, `.name`, or `.images.0.base64`.
pub(crate) fn issue(code: &str, field: &str) -> Value {
    json!({"code":format!("invalid-{code}"),"field":field,"message":"Request value is invalid"})
}

pub(crate) fn fail<T>(code: &str) -> ContractResult<T> {
    Err(ContractFailure::Issues(vec![issue(code, ".")]))
}

/// Garde reports for request types that domain code still validates itself.
pub(crate) fn garde_findings(report: &garde::Report, request: &impl Serialize) -> Vec<Value> {
    let input =
        serde_json::to_value(request).expect("request contracts contain JSON-compatible fields");
    report
        .iter()
        .map(|(path, error)| {
            let mut value = Some(&input);
            let mut names = Vec::new();
            for (kind, segment) in path.__iter().rev() {
                if kind == garde::error::Kind::None {
                    continue;
                }
                let raw = segment.as_str();
                let mut name = raw.to_owned();
                if value.is_some_and(|value| value.is_object() && value.get(raw).is_none()) {
                    let mut parts = raw.split('_');
                    name = parts.next().unwrap_or_default().to_owned();
                    for part in parts {
                        let mut chars = part.chars();
                        if let Some(first) = chars.next() {
                            name.extend(first.to_uppercase());
                            name.extend(chars);
                        }
                    }
                }
                value = value.and_then(|value| match value {
                    Value::Array(items) => {
                        raw.parse::<usize>().ok().and_then(|index| items.get(index))
                    }
                    _ => value.get(&name),
                });
                names.push(name);
            }
            let field = format!(".{}", names.join("."));
            let message = error.message();
            let code = if message == "too_small" || message.contains("lower than") {
                "too_small"
            } else if message == "too_big" || message.contains("greater than") {
                "too_big"
            } else if message == "invalid_value" {
                "invalid_value"
            } else if message == "custom" {
                "custom"
            } else if message == "invalid_number" {
                "invalid_type"
            } else {
                "invalid_format"
            };
            issue(code, &field)
        })
        .collect()
}

/// Moves findings of a nested value under `prefix`.
fn nest(failure: ContractFailure, prefix: &str) -> ContractFailure {
    match failure {
        ContractFailure::Issues(found) => ContractFailure::Issues(
            found
                .into_iter()
                .map(|mut finding| {
                    let field = finding["field"].as_str().unwrap_or(".");
                    finding["field"] = json!(if field == "." {
                        prefix.to_owned()
                    } else {
                        format!("{prefix}{field}")
                    });
                    finding
                })
                .collect(),
        ),
        other => other,
    }
}

/// A type, enum, key, or union issue: Zod stops refining the value.
fn aborts(finding: &Value) -> bool {
    matches!(
        finding["code"].as_str(),
        Some(
            "invalid-invalid_type"
                | "invalid-invalid_value"
                | "invalid-unrecognized_keys"
                | "invalid-invalid_union"
        )
    )
}

/// `z.union([...])`: the first branch that parses, else the only branch whose
/// findings do not abort, else `invalid_union`.
pub(crate) fn union(input: Option<&Value>, branches: &[Parse]) -> ContractResult<Value> {
    let mut open = Vec::new();
    for branch in branches {
        match branch(input) {
            Ok(value) => return Ok(value),
            Err(ContractFailure::Issues(found)) if !found.iter().any(aborts) => open.push(found),
            Err(ContractFailure::Issues(_)) => {}
            Err(other) => return Err(other),
        }
    }
    match open.pop() {
        Some(found) if open.is_empty() => Err(ContractFailure::Issues(found)),
        _ => fail("invalid_union"),
    }
}

/// `z.discriminatedUnion(key, ...)`: `branch` returns None for an unknown tag,
/// which is `invalid_union` at the key.
pub(crate) fn tagged(
    input: Option<&Value>,
    key: &str,
    branch: impl FnOnce(&Value) -> Option<ContractResult<Value>>,
) -> ContractResult<Value> {
    let Some(Value::Object(fields)) = input else {
        return fail("invalid_type");
    };
    fields.get(key).and_then(branch).unwrap_or_else(|| {
        Err(ContractFailure::Issues(vec![issue(
            "invalid_union",
            &format!(".{key}"),
        )]))
    })
}

/// A garde rule result that reports `code` unless `valid`.
pub(crate) fn rule(valid: bool, code: &'static str) -> garde::Result {
    if valid {
        Ok(())
    } else {
        Err(garde::Error::new(code))
    }
}

pub(crate) fn url(value: &str, _: &()) -> garde::Result {
    rule(url::Url::parse(value).is_ok(), "invalid_format")
}

/// One JSON object parsed field by field.
pub(crate) struct Fields<'a> {
    input: &'a Map<String, Value>,
    output: Map<String, Value>,
    findings: Vec<Value>,
    failure: Option<ContractFailure>,
    known: Vec<&'static str>,
}

impl<'a> Fields<'a> {
    pub fn new(input: Option<&'a Value>) -> ContractResult<Self> {
        match input {
            Some(Value::Object(input)) => Ok(Self {
                input,
                output: Map::new(),
                findings: Vec::new(),
                failure: None,
                known: Vec::new(),
            }),
            _ => fail("invalid_type"),
        }
    }

    /// The raw input value of a field.
    pub fn raw(&self, name: &str) -> Option<&'a Value> {
        self.input.get(name)
    }

    fn put(&mut self, name: &'static str, result: ContractResult<Value>) {
        match result {
            Ok(value) => {
                self.output.insert(name.to_owned(), value);
            }
            Err(ContractFailure::Issues(found)) => self.findings.extend(found),
            Err(other) => {
                self.failure.get_or_insert(other);
            }
        }
    }

    fn read(
        &mut self,
        name: &'static str,
        parse: impl FnOnce(Option<&Value>) -> ContractResult<Value>,
    ) -> ContractResult<Value> {
        self.known.push(name);
        parse(self.input.get(name)).map_err(|failure| nest(failure, &format!(".{name}")))
    }

    /// A required field; the parser decides what a missing value reports.
    pub fn req(
        mut self,
        name: &'static str,
        parse: impl FnOnce(Option<&Value>) -> ContractResult<Value>,
    ) -> Self {
        let result = self.read(name, parse);
        self.put(name, result);
        self
    }

    /// An optional field: absent stays absent.
    pub fn opt(
        mut self,
        name: &'static str,
        parse: impl FnOnce(Option<&Value>) -> ContractResult<Value>,
    ) -> Self {
        if self.input.contains_key(name) {
            self = self.req(name, parse);
        } else {
            self.known.push(name);
        }
        self
    }

    /// An optional field with a default for absence.
    pub fn or(
        mut self,
        name: &'static str,
        default: Value,
        parse: impl FnOnce(Option<&Value>) -> ContractResult<Value>,
    ) -> Self {
        if self.input.contains_key(name) {
            self = self.req(name, parse);
        } else {
            self.known.push(name);
            self.output.insert(name.to_owned(), default);
        }
        self
    }

    pub fn fail(&mut self, code: &str, field: &str) {
        self.findings.push(issue(code, field));
    }

    /// Report keys outside the declared fields, as a strict Zod object does.
    pub fn strict_keys(&mut self) {
        if self
            .input
            .keys()
            .any(|key| !self.known.contains(&key.as_str()))
        {
            self.fail("unrecognized_keys", ".");
        }
    }

    /// Zod skips object refinements after an aborting issue.
    pub fn refinable(&self) -> bool {
        !self.findings.iter().any(aborts)
    }

    /// The normalized object; unknown keys are stripped.
    pub fn finish(self) -> ContractResult<Value> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        if self.findings.is_empty() {
            Ok(Value::Object(self.output))
        } else {
            Err(ContractFailure::Issues(self.findings))
        }
    }

    pub fn strict(mut self) -> ContractResult<Value> {
        self.strict_keys();
        self.finish()
    }

    /// The normalized object with unknown keys kept.
    pub fn passthrough(mut self) -> ContractResult<Value> {
        for (key, value) in self.input {
            if !self.known.contains(&key.as_str()) {
                self.output.insert(key.clone(), value.clone());
            }
        }
        self.finish()
    }
}

/// One field parser as a trait object, for tables of fields.
pub(crate) type Parse<'p> = &'p dyn Fn(Option<&Value>) -> ContractResult<Value>;

/// `z.string()`: optional trim, UTF-16 length bounds, and a garde format rule.
/// Zod still measures an array's length after its type issue.
pub(crate) fn string(
    input: Option<&Value>,
    trim: bool,
    (min, max): (usize, usize),
    rule: Option<fn(&str, &()) -> garde::Result>,
) -> ContractResult<Value> {
    let (text, length) = match input {
        Some(Value::String(text)) => {
            let text = if trim { js_trim(text) } else { text };
            (Some(text), text.encode_utf16().count())
        }
        Some(Value::Array(items)) => (None, items.len()),
        _ => return fail("invalid_type"),
    };
    let mut found = Vec::new();
    if text.is_none() {
        found.push(issue("invalid_type", "."));
    }
    if length < min {
        found.push(issue("too_small", "."));
    }
    if length > max {
        found.push(issue("too_big", "."));
    }
    if let (Some(text), Some(rule)) = (text, rule)
        && let Err(error) = rule(text, &())
    {
        found.push(issue(error.message(), "."));
    }
    match text {
        Some(text) if found.is_empty() => Ok(json!(text)),
        _ => Err(ContractFailure::Issues(found)),
    }
}

pub(crate) fn text(
    min: usize,
    max: usize,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| string(input, false, (min, max), None)
}

pub(crate) fn trimmed(
    min: usize,
    max: usize,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| string(input, true, (min, max), None)
}

/// A string that must also pass a garde rule.
pub(crate) fn formatted(
    min: usize,
    max: usize,
    check: fn(&str, &()) -> garde::Result,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| string(input, false, (min, max), Some(check))
}

/// `z.enum([...])`: anything else, absence included, is `invalid_value`.
pub(crate) fn one_of(
    options: &'static [&'static str],
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| match input.and_then(Value::as_str) {
        Some(value) if options.contains(&value) => Ok(json!(value)),
        _ => fail("invalid_value"),
    }
}

/// A serde enum such as `DeliveryTarget`; any other value is `invalid_value`.
pub(crate) fn choice<T: DeserializeOwned + Serialize>(
    input: Option<&Value>,
) -> ContractResult<Value> {
    match input.map(|value| serde_json::from_value::<T>(value.clone())) {
        Some(Ok(value)) => Ok(json!(value)),
        _ => fail("invalid_value"),
    }
}

pub(crate) fn flag(input: Option<&Value>) -> ContractResult<Value> {
    match input {
        Some(Value::Bool(value)) => Ok(json!(value)),
        _ => fail("invalid_type"),
    }
}

/// Any present value (`z.unknown()` inside a required field).
pub(crate) fn present(input: Option<&Value>) -> ContractResult<Value> {
    input.cloned().map_or_else(|| fail("invalid_type"), Ok)
}

/// `z.number().int()` within `[min, max]` and the safe-integer range.
pub(crate) fn integer(number: f64, min: f64, max: f64) -> ContractResult<Value> {
    if !number.is_finite() || number.fract() != 0.0 {
        return fail("invalid_type");
    }
    let mut found = Vec::new();
    if number < min || number < -MAX_SAFE_INTEGER {
        found.push(issue("too_small", "."));
    }
    if number > max || number > MAX_SAFE_INTEGER {
        found.push(issue("too_big", "."));
    }
    if found.is_empty() {
        Ok(json!(number as i64))
    } else {
        Err(ContractFailure::Issues(found))
    }
}

/// `z.number().finite()` within `[min, max]`; the output keeps the JSON number.
pub(crate) fn number(
    min: f64,
    max: f64,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| match input.and_then(Value::as_f64) {
        Some(number) if number < min => fail("too_small"),
        Some(number) if number > max => fail("too_big"),
        Some(_) => Ok(input.cloned().unwrap_or_default()),
        None => fail("invalid_type"),
    }
}

/// A JSON integer.
pub(crate) fn int(min: f64, max: f64) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| match input {
        Some(Value::Number(number)) => integer(number.as_f64().unwrap_or(f64::NAN), min, max),
        _ => fail("invalid_type"),
    }
}

/// `z.coerce.number().int()`: JavaScript `Number(value)` first.
pub(crate) fn coerced(
    min: f64,
    max: f64,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| integer(js_number(input), min, max)
}

/// `Number(value)` for the values `z.coerce.number()` sees.
pub(crate) fn js_number(value: Option<&Value>) -> f64 {
    let text = match value {
        Some(Value::Number(number)) => return number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_trim(text),
        Some(Value::Bool(value)) => return f64::from(u8::from(*value)),
        Some(Value::Null) => return 0.0,
        Some(Value::Array(items)) if items.is_empty() => return 0.0,
        Some(Value::Array(items)) if items.len() == 1 => return js_number(items.first()),
        _ => return f64::NAN,
    };
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |value| value as f64);
        }
    }
    let unsigned = text.trim_start_matches(['+', '-']);
    if unsigned == "Infinity" && text.len() - unsigned.len() <= 1 {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        text.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `schema.nullable()`.
pub(crate) fn nullable(
    parse: impl Fn(Option<&Value>) -> ContractResult<Value> + Copy,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| match input {
        Some(Value::Null) => Ok(Value::Null),
        input => parse(input),
    }
}

/// `z.array(item)` with length bounds; item findings carry their index.
pub(crate) fn list(
    item: impl Fn(Option<&Value>) -> ContractResult<Value> + Copy,
    min: usize,
    max: usize,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| each(input, &item, min, max)
}

fn each(input: Option<&Value>, item: Parse, min: usize, max: usize) -> ContractResult<Value> {
    let Some(Value::Array(items)) = input else {
        return fail("invalid_type");
    };
    let mut output = Vec::new();
    let mut found = Vec::new();
    for (index, value) in items.iter().enumerate() {
        match item(Some(value)).map_err(|failure| nest(failure, &format!(".{index}"))) {
            Ok(value) => output.push(value),
            Err(ContractFailure::Issues(issues)) => found.extend(issues),
            Err(other) => return Err(other),
        }
    }
    if items.len() < min {
        found.push(issue("too_small", "."));
    }
    if items.len() > max {
        found.push(issue("too_big", "."));
    }
    if found.is_empty() {
        Ok(Value::Array(output))
    } else {
        Err(ContractFailure::Issues(found))
    }
}

/// `z.record(key, value)`: a key that fails `key` reports `key_code` at its path.
pub(crate) fn record(
    key: fn(&str) -> bool,
    key_code: &'static str,
    value: impl Fn(Option<&Value>) -> ContractResult<Value> + Copy,
) -> impl Fn(Option<&Value>) -> ContractResult<Value> + Copy {
    move |input| {
        let Some(Value::Object(fields)) = input else {
            return fail("invalid_type");
        };
        let mut output = Map::new();
        let mut found = Vec::new();
        for (name, item) in fields {
            let path = format!(".{name}");
            if !key(name) {
                found.push(issue(key_code, &path));
            }
            match value(Some(item)).map_err(|failure| nest(failure, &path)) {
                Ok(item) => {
                    output.insert(name.clone(), item);
                }
                Err(ContractFailure::Issues(issues)) => found.extend(issues),
                Err(other) => return Err(other),
            }
        }
        if found.is_empty() {
            Ok(Value::Object(output))
        } else {
            Err(ContractFailure::Issues(found))
        }
    }
}

/// `AdvisorProfileIdsSchema`: strict, each role an optional 1..256 id.
pub(crate) fn advisors(input: Option<&Value>) -> ContractResult<Value> {
    ["reviewer", "planner_a", "planner_b", "rater"]
        .into_iter()
        .try_fold(Fields::new(input)?, |fields, role| {
            Ok::<_, ContractFailure>(fields.opt(role, text(1, 256)))
        })?
        .strict()
}

/// Parse a field through a typed contract.
pub(crate) fn nested<T: Contract>(input: Option<&Value>) -> ContractResult<Value> {
    T::schema(input)
}

/// A single-key params object such as `{ taskId }`, stripping other keys.
pub(crate) fn params(
    input: Option<&Value>,
    names: &[&'static str],
    id: (usize, usize),
) -> ContractResult<Value> {
    names
        .iter()
        .fold(Fields::new(input)?, |fields, name| {
            fields.req(name, text(id.0, id.1))
        })
        .finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_fields_distinguish_omission_null_and_value() {
        #[derive(Debug, Deserialize, PartialEq)]
        struct Patch {
            #[serde(default, deserialize_with = "present_nullable")]
            nullable: Option<Option<String>>,
            #[serde(default, deserialize_with = "optional_nonnull")]
            nonnull: Option<String>,
        }
        let parse = |value| serde_json::from_value::<Patch>(value);
        assert_eq!(
            parse(json!({})).unwrap(),
            Patch {
                nullable: None,
                nonnull: None
            }
        );
        assert_eq!(
            parse(json!({"nullable": null})).unwrap().nullable,
            Some(None)
        );
        let patch = parse(json!({"nullable": "x", "nonnull": "y"})).unwrap();
        assert_eq!(patch.nullable, Some(Some("x".into())));
        assert_eq!(patch.nonnull, Some("y".into()));
        assert!(parse(json!({"nonnull": null})).is_err());
        assert!(parse(json!({"nullable": false})).is_err());
    }

    #[test]
    fn fields_keep_every_finding_with_its_path() {
        let result = Fields::new(Some(&json!({"a": [], "b": [1, ""], "c": {"d": 1}, "x": 1})))
            .unwrap()
            .req("a", text(1, 3))
            .req("b", list(text(1, MAX), 0, 1))
            .req("c", |input| Fields::new(input)?.req("d", flag).strict())
            .req("e", one_of(&["y"]))
            .strict();
        let Err(ContractFailure::Issues(found)) = result else {
            panic!("{result:?}")
        };
        let found = found
            .iter()
            .map(|finding| format!("{} {}", finding["code"], finding["field"]))
            .collect::<Vec<_>>();
        assert_eq!(
            found,
            [
                r#""invalid-invalid_type" ".a""#,
                r#""invalid-too_small" ".a""#,
                r#""invalid-invalid_type" ".b.0""#,
                r#""invalid-too_small" ".b.1""#,
                r#""invalid-too_big" ".b""#,
                r#""invalid-invalid_type" ".c.d""#,
                r#""invalid-invalid_value" ".e""#,
                r#""invalid-unrecognized_keys" ".""#,
            ]
        );
    }

    #[test]
    fn garde_paths_preserve_dynamic_record_keys() {
        let mut report = garde::Report::new();
        report.append(
            garde::Path::new("environment").join("FOO_BAR"),
            garde::Error::new("invalid_format"),
        );
        report.append(
            garde::Path::new("environment").join("workflow_ids"),
            garde::Error::new("invalid_format"),
        );
        report.append(
            garde::Path::new("workflow_ids").join(2usize),
            garde::Error::new("too_small"),
        );
        assert_eq!(
            garde_findings(
                &report,
                &json!({"environment":{"FOO_BAR":"", "workflow_ids":""}, "workflowIds":["a", "b", ""]})
            ),
            vec![
                json!({"code":"invalid-invalid_format","field":".environment.FOO_BAR","message":"Request value is invalid"}),
                json!({"code":"invalid-invalid_format","field":".environment.workflow_ids","message":"Request value is invalid"}),
                json!({"code":"invalid-too_small","field":".workflowIds.2","message":"Request value is invalid"}),
            ]
        );
    }
}
