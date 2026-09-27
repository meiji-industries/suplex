//! Task-generated visual media collected from the task evidence directory.

use std::{
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};

use crate::{
    platform::{
        artifacts::{self, ArtifactInput, StoredArtifact},
        database::{DatabaseResult, SuplexDatabase},
    },
    shared::hash::sha256_hex,
};

pub const MAX_VIDEO_BYTES: usize = 128 * 1024 * 1024;
const SETTLE_TIME: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaType {
    Png,
    Jpeg,
    WebP,
    Gif,
    Mp4,
    WebM,
}

impl MediaType {
    pub fn from_path(path: &Path) -> Option<Self> {
        Self::from_extension(path.extension()?.to_str()?)
    }

    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::WebP),
            "gif" => Some(Self::Gif),
            "mp4" => Some(Self::Mp4),
            "webm" => Some(Self::WebM),
            _ => None,
        }
    }

    pub fn from_mime_type(mime_type: &str) -> Option<Self> {
        match mime_type {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::WebP),
            "image/gif" => Some(Self::Gif),
            "video/mp4" => Some(Self::Mp4),
            "video/webm" => Some(Self::WebM),
            _ => None,
        }
    }

    pub const fn is_image(self) -> bool {
        matches!(self, Self::Png | Self::Jpeg | Self::WebP | Self::Gif)
    }

    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::WebP => "image/webp",
            Self::Gif => "image/gif",
            Self::Mp4 => "video/mp4",
            Self::WebM => "video/webm",
        }
    }

    const fn kind(self) -> &'static str {
        match self {
            Self::Png | Self::Jpeg | Self::WebP | Self::Gif => "delivery-image",
            Self::Mp4 | Self::WebM => "delivery-video",
        }
    }

    const fn max_bytes(self) -> usize {
        match self {
            Self::Png | Self::Jpeg | Self::WebP | Self::Gif => artifacts::MAX_ARTIFACT_BYTES,
            Self::Mp4 | Self::WebM => MAX_VIDEO_BYTES,
        }
    }

    pub fn matches(self, bytes: &[u8]) -> bool {
        match self {
            Self::Png => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Self::Jpeg => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            Self::WebP => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
            Self::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            Self::Mp4 => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
            Self::WebM => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        }
    }
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct CollectionReport {
    pub imported: usize,
    pub duplicates: usize,
    pub diagnostics: Vec<String>,
}

fn generated_directory(database_path: &Path, task_id: &str) -> Option<PathBuf> {
    let valid_task_id = !task_id.is_empty()
        && Path::new(task_id)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(task_id)
        && !matches!(task_id, "." | "..")
        && !task_id.contains('\u{5c}');
    valid_task_id.then(|| {
        database_path
            .parent()
            .unwrap_or(Path::new(""))
            .join("runtime/task-evidence")
            .join(task_id)
            .join("generated")
    })
}

fn media_paths(
    root: &Path,
    directory: &Path,
    output: &mut Vec<PathBuf>,
    diagnostics: &mut Vec<String>,
) {
    if fs::canonicalize(directory)
        .ok()
        .is_none_or(|resolved| !resolved.starts_with(root))
    {
        diagnostics.push(format!(
            "Ignored unsafe media directory {}",
            directory.display()
        ));
        return;
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            diagnostics.push(format!("Could not read {}: {error}", directory.display()));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                diagnostics.push(format!(
                    "Could not read an artifact directory entry: {error}"
                ));
                continue;
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                diagnostics.push(format!("Could not inspect {}: {error}", path.display()));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            diagnostics.push(format!("Ignored symbolic link {}", path.display()));
        } else if metadata.is_dir() {
            media_paths(root, &path, output, diagnostics);
        } else if metadata.is_file() && MediaType::from_path(&path).is_some() {
            output.push(path);
        }
    }
}

fn artifact_filename(directory: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(directory).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        parts.push(part.to_str()?);
    }
    (!parts.is_empty()).then(|| parts.join("--"))
}

