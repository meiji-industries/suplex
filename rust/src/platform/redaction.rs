//! String redaction at native command-output boundaries.

use std::sync::LazyLock;

use regex::Regex;

static SENSITIVE_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:Bearer|Basic)\s+[^\s,;]+|(?-u:\b)(?:gho_|github_pat_|sk-|fh[ap]_)[A-Za-z0-9_-]{8,}|(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?-u:\b)[a-z][a-z0-9+.-]*://[^:\s/]+:[^@\s/]+@|(?-u:\b)(?:access[_-]?token|token|password|secret|api[_-]?key|authorization)=[^\s,;]+|(?-u:\b)(?:authorization|x-api-key)\s*:\s*[^\r\n,;]+")
        .expect("source command-output redaction regex")
});

pub fn command_output(value: &str) -> String {
    SENSITIVE_VALUE
        .replace_all(value, "[REDACTED]")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_synthetic_token_and_assignment_in_command_output() {
        assert_eq!(
            command_output("one gho_ABCDEFGH two password=fixture\nthree égho_ABCDEFGH"),
            "one [REDACTED] two [REDACTED]\nthree é[REDACTED]"
        );
    }
}
