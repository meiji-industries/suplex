use serde_json::Value;

/// JSON.stringify for already-normalized serde values used by persisted hashes.
pub fn stringify(value: &Value) -> String {
    enum Step<'a> {
        Value(&'a Value),
        Key(&'a str),
        Comma,
        Colon,
        EndArray,
        EndObject,
    }
    let mut output = String::new();
    let mut stack = vec![Step::Value(value)];
    while let Some(step) = stack.pop() {
        match step {
            Step::Value(value) => match value {
                Value::Null => output.push_str("null"),
                Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
                Value::Number(value) => output.push_str(
                    ryu_js::Buffer::new().format(value.as_f64().expect("finite JSON number")),
                ),
                Value::String(value) => {
                    output.push_str(
                        &serde_json::to_string(value).expect("JSON string serialization"),
                    );
                }
                Value::Array(values) => {
                    output.push('[');
                    stack.push(Step::EndArray);
                    for position in (0..values.len()).rev() {
                        stack.push(Step::Value(&values[position]));
                        if position > 0 {
                            stack.push(Step::Comma);
                        }
                    }
                }
                Value::Object(values) => {
                    output.push('{');
                    stack.push(Step::EndObject);
                    let mut fields = values
                        .iter()
                        .enumerate()
                        .map(|(position, (key, value))| (position, key, value))
                        .collect::<Vec<_>>();
                    fields.sort_by_key(|(position, key, _)| {
                        key.parse::<u32>()
                            .ok()
                            .filter(|index| *index != u32::MAX && index.to_string() == key.as_str())
                            .map_or((1, *position as u32), |index| (0, index))
                    });
                    for position in (0..fields.len()).rev() {
                        let (_, key, value) = fields[position];
                        stack.push(Step::Value(value));
                        stack.push(Step::Colon);
                        stack.push(Step::Key(key));
                        if position > 0 {
                            stack.push(Step::Comma);
                        }
                    }
                }
            },
            Step::Key(key) => {
                output.push_str(&serde_json::to_string(key).expect("JSON key serialization"));
            }
            Step::Comma => output.push(','),
            Step::Colon => output.push(':'),
            Step::EndArray => output.push(']'),
            Step::EndObject => output.push('}'),
        }
    }
    output
}