fn read_stable(root: &Path, path: &Path, media_type: MediaType) -> Result<Vec<u8>, String> {
    if fs::canonicalize(path)
        .ok()
        .is_none_or(|resolved| !resolved.starts_with(root))
    {
        return Err("Media resolves outside the generated directory".to_owned());
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| error.to_string())?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    let max_bytes = media_type.max_bytes();
    if !before.is_file() || before.len() == 0 || before.len() > max_bytes as u64 {
        return Err(format!(
            "Media must be a regular file of at most {} MiB",
            max_bytes / 1024 / 1024
        ));
    }
    let settled = before
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age >= SETTLE_TIME);
    if !settled {
        return Err("Media is still settling and will be retried".to_owned());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let after = file.metadata().map_err(|error| error.to_string())?;
    let unchanged = before.len() == after.len()
        && before.modified().ok() == after.modified().ok()
        && bytes.len() as u64 == after.len();
    if !unchanged {
        return Err("Media changed while Suplex read it".to_owned());
    }
    if !media_type.matches(&bytes) {
        return Err(format!(
            "Media does not match its {} type",
            media_type.mime_type()
        ));
    }
    Ok(bytes)
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

pub fn collect_generated_media(
    database: &mut SuplexDatabase,
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
) -> CollectionReport {
    let mut report = CollectionReport::default();
    let Some(directory) = generated_directory(database_path, task_id) else {
        report
            .diagnostics
            .push("Task id cannot name an artifact directory".to_owned());
        return report;
    };
    if !directory.exists() {
        return report;
    }
    let evidence_root = database_path
        .parent()
        .unwrap_or(Path::new(""))
        .join("runtime/task-evidence");
    let canonical_directory = fs::canonicalize(&directory).ok();
    let canonical_root = fs::canonicalize(&evidence_root).ok();
    let safe = canonical_directory
        .as_ref()
        .zip(canonical_root.as_ref())
        .is_some_and(|(actual, root)| *actual == root.join(task_id).join("generated"));
    if !safe {
        report.diagnostics.push(format!(
            "Ignored unsafe artifact directory {}",
            directory.display()
        ));
        return report;
    }
    let canonical_directory = canonical_directory.expect("safe generated directory is canonical");
    let company_exists = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional();
    if !matches!(company_exists, Ok(Some(_))) {
        report.diagnostics.push(format!(
            "Task {task_id} is unavailable for artifact collection"
        ));
        return report;
    }
    let mut paths = Vec::new();
    media_paths(
        &canonical_directory,
        &directory,
        &mut paths,
        &mut report.diagnostics,
    );
    paths.sort();
    for path in paths {
        let Some(media_type) = MediaType::from_path(&path) else {
            continue;
        };
        let Some(filename) = artifact_filename(&directory, &path) else {
            report
                .diagnostics
                .push(format!("Ignored invalid media path {}", path.display()));
            continue;
        };
        let bytes = match read_stable(&canonical_directory, &path, media_type) {
            Ok(bytes) => bytes,
            Err(error) => {
                report
                    .diagnostics
                    .push(format!("Ignored {}: {error}", path.display()));
                continue;
            }
        };
        match store_media(
            database,
            artifact_root,
            task_id,
            &filename,
            media_type,
            &bytes,
            Utc::now(),
        ) {
            Ok(Some(_)) => report.imported += 1,
            Ok(None) => report.duplicates += 1,
            Err(error) => report
                .diagnostics
                .push(format!("Could not retain {}: {error}", path.display())),
        }
    }
    report
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        coordination::workflows::Workflow,
        platform::database::{OpenMode, SuplexDatabase},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use serde_json::json;
    use uuid::Uuid;

    fn settle(path: &Path) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(
            fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(2)),
        )
        .unwrap();
    }

    pub(crate) fn fixture() -> (PathBuf, PathBuf, SuplexDatabase, String) {
        let directory = std::env::temp_dir().join(format!("suplex-task-media-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let database_path = directory.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let user = crate::identity::auth::development_sign_in(&mut database, now)
            .unwrap()
            .user;
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_media','Media','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('project_media','company_media','Media','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)", [&stamp]).unwrap();
        let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
        let task = repository::create(
            &mut database,
            &PreparedTask {
                id: repository::new_task_id(),
                company_id: "company_media".into(),
                project_id: "project_media".into(),
                title: "Media task".into(),
                description: String::new(),
                configuration: json!({
                    "repository":"owner/repo",
                    "repositoryPath":"/tmp/repo",
                    "worktreeRoot":"/tmp/worktrees",
                    "branch":"task-media",
                    "baseBranch":"main",
                    "baselineSha":"head",
                    "startingSha":"head",
                    "visualEvidence":"off",
                    "source":null,
                    "capturedAt":now.to_rfc3339()
                }),
                idempotency_key: Uuid::new_v4().to_string(),
                request_hash: "media-hash".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "merged".into(),
                delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-media","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(profile.clone()).unwrap(),
                worker_profile: serde_json::from_value(profile).unwrap(),
                advisor_profiles: serde_json::from_value(json!({})).unwrap(),
                issue: None,
                start_queued: false,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![],
                workflow: Workflow::Standard,
            },
            now,
        )
        .unwrap()
        .task;
        (directory.clone(), database_path, database, task.id)
    }

    #[test]
    fn collection_keeps_good_nested_media_and_retries_bad_neighbors() {
        let (directory, database_path, mut database, task_id) = fixture();
        let generated = generated_directory(&database_path, &task_id).unwrap();
        fs::create_dir_all(generated.join("recordings")).unwrap();
        fs::write(
            generated.join("shot.png"),
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        settle(&generated.join("shot.png"));
        fs::write(
            generated.join("recordings/demo.mp4"),
            [0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'],
        )
        .unwrap();
        settle(&generated.join("recordings/demo.mp4"));
        fs::write(generated.join("delivery-evidence.json"), b"not media").unwrap();
        fs::write(generated.join("bad.webp"), b"not webp").unwrap();
        settle(&generated.join("bad.webp"));
        let oversized = fs::File::create(generated.join("large.gif")).unwrap();
        oversized
            .set_len(artifacts::MAX_ARTIFACT_BYTES as u64 + 1)
            .unwrap();
        settle(&generated.join("large.gif"));
        let outside = directory.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("outside.png"),
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, generated.join("linked-media")).unwrap();

        let root = directory.join("artifacts");
        let first = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(first.imported, 2);
        assert_eq!(first.duplicates, 0);
        assert_eq!(first.diagnostics.len(), 3);

        let repeated = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(repeated.imported, 0);
        assert_eq!(repeated.duplicates, 2);
        assert_eq!(repeated.diagnostics.len(), 3);

        database
            .transaction(false, |database| {
                artifacts::put_in_transaction(
                    database,
                    &root,
                    "company_media",
                    "delivery-evidence",
                    &ArtifactInput {
                        filename: "delivery-evidence.json",
                        mime_type: "application/json",
                        bytes: b"{}",
                        task_id: &task_id,
                    },
                    Utc::now(),
                )?;
                Ok(())
            })
            .unwrap();

        let response = serde_json::to_value(
            repository::task_response(&database, &task_id)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["artifacts"].as_array().unwrap().len(), 3);
        assert!(
            response["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|artifact| {
                    artifact["filename"] == "recordings--demo.mp4"
                        && artifact["mimeType"] == "video/mp4"
                })
        );
        assert!(
            response["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|artifact| artifact["mimeType"] == "application/json")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn newly_modified_media_waits_for_a_later_sweep() {
        let (directory, database_path, mut database, task_id) = fixture();
        let generated = generated_directory(&database_path, &task_id).unwrap();
        fs::create_dir_all(&generated).unwrap();
        let video = generated.join("demo.webm");
        fs::write(&video, [0x1a, 0x45, 0xdf, 0xa3]).unwrap();
        let root = directory.join("artifacts");

        let fresh = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(fresh.imported, 0);
        assert!(
            fresh
                .diagnostics
                .iter()
                .any(|item| item.contains("settling"))
        );

        settle(&video);
        let settled = collect_generated_media(&mut database, &database_path, &root, &task_id);
        assert_eq!(settled.imported, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn media_signatures_cover_the_supported_allowlist() {
        assert!(MediaType::Png.matches(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
        assert!(MediaType::Jpeg.matches(&[0xff, 0xd8, 0xff]));
        assert!(MediaType::WebP.matches(b"RIFF0000WEBP"));
        assert!(MediaType::Gif.matches(b"GIF89a"));
        assert!(MediaType::Mp4.matches(b"0000ftypisom"));
        assert!(MediaType::WebM.matches(&[0x1a, 0x45, 0xdf, 0xa3]));
        assert!(!MediaType::WebM.matches(b"<svg"));
    }
}
