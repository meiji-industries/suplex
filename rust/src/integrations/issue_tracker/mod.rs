//! TypeScript `IssueTracker`: GitHub Issues, Jira Cloud, and Linear. The connection comes from task or project
//! configuration; issue identities outside it are refused.

mod github;
mod jira;
mod linear;

pub use github::github_image_reference;

use std::{error::Error, fmt, sync::LazyLock};

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use super::{
    github_delivery::Github,
    provider_http::{id_text, lenient, missing_id},
};
use crate::tasks::images::MAX_TASK_IMAGE_BYTES;

pub type TrackerResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

/// The caller's final check before each tracker write.
pub type BeforeWrite<'a> =
    &'a (dyn Fn() -> std::pin::Pin<Box<dyn Future<Output = TrackerResult<()>> + Send + 'a>> + Sync);

/// TypeScript `ProviderHttpFailure`: the provider refused with this status.
#[derive(Debug)]
pub struct ProviderHttpFailure {
    pub status: u16,
}

impl fmt::Display for ProviderHttpFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "The provider request failed ({})", self.status)
    }
}

impl Error for ProviderHttpFailure {}

/// TypeScript `IssueTrackerScopeFailure`.
#[derive(Debug)]
pub struct IssueTrackerScopeFailure;

impl fmt::Display for IssueTrackerScopeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("The issue does not belong to the configured tracker")
    }
}

impl Error for IssueTrackerScopeFailure {}

/// TypeScript `MissingIntegrationCredential`.
#[derive(Debug)]
pub struct MissingIntegrationCredential(pub String);

impl fmt::Display for MissingIntegrationCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "The credential reference {} is not available",
            self.0
        )
    }
}

impl Error for MissingIntegrationCredential {}

fn fail(message: &str) -> Box<dyn Error + Send + Sync> {
    message.into()
}

fn evidence_marker(task_id: &str) -> String {
    format!("[Suplex task {task_id}]")
}

fn is_complete_evidence_comment(value: &str, marker: &str) -> bool {
    value.starts_with("## What changed\n\n")
        && value.ends_with(&format!("\n\n{marker}"))
        && EVIDENCE_SHAPE.is_match(value)
}

fn cap_context(text: String) -> String {
    const LIMIT: usize = 500_000;
    if text.encode_utf16().count() <= LIMIT {
        return text;
    }
    let units = text.encode_utf16().take(LIMIT).collect::<Vec<_>>();
    format!(
        "{}\n\nContext intake limit reached: additional content was not loaded. Inspect the linked issue before relying on this incomplete snapshot.",
        String::from_utf16_lossy(&units)
    )
}

pub fn environment_credential(name: &str) -> TrackerResult<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| MissingIntegrationCredential(name.to_owned()).into())
}

/// TypeScript `issueText`: the plain text of a string or Atlassian document.
pub fn issue_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Array(items) => items.iter().map(issue_text).collect::<Vec<_>>().join("\n"),
        Value::Object(node)
            if node.get("text").is_some_and(Value::is_string)
                || node.get("content").is_some_and(Value::is_array) =>
        {
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                return text.to_owned();
            }
            let separator = match node.get("type").and_then(Value::as_str) {
                Some("paragraph" | "heading") => "",
                _ => "\n",
            };
            node.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(issue_text)
                .collect::<Vec<_>>()
                .join(separator)
        }
        Value::Object(_) => crate::shared::js_json::stringify(value),
        other => other.to_string(),
    }
}

static EVIDENCE_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\n\nSource: [a-f0-9]{40,64}\n\n## Before\n\n.*\n\n## After\n\n.*\n\n## How to verify\n\n").expect("valid regex")
});

/// The tracker connection of a task or project configuration.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    #[serde(default, deserialize_with = "lenient")]
    kind: String,
    #[serde(default, deserialize_with = "lenient")]
    repository: String,
    #[serde(default, deserialize_with = "lenient")]
    site: String,
    #[serde(default, deserialize_with = "lenient")]
    project: String,
    #[serde(default, deserialize_with = "lenient")]
    email_environment: String,
    #[serde(default, deserialize_with = "lenient")]
    token_environment: String,
    #[serde(default, deserialize_with = "lenient")]
    team: String,
}

/// The identity fields of a stored issue association.
#[derive(Debug, Default, Deserialize)]
struct IssueRef {
    #[serde(default, deserialize_with = "lenient")]
    kind: String,
    #[serde(default, deserialize_with = "lenient")]
    repository: String,
    #[serde(default, deserialize_with = "lenient")]
    site: String,
    #[serde(default, deserialize_with = "lenient")]
    key: String,
    #[serde(default, deserialize_with = "lenient")]
    id: String,
    /// The JSON literal of the number, as the GitHub REST path takes it.
    #[serde(default = "missing_id", deserialize_with = "id_text")]
    number: String,
}

pub struct IssueImages {
    pub images: Vec<(String, String, Vec<u8>)>,
    pub notes: Vec<String>,
}

/// The selected issue-tracker provider. Provider choice occurs only here.
pub enum IssueTracker {
    Github(github::GithubTracker),
    Jira(jira::JiraTracker),
    Linear(linear::LinearTracker),
}

