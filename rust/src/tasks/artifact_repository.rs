//! Durable storage for task-generated media.

use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};

use super::{MediaType, artifacts};
use crate::{
    platform::{
        artifacts::{ArtifactInput, StoredArtifact},
        database::{DatabaseResult, SuplexDatabase},
    },
    shared::hash::sha256_hex,
};

pub(super) fn task_exists(database: &SuplexDatabase, task_id: &str) -> bool {
    database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .is_ok_and(|company_id| company_id.is_some())
}

pub(crate) fn store_media(
    database: &mut SuplexDatabase,
    artifact_root: &Path,
    task_id: &str,
    filename: &str,
    media_type: MediaType,
    bytes: &[u8],
    now: DateTime<Utc>,
) -> DatabaseResult<Option<StoredArtifact>> {
    if !media_type.matches(bytes) || bytes.len() > media_type.max_bytes() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Generated media is invalid or too large",
        )
        .into());
    }
    let digest = sha256_hex(bytes);
    let mut written = None;
    let result = database.transaction(false, |database| {
        let duplicate: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_artifacts WHERE task_id = ?1 AND mime_type = ?2 AND sha256 = ?3 AND kind IN ('delivery-image','delivery-video'))",
            params![task_id, media_type.mime_type(), digest],
            |row| row.get(0),
        )?;
        if duplicate {
            return Ok(None);
        }
        let company_id: String = database.connection().query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        let artifact = artifacts::put_in_transaction_with_limit(
            database,
            artifact_root,
            &company_id,
            media_type.kind(),
            &ArtifactInput {
                filename,
                mime_type: media_type.mime_type(),
                bytes,
                task_id,
            },
            now,
            media_type.max_bytes(),
        )?;
        written = Some(artifact.clone());
        Ok(Some(artifact))
    });
    if result.is_err()
        && let Some(artifact) = &written
    {
        artifacts::remove_written(artifact_root, artifact);
    }
    result
}
