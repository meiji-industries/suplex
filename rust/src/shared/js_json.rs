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

/// JSON.parse-compatible nodes. Strings and keys retain UTF-16 code units,
/// including lone surrogates; numbers retain JavaScript binary64 values.
#[derive(Clone, Debug, PartialEq)]
pub enum JsNode {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<usize>),
    Object(Vec<(Vec<u16>, usize)>),
}

/// A flat node arena keeps parsing, serialization, cloning and dropping safe
/// for deeply nested JSON that JavaScript accepts within the HTTP body limit.
#[derive(Clone, Debug, PartialEq)]
pub struct JsDocument {
    nodes: Vec<JsNode>,
    root: usize,
}

impl JsDocument {
    pub fn parse(input: &str) -> Result<Self, String> {
        let mut parser = Parser {
            source: input,
            position: 0,
            nodes: Vec::new(),
        };
        let (root, frame) = parser.value_start()?;
        let mut stack = Vec::new();
        if let Some(frame) = frame {
            stack.push(frame);
        }
        while let Some(frame) = stack.pop() {
            parser.whitespace();
            match frame {
                Frame::ArrayValue { node, first } => {
                    if first && parser.take(b']') {
                        continue;
                    }
                    let (child, child_frame) = parser.value_start()?;
                    let JsNode::Array(items) = &mut parser.nodes[node] else {
                        unreachable!("array frame")
                    };
                    items.push(child);
                    stack.push(Frame::ArrayAfter { node });
                    if let Some(child_frame) = child_frame {
                        stack.push(child_frame);
                    }
                }
                Frame::ArrayAfter { node } => {
                    if parser.take(b']') {
                        continue;
                    }
                    if !parser.take(b',') {
                        return Err("expected JSON array separator".into());
                    }
                    stack.push(Frame::ArrayValue { node, first: false });
                }
                Frame::ObjectKey { node, first } => {
                    if first && parser.take(b'}') {
                        continue;
                    }
                    let key = parser.string()?;
                    parser.whitespace();
                    if !parser.take(b':') {
                        return Err("expected JSON object colon".into());
                    }
                    let (child, child_frame) = parser.value_start()?;
                    let JsNode::Object(fields) = &mut parser.nodes[node] else {
                        unreachable!("object frame")
                    };
                    if let Some((_, previous)) =
                        fields.iter_mut().find(|(existing, _)| *existing == key)
                    {
                        *previous = child;
                    } else {
                        fields.push((key, child));
                    }
                    stack.push(Frame::ObjectAfter { node });
                    if let Some(child_frame) = child_frame {
                        stack.push(child_frame);
                    }
                }
                Frame::ObjectAfter { node } => {
                    if parser.take(b'}') {
                        continue;
                    }
                    if !parser.take(b',') {
                        return Err("expected JSON object separator".into());
                    }
                    stack.push(Frame::ObjectKey { node, first: false });
                }
            }
        }
        parser.whitespace();
        if parser.position != input.len() {
            return Err("trailing JSON content".into());
        }
        Ok(Self {
            nodes: parser.nodes,
            root,
        })
    }

    pub fn root(&self) -> usize {
        self.root
    }

    pub fn node(&self, index: usize) -> &JsNode {
        &self.nodes[index]
    }