impl IssueTracker {
    pub async fn new(connection: &Value) -> TrackerResult<Self> {
        match Connection::deserialize(connection)
            .unwrap_or_default()
            .kind
            .as_str()
        {
            "github" => Ok(Self::Github(github::GithubTracker::new(
                connection,
                Some(Github::load().await?),
            ))),
            "jira" => Ok(Self::Jira(jira::JiraTracker::new(connection))),
            "linear" => Ok(Self::Linear(linear::LinearTracker::new(connection))),
            _ => Err(fail("The project does not use a supported issue tracker")),
        }
    }

    pub fn with_github(connection: &Value, github: Option<Github>) -> Self {
        match Connection::deserialize(connection)
            .unwrap_or_default()
            .kind
            .as_str()
        {
            "jira" => Self::Jira(jira::JiraTracker::new(connection)),
            "linear" => Self::Linear(linear::LinearTracker::new(connection)),
            _ => Self::Github(github::GithubTracker::new(connection, github)),
        }
    }

    pub async fn search(&self, query: &str) -> TrackerResult<Vec<Value>> {
        match self {
            Self::Github(tracker) => tracker.search(query).await,
            Self::Jira(tracker) => tracker.search(query).await,
            Self::Linear(tracker) => tracker.search(query).await,
        }
    }
    pub async fn read(&self, issue: &Value) -> TrackerResult<Value> {
        match self {
            Self::Github(tracker) => tracker.read(issue).await,
            Self::Jira(tracker) => tracker.read(issue).await,
            Self::Linear(tracker) => tracker.read(issue).await,
        }
    }
    pub async fn images(&self, issue: &Value, limit: usize) -> TrackerResult<IssueImages> {
        match self {
            Self::Github(_) => Ok(IssueImages {
                images: Vec::new(),
                notes: Vec::new(),
            }),
            Self::Jira(tracker) => tracker.images(issue, limit).await,
            Self::Linear(_) => Ok(IssueImages {
                images: Vec::new(),
                notes: Vec::new(),
            }),
        }
    }
    pub async fn upload(
        &self,
        issue: &Value,
        filename: &str,
        bytes: &[u8],
        mime_type: &str,
        before_write: BeforeWrite<'_>,
    ) -> TrackerResult<String> {
        match self {
            Self::Github(tracker) => {
                tracker
                    .upload(issue, filename, bytes, mime_type, before_write)
                    .await
            }
            Self::Jira(tracker) => {
                tracker
                    .upload(issue, filename, bytes, mime_type, before_write)
                    .await
            }
            Self::Linear(tracker) => {
                tracker
                    .upload(issue, filename, bytes, mime_type, before_write)
                    .await
            }
        }
    }
    pub async fn publish(
        &self,
        issue: &Value,
        task_id: &str,
        body: &str,
        before_write: BeforeWrite<'_>,
        known_comment_id: Option<&str>,
    ) -> TrackerResult<String> {
        match self {
            Self::Github(tracker) => {
                tracker
                    .publish(issue, task_id, body, before_write, known_comment_id)
                    .await
            }
            Self::Jira(tracker) => {
                tracker
                    .publish(issue, task_id, body, before_write, known_comment_id)
                    .await
            }
            Self::Linear(tracker) => {
                tracker
                    .publish(issue, task_id, body, before_write, known_comment_id)
                    .await
            }
        }
    }
    pub fn hosts_evidence_screenshots(&self) -> bool {
        matches!(self, Self::Jira(_) | Self::Linear(_))
    }
    pub fn evidence_label(&self) -> &'static str {
        match self {
            Self::Github(_) => "GitHub",
            Self::Jira(_) => "Jira",
            Self::Linear(_) => "Linear",
        }
    }
    #[cfg(test)]
    fn check(&self, issue: &Value) -> TrackerResult<IssueRef> {
        match self {
            Self::Github(tracker) => tracker.check(issue),
            Self::Jira(tracker) => tracker.check(issue),
            Self::Linear(_) => unreachable!("Linear has provider-specific scope checks"),
        }
    }
    #[cfg(test)]
    fn set_gh_command(&mut self, command: String) {
        if let Self::Github(tracker) = self {
            tracker.set_gh_command(command);
        }
    }
}

pub fn credential_environment_keys(connection: &Value) -> Vec<String> {
    let connection = Connection::deserialize(connection).unwrap_or_default();
    match connection.kind.as_str() {
        "jira" => vec![connection.email_environment, connection.token_environment],
        "linear" => vec![connection.token_environment],
        _ => Vec::new(),
    }
}

/// `suplex-<name>-<sha256>.<ext>`: the evidence file name for these bytes.
fn valid_evidence_name(filename: &str, hash: &str) -> bool {
    filename
        .strip_prefix("suplex-")
        .and_then(|rest| rest.rsplit_once('.'))
        .is_some_and(|(stem, extension)| {
            stem.ends_with(&format!("-{hash}"))
                && stem.len() > hash.len() + 1
                && stem[..stem.len() - hash.len() - 1]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && !extension.is_empty()
                && extension
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn issue_text_flattens_documents_and_stringifies_unknown_objects() {
        assert_eq!(
            issue_text(&json!({"type":"paragraph","content":[{"text":"a"},{"text":"b"}]})),
            "ab"
        );
        assert_eq!(issue_text(&json!({"x":1})), "{\"x\":1}");
        assert_eq!(issue_text(&json!(3)), "3");
    }

    #[test]
    fn linear_credential_environment_key_is_the_token() {
        assert_eq!(
            credential_environment_keys(
                &json!({"kind":"linear","team":"ENG","tokenEnvironment":"LINEAR_API_KEY"})
            ),
            vec!["LINEAR_API_KEY".to_string()]
        );
    }
}
