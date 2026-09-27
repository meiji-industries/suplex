//! Read the published-base-to-local-head range for a Standard task.

use crate::delivery::DeliveryError;
use crate::shared::hash::sha256_hex;
use std::{error::Error, path::Path};
use ts_rs::TS;

use git2::{DiffFormat, DiffOptions, Repository, Sort};
use serde::Serialize;

use crate::{integrations::github_delivery::valid_sha, platform::redaction, tasks::worktree};

const PATCH_DISPLAY_UNITS: usize = 64_000;

/// TypeScript `ReviewRange`: the reviewed or observed delivery range.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRange {
    pub base_sha: String,
    pub head_sha: String,
    pub files: Vec<String>,
    pub commits: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub patch_digest: Option<String>,
}

impl From<&DeliveryDiff> for ReviewRange {
    fn from(diff: &DeliveryDiff) -> Self {
        Self {
            base_sha: diff.base_sha.clone(),
            head_sha: diff.head_sha.clone(),
            files: diff.files.clone(),
            commits: diff.commits.clone(),
            patch_digest: Some(diff.patch_digest.clone()),
        }
    }
}

/// TypeScript `rangeDifferences`.
pub fn range_differences(review: &ReviewRange, actual: &ReviewRange) -> Vec<&'static str> {
    let same = |left: &[String], right: &[String]| {
        let (mut left, mut right) = (left.to_vec(), right.to_vec());
        left.sort();
        right.sort();
        left == right
    };
    let mut differences = Vec::new();
    if review.head_sha != actual.head_sha {
        differences.push("head");
    }
    if !same(&review.commits, &actual.commits) {
        differences.push("commits");
    }
    if !same(&review.files, &actual.files) {
        differences.push("files");
    }
    if review.base_sha != actual.base_sha
        && (review.patch_digest.is_none()
            || actual.patch_digest.is_none()
            || review.patch_digest != actual.patch_digest)
    {
        differences.push("patch content");
    }
    differences
}

pub fn same_range(review: &ReviewRange, actual: &ReviewRange) -> bool {
    range_differences(review, actual).is_empty()
}

/// TypeScript `inspectDeliveryDiff` on two revisions, fetching either when absent.
pub fn inspect_revisions(
    path: &Path,
    base_sha: &str,
    head_sha: &str,
    github_token: Option<&str>,
    base_branch: &str,
) -> Result<DeliveryDiff, Box<dyn Error>> {
    if ![base_sha, head_sha].iter().all(|sha| valid_sha(sha)) {
        return Err(unavailable("GitHub delivery revisions are not valid"));
    }
    let head = git2::Oid::from_str(head_sha)?;
    let repository = Repository::open(path)?;
    worktree::published_base_commit(&repository, head, github_token).map_err(|_| {
        DeliveryError::internal(format!(
            "Git could not obtain reviewed revision {}",
            &head_sha[..12]
        ))
    })?;
    inspect_git_range(
        &repository,
        head,
        git2::Oid::from_str(base_sha)?,
        github_token,
        base_branch,
    )
}

