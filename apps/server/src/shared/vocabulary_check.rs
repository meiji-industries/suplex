//! Fails when a `wire_enum!` variant string is compared as a bare literal
//! outside the files that define it. Compare `Enum::Variant.as_str()` instead.

use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Words another vocabulary shares, by path prefix under `src/` ("" is anywhere).
const ALLOWED: &[(&str, &[&str])] = &[
    // Repository host and issue tracker kind; only AuthProvider is a wire_enum.
    ("", &["github"]),
    // GitHub pull request state from the REST API.
    ("", &["open", "closed"]),
    // Task source kind; no wire_enum covers source kinds yet.
    ("", &["pull_request"]),
    // GitHub pull request state and merge queue disposition.
    ("delivery/operations.rs", &["merged", "queued"]),
    // Native runtime turn and tool outcome state in stored JSON.
    ("coordination/", &["completed"]),
    // Stripe subscription status and hosted billing operation state.
    (
        "billing/hosted/",
        &["active", "paused", "completed", "failed"],
    ),
    // OpenCode session and tool status protocol.
    (
        "runtimes/opencode/",
        &["idle", "pending", "running", "completed", "error"],
    ),
    // Pi assistant message stopReason protocol.
    ("runtimes/pi/", &["error"]),
    // Herdr pane state and client name.
    ("integrations/herdr_readiness.rs", &["running", "unknown"]),
    // Model name for usage that has no model.
    ("tasks/limits.rs", &["unknown"]),
    // OAuth token_endpoint_auth_method.
    ("identity/oauth.rs", &["none"]),
    // Log record state.
    ("platform/log_viewer.rs", &["error"]),
    // GitHub repository connection state of a project.
    ("projects/connection.rs", &["connected"]),
    // Update status kind.
    ("platform/update.rs", &["failed"]),
];

fn sources(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if !path.ends_with("migrations") {
                sources(&path, files);
            }
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

#[test]
fn wire_enum_vocabulary_is_not_compared_as_literals() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    let texts: Vec<(PathBuf, String)> = files
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path).unwrap();
            (path, text)
        })
        .collect();
    let block = Regex::new(r"(?s)wire_enum!\s*\{.*?\n\}").unwrap();
    let variant = Regex::new(r#"\w+\s*=\s*"([^"]+)""#).unwrap();
    let mut owners = BTreeMap::<String, BTreeSet<&Path>>::new();
    for (path, text) in &texts {
        for found in block.find_iter(text) {
            for capture in variant.captures_iter(found.as_str()) {
                owners
                    .entry(capture[1].to_owned())
                    .or_default()
                    .insert(path);
            }
        }
    }
    let literal = r#""([^"\\]*)""#;
    let comparisons = [
        Regex::new(&format!(r"[!=]=\s*{literal}")).unwrap(),
        Regex::new(&format!(r"{literal}\s*[!=]=")).unwrap(),
        Regex::new(&format!(r"\.contains\(&{literal}\)")).unwrap(),
    ];
    let matches_macro = Regex::new(r"matches!\([^)]*\)").unwrap();
    let string = Regex::new(literal).unwrap();
    let mut offenders = Vec::new();
    for (path, text) in &texts {
        let relative = path.strip_prefix(&root).unwrap().to_string_lossy();
        if relative.ends_with("tests.rs") {
            continue;
        }
        // Test modules sit at the end of each file.
        let code = text.split("#[cfg(test)]").next().unwrap_or_default();
        let code: Vec<&str> = code
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect();
        let code = code.join("\n");
        let mut found = BTreeSet::new();
        for pattern in &comparisons {
            found.extend(
                pattern
                    .captures_iter(&code)
                    .map(|capture| capture[1].to_owned()),
            );
        }
        for call in matches_macro.find_iter(&code) {
            found.extend(
                string
                    .captures_iter(call.as_str())
                    .map(|capture| capture[1].to_owned()),
            );
        }
        for word in found {
            let Some(defining) = owners.get(&word) else {
                continue;
            };
            let allowed = ALLOWED.iter().any(|(prefix, words)| {
                relative.starts_with(prefix) && words.contains(&word.as_str())
            });
            if !allowed && !defining.contains(path.as_path()) {
                offenders.push(format!("{relative}: \"{word}\""));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "compare the wire_enum, not its string:\n{}",
        offenders.join("\n")
    );
}
