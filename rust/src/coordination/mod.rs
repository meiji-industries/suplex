pub mod advisor_bridge;
pub mod advisor_evidence;
pub mod bridge_auth;
pub mod persistence;
pub mod replacement;
pub mod root_bridge;
pub mod root_controller;
pub mod root_prompts;
pub mod root_session_store;
pub mod root_stdio;
pub mod session_recovery;
pub mod worker_evidence;
pub mod workflow_evidence;
pub mod workflow_records;
pub mod workflows;

/// A Root, Worker, or Advisor command that the durable task intent refuses.
/// The text is the TypeScript error message the caller reports.
#[derive(Debug, thiserror::Error)]
pub enum CoordinationError {
    #[error("{0}")]
    Refused(String),
}

impl CoordinationError {
    pub fn refused(message: impl Into<String>) -> Self {
        Self::Refused(message.into())
    }
}