/// TypeScript `reviewEquivalence`: a reviewed range still authorizes delivery
/// onto another base when Git proves the integrated content is unchanged.
pub fn review_equivalence(
    path: &Path,
    accepted: &ReviewRange,
    base_sha: &str,
    github_token: Option<&str>,
) -> Result<ReviewRange, String> {
    let shas = [
        accepted.base_sha.as_str(),
        base_sha,
        accepted.head_sha.as_str(),
    ];
    if !shas.iter().all(|sha| valid_sha(sha)) {
        return Err("Git delivery revisions are not valid".into());
    }
    let repository = Repository::open(path).map_err(|error| error.to_string())?;
    for sha in shas {
        let oid = git2::Oid::from_str(sha).map_err(|error| error.to_string())?;
        worktree::published_base_commit(&repository, oid, github_token)
            .map_err(|_| format!("Git could not obtain reviewed revision {}", &sha[..12]))?;
    }
    let reviewed = inspect_loaded_range(
        &repository,
        git2::Oid::from_str(&accepted.head_sha).map_err(|error| error.to_string())?,
        git2::Oid::from_str(&accepted.base_sha).map_err(|error| error.to_string())?,
        "",
    )
    .map_err(|error| error.to_string())?;
    let reviewed = ReviewRange::from(&reviewed);
    if !same_range(accepted, &reviewed) {
        return Err(format!(
            "The accepted range no longer matches Git: {}.",
            range_differences(accepted, &reviewed).join(", ")
        ));
    }
    if base_sha == accepted.base_sha {
        return Ok(reviewed);
    }
    let merged = (|| -> Result<git2::Index, git2::Error> {
        let base = repository.find_commit(git2::Oid::from_str(base_sha)?)?;
        let head = repository.find_commit(git2::Oid::from_str(&accepted.head_sha)?)?;
        repository.merge_commits(&base, &head, None)
    })()
    .map_err(|error| error.to_string())?;
    if merged.has_conflicts() {
        let files = merged
            .conflicts()
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .filter_map(|conflict| conflict.our.or(conflict.their).or(conflict.ancestor))
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .collect::<Vec<_>>();
        return Err(format!(
            "Integrating the reviewed head onto base {} conflicts in: {}.",
            &base_sha[..12],
            if files.is_empty() {
                "unknown files".to_owned()
            } else {
                files.join(", ")
            }
        ));
    }
    let fresh = inspect_loaded_range(
        &repository,
        git2::Oid::from_str(&accepted.head_sha).map_err(|error| error.to_string())?,
        git2::Oid::from_str(base_sha).map_err(|error| error.to_string())?,
        "",
    )
    .map_err(|error| error.to_string())?;
    let fresh = ReviewRange::from(&fresh);
    if !same_range(&reviewed, &fresh) {
        return Err(format!(
            "The base branch advanced and changed the reviewed range ({}).",
            range_differences(&reviewed, &fresh).join(", ")
        ));
    }
    Ok(fresh)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryDiff {
    pub base_sha: String,
    pub head_sha: String,
    pub files: Vec<String>,
    pub commits: Vec<String>,
    pub patch_digest: String,
    pub patch: String,
    pub patch_truncated: bool,
    pub base_branch: String,
}

fn unavailable(message: &'static str) -> Box<dyn Error> {
    DeliveryError::internal(message).into()
}

fn patch_display(patch: &str) -> (String, bool) {
    let mut units = patch.encode_utf16();
    let display = units.by_ref().take(PATCH_DISPLAY_UNITS).collect::<Vec<_>>();
    let truncated = units.next().is_some();
    (String::from_utf16_lossy(&display), truncated)
}

/// Git's no-rename three-dot patch is the review evidence. The complete text
/// is hashed before the display is truncated to the source's UTF-16 limit.
pub fn inspect_git_range(
    repository: &Repository,
    head: git2::Oid,
    published_base: git2::Oid,
    github_token: Option<&str>,
    base_branch: &str,
) -> Result<DeliveryDiff, Box<dyn Error>> {
    let base = worktree::published_base_commit(repository, published_base, github_token)?;
    inspect_loaded_range(repository, head, base, base_branch)
}

fn inspect_loaded_range(
    repository: &Repository,
    head: git2::Oid,
    base: git2::Oid,
    base_branch: &str,
) -> Result<DeliveryDiff, Box<dyn Error>> {
    let merge_base = repository.merge_base(base, head)?;
    let base_tree = repository.find_commit(merge_base)?.tree()?;
    let head_tree = repository.find_commit(head)?.tree()?;
    let mut options = DiffOptions::new();
    let abbreviation = repository
        .config()?
        .get_i32("core.abbrev")
        .ok()
        .filter(|value| (4..=40).contains(value))
        .unwrap_or(7) as u16;
    options.id_abbrev(abbreviation);
    let context = repository
        .config()?
        .get_i32("diff.context")
        .ok()
        .filter(|value| *value >= 0)
        .unwrap_or(3) as u32;
    options.context_lines(context);
    let diff =
        repository.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut options))?;
    let file_output = diff
        .deltas()
        .filter_map(|delta| delta.new_file().path().or_else(|| delta.old_file().path()))
        .map(|path| format!("{}\0", path.to_string_lossy()))
        .collect::<String>();
    let files = redaction::command_output(&file_output)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    let mut patch_bytes = Vec::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch_bytes.push(line.origin() as u8);
        }
        patch_bytes.extend_from_slice(line.content());
        true
    })?;
    let patch = redaction::command_output(&String::from_utf8_lossy(&patch_bytes));
    let patch_digest = sha256_hex(patch.as_bytes());
    let (patch, patch_truncated) = patch_display(&patch);

    let mut revisions = repository.revwalk()?;
    revisions.push(head)?;
    revisions.hide(base)?;
    revisions.set_sorting(Sort::TIME)?;
    let commits = revisions
        .map(|revision| revision.map(|id| id.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DeliveryDiff {
        base_sha: base.to_string(),
        head_sha: head.to_string(),
        files,
        commits,
        patch_digest,
        patch,
        patch_truncated,
        base_branch: base_branch.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_limit_counts_utf16_units_after_full_digest() {
        let patch = format!("{}🌍end", "a".repeat(PATCH_DISPLAY_UNITS - 1));
        let (display, truncated) = patch_display(&patch);
        assert!(truncated);
        assert_eq!(display.encode_utf16().count(), PATCH_DISPLAY_UNITS);
        assert!(display.ends_with('\u{fffd}'));
    }
}
