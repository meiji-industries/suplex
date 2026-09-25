//! Read the published-base-to-local-head range for a Standard task.

use std::{error::Error, io, path::Path};

use git2::{DiffFormat, DiffOptions, Repository, Sort};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    coordination::{root_bridge::RootIdentity, root_session_store},
    integrations::github::Access,
    platform::{
        database::{DatabaseResult, OpenMode, SuplexDatabase},
        redaction,
    },
    tasks::worktree,
};

const PATCH_DISPLAY_UNITS: usize = 64_000;

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
    io::Error::other(message).into()
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
    path: &Path,
    head: git2::Oid,
    published_base: git2::Oid,
    github_token: Option<&str>,
    base_branch: &str,
) -> Result<DeliveryDiff, Box<dyn Error>> {
    let repository = Repository::open(path)?;
    let base = worktree::published_base_commit(&repository, published_base, github_token)?;
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
    let patch_digest = format!("{:x}", Sha256::digest(patch.as_bytes()));
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

/// The MCP transport already holds this call's tool-owner token. The source
/// inspection itself requires only a current Root assertion before Git reads.
pub async fn inspect_standard_delivery_diff(
    database_path: &Path,
    root: &RootIdentity,
) -> DatabaseResult<serde_json::Value> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    let rows = root_session_store::root_observation_rows(&database, &root.task_id)?;
    let control = rows.control;
    if control["workflow"] != "standard"
        || !control["pullRequest"].is_null()
        || !control["deliveryIntent"]["pullRequestNumber"].is_null()
        || rows.context["configuration"]["source"]["kind"] == "pull_request"
        || rows.context["configuration"]["integration"]["repository"]["kind"] == "bitbucket"
    {
        return Err(unavailable(
            "Standard delivery inspection is not available for this task",
        ));
    }
    let path = control["worktree"]["path"]
        .as_str()
        .ok_or_else(|| unavailable("The task has no worktree"))?;
    let repository = control["deliveryIntent"]["repository"]
        .as_str()
        .ok_or_else(|| unavailable("Task delivery repository is missing"))?;
    let branch = control["deliveryIntent"]["baseBranch"]
        .as_str()
        .ok_or_else(|| unavailable("Task delivery base branch is missing"))?;
    let local = worktree::observe_local_revision(Path::new(path))?;
    let head = git2::Oid::from_str(&local.head_sha)?;
    let access = Access::load()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let published_base = access
        .published_branch_sha(repository, branch)
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let diff = inspect_git_range(
        Path::new(path),
        head,
        published_base,
        access.token(),
        branch,
    )?;
    Ok(serde_json::to_value(diff)?)
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
