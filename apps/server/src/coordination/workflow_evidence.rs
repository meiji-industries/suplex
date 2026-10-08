//! TypeScript `coordination/workflow-evidence.ts`: task-scoped evidence
//! directories outside the Git worktree:
//! `<root>/<taskId>/<evidence-id>/{manifest.json,patch.diff,verification.json,attachments/}`.

use super::CoordinationError;
use crate::shared::time::now_millis_rfc3339;
use std::{
    error::Error,
    fs,
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use git2::{DiffFormat, DiffOptions, Repository};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::workflows::ReviewRange;

pub struct EvidenceAttachment {
    pub artifact_id: String,
    pub mime_type: String,
    pub bytes: Result<Vec<u8>, String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestAttachment {
    pub artifact_id: String,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceManifest<'a> {
    version: u8,
    task_id: &'a str,
    created_at: String,
    base_sha: &'a str,
    head_sha: &'a str,
    files: &'a [String],
    commits: &'a [String],
    attachments: &'a [ManifestAttachment],
}

pub struct WrittenEvidence {
    pub directory: PathBuf,
    pub sha256: String,
    pub attachments: Vec<ManifestAttachment>,
}

fn valid_id(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|ch| ch.is_ascii_alphanumeric())
        && characters.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

pub fn task_evidence_root(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("runtime")
        .join("task-evidence")
}

fn extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

/// The complete three-dot, no-rename patch from the merge base to the head.
fn patch(worktree: &Path, range: &ReviewRange) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
    let repository = Repository::open(worktree)?;
    let base = git2::Oid::from_str(&range.base_sha)?;
    let head = git2::Oid::from_str(&range.head_sha)?;
    let merge_base = repository.merge_base(base, head)?;
    let base_tree = repository.find_commit(merge_base)?.tree()?;
    let head_tree = repository.find_commit(head)?.tree()?;
    let diff = repository.diff_tree_to_tree(
        Some(&base_tree),
        Some(&head_tree),
        Some(&mut DiffOptions::new()),
    )?;
    let mut bytes = Vec::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            bytes.push(line.origin() as u8);
        }
        bytes.extend_from_slice(line.content());
        true
    })?;
    Ok(bytes)
}

fn evidence_files(directory: &Path) -> Vec<String> {
    let mut files = vec![
        "manifest.json".to_owned(),
        "patch.diff".to_owned(),
        "verification.json".to_owned(),
    ];
    if let Ok(entries) = fs::read_dir(directory.join("attachments")) {
        files.extend(
            entries
                .flatten()
                .map(|entry| format!("attachments/{}", entry.file_name().to_string_lossy())),
        );
    }
    files
}

