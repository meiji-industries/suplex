//! String redaction at native command-output and diagnostic-log boundaries.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

static SENSITIVE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:authorization|cookie|credential|password|private.?key|secret|token|api.?key|thread[_-]?id|threadId)")
        .expect("source log key redaction regex")
});

static SENSITIVE_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:Bearer|Basic)\s+[^\s,;]+|(?-u:\b)(?:gho_|github_pat_|sk-|fh[ap]_)[A-Za-z0-9_-]{8,}|(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?-u:\b)[a-z][a-z0-9+.-]*://[^:\s/]+:[^@\s/]+@|(?-u:\b)(?:access[_-]?token|token|password|secret|api[_-]?key|authorization)=[^\s,;]+|(?-u:\b)(?:authorization|x-api-key)\s*:\s*[^\r\n,;]+")
        .expect("source command-output redaction regex")
});

pub fn command_output(value: &str) -> String {
    SENSITIVE_VALUE
        .replace_all(value, "[REDACTED]")
        .into_owned()
}

/// `redact` from `platform/logging.ts`: sensitive keys and values in a JSON record.
pub fn value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(command_output(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(self::value).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, item)| {
                    let item = if SENSITIVE_KEY.is_match(&key) {
                        Value::String("[REDACTED]".into())
                    } else {
                        self::value(item)
                    };
                    (key, item)
                })
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_sensitive_record_keys_and_nested_values() {
        assert_eq!(
            value(serde_json::json!({"apiKey":"x","nested":[{"note":"Bearer abc"}],"count":1})),
            serde_json::json!({"apiKey":"[REDACTED]","nested":[{"note":"[REDACTED]"}],"count":1})
        );
    }

    #[test]
    fn masks_synthetic_token_and_assignment_in_command_output() {
        assert_eq!(
            command_output("one gho_ABCDEFGH two password=fixture\nthree égho_ABCDEFGH"),
            "one [REDACTED] two [REDACTED]\nthree é[REDACTED]"
        );
    }
}