    pub fn value_type(&self, index: usize) -> &'static str {
        match self.node(index) {
            JsNode::Null => "null",
            JsNode::Bool(_) => "boolean",
            JsNode::Number(_) => "number",
            JsNode::String(_) => "string",
            JsNode::Array(_) => "array",
            JsNode::Object(_) => "object",
        }
    }

    pub fn append_node(&mut self, node: JsNode) -> usize {
        let index = self.nodes.len();
        self.nodes.push(node);
        index
    }

    pub fn set_root(&mut self, index: usize) {
        assert!(index < self.nodes.len(), "root node must exist");
        self.root = index;
    }

    pub fn get(&self, object: usize, name: &str) -> Option<usize> {
        let JsNode::Object(fields) = self.node(object) else {
            return None;
        };
        fields
            .iter()
            .find(|(key, _)| key.iter().copied().eq(name.encode_utf16()))
            .map(|(_, index)| *index)
    }

    pub fn stringify(&self) -> String {
        enum Step {
            Node(usize),
            Key(usize, usize),
            Comma,
            Colon,
            EndArray,
            EndObject,
        }
        let mut output = String::new();
        let mut stack = vec![Step::Node(self.root)];
        while let Some(step) = stack.pop() {
            match step {
                Step::Node(index) => match self.node(index) {
                    JsNode::Null => output.push_str("null"),
                    JsNode::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
                    JsNode::Number(value) if !value.is_finite() => output.push_str("null"),
                    JsNode::Number(value) => output.push_str(ryu_js::Buffer::new().format(*value)),
                    JsNode::String(value) => stringify_utf16_into(value, &mut output),
                    JsNode::Array(items) => {
                        output.push('[');
                        stack.push(Step::EndArray);
                        for position in (0..items.len()).rev() {
                            stack.push(Step::Node(items[position]));
                            if position > 0 {
                                stack.push(Step::Comma);
                            }
                        }
                    }
                    JsNode::Object(fields) => {
                        output.push('{');
                        stack.push(Step::EndObject);
                        let mut positions = (0..fields.len()).collect::<Vec<_>>();
                        positions.sort_by_key(|position| {
                            array_index(&fields[*position].0)
                                .map_or((1, *position as u32), |index| (0, index))
                        });
                        for position in (0..positions.len()).rev() {
                            let field = positions[position];
                            stack.push(Step::Node(fields[field].1));
                            stack.push(Step::Colon);
                            stack.push(Step::Key(index, field));
                            if position > 0 {
                                stack.push(Step::Comma);
                            }
                        }
                    }
                },
                Step::Key(index, field) => {
                    let JsNode::Object(fields) = self.node(index) else {
                        unreachable!("object key")
                    };
                    stringify_utf16_into(&fields[field].0, &mut output);
                }
                Step::Comma => output.push(','),
                Step::Colon => output.push(':'),
                Step::EndArray => output.push(']'),
                Step::EndObject => output.push('}'),
            }
        }
        output
    }

    /// A checked bridge for ordinary values. Deep or unrepresentable values
    /// remain in this document for lossless validation and serialization.
    pub fn to_serde_if_representable(&self) -> Result<Value, String> {
        let mut stack = vec![(self.root, 0usize)];
        while let Some((index, depth)) = stack.pop() {
            if depth > 128 {
                return Err("nested value requires lossless validator".into());
            }
            match self.node(index) {
                JsNode::Array(items) => stack.extend(items.iter().map(|item| (*item, depth + 1))),
                JsNode::Object(fields) => {
                    stack.extend(fields.iter().map(|(_, item)| (*item, depth + 1)));
                }
                _ => {}
            }
        }
        self.to_serde_node(self.root)
    }

    fn to_serde_node(&self, index: usize) -> Result<Value, String> {
        match self.node(index) {
            JsNode::Null => Ok(Value::Null),
            JsNode::Bool(value) => Ok(Value::Bool(*value)),
            JsNode::Number(value) if !value.is_finite() => {
                Err("non-finite JavaScript number".into())
            }
            JsNode::Number(value) if *value == 0.0 && value.is_sign_negative() => {
                serde_json::Number::from_f64(*value)
                    .map(Value::Number)
                    .ok_or_else(|| "negative zero is not representable".into())
            }
            JsNode::Number(value) => serde_json::from_str(ryu_js::Buffer::new().format(*value))
                .map_err(|_| "JavaScript number is not representable".into()),
            JsNode::String(value) => String::from_utf16(value)
                .map(Value::String)
                .map_err(|_| "lone UTF-16 surrogate".into()),
            JsNode::Array(items) => items
                .iter()
                .map(|item| self.to_serde_node(*item))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            JsNode::Object(fields) => {
                let mut output = serde_json::Map::new();
                for (key, value) in fields {
                    let key = String::from_utf16(key)
                        .map_err(|_| "lone UTF-16 surrogate in object key")?;
                    output.insert(key, self.to_serde_node(*value)?);
                }
                Ok(Value::Object(output))
            }
        }
    }
}

pub fn stringify_raw_json(input: &str) -> Result<String, String> {
    JsDocument::parse(input).map(|document| document.stringify())
}

pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key[0] == b'0' as u16) {
        return None;
    }
    let index = key.iter().try_fold(0u32, |value, digit| {
        if !(b'0' as u16..=b'9' as u16).contains(digit) {
            return None;
        }
        value
            .checked_mul(10)?
            .checked_add(u32::from(*digit - b'0' as u16))
    })?;
    (index != u32::MAX).then_some(index)
}

fn stringify_utf16_into(value: &[u16], output: &mut String) {
    output.push('"');
    let mut index = 0;
    while index < value.len() {
        let unit = value[index];
        match unit {
            0x22 => output.push_str("\\\""),
            0x5c => output.push_str("\\\\"),
            0x08 => output.push_str("\\b"),
            0x0c => output.push_str("\\f"),
            0x0a => output.push_str("\\n"),
            0x0d => output.push_str("\\r"),
            0x09 => output.push_str("\\t"),
            0x00..=0x1f => output.push_str(&format!("\\u{unit:04x}")),
            0xd800..=0xdbff
                if value
                    .get(index + 1)
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next)) =>
            {
                let low = value[index + 1];
                let code = 0x10000 + ((u32::from(unit) - 0xd800) << 10) + u32::from(low) - 0xdc00;
                output.push(char::from_u32(code).expect("valid surrogate pair"));
                index += 1;
            }
            0xd800..=0xdfff => output.push_str(&format!("\\u{unit:04x}")),
            _ => output.push(char::from_u32(u32::from(unit)).expect("UTF-16 scalar")),
        }
        index += 1;
    }
    output.push('"');
}