fn digest_files(directory: &Path, mut relative_paths: Vec<String>) -> io::Result<String> {
    relative_paths.sort();
    let mut hash = Sha256::new();
    for relative in relative_paths {
        hash.update(relative.as_bytes());
        hash.update([0]);
        hash.update(fs::read(directory.join(&relative))?);
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Writes every evidence file into a pending directory and publishes it only
/// after all writes finish.
pub fn write_task_evidence(
    root: &Path,
    task_id: &str,
    worktree: &Path,
    range: &ReviewRange,
    attachments: Vec<EvidenceAttachment>,
    verification: &Value,
) -> Result<WrittenEvidence, Box<dyn Error + Send + Sync>> {
    if !valid_id(task_id) {
        return Err(CoordinationError::refused("Invalid task evidence identity").into());
    }
    let task_root = root.join(task_id);
    fs::create_dir_all(&task_root)?;
    fs::set_permissions(&task_root, fs::Permissions::from_mode(0o700))?;
    let id = format!("evidence_{}", uuid::Uuid::new_v4().simple());
    let pending = task_root.join(format!("{id}.pending"));
    let directory = task_root.join(&id);
    fs::create_dir_all(pending.join("attachments"))?;
    for path in [&pending, &pending.join("attachments")] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let written =
        (|| -> Result<(String, Vec<ManifestAttachment>), Box<dyn Error + Send + Sync>> {
            write_private(&pending.join("patch.diff"), &patch(worktree, range)?)?;
            let mut manifest_attachments = Vec::new();
            for attachment in attachments {
                let artifact_id = attachment.artifact_id;
                let (path, error) = if !valid_id(&artifact_id) {
                    (None, Some("invalid artifact identity".to_owned()))
                } else if let Some(extension) = extension(&attachment.mime_type) {
                    let name = format!("{artifact_id}.{extension}");
                    match attachment
                        .bytes
                        .map_err(io::Error::other)
                        .and_then(|bytes| {
                            write_private(&pending.join("attachments").join(&name), &bytes)
                        }) {
                        Ok(()) => (Some(format!("attachments/{name}")), None),
                        Err(error) => (None, Some(error.to_string())),
                    }
                } else {
                    (
                        None,
                        Some(format!("unsupported type {}", attachment.mime_type)),
                    )
                };
                manifest_attachments.push(ManifestAttachment {
                    artifact_id,
                    path,
                    error,
                });
            }
            let manifest = EvidenceManifest {
                version: 1,
                task_id,
                created_at: now_millis_rfc3339(),
                base_sha: &range.base_sha,
                head_sha: &range.head_sha,
                files: &range.files,
                commits: &range.commits,
                attachments: &manifest_attachments,
            };
            write_private(
                &pending.join("manifest.json"),
                serde_json::to_string_pretty(&manifest)?.as_bytes(),
            )?;
            write_private(
                &pending.join("verification.json"),
                serde_json::to_string_pretty(verification)?.as_bytes(),
            )?;
            let sha256 = digest_files(&pending, evidence_files(&pending))?;
            fs::rename(&pending, &directory)?;
            Ok((sha256, manifest_attachments))
        })();
    match written {
        Ok((sha256, attachments)) => Ok(WrittenEvidence {
            directory,
            sha256,
            attachments,
        }),
        Err(error) => {
            let _ = fs::remove_dir_all(&pending);
            Err(error)
        }
    }
}

/// Recomputes the digest over the published files; a missing or changed file
/// never matches.
pub fn verify_task_evidence(directory: &Path, sha256: &str) -> bool {
    digest_files(directory, evidence_files(directory)).is_ok_and(|digest| digest == sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn git(directory: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(directory)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn evidence_is_published_complete_and_any_change_breaks_verification() {
        let base = std::env::temp_dir().join(format!("suplex-evidence-{}", uuid::Uuid::new_v4()));
        let worktree = base.join("work");
        fs::create_dir_all(&worktree).unwrap();
        git(&worktree, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Evidence"),
            ("user.email", "evidence@example.invalid"),
        ] {
            git(&worktree, &["config", key, value]);
        }
        fs::write(worktree.join("a.txt"), "before\n").unwrap();
        git(&worktree, &["add", "."]);
        git(&worktree, &["commit", "-q", "-m", "base"]);
        let base_sha = git(&worktree, &["rev-parse", "HEAD"]);
        fs::write(worktree.join("a.txt"), "after\n").unwrap();
        git(&worktree, &["commit", "-q", "-am", "change"]);
        let head_sha = git(&worktree, &["rev-parse", "HEAD"]);
        let range = ReviewRange {
            base_sha,
            head_sha: head_sha.clone(),
            files: vec!["a.txt".into()],
            commits: vec![head_sha],
            patch_digest: None,
        };
        let root = base.join("evidence");
        let attachments = vec![
            EvidenceAttachment {
                artifact_id: "image_1".into(),
                mime_type: "image/png".into(),
                bytes: Ok(vec![1, 2, 3]),
            },
            EvidenceAttachment {
                artifact_id: "image_2".into(),
                mime_type: "image/png".into(),
                bytes: Err("The task image changed in storage".into()),
            },
            EvidenceAttachment {
                artifact_id: "image_3".into(),
                mime_type: "text/plain".into(),
                bytes: Ok(vec![]),
            },
        ];
        assert!(
            write_task_evidence(&root, "../escape", &worktree, &range, vec![], &json!({})).is_err()
        );
        let written = write_task_evidence(
            &root,
            "task_1",
            &worktree,
            &range,
            attachments,
            &json!({"note":"checks"}),
        )
        .unwrap();
        assert!(written.directory.starts_with(root.join("task_1")));
        assert_eq!(
            fs::read_dir(root.join("task_1")).unwrap().count(),
            1,
            "no pending directory remains"
        );
        let patch = fs::read_to_string(written.directory.join("patch.diff")).unwrap();
        assert!(patch.contains("-before\n+after\n"), "{patch}");
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(written.directory.join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["attachments"],
            json!([
                {"artifactId":"image_1","path":"attachments/image_1.png","error":null},
                {"artifactId":"image_2","path":null,"error":"The task image changed in storage"},
                {"artifactId":"image_3","path":null,"error":"unsupported type text/plain"},
            ])
        );
        assert_eq!(
            fs::metadata(written.directory.join("patch.diff"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(verify_task_evidence(&written.directory, &written.sha256));
        fs::write(written.directory.join("attachments/image_1.png"), [9]).unwrap();
        assert!(!verify_task_evidence(&written.directory, &written.sha256));
        fs::remove_file(written.directory.join("attachments/image_1.png")).unwrap();
        assert!(!verify_task_evidence(&written.directory, &written.sha256));
        fs::remove_dir_all(base).unwrap();
    }
}
