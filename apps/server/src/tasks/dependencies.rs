use super::{TaskError, repository};
use crate::platform::database::{DatabaseResult, SuplexDatabase};
use crate::shared::time::rfc3339_millis;
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;

pub fn blocked(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_dependencies d LEFT JOIN suplex_task_controls c ON c.task_id = d.depends_on_task_id WHERE d.task_id = ?1 AND COALESCE(c.status, 'backlog') <> 'delivered')",
        [task_id], |row| row.get(0),
    )?)
}

/// Prerequisites hold native dispatch unless the user started the task anyway.
pub fn dispatch_blocked(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<bool> {
    Ok(blocked(database, task_id)?
        && crate::coordination::root_session_store::workflow_state(database, task_id)?.manual_start
            != Some(true))
}

/// `replaceTaskDependencies`: company scope and acyclicity proven in the writing transaction.
pub fn replace(
    database: &mut SuplexDatabase,
    task_id: &str,
    company_id: &str,
    depends_on: &[String],
    now: DateTime<Utc>,
    reconcile_if_blocked: bool,
) -> DatabaseResult<()> {
    let mut depends_on = depends_on.to_vec();
    depends_on.sort();
    depends_on.dedup();
    if depends_on.iter().any(|dependency| dependency == task_id) {
        return Err(TaskError::new("A task cannot depend on itself", 422).into());
    }
    let time = rfc3339_millis(now);
    database.transaction(true, |database| {
        let was_blocked = blocked(database, task_id)?;
        for dependency in &depends_on {
            let company: Option<String> = database
                .connection()
                .query_row("SELECT company_id FROM suplex_tasks WHERE id = ?1", [dependency], |row| row.get(0))
                .optional()?;
            if company.as_deref() != Some(company_id) {
                return Err(TaskError::new("A dependency task is not available", 404).into());
            }
        }
        database.connection().execute("DELETE FROM suplex_task_dependencies WHERE task_id = ?1", [task_id])?;
        for dependency in &depends_on {
            database.connection().execute(
                "INSERT INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?1, ?2, ?3)",
                params![task_id, dependency, time],
            )?;
        }
        let mut seen = HashSet::new();
        let mut queue = depends_on.clone();
        while let Some(next) = queue.pop() {
            if next == task_id {
                return Err(TaskError::new("The dependency creates a cycle", 422).into());
            }
            if !seen.insert(next.clone()) {
                continue;
            }
            let mut statement = database.connection().prepare("SELECT depends_on_task_id FROM suplex_task_dependencies WHERE task_id = ?1")?;
            for edge in statement.query_map([&next], |row| row.get::<_, String>(0))? {
                queue.push(edge?);
            }
        }
        if reconcile_if_blocked && was_blocked {
            repository::reconcile_dependency_release(database, task_id, now)?;
        }
        Ok(())
    })
}
