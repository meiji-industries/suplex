use serde_json::Value;

/// JSON.stringify for the four persisted task hashes. Callers must pass their
/// already-normalized value in the same field order as the TypeScript code.
pub fn stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => ryu_js::Buffer::new()
            .format(value.as_f64().expect("JSON numbers are finite"))
            .to_owned(),
        Value::String(value) => serde_json::to_string(value).expect("JSON string serialization"),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut indexed = values
                .iter()
                .filter_map(|(key, value)| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|index| *index != u32::MAX && index.to_string() == key.as_str())
                        .map(|index| (index, key, value))
                })
                .collect::<Vec<_>>();
            indexed.sort_by_key(|(index, _, _)| *index);
            let keys = indexed
                .into_iter()
                .map(|(_, key, value)| (key, value))
                .chain(values.iter().filter(|(key, _)| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|index| *index != u32::MAX && index.to_string() == key.as_str())
                        .is_none()
                }));
            format!(
                "{{{}}}",
                keys.map(|(key, value)| format!(
                    "{}:{}",
                    serde_json::to_string(key).expect("JSON key serialization"),
                    stringify(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
            )
        }
    }
}

#[derive(Clone)]
enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<JsValue>),
    Object(Vec<(Vec<u16>, JsValue)>),
}

/// Parse raw JSON with JavaScript number and UTF-16 string semantics before
/// hashing. `serde_json::Value` cannot hold lone surrogates or overflowing
/// JSON number literals, both of which JSON.parse accepts.
pub fn stringify_raw_json(input: &str) -> Result<String, String> {
    let mut parser = Parser {
        source: input,
        position: 0,
    };
    let value = parser.value()?;
    parser.whitespace();
    if parser.position != input.len() {
        return Err("trailing JSON content".into());
    }
    Ok(stringify_js(&value))
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

fn stringify_js(value: &JsValue) -> String {
    match value {
        JsValue::Null => "null".into(),
        JsValue::Bool(value) => value.to_string(),
        JsValue::Number(value) if !value.is_finite() => "null".into(),
        JsValue::Number(value) => ryu_js::Buffer::new().format(*value).to_owned(),
        JsValue::String(value) => stringify_utf16(value),
        JsValue::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(stringify_js)
                .collect::<Vec<_>>()
                .join(",")
        ),
        JsValue::Object(values) => {
            let mut keys = values
                .iter()
                .enumerate()
                .filter_map(|(position, (key, _))| array_index(key).map(|index| (index, position)))
                .collect::<Vec<_>>();
            keys.sort_by_key(|(index, _)| *index);
            let positions = keys.into_iter().map(|(_, position)| position).chain(
                (0..values.len()).filter(|position| array_index(&values[*position].0).is_none()),
            );
            format!(
                "{{{}}}",
                positions
                    .map(|position| {
                        let (key, value) = &values[position];
                        format!("{}:{}", stringify_utf16(key), stringify_js(value))
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn stringify_utf16(value: &[u16]) -> String {
    let mut output = String::from("\"");
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
    output
}

struct Parser<'a> {
    source: &'a str,
    position: usize,
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

    fn value(&mut self) -> Result<JsValue, String> {
        self.whitespace();
        match self.source.as_bytes().get(self.position) {
            Some(b'n') if self.literal("null") => Ok(JsValue::Null),
            Some(b't') if self.literal("true") => Ok(JsValue::Bool(true)),
            Some(b'f') if self.literal("false") => Ok(JsValue::Bool(false)),
            Some(b'"') => self.string().map(JsValue::String),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err("invalid JSON value".into()),
        }
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

    fn number(&mut self) -> Result<JsValue, String> {
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
        let number = self.source[start..self.position]
            .parse::<f64>()
            .map_err(|_| "invalid JSON number")?;
        Ok(JsValue::Number(number))
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

    fn array(&mut self) -> Result<JsValue, String> {
        self.take(b'[');
        self.whitespace();
        let mut values = Vec::new();
        if self.take(b']') {
            return Ok(JsValue::Array(values));
        }
        loop {
            values.push(self.value()?);
            self.whitespace();
            if self.take(b']') {
                return Ok(JsValue::Array(values));
            }
            if !self.take(b',') {
                return Err("expected JSON array separator".into());
            }
        }
    }

    fn object(&mut self) -> Result<JsValue, String> {
        self.take(b'{');
        self.whitespace();
        let mut values: Vec<(Vec<u16>, JsValue)> = Vec::new();
        if self.take(b'}') {
            return Ok(JsValue::Object(values));
        }
        loop {
            self.whitespace();
            let key = self.string()?;
            self.whitespace();
            if !self.take(b':') {
                return Err("expected JSON object colon".into());
            }
            let value = self.value()?;
            if let Some((_, current)) = values.iter_mut().find(|(existing, _)| *existing == key) {
                *current = value;
            } else {
                values.push((key, value));
            }
            self.whitespace();
            if self.take(b'}') {
                return Ok(JsValue::Object(values));
            }
            if !self.take(b',') {
                return Err("expected JSON object separator".into());
            }
        }
    }
}
