//! Opaque artifact files and their single durable database row.

use crate::shared::hash::sha256_hex;
use crate::shared::time::rfc3339_millis;
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, Utc};
use rusqlite::params;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    PlatformError,
    database::{DatabaseResult, SuplexDatabase},
};

pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;

impl PlatformError {
    pub const fn invalid_image_data() -> Self {
        Self::Artifact {
            code: "invalid-image-data",
            message: "Image data is invalid or too large",
        }
    }

    fn invalid_artifact() -> Self {
        Self::Artifact {
            code: "invalid-artifact",
            message: "Artifact input is invalid",
        }
    }

    fn invalid_company() -> Self {
        Self::Artifact {
            code: "invalid-company",
            message: "Artifact company is invalid",
        }
    }

    fn traversal() -> Self {
        Self::Artifact {
            code: "artifact-traversal",
            message: "Artifact path is invalid",
        }
    }

    fn company_scope() -> Self {
        Self::Artifact {
            code: "artifact-company-scope",
            message: "Artifact is outside the company root",
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredArtifact {
    pub id: String,
    pub company_id: String,
    pub kind: String,
    pub filename: String,
    pub mime_type: String,
    pub byte_size: usize,
    pub sha256: String,
    pub storage_path: String,
    pub created_at: String,
}

pub struct ArtifactInput<'a> {
    pub filename: &'a str,
    pub mime_type: &'a str,
    pub bytes: &'a [u8],
    pub task_id: &'a str,
}

fn valid_company_id(company_id: &str) -> bool {
    company_id.len() <= 128
        && company_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || index > 0 && (byte == b'_' || byte == b'-')
        })
        && !company_id.is_empty()
}

fn validate_with_limit(
    company_id: &str,
    kind: &str,
    input: &ArtifactInput<'_>,
    max_bytes: usize,
) -> Result<(), PlatformError> {
    if kind.trim().is_empty()
        || input.mime_type.is_empty()
        || input.mime_type.contains(['\r', '\n'])
        || input.bytes.is_empty()
        || input.bytes.len() > max_bytes
        || input.filename.trim().is_empty()
        || Path::new(input.filename)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(input.filename)
    {
        return Err(PlatformError::invalid_artifact());
    }
    if !valid_company_id(company_id) {
        return Err(PlatformError::invalid_company());
    }
    Ok(())
}

fn checked(root: &Path, company_id: &str, storage_path: &str) -> Result<PathBuf, PlatformError> {
    if !valid_company_id(company_id)
        || storage_path.is_empty()
        || storage_path.contains('\\')
        || Path::new(storage_path).is_absolute()
        || Path::new(storage_path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || storage_path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(PlatformError::traversal());
    }
    let target = root.join(storage_path);
    if !target.starts_with(root.join(company_id)) {
        return Err(PlatformError::company_scope());
    }
    Ok(target)
}

/// Call inside the task's transaction. The caller removes returned files if an
/// outer write later rolls back, as the source repository does.
pub fn put_in_transaction(
    database: &SuplexDatabase,
    root: &Path,
    company_id: &str,
    kind: &str,
    input: &ArtifactInput<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<StoredArtifact> {
    put_in_transaction_with_limit(
        database,
        root,
        company_id,
        kind,
        input,
        now,
        MAX_ARTIFACT_BYTES,
    )
}

pub fn put_in_transaction_with_limit(
    database: &SuplexDatabase,
    root: &Path,
    company_id: &str,
    kind: &str,
    input: &ArtifactInput<'_>,
    now: DateTime<Utc>,
    max_bytes: usize,
) -> DatabaseResult<StoredArtifact> {
    validate_with_limit(company_id, kind, input, max_bytes)?;
    let id = format!("artifact_{}", Uuid::new_v4().simple());
    let sha256 = sha256_hex(input.bytes);
    let storage_path = format!("{company_id}/objects/{}/{}.bin", &sha256[..2], id);
    let path = checked(root, company_id, &storage_path)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path.parent().ok_or("Artifact path has no parent")?)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    if let Err(error) = file.write_all(input.bytes) {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    let artifact = StoredArtifact {
        id,
        company_id: company_id.to_owned(),
        kind: kind.to_owned(),
        filename: input.filename.to_owned(),
        mime_type: input.mime_type.to_owned(),
        byte_size: input.bytes.len(),
        sha256,
        storage_path,
        created_at: rfc3339_millis(now),
    };
    let insert = database.connection().execute(
        "INSERT INTO suplex_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![artifact.id, artifact.company_id, input.task_id, artifact.kind, artifact.filename, artifact.mime_type, artifact.byte_size as i64, artifact.sha256, artifact.storage_path, artifact.created_at],
    );
    if let Err(error) = insert {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    Ok(artifact)
}

pub fn read(root: &Path, company_id: &str, storage_path: &str) -> DatabaseResult<Vec<u8>> {
    Ok(fs::read(checked(root, company_id, storage_path)?)?)
}

pub fn verified_path(
    root: &Path,
    company_id: &str,
    storage_path: &str,
    expected_sha256: &str,
) -> DatabaseResult<Option<PathBuf>> {
    let path = checked(root, company_id, storage_path)?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    if !file.metadata()?.is_file() {
        return Err(PlatformError::invalid_artifact().into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    if format!("{:x}", digest.finalize()) != expected_sha256 {
        return Ok(None);
    }
    Ok(Some(path))
}

/// Best-effort cleanup only for files created by the failed transaction.
pub fn remove_written(root: &Path, artifact: &StoredArtifact) {
    if let Ok(path) = checked(root, &artifact.company_id, &artifact.storage_path) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
include!("../../tests/platform/artifacts.rs");
