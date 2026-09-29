//! Provider-neutral native session identities and observations.
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy)]
pub struct SessionRef<'a> {
    pub directory: &'a Path,
    pub native_session_id: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchState {
    NotSubmitted,
    Ambiguous,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptState {
    Unknown,
    Running,
    Completed,
    Error,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptObservation {
    pub state: PromptState,
    pub admission_observed: bool,
    pub retry_allowed: bool,
    pub reason: &'static str,
    pub unsettled_tool_ids: Vec<String>,
    pub native_final_observed: bool,
    pub process_running: bool,
    /// TypeScript `executionUncertain`: a native execution Suplex cannot identify.
    pub execution_uncertain: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UsageTokens {
    pub input: f64,
    pub output: f64,
    pub reasoning: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeTool {
    pub id: String,
    pub name: String,
    pub status: &'static str,
    pub input: Map<String, Value>,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeReasoning {
    pub id: String,
    pub text: String,
}

pub fn session_directory(database_path: &Path, session_id: &str) -> io::Result<PathBuf> {
    if session_id.is_empty()
        || !session_id.as_bytes()[0].is_ascii_alphanumeric()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid task session identity",
        ));
    }
    let parent = database_path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Database path has no parent")
    })?;
    Ok(parent.join("runtime/task-sessions").join(session_id))
}
