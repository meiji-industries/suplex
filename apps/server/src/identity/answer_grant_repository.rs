//! Persistence for an external agent's grant to answer Coordinator questions.

use rusqlite::{OptionalExtension, params};

use crate::platform::database::{DatabaseResult, SuplexDatabase};

/// An administrator let this agent answer Coordinator questions on their behalf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnswerGrant {
    pub agent_name: String,
    pub user_id: String,
    pub user_name: String,
}

/// The grant holds only while the granting user is still an active administrator.
pub(crate) fn read(
    database: &SuplexDatabase,
    agent_id: &str,
) -> DatabaseResult<Option<AnswerGrant>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT ag.name, u.id, u.display_name FROM suplex_external_agents e JOIN suplex_agents ag ON ag.id = e.id JOIN suplex_users u ON u.id = e.answer_granted_by_user_id WHERE e.id = ?1 AND e.answer_granted_at IS NOT NULL AND u.status = 'active' AND u.role = 'admin'",
            [agent_id],
            |row| {
                Ok(AnswerGrant {
                    agent_name: row.get(0)?,
                    user_id: row.get(1)?,
                    user_name: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Record the granting administrator and time, or clear both.
pub(crate) fn write(
    database: &SuplexDatabase,
    agent_id: &str,
    granted_by: Option<&str>,
    now: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_external_agents SET answer_granted_by_user_id = ?1, answer_granted_at = ?2, updated_at = ?3 WHERE id = ?4",
        params![granted_by, granted_by.map(|_| now), now, agent_id],
    )?;
    Ok(())
}
