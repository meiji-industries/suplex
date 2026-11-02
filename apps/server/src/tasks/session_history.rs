//! Native session history shared by the board and the Agent API.

use std::{collections::HashMap, error::Error, io, path::PathBuf};

use serde_json::Value;

use crate::{
    coordination::root_session_store,
    platform::database::SuplexDatabase,
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::TaskError,
};

pub(crate) const PAGE_SIZE: usize = 40;

#[derive(Clone)]
pub(crate) struct ScopedSession {
    database_path: PathBuf,
    session_id: String,
    pub(crate) current: bool,
    native_session_id: Option<String>,
    instance_home_directory: Option<String>,
}

/// A session of the task. The caller has already authorized the task.
pub(crate) fn session_scope(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
) -> Result<ScopedSession, Box<dyn Error + Send + Sync>> {
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let session = rows.session(session_id).ok_or_else(TaskError::not_found)?;
    let instance_home_directory = rows
        .profile_of(session)
        .instance_home_directory()
        .map(str::to_owned);
    Ok(ScopedSession {
        database_path: PathBuf::from(
            database
                .connection()
                .path()
                .ok_or("Task database has no path")?,
        ),
        session_id: session_id.to_owned(),
        current: session.current,
        native_session_id: session.native_session_id.clone(),
        instance_home_directory,
    })
}

pub(crate) async fn native_history(scoped: &ScopedSession) -> io::Result<Vec<Value>> {
    let Some(native_session_id) = scoped.native_session_id.as_deref() else {
        return Ok(Vec::new());
    };
    task_harness_registry::native_session_reader(native_session_id)
        .ok_or_else(|| io::Error::other("Native session history is not available"))?
        .history(&ReaderSession {
            database_path: &scoped.database_path,
            session_id: &scoped.session_id,
            native_session_id,
            instance_home_directory: scoped
                .instance_home_directory
                .as_deref()
                .map(std::path::Path::new),
        })
        .await
}

/// The messages in first-seen order; a later message with the same id replaces the earlier one.
pub(crate) fn ordered(messages: &[Value]) -> Vec<&Value> {
    let mut ordered = Vec::new();
    let mut slots = HashMap::new();
    for message in messages {
        match slots
            .get(message["id"].as_str().unwrap_or_default())
            .copied()
        {
            Some(index) => ordered[index] = message,
            None => {
                slots.insert(message["id"].as_str().unwrap_or_default(), ordered.len());
                ordered.push(message);
            }
        }
    }
    ordered
}

/// The index after the last message of a page: the cursor message, or the end.
pub(crate) fn page_end(ordered: &[&Value], before: Option<&str>) -> Result<usize, TaskError> {
    match before {
        None => Ok(ordered.len()),
        Some(before) => ordered
            .iter()
            .position(|message| message["id"] == before)
            .ok_or_else(|| TaskError::Failure {
                message: "The session history cursor is not available".into(),
                status: 400,
                code: "cursor_invalid",
            }),
    }
}