enum Frame {
    ArrayValue { node: usize, first: bool },
    ArrayAfter { node: usize },
    ObjectKey { node: usize, first: bool },
    ObjectAfter { node: usize },
}

struct Parser<'a> {
    source: &'a str,
    position: usize,
    nodes: Vec<JsNode>,
}

impl Parser<'_> {
    fn whitespace(&mut self) {
        while self
            .source
            .as_bytes()
            .get(self.position)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.position += 1;
        }
    }

    fn take(&mut self, expected: u8) -> bool {
        if self.source.as_bytes().get(self.position) == Some(&expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn value_start(&mut self) -> Result<(usize, Option<Frame>), String> {
        self.whitespace();
        let (node, frame) = match self.source.as_bytes().get(self.position) {
            Some(b'n') if self.literal("null") => (JsNode::Null, None),
            Some(b't') if self.literal("true") => (JsNode::Bool(true), None),
            Some(b'f') if self.literal("false") => (JsNode::Bool(false), None),
            Some(b'"') => (JsNode::String(self.string()?), None),
            Some(b'[') => {
                self.position += 1;
                (JsNode::Array(Vec::new()), Some(true))
            }
            Some(b'{') => {
                self.position += 1;
                (JsNode::Object(Vec::new()), Some(false))
            }
            Some(b'-' | b'0'..=b'9') => (JsNode::Number(self.number()?), None),
            _ => return Err("invalid JSON value".into()),
        };
        let index = self.nodes.len();
        self.nodes.push(node);
        let frame = match frame {
            Some(true) => Some(Frame::ArrayValue {
                node: index,
                first: true,
            }),
            Some(false) => Some(Frame::ObjectKey {
                node: index,
                first: true,
            }),
            None => None,
        };
        Ok((index, frame))
    }

    fn literal(&mut self, text: &str) -> bool {
        if self.source[self.position..].starts_with(text) {
            self.position += text.len();
            true
        } else {
            false
        }
    }

    fn string(&mut self) -> Result<Vec<u16>, String> {
        if !self.take(b'"') {
            return Err("expected JSON string".into());
        }
        let mut output = Vec::new();
        loop {
            let byte = *self
                .source
                .as_bytes()
                .get(self.position)
                .ok_or("unterminated JSON string")?;
            if byte == b'"' {
                self.position += 1;
                return Ok(output);
            }
            if byte < 0x20 {
                return Err("unescaped control character".into());
            }
            if byte == b'\\' {
                self.position += 1;
                let escaped = *self
                    .source
                    .as_bytes()
                    .get(self.position)
                    .ok_or("unterminated JSON escape")?;
                self.position += 1;
                match escaped {
                    b'"' | b'\\' | b'/' => output.push(u16::from(escaped)),
                    b'b' => output.push(0x08),
                    b'f' => output.push(0x0c),
                    b'n' => output.push(0x0a),
                    b'r' => output.push(0x0d),
                    b't' => output.push(0x09),
                    b'u' => {
                        let end = self.position + 4;
                        let digits = self
                            .source
                            .get(self.position..end)
                            .ok_or("short Unicode escape")?;
                        output.push(
                            u16::from_str_radix(digits, 16)
                                .map_err(|_| "invalid Unicode escape")?,
                        );
                        self.position = end;
                    }
                    _ => return Err("invalid JSON escape".into()),
                }
            } else {
                let character = self.source[self.position..]
                    .chars()
                    .next()
                    .ok_or("invalid UTF-8")?;
                output.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
                self.position += character.len_utf8();
            }
        }
    }

    fn number(&mut self) -> Result<f64, String> {
        let start = self.position;
        self.take(b'-');
        if !self.take(b'0') {
            if !self.take_digit(b'1', b'9') {
                return Err("invalid JSON number".into());
            }
            while self.take_digit(b'0', b'9') {}
        }
        if self.take(b'.') {
            if !self.take_digit(b'0', b'9') {
                return Err("invalid JSON fraction".into());
            }
            while self.take_digit(b'0', b'9') {}
        }
        if self.take(b'e') || self.take(b'E') {
            if !self.take(b'+') {
                self.take(b'-');
            }
            if !self.take_digit(b'0', b'9') {
                return Err("invalid JSON exponent".into());
            }
            while self.take_digit(b'0', b'9') {}
        }
        self.source[start..self.position]
            .parse::<f64>()
            .map_err(|_| "invalid JSON number".into())
    }

    fn take_digit(&mut self, first: u8, last: u8) -> bool {
        if self
            .source
            .as_bytes()
            .get(self.position)
            .is_some_and(|byte| (first..=last).contains(byte))
        {
            self.position += 1;
            true
        } else {
            false
        }
    }
}
