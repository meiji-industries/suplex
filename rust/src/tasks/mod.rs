pub mod agent_api;
pub mod analytics;
pub mod archive;
pub mod artifacts;
pub mod commands;
pub mod control;
pub mod creation;
pub mod dependencies;
pub mod duplicate_title;
pub mod host;
pub mod images;
pub mod integration;
pub mod issue_context;
pub mod limits;
pub mod pane_layout;
pub mod preparation;
pub mod pull_request_dependencies;
pub mod repository;
pub mod response;
pub mod sources;
pub mod templates;
pub mod timeline;
pub mod today_repository;
pub mod worktree;
pub mod worktree_open;

use serde_json::{Map, Value};

use crate::shared::PublicFailure;

/// Task command refusals, and the task domain's internal failures.
#[derive(Debug, thiserror::Error)]
pub enum TaskError {
    /// TypeScript `TaskFailure`.
    #[error("{message}")]
    Failure {
        status: u16,
        code: &'static str,
        message: String,
    },
    /// TypeScript `TaskConflict`.
    #[error("This idempotency key belongs to a different request")]
    Conflict,
    /// TypeScript `TaskSourceFailure`.
    #[error("{message}")]
    Source {
        status: u16,
        code: &'static str,
        message: &'static str,
    },
    /// A task failure with the runtime detail fields TypeScript spreads into the error body.
    #[error("{message}")]
    Agent {
        status: u16,
        code: &'static str,
        message: String,
        details: Map<String, Value>,
    },
    #[error("A task already uses this pull request.")]
    PullRequestOwned,
    /// A task invariant failed. Browsers see a server error.
    #[error("{0}")]
    Internal(String),
}

impl TaskError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self::Failure {
            status,
            code: "task_failure",
            message: message.into(),
        }
    }

    pub fn not_found() -> Self {
        Self::new("Not found", 404)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn is_pull_request_owned(error: &(dyn std::error::Error + 'static)) -> bool {
        matches!(error.downcast_ref(), Some(Self::PullRequestOwned))
    }
}

impl From<TaskError> for PublicFailure {
    fn from(error: TaskError) -> Self {
        let message = error.to_string();
        match error {
            // TypeScript `sendDomainFailure` shows every task code except `task_failure`.
            TaskError::Failure { status, code, .. } | TaskError::Agent { status, code, .. }
                if code != "task_failure" =>
            {
                PublicFailure::new(status, message).with_code(code)
            }
            TaskError::Failure { status, .. } | TaskError::Agent { status, .. } => {
                PublicFailure::new(status, message)
            }
            TaskError::Conflict => PublicFailure::new(409, message),
            TaskError::Source { status, code, .. } => {
                PublicFailure::new(status, message).with_code(code)
            }
            TaskError::PullRequestOwned | TaskError::Internal(_) => PublicFailure::internal(),
        }
    }
}

/// Check task existence and the user's current company access.
pub fn authorize_task(
    database: &crate::platform::database::SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> crate::platform::database::DatabaseResult<String> {
    use rusqlite::OptionalExtension;
    let company: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    let company = company.ok_or_else(TaskError::not_found)?;
    crate::identity::companies::require_company_access(database, user_id, &company)?;
    Ok(company)
}
