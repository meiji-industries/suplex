//! Task-generated visual media collected from the task evidence directory.

use std::{
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

use chrono::Utc;

use crate::platform::{artifacts, database::SuplexDatabase};

#[path = "artifact_repository.rs"]
mod repository;

pub(crate) use repository::store_media;

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
    if !repository::task_exists(database, task_id) {
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
include!("../../tests/tasks/artifacts.rs");
