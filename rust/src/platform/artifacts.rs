//! Opaque artifact files and their single durable database row.

use crate::shared::hash::sha256_hex;
use crate::shared::time::rfc3339_millis;
use std::{
    error::Error,
    fmt, fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, Utc};
use rusqlite::params;
use uuid::Uuid;

use super::database::{DatabaseResult, SuplexDatabase};

pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct ArtifactFailure {
    pub code: &'static str,
    pub message: &'static str,
}

impl ArtifactFailure {
    pub const fn invalid_image_data() -> Self {
        Self {
            code: "invalid-image-data",
            message: "Image data is invalid or too large",
        }
    }

    fn invalid_artifact() -> Self {
        Self {
            code: "invalid-artifact",
            message: "Artifact input is invalid",
        }
    }

    fn invalid_company() -> Self {
        Self {
            code: "invalid-company",
            message: "Artifact company is invalid",
        }
    }

    fn traversal() -> Self {
        Self {
            code: "artifact-traversal",
            message: "Artifact path is invalid",
        }
    }

    fn company_scope() -> Self {
        Self {
            code: "artifact-company-scope",
            message: "Artifact is outside the company root",
        }
    }
}

impl fmt::Display for ArtifactFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for ArtifactFailure {}

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

fn validate(
    company_id: &str,
    kind: &str,
    input: &ArtifactInput<'_>,
) -> Result<(), ArtifactFailure> {
    if kind.trim().is_empty()
        || input.mime_type.is_empty()
        || input.mime_type.contains(['\r', '\n'])
        || input.bytes.is_empty()
        || input.bytes.len() > MAX_ARTIFACT_BYTES
        || input.filename.trim().is_empty()
        || Path::new(input.filename)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(input.filename)
    {
        return Err(ArtifactFailure::invalid_artifact());
    }
    if !valid_company_id(company_id) {
        return Err(ArtifactFailure::invalid_company());
    }
    Ok(())
}

fn checked(root: &Path, company_id: &str, storage_path: &str) -> Result<PathBuf, ArtifactFailure> {
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
        return Err(ArtifactFailure::traversal());
    }
    let target = root.join(storage_path);
    if !target.starts_with(root.join(company_id)) {
        return Err(ArtifactFailure::company_scope());
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
    validate(company_id, kind, input)?;
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

/// Best-effort cleanup only for files created by the failed transaction.
pub fn remove_written(root: &Path, artifact: &StoredArtifact) {
    if let Ok(path) = checked(root, &artifact.company_id, &artifact.storage_path) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;
    use crate::platform::database::OpenMode;

    #[test]
    fn task_image_file_and_row_share_commit_and_rollback_cleanup() {
        let directory = std::env::temp_dir().join(format!("suplex-artifacts-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let root = directory.join("artifacts");
        let mut database =
            SuplexDatabase::open(&directory.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        database
            .connection()
            .execute(
                "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?1)",
                [now.to_rfc3339()],
            )
            .unwrap();
        let input = ArtifactInput {
            filename: "proof.png",
            mime_type: "image/png",
            bytes: &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            task_id: "task_1",
        };
        let mut written = Vec::new();
        let failed: DatabaseResult<()> = database.transaction(true, |database| {
            written.push(put_in_transaction(
                database,
                &root,
                "company",
                "task-image",
                &input,
                now,
            )?);
            Err(io::Error::other("later task write failed").into())
        });
        assert!(failed.is_err());
        for artifact in &written {
            remove_written(&root, artifact);
        }
        let count: i64 = database
            .connection()
            .query_row("SELECT count(*) FROM suplex_artifacts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(
            !checked(&root, "company", &written[0].storage_path)
                .unwrap()
                .exists()
        );

        let stored = database
            .transaction(true, |database| {
                put_in_transaction(database, &root, "company", "task-image", &input, now)
            })
            .unwrap();
        assert_eq!(
            read(&root, &stored.company_id, &stored.storage_path).unwrap(),
            input.bytes
        );
        assert_eq!(stored.byte_size, input.bytes.len());
        assert_eq!(stored.sha256, sha256_hex(input.bytes));
        assert!(stored.storage_path.starts_with("company/objects/"));
        let recorded_path: String = database
            .connection()
            .query_row(
                "SELECT storage_path FROM suplex_artifacts WHERE id = ?1 AND task_id = 'task_1'",
                [&stored.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded_path, stored.storage_path);
        use std::os::unix::fs::PermissionsExt;
        let file_path = checked(&root, "company", &stored.storage_path).unwrap();
        assert_eq!(
            fs::metadata(&file_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(file_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(read(&root, "company", "other/objects/aa/image.bin").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
