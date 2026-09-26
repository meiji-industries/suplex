//! TypeScript `DeliveryOperations`: Git and GitHub are observed before every
//! deterministic delivery operation. The durable task control is rechecked
//! after each provider await and before each mutation.
//! Non-Standard workflows apply `workflows::delivery_decision` to the reviewed
//! range and fresh local facts. Bitbucket repositories deliver through the
//! Bitbucket release port.

use super::{DeliveryError, DeliveryOperation};
use crate::shared::time::{now_millis_rfc3339, rfc3339_millis};
use std::{
    error::Error,
    ops::ControlFlow,
    path::{Path, PathBuf},
};

use chrono::{Duration, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use tokio::sync::OnceCell;

use super::{
    inspection::{self, DeliveryDiff, ReviewRange},
    issue_evidence,
};
use crate::{
    coordination::{
        root_bridge::RootIdentity,
        root_session_store,
        workflows::{
            self, Completion, DeliveryRefusal, DeliveryWait, LocalSourceFacts, Workflow,
            WorkflowState,
        },
    },
    integrations::{
        bitbucket::ReleasePort,
        github_delivery::{self, Github, GithubFailure, MergeResult, Observation, PullRequest},
        github_triggers_dispatches::{self, DeliveryPolicy},
        github_triggers_inspection::{self, PullRequestInspection},
    },
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    tasks::{
        control::{DeliveryTarget, TaskControlRow, TaskStatus, WorktreeReference},
        repository,
        worktree::{self, LocalRevisionObservation},
    },
};

pub const DELIVERY_WAIT_NEXT: &str =
    "End this Coordinator turn. Suplex will resume it when delivery state changes.";

pub fn delivery_failure(code: &'static str, message: impl Into<String>) -> Box<dyn Error> {
    DeliveryError::operation(code, message).into()
}

/// The worktree a delivery step reads; a task without one cannot deliver.
fn required_worktree(control: &TaskControlRow) -> Result<&str, DeliveryError> {
    control.worktree_path().ok_or(DeliveryError::operation(
        "worktree_missing",
        "The task has no worktree",
    ))
}

/// Check source control state before waiting for a Git observation.
pub fn standard_local_worktree_path(control: &TaskControlRow) -> Result<&str, DeliveryError> {
    if control.delivery_target != DeliveryTarget::LocalWorktree {
        return Err(DeliveryError::operation(
            "delivery_target_mismatch",
            "This task has a different delivery target",
        ));
    }
    required_worktree(control)
}

/// Check only the conditions in the source Standard `completeLocal` path.
/// An uncommitted working tree is valid local delivery evidence.
pub fn check_standard_local_completion(
    control: &TaskControlRow,
    expected_head: Option<&str>,
    local: &LocalRevisionObservation,
) -> Result<(), DeliveryError> {
    standard_local_worktree_path(control)?;
    if expected_head.is_none_or(|head| head != local.head_sha)
        || control.delivery_intent.head_branch != local.branch
    {
        return Err(DeliveryError::operation(
            "head_diverged",
            "Review the current worktree before completing the task",
        ));
    }
    Ok(())
}

/// Observe Git outside SQLite, then recheck the current Root and tool owner
/// before recording the actual local revision and completing the task.
pub async fn complete_local_work(
    database_path: &Path,
    root: &RootIdentity,
    owner_token: &str,
    expected_head: Option<&str>,
) -> DatabaseResult<Value> {
    let initial = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let control = root_session_store::root_observation_rows(&initial, &root.task_id)?.control;
    if control.workflow != Workflow::Standard {
        return crate::coordination::root_controller::complete_workflow_local_work(
            database_path,
            root,
            owner_token,
            expected_head,
        )
        .await;
    }
    let path = PathBuf::from(standard_local_worktree_path(&control)?);
    drop(initial);
    let local = tokio::task::spawn_blocking(move || {
        worktree::observe_local_revision(&path).map_err(|error| error.to_string())
    })
    .await??;
    check_standard_local_completion(&control, expected_head, &local)?;

    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    root_session_store::assert_tool_owner(&database, &root.task_id, owner_token)?;
    let current = root_session_store::root_observation_rows(&database, &root.task_id)?.control;
    let mut worktree = current.worktree.ok_or(DeliveryError::operation(
        "worktree_missing",
        "The task has no worktree",
    ))?;
    worktree.head_sha = local.head_sha.clone();
    worktree.dirty = !local.clean;
    root_session_store::set_worktree(&mut database, &root.task_id, &worktree, Utc::now())?;
    root_session_store::mark_delivered(&mut database, &root.task_id, Utc::now())?;
    Ok(json!({"kind":"local_work_completed","headSha":local.head_sha}))
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorkflowCompletion {
    Completed,
    Already,
    Cancelled,
    Declined { code: &'static str, reason: String },
}

/// TypeScript `completeWorkflowDelivery`: the completion commit boundary for
/// non-Standard workflows. One short transaction reloads the task, its reviews,
/// and its delegates, applies the delivery policy to the validated range against
/// freshly observed local facts, rechecks ownership, and records the workflow
/// completion with the delivered status. No Git or network I/O runs inside it.
pub fn complete_workflow_delivery(
    database: &mut SuplexDatabase,
    task_id: &str,
    range: &crate::coordination::workflows::ReviewRange,
    local: &LocalRevisionObservation,
    pull_request_number: Option<u64>,
    require_accepted: bool,
    recheck: impl FnOnce(&SuplexDatabase) -> DatabaseResult<()>,
) -> DatabaseResult<WorkflowCompletion> {
    use crate::coordination::workflows::{self, LocalSourceFacts};
    database.transaction(true, |database| {
        let rows = root_session_store::root_observation_rows(database, task_id)?;
        let control = &rows.control;
        if control.status == TaskStatus::Cancelled {
            return Ok(WorkflowCompletion::Cancelled);
        }
        let mut state = root_session_store::workflow_state(database, task_id)?;
        if state.completion.is_some() || control.status == TaskStatus::Delivered {
            if control.status != TaskStatus::Delivered {
                root_session_store::mark_delivered(database, task_id, Utc::now())?;
            }
            return Ok(WorkflowCompletion::Already);
        }
        if require_accepted && state.accepted_delivery.as_ref().is_none_or(|accepted| !workflows::same_range(accepted, range)) {
            return Ok(WorkflowCompletion::Declined {
                code: "workflow_review_required",
                reason: "No accepted delivery decision matches this range. Complete the workflow's review and request delivery.".into(),
            });
        }
        let facts = LocalSourceFacts {
            branch: Some(&local.branch),
            head_sha: Some(&local.head_sha),
            clean: local.clean,
        };
        if let Err(refusal) = workflows::delivery_decision(control, &rows.sessions, &rows.turns, range, &facts, true) {
            return Ok(WorkflowCompletion::Declined {
                code: refusal.code,
                reason: refusal.reason,
            });
        }
        recheck(database)?;
        state.accepted_delivery = Some(range.clone());
        state.delivery_wait = None;
        state.completion = Some(Completion {
            kind: "workflow".into(),
            reviewed_head: Some(range.head_sha.clone()),
            pull_request_number,
            observed_at: now_millis_rfc3339(),
        });
        root_session_store::write_workflow_state(database, task_id, &state, Utc::now())?;
        root_session_store::mark_delivered(database, task_id, Utc::now())?;
        Ok(WorkflowCompletion::Completed)
    })
}

/// TypeScript `matchesDeliveryIntent`.
pub fn matches_delivery_intent(control: &TaskControlRow, pull: &PullRequest) -> bool {
    let intent = &control.delivery_intent;
    intent.repository == pull.repository
        && intent.head_branch == pull.head_branch
        && pull.is_cross_repository != Some(true)
        && match intent.pull_request_number {
            None => intent.base_branch == pull.base_branch,
            Some(number) => pull.number == number,
        }
}

/// TypeScript `observedPullReference`.
pub fn observed_pull_reference(repository: &str, observed: &Observation) -> Option<Value> {
    if !observed.exists {
        return None;
    }
    Some(json!({
        "repository": repository, "number": observed.number?, "url": observed.url.as_ref()?,
        "headSha": observed.head_sha.as_ref()?, "state": observed.state.as_ref()?, "mergedAt": null,
    }))
}

/// TypeScript `checkSummary`.
pub fn check_summary(observed: &Observation) -> String {
    if observed.checks.total == 0 {
        return "No remote checks reported".into();
    }
    format!(
        "{} successful, {} pending, {} failing",
        observed.checks.successful, observed.checks.pending, observed.checks.failing
    )
}

/// TypeScript `supportsDeliveryTarget`.
pub fn supports_delivery_target(connection: Option<&Value>, target: DeliveryTarget) -> bool {
    connection.and_then(|connection| connection["kind"].as_str()) != Some("bitbucket")
        || target.bitbucket_supports()
}

/// TypeScript `deliveryWaitFingerprint`.
pub fn delivery_wait_fingerprint(observation: &Observation) -> String {
    let mut failures = observation
        .checks
        .runs
        .iter()
        .filter(|run| run["status"] == "failing")
        .map(|run| {
            format!(
                "{}:{}:{}",
                run["name"].as_str().unwrap_or(""),
                run["status"].as_str().unwrap_or(""),
                run["conclusion"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>();
    failures.sort();
    let mut checks = vec![if observation.checks.pending > 0 {
        "pending".to_owned()
    } else {
        "settled".to_owned()
    }];
    if observation.checks.failing > 0 {
        checks.push(format!("failed:{}", observation.checks.failing));
        checks.extend(failures);
    }
    crate::shared::js_json::stringify(&json!({
        "number": observation.number, "head": observation.head_sha, "draft": observation.is_draft,
        "review": observation.review_decision, "mergeable": observation.mergeable,
        "mergeState": observation.merge_state_status, "state": observation.state, "checks": checks,
    }))
}

/// TypeScript `sameDeliveryWaitFingerprint`, including the legacy per-run form.
pub fn same_delivery_wait_fingerprint(stored: &str, observation: &Observation) -> bool {
    let current = delivery_wait_fingerprint(observation);
    if stored == current {
        return true;
    }
    if observation.checks.pending == 0 || observation.checks.failing > 0 {
        return false;
    }
    let Ok(Value::Object(mut legacy)) = serde_json::from_str::<Value>(stored) else {
        return false;
    };
    let keys = [
        "number",
        "head",
        "draft",
        "review",
        "mergeable",
        "mergeState",
        "state",
        "checks",
    ];
    if legacy.len() != keys.len() || !keys.iter().all(|key| legacy.contains_key(*key)) {
        return false;
    }
    let Some(checks) = legacy["checks"].as_array() else {
        return false;
    };
    let checks = checks.iter().filter_map(Value::as_str).collect::<Vec<_>>();
    if !checks.iter().any(|check| check.ends_with(":pending:"))
        || checks.iter().any(|check| check.contains(":failing:"))
    {
        return false;
    }
    legacy.insert("checks".into(), json!(["pending"]));
    crate::shared::js_json::stringify(&Value::Object(legacy)) == current
}

fn select_discovered_pull(
    control: &TaskControlRow,
    pulls: Vec<PullRequest>,
) -> DatabaseResult<Option<PullRequest>> {
    let matches = pulls
        .into_iter()
        .filter(|pull| matches_delivery_intent(control, pull))
        .collect::<Vec<_>>();
    let eligible = matches
        .iter()
        .filter(|pull| pull.state != "closed")
        .collect::<Vec<_>>();
    if eligible.len() > 1 {
        return Err(delivery_failure(
            "pull_request_ambiguous",
            "GitHub returned more than one pull request for this task intent",
        ));
    }
    Ok(eligible
        .first()
        .map(|pull| (*pull).clone())
        .or_else(|| matches.first().cloned()))
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

fn facts(local: &LocalRevisionObservation) -> LocalSourceFacts<'_> {
    LocalSourceFacts {
        branch: Some(&local.branch),
        head_sha: Some(&local.head_sha),
        clean: local.clean,
    }
}

/// The Root and tool-owner assertions of `recheck` inside an open transaction.
fn recheck_in(database: &SuplexDatabase, recheck: &Recheck<'_>) -> DatabaseResult<()> {
    root_session_store::assert_current_root(
        database,
        &recheck.root.task_id,
        &recheck.root.session_id,
        recheck.root.generation,
    )?;
    if let Some(token) = recheck.owner_token {
        root_session_store::assert_tool_owner(database, &recheck.root.task_id, token)?;
    }
    Ok(())
}

/// TypeScript `CommitDecision`.
enum Commit {
    Done,
    Declined(&'static str, String),
    Cancelled,
}

impl Commit {
    /// A refusal becomes the delivery failure; a cancellation rechecks ownership first.
    fn into_result(self, recheck: impl FnOnce() -> DatabaseResult<()>) -> DatabaseResult<()> {
        match self {
            Commit::Done => Ok(()),
            Commit::Declined(code, reason) => Err(delivery_failure(code, reason)),
            Commit::Cancelled => {
                recheck()?;
                Err(delivery_failure(
                    "workflow_review_required",
                    "The task was cancelled; Suplex recorded no workflow completion.",
                ))
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Adoption<'a> {
    publication: bool,
    explicit: bool,
    recheck: Option<&'a Recheck<'a>>,
    defer_completion: bool,
    is_draft: Option<bool>,
    validated_range: Option<&'a ReviewRange>,
}

/// The Root and tool-owner assertions TypeScript runs as `recheck`.
pub struct Recheck<'a> {
    pub root: &'a RootIdentity,
    pub owner_token: Option<&'a str>,
}

pub struct DeliveryOperations {
    database_path: PathBuf,
    artifact_root: PathBuf,
    github: OnceCell<Github>,
}

impl DeliveryOperations {
    pub fn new(database_path: &Path, artifact_root: &Path) -> Self {
        Self {
            database_path: database_path.to_owned(),
            artifact_root: artifact_root.to_owned(),
            github: OnceCell::new(),
        }
    }

    pub fn with_github(database_path: &Path, artifact_root: &Path, github: Github) -> Self {
        let operations = Self::new(database_path, artifact_root);
        let _ = operations.github.set(github);
        operations
    }

    fn open(&self, mode: OpenMode) -> DatabaseResult<SuplexDatabase> {
        SuplexDatabase::open(&self.database_path, mode)
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn artifact_root(&self) -> &Path {
        &self.artifact_root
    }

    fn get(&self, task_id: &str) -> DatabaseResult<TaskControlRow> {
        Ok(
            root_session_store::root_observation_rows(&self.open(OpenMode::ReadOnly)?, task_id)?
                .control,
        )
    }

    fn context(&self, task_id: &str) -> DatabaseResult<Value> {
        Ok(
            root_session_store::root_observation_rows(&self.open(OpenMode::ReadOnly)?, task_id)?
                .context,
        )
    }

    /// TypeScript `forTask`: Bitbucket repositories use their own provider.
    pub async fn for_task(&self, task_id: &str) -> DatabaseResult<ReleasePort<'_>> {
        let context = self.context(task_id)?;
        if let Some(client) =
            ReleasePort::bitbucket(&context["configuration"]["integration"]["repository"])
        {
            return Ok(ReleasePort::Bitbucket(client));
        }
        Ok(ReleasePort::Github(
            self.github
                .get_or_try_init(Github::load)
                .await
                .map_err(Box::new)?,
        ))
    }

    pub fn recheck(&self, recheck: &Recheck<'_>) -> DatabaseResult<()> {
        let database = self.open(OpenMode::ReadOnly)?;
        root_session_store::assert_current_root(
            &database,
            &recheck.root.task_id,
            &recheck.root.session_id,
            recheck.root.generation,
        )?;
        if let Some(token) = recheck.owner_token {
            root_session_store::assert_tool_owner(&database, &recheck.root.task_id, token)?;
        }
        Ok(())
    }

    fn set_worktree(
        &self,
        task_id: &str,
        worktree: &WorktreeReference,
        local: &LocalRevisionObservation,
    ) -> DatabaseResult<()> {
        let mut worktree = worktree.clone();
        worktree.branch = local.branch.clone();
        worktree.head_sha = local.head_sha.clone();
        worktree.dirty = !local.clean;
        root_session_store::set_worktree(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            &worktree,
            Utc::now(),
        )
    }

    /// TypeScript `TaskControlStore.setPullRequest`. A Root delivery operation
    /// `claim`s the pull request, which another live task must not own. Passive
    /// observation records what GitHub reports without that check.
    pub fn set_pull_request(
        &self,
        task_id: &str,
        pull: Option<&Value>,
        claim: bool,
    ) -> DatabaseResult<()> {
        let mut database = self.open(OpenMode::ReadWrite)?;
        let value = pull.map(crate::shared::js_json::stringify);
        let changed = database.transaction(true, |database| {
            let status: Option<TaskStatus> = database
                .connection()
                .query_row(
                    "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(pull) = pull.filter(|_| claim)
                && matches!(status, Some(TaskStatus::Active | TaskStatus::WaitingHuman))
            {
                repository::assert_pull_request_available(
                    database,
                    task_id,
                    pull["repository"].as_str().unwrap_or(""),
                    pull["number"].as_i64().unwrap_or(0),
                )?;
            }
            Ok(database.connection().execute(
                "UPDATE suplex_task_controls SET pull_request_json = ?1, updated_at = ?2 WHERE task_id = ?3 AND status IN ('active', 'waiting_human', 'delivered', 'cancelled')",
                params![value, crate::shared::time::now_millis_rfc3339(), task_id],
            )?)
        })?;
        if changed != 1 {
            return Err(DeliveryError::internal("task_not_active").into());
        }
        Ok(())
    }

    fn mark_delivered(&self, task_id: &str) -> DatabaseResult<()> {
        root_session_store::mark_delivered(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            Utc::now(),
        )?;
        Ok(())
    }

    /// TypeScript `updateWorkflowState`.
    fn update_workflow_state(
        &self,
        task_id: &str,
        mutate: impl FnOnce(&mut WorkflowState),
    ) -> DatabaseResult<()> {
        root_session_store::update_workflow_state(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            Utc::now(),
            mutate,
        )?;
        Ok(())
    }

    fn schedule_wake(&self, task_id: &str, seconds: i64) -> DatabaseResult<()> {
        let now = Utc::now();
        self.open(OpenMode::ReadWrite)?.connection().execute(
            "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![
                rfc3339_millis(now + Duration::seconds(seconds)),
                rfc3339_millis(now),
                task_id
            ],
        )?;
        Ok(())
    }

    /// TypeScript `askHuman` without a Root binding; the delivery wait is cleared with it.
    fn ask_human(&self, task_id: &str, question: &str) -> DatabaseResult<bool> {
        root_session_store::ask_human(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            question,
            &json!([]),
            Utc::now(),
        )
    }

    fn resume_delivery_wait(
        &self,
        task_id: &str,
        expected: &DeliveryWait,
        prompt: &str,
    ) -> DatabaseResult<bool> {
        root_session_store::resume_delivery_wait(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            expected,
            prompt,
            Utc::now(),
        )
    }

    fn clear_delivery_wait(&self, task_id: &str, expected: &DeliveryWait) -> DatabaseResult<bool> {
        root_session_store::clear_delivery_wait(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            expected,
            Utc::now(),
        )
    }

    fn fail_delivery_wait(
        &self,
        task_id: &str,
        expected: &DeliveryWait,
        question: &str,
    ) -> DatabaseResult<bool> {
        root_session_store::fail_delivery_wait(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            expected,
            question,
            &json!([]),
            Utc::now(),
        )
    }

    /// TypeScript `observe`: a finished task keeps its recorded pull request.
    pub async fn observe(&self, task_id: &str) -> DatabaseResult<Value> {
        let control = self.get(task_id)?;
        if matches!(
            control.status,
            TaskStatus::Cancelled | TaskStatus::Delivered
        ) {
            return Ok(serde_json::to_value(&control.pull_request)?);
        }
        if control.delivery_target == DeliveryTarget::LocalWorktree {
            return Ok(Value::Null);
        }
        self.observe_known_pull(&control, Adoption::default()).await
    }

    /// TypeScript `observeDeliveryWait`: one persisted wait is consumed at most once.
    pub async fn observe_delivery_wait(&self, task_id: &str) -> DatabaseResult<&'static str> {
        let control = self.get(task_id)?;
        let Some(wait) = control
            .workflow_state
            .delivery_wait
            .clone()
            .filter(|_| control.status == TaskStatus::Active)
        else {
            return Ok("none");
        };
        let repository = control.delivery_intent.repository.as_str().to_owned();
        let github = self.for_task(task_id).await?;
        let number = control.pull_request_number();
        let observed = match github
            .observe_pull_request(
                &repository,
                control.delivery_intent.head_branch.as_str(),
                number,
            )
            .await
        {
            Ok(observed) => observed,
            Err(error) => {
                let Some(denied) = error
                    .downcast_ref::<GithubFailure>()
                    .filter(|failure| failure.code == "authentication-required")
                else {
                    return Err(error);
                };
                let asked = self.fail_delivery_wait(task_id, &wait, &format!("GitHub could not access this pull request. Restore the GitHub CLI login or repository permission, then continue. {}", denied.summary))?;
                return Ok(if asked { "changed" } else { "none" });
            }
        };
        if observed.state.as_deref() == Some("merged")
            && let Some(number) = observed.number
        {
            let pull = github.get_pull_request(&repository, number).await?;
            self.adopt_known_pull(&self.get(task_id)?, &pull, Adoption::default())
                .await?;
            self.clear_delivery_wait(task_id, &wait)?;
            return Ok("finished");
        }
        let prompt = if wait.reason == "observation" {
            let (branch, sha) = self.resolve_delivery_base(&control).await?;
            if sha.is_none() {
                return Ok("unchanged");
            }
            format!(
                "GitHub evidence is available again (the head of {branch}). Retry the delivery operation with your current review; no source change is needed."
            )
        } else {
            if observed.exists && same_delivery_wait_fingerprint(&wait.fingerprint, &observed) {
                return Ok("unchanged");
            }
            Self::changed_delivery_prompt(&wait, &observed)
        };
        Ok(if self.resume_delivery_wait(task_id, &wait, &prompt)? {
            "changed"
        } else {
            "none"
        })
    }

    /// The Coordinator prompt for a delivery state that changed during a wait.
    fn changed_delivery_prompt(wait: &DeliveryWait, observed: &Observation) -> String {
        let summary = crate::shared::js_json::stringify(&json!({
            "exists": observed.exists, "state": observed.state, "headSha": observed.head_sha,
            "isDraft": observed.is_draft, "mergeable": observed.mergeable,
            "mergeStateStatus": observed.merge_state_status, "reviewDecision": observed.review_decision,
            "checks": observed.checks,
        }));
        format!(
            "Delivery state changed while Suplex waited ({}). Current observation: {summary}. If checks failed, obtain their evidence and continue the workflow; if the pull request is eligible, request merge_pull_request with your current review; otherwise observe_checks again.",
            wait.reason
        )
    }

    /// TypeScript `checksObservation`: null without a pull request or when GitHub cannot answer.
    pub async fn checks_observation(&self, task_id: &str) -> DatabaseResult<Option<Observation>> {
        let control = self.get(task_id)?;
        let Some(number) = control.pull_request_number() else {
            return Ok(None);
        };
        let Ok(github) = self.for_task(task_id).await else {
            return Ok(None);
        };
        Ok(github
            .observe_pull_request(
                control.delivery_intent.repository.as_str(),
                control.delivery_intent.head_branch.as_str(),
                Some(number),
            )
            .await
            .ok())
    }

    /// TypeScript `currentRange`: the live GitHub-base-to-local-head range with the tree state.
    pub async fn current_range(&self, task_id: &str) -> DatabaseResult<Value> {
        let control = self.get(task_id)?;
        let path = control
            .worktree_path()
            .ok_or_else(|| delivery_failure("worktree_missing", "The task has no worktree"))?;
        let local = github_delivery::inspect_local_revision(Path::new(path)).map_err(Box::new)?;
        let diff = self.delivery_diff(&control, &local.head_sha).await?;
        Ok(json!({
            "baseBranch": diff.base_branch, "baseSha": diff.base_sha, "headSha": diff.head_sha,
            "files": diff.files, "commits": diff.commits, "patchDigest": diff.patch_digest, "clean": local.clean,
        }))
    }

    async fn resolve_delivery_base(
        &self,
        control: &TaskControlRow,
    ) -> DatabaseResult<(String, Option<String>)> {
        let task_id = control.task_id.as_str();
        let repository = control.delivery_intent.repository.as_str();
        let github = self.for_task(task_id).await?;
        let mut branch = control.delivery_intent.base_branch.as_str().to_owned();
        if let Some(number) = control.delivery_intent.pull_request_number {
            let pull = github.get_pull_request(repository, number).await?;
            if !matches_delivery_intent(control, &pull) {
                return Err(delivery_failure(
                    "pull_request_ambiguous",
                    "The pinned pull request no longer matches this task intent",
                ));
            }
            branch = pull.base_branch;
        }
        let sha = github.get_branch_head(repository, &branch).await?;
        Ok((branch, sha))
    }

    async fn delivery_diff(
        &self,
        control: &TaskControlRow,
        head_sha: &str,
    ) -> DatabaseResult<DeliveryDiff> {
        let (branch, sha) = self.resolve_delivery_base(control).await?;
        let Some(sha) = sha else {
            return Err(delivery_failure(
                "observation_unavailable",
                format!(
                    "GitHub did not return the head of {branch}. Suplex cannot compute the delivery range until that observation is available; no source change is needed."
                ),
            ));
        };
        let path = PathBuf::from(required_worktree(control)?);
        let token = self
            .for_task(control.task_id.as_str())
            .await?
            .token()
            .map(str::to_owned);
        let head = head_sha.to_owned();
        tokio::task::spawn_blocking(move || {
            inspection::inspect_revisions(&path, &sha, &head, token.as_deref(), &branch)
                .map_err(|error| error.to_string())
        })
        .await?
        .map_err(|error| DeliveryError::internal(error).into())
    }

    fn observation_unavailable(error: &(dyn Error + 'static)) -> bool {
        DeliveryError::code_of(error) == Some("observation_unavailable")
            || error
                .downcast_ref::<GithubFailure>()
                .is_some_and(|failure| {
                    matches!(
                        failure.code,
                        "provider-unavailable" | "provider-rate-limited"
                    )
                })
    }

    fn observation_wait(
        &self,
        control: &TaskControlRow,
        head_sha: &str,
        evidence: &str,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        let wait = DeliveryWait {
            head_sha: head_sha.to_owned(),
            fingerprint: format!("observation:{evidence}"),
            since: crate::shared::time::now_millis_rfc3339(),
            reason: "observation".into(),
        };
        self.update_workflow_state(task_id, |state| state.delivery_wait = Some(wait.clone()))?;
        self.schedule_wake(task_id, 30)?;
        Ok(
            json!({"kind": "waiting", "problems": [format!("{evidence} is unavailable")], "wait": wait, "next": DELIVERY_WAIT_NEXT}),
        )
    }

    /// TypeScript `workflowDecision`: the shared policy over fresh task, delegate, and review state.
    fn workflow_decision(
        &self,
        task_id: &str,
        actual: &ReviewRange,
        local: &LocalSourceFacts<'_>,
        require_review: bool,
    ) -> DatabaseResult<Result<(), DeliveryRefusal>> {
        let rows =
            root_session_store::root_observation_rows(&self.open(OpenMode::ReadOnly)?, task_id)?;
        Ok(workflows::delivery_decision(
            &rows.control,
            &rows.sessions,
            &rows.turns,
            actual,
            local,
            require_review,
        ))
    }

    /// TypeScript `gateWorkflow`.
    fn gate_workflow(
        &self,
        task_id: &str,
        actual: &ReviewRange,
        local: &LocalSourceFacts<'_>,
        require_review: bool,
    ) -> DatabaseResult<()> {
        self.workflow_decision(task_id, actual, local, require_review)?
            .map_err(|refusal| delivery_failure(refusal.code, refusal.reason))
    }

    /// TypeScript `finalRecheck`: outside Standard, the local source must still
    /// be the reviewed head on the task branch, clean, and gated.
    async fn final_recheck(
        &self,
        control: &TaskControlRow,
        actual: &ReviewRange,
        recheck: &Recheck<'_>,
        require_review: bool,
    ) -> DatabaseResult<()> {
        if control.workflow != Workflow::Standard {
            let path = required_worktree(control)?;
            let local =
                github_delivery::inspect_local_revision(Path::new(path)).map_err(Box::new)?;
            self.gate_workflow(
                control.task_id.as_str(),
                actual,
                &facts(&local),
                require_review,
            )?;
        }
        self.recheck(recheck)
    }

    async fn equivalence(
        &self,
        task_id: &str,
        path: &str,
        review: &ReviewRange,
        base_sha: &str,
    ) -> DatabaseResult<Result<ReviewRange, String>> {
        let (path, review, base, token) = (
            PathBuf::from(path),
            review.clone(),
            base_sha.to_owned(),
            self.for_task(task_id).await?.token().map(str::to_owned),
        );
        Ok(tokio::task::spawn_blocking(move || {
            inspection::review_equivalence(&path, &review, &base, token.as_deref())
        })
        .await?)
    }

    fn record_workflow_outcome(
        &self,
        task_id: &str,
        completion: &Completion,
    ) -> DatabaseResult<()> {
        root_session_store::record_workflow_outcome(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            completion,
            Utc::now(),
        )?;
        Ok(())
    }

    /// TypeScript `commitCompletion`: one last local observation after every
    /// provider await, then one transaction that applies the policy and records completion.
    async fn commit_completion(
        &self,
        control: &TaskControlRow,
        range: &ReviewRange,
        pull_request_number: Option<u64>,
        require_accepted: bool,
        recheck: Option<&Recheck<'_>>,
    ) -> DatabaseResult<Commit> {
        let task_id = control.task_id.as_str();
        let Some(path) = control.worktree_path() else {
            return Ok(Commit::Declined(
                "worktree_missing",
                "The task has no observed worktree to confirm the reviewed source.".into(),
            ));
        };
        if let Some(number) = pull_request_number {
            issue_evidence::complete(self, task_id, number, &range.head_sha, recheck).await?;
        }
        let local = match github_delivery::inspect_local_revision(Path::new(path)) {
            Ok(local) => local,
            Err(error) => {
                return Ok(Commit::Declined(
                    "worktree_missing",
                    format!("The local source could not be observed: {error}"),
                ));
            }
        };
        let result = complete_workflow_delivery(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            range,
            &local,
            pull_request_number,
            require_accepted,
            |database| match recheck {
                Some(recheck) => recheck_in(database, recheck),
                None => Ok(()),
            },
        )?;
        Ok(match result {
            WorkflowCompletion::Completed | WorkflowCompletion::Already => Commit::Done,
            WorkflowCompletion::Cancelled => Commit::Cancelled,
            WorkflowCompletion::Declined { code, reason } => Commit::Declined(code, reason),
        })
    }

    /// TypeScript `completeRemoteBranch`.
    async fn complete_remote_branch(
        &self,
        control: &TaskControlRow,
        actual: &ReviewRange,
        recheck: &Recheck<'_>,
    ) -> DatabaseResult<()> {
        let task_id = control.task_id.as_str();
        if control.workflow == Workflow::Standard {
            return self.mark_delivered(task_id);
        }
        let path = required_worktree(control)?;
        let local = github_delivery::inspect_local_revision(Path::new(path)).map_err(Box::new)?;
        if let Err(refusal) = self.workflow_decision(task_id, actual, &facts(&local), true)?
            && refusal.code == "workflow_review_required"
        {
            return Ok(());
        }
        self.commit_completion(control, actual, None, true, Some(recheck))
            .await?
            .into_result(|| self.recheck(recheck))
    }

    /// TypeScript `externalCompletion`: the latest valid review's head is kept, never relabeled.
    fn external_completion(
        current: &TaskControlRow,
        pull_request_number: Option<u64>,
    ) -> Completion {
        let reviewed_head = workflows::review_role(current.workflow)
            .and_then(|role| workflows::latest_review(&current.workflow_state.reviews, role))
            .filter(|latest| latest.result.is_some())
            .map(|latest| latest.range.head_sha.clone());
        Completion {
            kind: "external_merge".into(),
            reviewed_head,
            pull_request_number,
            observed_at: crate::shared::time::now_millis_rfc3339(),
        }
    }

    /// TypeScript `cancelledOutcome`.
    fn cancelled_outcome(
        current: &TaskControlRow,
        pull: &Value,
        validated_range: Option<&ReviewRange>,
    ) -> Completion {
        match validated_range {
            Some(range) if pull["headSha"] == range.head_sha.as_str() => Completion {
                kind: "workflow".into(),
                reviewed_head: Some(range.head_sha.clone()),
                pull_request_number: pull["number"].as_u64(),
                observed_at: crate::shared::time::now_millis_rfc3339(),
            },
            _ => Self::external_completion(current, pull["number"].as_u64()),
        }
    }

    /// TypeScript `openCompletionDecision`.
    async fn open_completion_decision(
        &self,
        control: &TaskControlRow,
        pull: &Value,
        recheck: Option<&Recheck<'_>>,
    ) -> DatabaseResult<Commit> {
        let Some(accepted) = control.workflow_state.accepted_delivery.clone() else {
            return Ok(Commit::Declined(
                "workflow_review_required",
                "No accepted delivery decision exists for this pull request yet. Complete the workflow's review and request delivery.".into(),
            ));
        };
        let head = pull["headSha"].as_str().unwrap_or("");
        if head != accepted.head_sha {
            return Ok(Commit::Declined(
                "head_diverged",
                format!(
                    "The pull request head {} is not the accepted head {}.",
                    short(head),
                    short(&accepted.head_sha)
                ),
            ));
        }
        let (branch, sha) = match self.resolve_delivery_base(control).await {
            Ok(base) => base,
            Err(error) if Self::observation_unavailable(error.as_ref()) => {
                return Ok(Commit::Declined(
                    "observation_unavailable",
                    "GitHub did not return the current delivery base; Suplex will observe it again."
                        .into(),
                ));
            }
            Err(error) => return Err(error),
        };
        let Some(sha) = sha else {
            return Ok(Commit::Declined(
                "observation_unavailable",
                format!(
                    "GitHub did not return the head of {branch}; Suplex will observe it again."
                ),
            ));
        };
        let task_id = control.task_id.as_str();
        let Some(path) = control.worktree_path() else {
            return Ok(Commit::Declined(
                "worktree_missing",
                "The task has no observed worktree to confirm the reviewed source.".into(),
            ));
        };
        if let Err(reason) = self.equivalence(task_id, path, &accepted, &sha).await? {
            return Ok(Commit::Declined(
                "delivery_review_required",
                format!("{reason}{}", workflows::fresh_review_hint(control.workflow)),
            ));
        }
        self.commit_completion(control, &accepted, pull["number"].as_u64(), true, recheck)
            .await
    }

    /// `inspect_delivery_diff`: the diff from the current delivery base to the local head.
    async fn inspect_delivery_diff(&self, control: &TaskControlRow) -> DatabaseResult<Value> {
        let path = control
            .worktree_path()
            .ok_or_else(|| delivery_failure("worktree_missing", "The task has no worktree"))?;
        let local = github_delivery::inspect_local_revision(Path::new(path)).map_err(Box::new)?;
        Ok(serde_json::to_value(
            self.delivery_diff(control, &local.head_sha).await?,
        )?)
    }

    /// `complete_local_work` for a task that delivers to its local worktree.
    async fn complete_local_delivery(
        &self,
        root: &RootIdentity,
        owner_token: Option<&str>,
        control: &TaskControlRow,
        expected_head: Option<&str>,
    ) -> DatabaseResult<Value> {
        let Some(token) = owner_token else {
            return Err(DeliveryError::internal("task_tool_owner_lost").into());
        };
        if control.delivery_target != DeliveryTarget::LocalWorktree {
            return Err(delivery_failure(
                "delivery_target_mismatch",
                "This task has a different delivery target",
            ));
        }
        complete_local_work(&self.database_path, root, token, expected_head).await
    }

    /// Observe the task worktree on the intended branch and save the observation.
    fn observe_task_worktree(
        &self,
        control: &TaskControlRow,
    ) -> DatabaseResult<(PathBuf, LocalRevisionObservation)> {
        let Some(worktree) = &control.worktree else {
            return Err(delivery_failure(
                "worktree_missing",
                "Suplex has no observed worktree for this task",
            ));
        };
        let path = PathBuf::from(&worktree.path);
        let local = github_delivery::inspect_local_revision(&path).map_err(Box::new)?;
        if control.delivery_intent.head_branch != local.branch {
            return Err(delivery_failure(
                "head_diverged",
                "The worktree branch does not match this task intent",
            ));
        }
        self.set_worktree(control.task_id.as_str(), worktree, &local)?;
        Ok((path, local))
    }

    /// The worktree remote is the task's repository.
    async fn require_task_remote(
        github: &ReleasePort<'_>,
        path: &Path,
        repository: &str,
    ) -> DatabaseResult<()> {
        let remote = github.remote_repository(path).map_err(Box::new)?;
        let same_repository = remote == repository
            || match github.github() {
                Some(client) => client
                    .same_repository(&remote, repository)
                    .await
                    .map_err(Box::new)?,
                None => false,
            };
        if !same_repository {
            return Err(delivery_failure(
                "head_diverged",
                "The worktree remote does not match this task intent",
            ));
        }
        Ok(())
    }

    /// The review covers the current delivery range: the same range on the
    /// same base, or an equivalent integration on a moved base.
    async fn confirm_review(
        &self,
        task_id: &str,
        path: &Path,
        review: &ReviewRange,
        range: ReviewRange,
    ) -> DatabaseResult<ReviewRange> {
        if review.base_sha != range.base_sha {
            return self
                .equivalence(task_id, &path.to_string_lossy(), review, &range.base_sha)
                .await?
                .map_err(|reason| delivery_failure("delivery_review_required", format!("{reason} Inspect delivery again and review the new range before retrying.")));
        }
        if !inspection::same_range(review, &range) {
            return Err(delivery_failure(
                "delivery_review_required",
                format!(
                    "The reviewed delivery range differs in: {}. Inspect delivery again and review the new range before retrying.",
                    inspection::range_differences(review, &range).join(", ")
                ),
            ));
        }
        Ok(range)
    }

    /// A mutation needs the Coordinator's review of the current local head and
    /// delivery range, gated by the workflow; other operations carry none. Breaks with a wait response when
    /// a merge cannot observe the delivery base.
    async fn reviewed_range(
        &self,
        operation: DeliveryOperation,
        control: &TaskControlRow,
        path: &Path,
        local: &LocalRevisionObservation,
        review: Option<&ReviewRange>,
        expected_head: Option<&str>,
        recheck: &Recheck<'_>,
    ) -> DatabaseResult<ControlFlow<Value, Option<ReviewRange>>> {
        let mutation = matches!(
            operation,
            DeliveryOperation::PushBranch
                | DeliveryOperation::CreateOrAdoptPullRequest
                | DeliveryOperation::RequestReview
                | DeliveryOperation::MergePullRequest
        );
        if !mutation {
            return Ok(ControlFlow::Continue(None));
        }
        let task_id = control.task_id.as_str();
        let Some(review) = review.filter(|_| expected_head == Some(local.head_sha.as_str())) else {
            return Err(delivery_failure(
                "delivery_review_required",
                "Inspect delivery with inspect_delivery_diff. Independently review the entire GitHub-base-to-head diff and every commit, then supply expectedHead and review { baseSha, headSha, files, commits }. Do not approve unrelated changes or import unpublished local main; ask the human if the task depends on unpublished work.",
            ));
        };
        let diff = match self.delivery_diff(control, &local.head_sha).await {
            Ok(diff) => diff,
            Err(error)
                if operation == DeliveryOperation::MergePullRequest
                    && control.pull_request.is_some()
                    && Self::observation_unavailable(error.as_ref()) =>
            {
                return self
                    .observation_wait(control, &local.head_sha, "the current delivery base")
                    .map(ControlFlow::Break);
            }
            Err(error) => return Err(error),
        };
        let range = self
            .confirm_review(task_id, path, review, ReviewRange::from(&diff))
            .await?;
        self.gate_workflow(
            task_id,
            &range,
            &LocalSourceFacts {
                branch: None,
                head_sha: None,
                clean: local.clean,
            },
            !matches!(
                operation,
                DeliveryOperation::PushBranch | DeliveryOperation::CreateOrAdoptPullRequest
            ),
        )?;
        self.recheck(recheck)?;
        Ok(ControlFlow::Continue(Some(range)))
    }

    /// Adopt the task's known pull request first (except for a push). Returns
    /// it when the task is delivered or the pull request merged.
    async fn finished_delivery(
        &self,
        push: bool,
        control: &TaskControlRow,
        recheck: &Recheck<'_>,
        reviewed: bool,
    ) -> DatabaseResult<Option<Value>> {
        let known = if push {
            Value::Null
        } else {
            self.observe_known_pull(
                control,
                Adoption {
                    recheck: Some(recheck),
                    defer_completion: reviewed,
                    ..Adoption::default()
                },
            )
            .await?
        };
        let delivered = self.get(control.task_id.as_str())?.status == TaskStatus::Delivered;
        Ok((delivered || known["state"] == "merged").then_some(known))
    }

    /// Save the reviewed range as the accepted delivery when the workflow
    /// policy accepts it with a review.
    fn accept_if_eligible(
        &self,
        task_id: &str,
        actual: &ReviewRange,
        local: &LocalRevisionObservation,
    ) -> DatabaseResult<()> {
        if self
            .workflow_decision(task_id, actual, &facts(local), true)?
            .is_ok()
        {
            self.update_workflow_state(task_id, |state| {
                state.accepted_delivery = Some(actual.clone())
            })?;
        }
        Ok(())
    }

    /// The whole TypeScript `execute` for the Standard workflow.
    pub async fn execute(
        &self,
        root: &RootIdentity,
        owner_token: Option<&str>,
        operation: DeliveryOperation,
        expected_head: Option<&str>,
        review: Option<&ReviewRange>,
        pull_request_title: Option<&str>,
        pull_request_body: Option<&str>,
    ) -> DatabaseResult<Value> {
        let recheck = Recheck { root, owner_token };
        let task_id = root.task_id.as_str();
        self.recheck(&Recheck {
            root,
            owner_token: None,
        })?;
        let control = self.get(task_id)?;
        match operation {
            DeliveryOperation::InspectDeliveryDiff => {
                return self.inspect_delivery_diff(&control).await;
            }
            DeliveryOperation::CompleteLocalWork => {
                return self
                    .complete_local_delivery(root, owner_token, &control, expected_head)
                    .await;
            }
            _ => {}
        }
        let push = operation == DeliveryOperation::PushBranch;
        if let Some(known) = self
            .finished_delivery(push, &control, &recheck, review.is_some())
            .await?
        {
            return Ok(known);
        }
        let (path, local) = self.observe_task_worktree(&control)?;
        let refreshed = self.get(task_id)?;
        let repository = refreshed.delivery_intent.repository.as_str().to_owned();
        let github = self.for_task(task_id).await?;
        Self::require_task_remote(&github, &path, &repository).await?;
        let actual = match self
            .reviewed_range(
                operation,
                &refreshed,
                &path,
                &local,
                review,
                expected_head,
                &recheck,
            )
            .await?
        {
            ControlFlow::Break(wait) => return Ok(wait),
            ControlFlow::Continue(range) => range,
        };
        let pull = if push {
            Value::Null
        } else {
            self.observe_pull(&refreshed, &repository, &local.branch)
                .await?
        };
        if pull["state"] == "merged" {
            let number = pull["number"].as_u64().unwrap_or(0);
            return self
                .adopt_pull_number(&github, &refreshed, &repository, number, &recheck)
                .await;
        }
        if let Some(actual) = &actual {
            self.accept_if_eligible(task_id, actual, &local)?;
        }
        let reviewed = || actual.as_ref().expect("reviewed");
        match operation {
            DeliveryOperation::ObservePullRequest => Ok(pull),
            DeliveryOperation::PushBranch => {
                self.push(&recheck, &refreshed, &repository, &local, reviewed())
                    .await
            }
            DeliveryOperation::CreateOrAdoptPullRequest => {
                self.create_or_adopt(
                    &recheck,
                    &refreshed,
                    &repository,
                    &local,
                    &pull,
                    reviewed(),
                    pull_request_title,
                    pull_request_body,
                )
                .await
            }
            DeliveryOperation::ObserveChecks => {
                self.observe_checks(&refreshed, &repository, &local).await
            }
            DeliveryOperation::RequestReview => {
                self.request_review(
                    &recheck,
                    &refreshed,
                    &repository,
                    &local.branch,
                    expected_head,
                    reviewed(),
                )
                .await
            }
            DeliveryOperation::MergePullRequest => {
                self.merge(
                    &recheck,
                    &refreshed,
                    &repository,
                    &local.branch,
                    expected_head,
                    reviewed(),
                )
                .await
            }
            DeliveryOperation::InspectDeliveryDiff | DeliveryOperation::CompleteLocalWork => {
                Err(DeliveryError::internal("delivery_operation_invalid").into())
            }
        }
    }

    async fn observe_known_pull(
        &self,
        control: &TaskControlRow,
        options: Adoption<'_>,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        let repository = control.delivery_intent.repository.as_str();
        let github = self.for_task(task_id).await?;
        if let Some(number) = control.delivery_intent.pull_request_number {
            let pull = github.get_pull_request(repository, number).await?;
            return self.adopt_known_pull(control, &pull, options).await;
        }
        let pulls = github
            .list_pull_requests(
                repository,
                control.delivery_intent.head_branch.as_str(),
                control.delivery_intent.base_branch.as_str(),
            )
            .await?;
        if let Some(pull) = select_discovered_pull(control, pulls)? {
            return self.adopt_known_pull(control, &pull, options).await;
        }
        if control.pull_request.is_some() {
            self.set_pull_request(task_id, None, false)?;
        }
        Ok(Value::Null)
    }

    async fn adopt_known_pull(
        &self,
        control: &TaskControlRow,
        pull: &PullRequest,
        options: Adoption<'_>,
    ) -> DatabaseResult<Value> {
        if !matches_delivery_intent(control, pull) {
            return Err(delivery_failure(
                "pull_request_ambiguous",
                "The stored pull request no longer matches this task intent",
            ));
        }
        let reference = pull.reference();
        if options.defer_completion && pull.state == "open" {
            self.set_pull_request(
                control.task_id.as_str(),
                Some(&reference),
                options.recheck.is_some(),
            )?;
            return Ok(reference);
        }
        self.complete_if_target_matches(
            control,
            reference,
            Adoption {
                is_draft: Some(pull.is_draft),
                ..options
            },
        )
        .await
    }

    async fn observe_pull(
        &self,
        control: &TaskControlRow,
        repository: &str,
        branch: &str,
    ) -> DatabaseResult<Value> {
        let Some(number) = control.pull_request.as_ref().map(|pull| pull.number) else {
            return Ok(Value::Null);
        };
        let task_id = control.task_id.as_str();
        let observed = self
            .for_task(task_id)
            .await?
            .observe_pull_request(repository, branch, Some(number))
            .await?;
        let pull = observed_pull_reference(repository, &observed);
        if let Some(pull) = &pull {
            self.set_pull_request(task_id, Some(pull), false)?;
        }
        Ok(pull.unwrap_or(Value::Null))
    }

    /// Proof that a merged pull request carries the reviewed head: the
    /// validated range of this merge, or else the accepted delivery.
    fn merged_head_proof(
        validated_range: Option<&ReviewRange>,
        accepted: Option<&ReviewRange>,
        head: &str,
    ) -> Commit {
        match (validated_range, accepted) {
            (Some(range), _) if head != range.head_sha => Commit::Declined(
                "head_diverged",
                format!(
                    "GitHub reports the merged pull request head {}, not the reviewed head {}.",
                    short(head),
                    short(&range.head_sha)
                ),
            ),
            (Some(_), _) => Commit::Done,
            (None, None) => Commit::Declined(
                "workflow_review_required",
                "No accepted delivery decision exists for this pull request.".into(),
            ),
            (None, Some(accepted)) if accepted.head_sha != head => Commit::Declined(
                "head_diverged",
                format!(
                    "The merged head {} is not the accepted head {}.",
                    short(head),
                    short(&accepted.head_sha)
                ),
            ),
            (None, Some(_)) => Commit::Done,
        }
    }

    /// A non-Standard merge completes the workflow when the reviewed head
    /// merged; otherwise it records the external merge truthfully.
    async fn complete_merged_workflow(
        &self,
        current: &TaskControlRow,
        pull: &Value,
        options: Adoption<'_>,
    ) -> DatabaseResult<()> {
        let task_id = current.task_id.as_str();
        let accepted = current.workflow_state.accepted_delivery.clone();
        let head = pull["headSha"].as_str().unwrap_or("");
        let proof = Self::merged_head_proof(options.validated_range, accepted.as_ref(), head);
        let decision = match (proof, options.validated_range.or(accepted.as_ref())) {
            (Commit::Done, Some(range)) => {
                self.commit_completion(
                    current,
                    range,
                    pull["number"].as_u64(),
                    options.validated_range.is_none(),
                    options.recheck,
                )
                .await?
            }
            (proof, _) => proof,
        };
        match decision {
            Commit::Done => Ok(()),
            Commit::Cancelled => self.record_workflow_outcome(
                task_id,
                &Self::cancelled_outcome(&self.get(task_id)?, pull, options.validated_range),
            ),
            Commit::Declined(..) => self.record_workflow_outcome(
                task_id,
                &Self::external_completion(&self.get(task_id)?, pull["number"].as_u64()),
            ),
        }
    }

    /// A non-Standard open pull request completes only through the accepted
    /// delivery decision. An explicit request reports why it did not.
    async fn complete_open_workflow(
        &self,
        current: &TaskControlRow,
        pull: &Value,
        options: Adoption<'_>,
    ) -> DatabaseResult<()> {
        let decision = self
            .open_completion_decision(current, pull, options.recheck)
            .await?;
        if options.explicit && !options.publication && !matches!(decision, Commit::Done) {
            return Err(match decision {
                Commit::Declined(code, reason) => delivery_failure(code, reason),
                _ => delivery_failure(
                    "workflow_review_required",
                    "The task was cancelled; Suplex recorded no workflow completion.",
                ),
            });
        }
        Ok(())
    }

    /// Standard delivery publishes issue evidence and marks the task delivered
    /// unless it was cancelled.
    async fn complete_standard(
        &self,
        task_id: &str,
        pull: &Value,
        recheck: Option<&Recheck<'_>>,
    ) -> DatabaseResult<()> {
        issue_evidence::complete(
            self,
            task_id,
            pull["number"].as_u64().unwrap_or(0),
            pull["headSha"].as_str().unwrap_or(""),
            recheck,
        )
        .await?;
        if let Some(recheck) = recheck {
            self.recheck(recheck)?;
        }
        if self.get(task_id)?.status != TaskStatus::Cancelled {
            self.mark_delivered(task_id)?;
        }
        Ok(())
    }

    /// TypeScript `completeIfTargetMatches`: Standard completes on a matching
    /// endpoint; other workflows complete only through the final boundary, or
    /// record an external merge truthfully.
    async fn complete_if_target_matches(
        &self,
        control: &TaskControlRow,
        pull: Value,
        options: Adoption<'_>,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        self.set_pull_request(task_id, Some(&pull), options.recheck.is_some())?;
        if !target_reached(control.delivery_target, &pull, options.is_draft) {
            return Ok(pull);
        }
        let current = self.get(task_id)?;
        let standard = control.workflow == Workflow::Standard;
        if current.status == TaskStatus::Cancelled {
            // An accepted remote request finished after cancellation: record the outcome and stay cancelled.
            if !standard && current.workflow_state.completion.is_none() && pull["state"] == "merged"
            {
                self.record_workflow_outcome(
                    task_id,
                    &Self::cancelled_outcome(&current, &pull, options.validated_range),
                )?;
            }
            return Ok(pull);
        }
        if current.workflow_state.follow_up == Some(true)
            && !options.explicit
            && options.validated_range.is_none()
        {
            return Ok(pull);
        }
        if standard {
            self.complete_standard(task_id, &pull, options.recheck)
                .await?;
        } else if current.workflow_state.completion.is_some() {
            if current.status != TaskStatus::Delivered {
                self.mark_delivered(task_id)?;
            }
        } else if pull["state"] == "merged" {
            self.complete_merged_workflow(&current, &pull, options)
                .await?;
        } else {
            self.complete_open_workflow(&current, &pull, options)
                .await?;
        }
        Ok(pull)
    }

    /// TypeScript `pushPublication`.
    async fn push(
        &self,
        recheck: &Recheck<'_>,
        control: &TaskControlRow,
        repository: &str,
        local: &LocalRevisionObservation,
        actual: &ReviewRange,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        let trigger = self.inspect_trigger_policy(control, None, false).await?;
        let github = self.for_task(task_id).await?;
        let remote_head = github.get_branch_head(repository, &local.branch).await?;
        self.final_recheck(control, actual, recheck, false).await?;
        if remote_head.as_deref() == Some(local.head_sha.as_str()) {
            if control.delivery_target == DeliveryTarget::RemoteBranch {
                self.complete_remote_branch(control, actual, recheck)
                    .await?;
            }
            return Ok(json!({"kind": "adopted", "headSha": local.head_sha}));
        }
        let observed = Self::push_head(&github, control, repository, local).await?;
        if let Some((policy, pull)) = &trigger {
            github_triggers_dispatches::record_trigger_push(
                &mut self.open(OpenMode::ReadWrite)?,
                task_id,
                &policy.dispatch_id,
                remote_head.as_deref().unwrap_or(&pull.head_sha),
                &local.head_sha,
                &serde_json::to_value(actual)?,
            )?;
        }
        self.recheck(recheck)?;
        if control.delivery_target == DeliveryTarget::RemoteBranch {
            self.complete_remote_branch(control, actual, recheck)
                .await?;
        }
        Ok(json!({"kind": "pushed", "headSha": observed}))
    }

    /// Push the local head without force and confirm the remote branch now has it.
    async fn push_head(
        github: &ReleasePort<'_>,
        control: &TaskControlRow,
        repository: &str,
        local: &LocalRevisionObservation,
    ) -> DatabaseResult<Option<String>> {
        let (path, branch, head, token) = (
            PathBuf::from(required_worktree(control)?),
            local.branch.clone(),
            local.head_sha.clone(),
            github.token().map(str::to_owned),
        );
        tokio::task::spawn_blocking(move || {
            github_delivery::push_normal(&path, &branch, &head, token.as_deref())
        })
        .await?
        .map_err(Box::new)?;
        let observed = github.get_branch_head(repository, &local.branch).await?;
        if observed.as_deref() != Some(local.head_sha.as_str()) {
            return Err(delivery_failure(
                "head_diverged",
                "The remote branch does not match the observed worktree head",
            ));
        }
        Ok(observed)
    }

    /// TypeScript `createOrAdoptPublication`.
    async fn create_or_adopt(
        &self,
        recheck: &Recheck<'_>,
        control: &TaskControlRow,
        repository: &str,
        local: &LocalRevisionObservation,
        pull: &Value,
        actual: &ReviewRange,
        title: Option<&str>,
        body: Option<&str>,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        let github = self.for_task(task_id).await?;
        let adopt = Adoption {
            publication: true,
            explicit: true,
            recheck: Some(recheck),
            ..Adoption::default()
        };
        if !pull.is_null() {
            if pull["state"] == "closed" {
                return Err(delivery_failure(
                    "pull_request_closed",
                    "The matching pull request is closed and was not merged",
                ));
            }
            if pull["headSha"] != local.head_sha.as_str() && pull["state"] != "merged" {
                return Err(delivery_failure(
                    "head_diverged",
                    "The pull request head does not match the observed worktree head. Push the reviewed head first.",
                ));
            }
            let full = github
                .get_pull_request(repository, pull["number"].as_u64().unwrap_or(0))
                .await?;
            self.final_recheck(control, actual, recheck, false).await?;
            return self.adopt_known_pull(control, &full, adopt).await;
        }
        if control.delivery_intent.pull_request_number.is_some() {
            return Err(delivery_failure(
                "pull_request_closed",
                "GitHub did not return the pinned pull request",
            ));
        }
        if control.delivery_intent.head_branch != local.branch {
            return Err(delivery_failure(
                "head_diverged",
                "The worktree branch does not match this task intent",
            ));
        }
        let candidate = select_discovered_pull(
            control,
            github
                .list_pull_requests(
                    repository,
                    &local.branch,
                    control.delivery_intent.base_branch.as_str(),
                )
                .await?,
        )?;
        if let Some(candidate) = &candidate {
            if candidate.state == "closed" {
                return Err(delivery_failure(
                    "pull_request_closed",
                    "The matching pull request is closed and was not merged",
                ));
            }
            if candidate.state != "merged" && candidate.head_sha != local.head_sha {
                return Err(delivery_failure(
                    "head_diverged",
                    "The pull request head does not match the observed worktree head",
                ));
            }
        }
        self.final_recheck(control, actual, recheck, false).await?;
        if let Some(candidate) = candidate {
            return self.adopt_known_pull(control, &candidate, adopt).await;
        }
        let Some(title) = title
            .map(crate::identity::auth::js_trim)
            .filter(|title| valid_title(title))
        else {
            return Err(delivery_failure(
                "pull_request_title_required",
                "Supply a concise title that describes the final solution before you create a pull request.",
            ));
        };
        let Some(body) = body
            .map(crate::identity::auth::js_trim)
            .filter(|body| valid_body(body))
        else {
            return Err(delivery_failure(
                "pull_request_body_required",
                "Supply a pull request description with the headings ## Summary, ## Why, ## Validation, ## Review notes, in order, before you create a pull request.",
            ));
        };
        let base = control.delivery_intent.base_branch.as_str();
        let created = github
            .create_draft_pull_request(repository, &local.branch, base, title, body)
            .await?;
        self.adopt_known_pull(control, &created, adopt).await
    }

    async fn checks(
        &self,
        control: &TaskControlRow,
        repository: &str,
        branch: &str,
    ) -> DatabaseResult<Observation> {
        let Some(number) = control.pull_request.as_ref().map(|pull| pull.number) else {
            return Err(delivery_failure(
                "pull_request_closed",
                "No matching pull request was found for this task",
            ));
        };
        let observed = self
            .for_task(control.task_id.as_str())
            .await?
            .observe_pull_request(repository, branch, Some(number))
            .await?;
        if !observed.exists {
            return Err(delivery_failure(
                "pull_request_closed",
                "GitHub did not return the pull request",
            ));
        }
        Ok(observed)
    }

    fn summary(observed: &Observation) -> Value {
        let mut summary = observed.to_value();
        summary["checkSummary"] = json!(check_summary(observed));
        summary
    }

    /// TypeScript `observeChecks`: GitHub's exact-head merge response stays authoritative.
    async fn observe_checks(
        &self,
        control: &TaskControlRow,
        repository: &str,
        local: &LocalRevisionObservation,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        let observed = self.checks(control, repository, &local.branch).await?;
        let mut summary = Self::summary(&observed);
        if observed.head_sha.as_deref() != Some(local.head_sha.as_str()) {
            summary["note"] = json!(
                "The pull request head differs from the local head. Push the reviewed head before observing its checks."
            );
            return Ok(summary);
        }
        if observed.state.as_deref() == Some("open")
            && observed.checks.pending > 0
            && observed.checks.failing == 0
        {
            let fingerprint = delivery_wait_fingerprint(&observed);
            let current = self.get(task_id)?.workflow_state.delivery_wait;
            let wait = match current.filter(|current| {
                current.reason == "checks"
                    && current.head_sha == local.head_sha
                    && current.fingerprint == fingerprint
            }) {
                Some(current) => current,
                None => DeliveryWait {
                    head_sha: local.head_sha.clone(),
                    fingerprint,
                    since: crate::shared::time::now_millis_rfc3339(),
                    reason: "checks".into(),
                },
            };
            self.update_workflow_state(task_id, |state| state.delivery_wait = Some(wait.clone()))?;
            self.schedule_wake(task_id, 30)?;
            summary["wait"] = json!(wait);
            summary["next"] = json!(DELIVERY_WAIT_NEXT);
        }
        Ok(summary)
    }

    async fn request_review(
        &self,
        recheck: &Recheck<'_>,
        control: &TaskControlRow,
        repository: &str,
        branch: &str,
        expected_head: Option<&str>,
        actual: &ReviewRange,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        let observed = self.checks(control, repository, branch).await?;
        if observed.head_sha.as_deref()
            != control
                .worktree
                .as_ref()
                .map(|worktree| worktree.head_sha.as_str())
        {
            return Err(delivery_failure(
                "head_diverged",
                "GitHub returned a pull request for another head",
            ));
        }
        if expected_head.is_none() || expected_head != observed.head_sha.as_deref() {
            return Err(delivery_failure(
                "head_diverged",
                "The Coordinator must review the current observed pull request head before requesting merge",
            ));
        }
        let Some(number) = observed
            .number
            .filter(|_| observed.state.as_deref() == Some("open"))
        else {
            return Err(delivery_failure(
                "pull_request_closed",
                "The pull request is not open for review",
            ));
        };
        self.final_recheck(control, actual, recheck, true).await?;
        let github = self.for_task(task_id).await?;
        github.mark_ready_for_review(repository, number).await?;
        let last = github.get_pull_request(repository, number).await?;
        if Some(last.head_sha.as_str()) != expected_head {
            return Err(delivery_failure(
                "head_diverged",
                "The pull request head changed while requesting review",
            ));
        }
        self.adopt_known_pull(
            control,
            &last,
            Adoption {
                explicit: true,
                recheck: Some(recheck),
                ..Adoption::default()
            },
        )
        .await?;
        Ok(self
            .checks(&self.get(task_id)?, repository, branch)
            .await?
            .to_value())
    }

    /// Read the numbered pull request and adopt it under the recheck.
    async fn adopt_pull_number(
        &self,
        github: &ReleasePort<'_>,
        control: &TaskControlRow,
        repository: &str,
        number: u64,
        recheck: &Recheck<'_>,
    ) -> DatabaseResult<Value> {
        let pull = github.get_pull_request(repository, number).await?;
        self.adopt_known_pull(
            control,
            &pull,
            Adoption {
                recheck: Some(recheck),
                ..Adoption::default()
            },
        )
        .await
    }

    /// The pull request head is the observed worktree head the Coordinator reviewed.
    fn require_reviewed_head(
        control: &TaskControlRow,
        head: &str,
        expected_head: Option<&str>,
    ) -> DatabaseResult<()> {
        if Some(head)
            != control
                .worktree
                .as_ref()
                .map(|worktree| worktree.head_sha.as_str())
        {
            return Err(delivery_failure(
                "head_diverged",
                "The pull request head changed after review",
            ));
        }
        if expected_head != Some(head) {
            return Err(delivery_failure(
                "head_diverged",
                "The pull request head changed after the Coordinator reviewed it",
            ));
        }
        Ok(())
    }

    /// The accepted review still covers the integration with the current
    /// delivery base. Returns a wait response when the base is unobserved.
    async fn confirm_merge_base(
        &self,
        control: &TaskControlRow,
        head: &str,
        actual: &ReviewRange,
    ) -> DatabaseResult<Option<Value>> {
        let (base_branch, base_sha) = match self.resolve_delivery_base(control).await {
            Ok(base) => base,
            Err(error) if Self::observation_unavailable(error.as_ref()) => {
                return self
                    .observation_wait(control, head, "the current delivery base")
                    .map(Some);
            }
            Err(error) => return Err(error),
        };
        let Some(base_sha) = base_sha else {
            return self
                .observation_wait(control, head, &format!("the head of {base_branch}"))
                .map(Some);
        };
        // Concrete harm prevented: merging content the accepted review never covered.
        // Evidence: the Git integration result on the current authoritative base.
        let path = required_worktree(control)?;
        if let Err(reason) = self
            .equivalence(control.task_id.as_str(), path, actual, &base_sha)
            .await?
        {
            return Err(delivery_failure(
                "delivery_review_required",
                format!("{reason}{}", workflows::fresh_review_hint(control.workflow)),
            ));
        }
        Ok(None)
    }

    /// The final local recheck, delivered prerequisites, and a fresh Root recheck.
    async fn recheck_before_merge(
        &self,
        control: &TaskControlRow,
        actual: &ReviewRange,
        recheck: &Recheck<'_>,
    ) -> DatabaseResult<()> {
        self.final_recheck(control, actual, recheck, true).await?;
        self.require_prerequisites_delivered(control.task_id.as_str())?;
        self.recheck(recheck)
    }

    /// Every prerequisite task is delivered before a merge.
    fn require_prerequisites_delivered(&self, task_id: &str) -> DatabaseResult<()> {
        let rows =
            root_session_store::root_observation_rows(&self.open(OpenMode::ReadOnly)?, task_id)?;
        let blockers = rows
            .dependencies
            .iter()
            .filter(|dependency| dependency.status != TaskStatus::Delivered)
            .map(|dependency| dependency.describe())
            .collect::<Vec<_>>();
        if !blockers.is_empty() {
            return Err(delivery_failure(
                "merge_not_eligible",
                format!(
                    "Waiting for these prerequisites: {}. Suplex resumes when delivered.",
                    blockers.join(", ")
                ),
            ));
        }
        Ok(())
    }

    /// Save a delivery wait for this head and wake the task in 30 seconds.
    fn wait_for_merge(
        &self,
        task_id: &str,
        head: &str,
        observed: &Observation,
        reason: &str,
    ) -> DatabaseResult<DeliveryWait> {
        let wait = DeliveryWait {
            head_sha: head.to_owned(),
            fingerprint: delivery_wait_fingerprint(observed),
            since: crate::shared::time::now_millis_rfc3339(),
            reason: reason.into(),
        };
        self.update_workflow_state(task_id, |state| state.delivery_wait = Some(wait.clone()))?;
        self.schedule_wake(task_id, 30)?;
        Ok(wait)
    }

    /// Request the merge. TypeScript `mergePullRequest` discards the
    /// conditional result and observes the pull request afterwards;
    /// `mergePullRequestDirect` (a trigger merge) reports it, and returns the
    /// wait response when GitHub has not merged.
    async fn request_merge(
        &self,
        control: &TaskControlRow,
        github: &ReleasePort<'_>,
        repository: &str,
        head: &str,
        observed: &Observation,
        trigger: bool,
    ) -> DatabaseResult<Option<Value>> {
        let requested = observed.number.unwrap_or(0);
        if !trigger {
            github
                .merge_conditionally(repository, requested, head, true)
                .await?;
            return Ok(None);
        }
        if observed.auto_merge_enabled == Some(true) {
            return Err(self.trigger_blocked(
                control,
                "Auto-merge is enabled for this trigger pull request. Review delivery manually.",
                "merge_not_eligible",
            )?);
        }
        let (disposition, message) = match github
            .merge_conditionally(repository, requested, head, false)
            .await?
        {
            MergeResult::Merged => return Ok(None),
            MergeResult::NotMerged => ("", "GitHub has not completed the merge".into()),
            MergeResult::Disposition {
                disposition,
                message,
            } => (disposition, message),
        };
        if disposition == "blocked" {
            return Err(delivery_failure("merge_not_eligible", message));
        }
        let reason = if disposition == "waiting" {
            "checks"
        } else {
            "merge_queue"
        };
        let wait = self.wait_for_merge(control.task_id.as_str(), head, observed, reason)?;
        Ok(Some(if disposition == "queued" {
            json!({"kind": "merge_requested", "checkSummary": check_summary(observed), "wait": wait, "next": DELIVERY_WAIT_NEXT})
        } else {
            json!({"kind": "waiting", "problems": [message], "wait": wait, "next": DELIVERY_WAIT_NEXT})
        }))
    }

    /// The merged pull request GitHub returned is this task's pull request.
    fn require_task_pull_request(
        control: &TaskControlRow,
        last: &PullRequest,
        repository: &str,
        requested: u64,
    ) -> DatabaseResult<()> {
        let captured = control.pull_request_number();
        if last.repository != repository
            || last.number != requested
            || captured.is_some_and(|number| number != last.number)
            || control.delivery_intent.head_branch != last.head_branch
            || last.is_cross_repository == Some(true)
        {
            return Err(delivery_failure(
                "pull_request_ambiguous",
                format!(
                    "GitHub returned {}#{} ({} into {}{}) for the merge request of {repository}#{requested}; the result does not identify this task's pull request.",
                    last.repository,
                    last.number,
                    last.head_branch,
                    last.base_branch,
                    if last.is_cross_repository == Some(true) {
                        ", cross-repository"
                    } else {
                        ""
                    }
                ),
            ));
        }
        Ok(())
    }

    async fn merge(
        &self,
        recheck: &Recheck<'_>,
        control: &TaskControlRow,
        repository: &str,
        branch: &str,
        expected_head: Option<&str>,
        actual: &ReviewRange,
    ) -> DatabaseResult<Value> {
        let task_id = control.task_id.as_str();
        let github = self.for_task(task_id).await?;
        let observed = self.checks(control, repository, branch).await?;
        if observed.state.as_deref() == Some("merged")
            && let Some(number) = observed.number
        {
            return self
                .adopt_pull_number(&github, control, repository, number, recheck)
                .await;
        }
        let head = observed.head_sha.clone().unwrap_or_default();
        Self::require_reviewed_head(control, &head, expected_head)?;
        let trigger = self
            .inspect_trigger_policy(control, Some(&head), true)
            .await?;
        if (trigger.is_some() || control.workflow != Workflow::Standard)
            && let Some(wait) = self.confirm_merge_base(control, &head, actual).await?
        {
            return Ok(wait);
        }
        self.recheck_before_merge(control, actual, recheck).await?;
        let requested = observed.number.unwrap_or(0);
        if let Some(wait) = self
            .request_merge(
                control,
                &github,
                repository,
                &head,
                &observed,
                trigger.is_some(),
            )
            .await?
        {
            return Ok(wait);
        }
        let last = github.get_pull_request(repository, requested).await?;
        if last.state != "merged" {
            let wait = self.wait_for_merge(task_id, &head, &observed, "merge_queue")?;
            return Ok(
                json!({"kind": "merge_requested", "pullRequest": last.reference(), "checkSummary": check_summary(&observed), "wait": wait, "next": DELIVERY_WAIT_NEXT}),
            );
        }
        Self::require_task_pull_request(control, &last, repository, requested)?;
        let mut result = self
            .complete_if_target_matches(
                control,
                last.reference(),
                Adoption {
                    validated_range: Some(actual),
                    recheck: Some(recheck),
                    ..Adoption::default()
                },
            )
            .await?;
        result["checkSummary"] = json!(check_summary(&observed));
        result["reviewedHead"] = json!(head);
        Ok(result)
    }

    /// TypeScript `triggerBlocked`: an active task asks its human; the operation fails either way.
    fn trigger_blocked(
        &self,
        control: &TaskControlRow,
        question: &str,
        code: &'static str,
    ) -> DatabaseResult<Box<dyn Error>> {
        if control.status == TaskStatus::Active {
            self.ask_human(control.task_id.as_str(), question)?;
        }
        Ok(delivery_failure(code, question))
    }

    /// TypeScript `inspectTriggerPolicy`: a GitHub trigger task delivers only
    /// while its captured pull request keeps its identity and open reviewable state.
    async fn inspect_trigger_policy(
        &self,
        control: &TaskControlRow,
        expected_head: Option<&str>,
        protected_paths: bool,
    ) -> DatabaseResult<Option<(DeliveryPolicy, PullRequestInspection)>> {
        let task_id = control.task_id.as_str();
        let Some(policy) = github_triggers_dispatches::trigger_delivery_policy(
            &self.open(OpenMode::ReadOnly)?,
            task_id,
        )?
        else {
            return Ok(None);
        };
        let uninspectable = || {
            delivery_failure(
                "head_diverged",
                "GitHub trigger delivery policy could not be inspected",
            )
        };
        let port = self.for_task(task_id).await.map_err(|_| uninspectable())?;
        let pull = github_triggers_inspection::inspect_pull_request(
            port.github().ok_or_else(uninspectable)?,
            &policy.repository_name,
            policy.pull_request_number,
        )
        .await
        .map_err(|_| uninspectable())?;
        if !trigger_identity_holds(&policy, &pull) {
            return Err(self.trigger_blocked(
                control,
                "The trigger pull request identity or open reviewable state changed. Review delivery manually.",
                "head_diverged",
            )?);
        }
        if protected_paths && !pull.matching_paths(&policy.protected_paths).is_empty() {
            return Err(self.trigger_blocked(
                control,
                "The trigger pull request changes a protected path. Review delivery manually.",
                "merge_not_eligible",
            )?);
        }
        if expected_head.is_some_and(|head| head != pull.head_sha) {
            return Err(delivery_failure(
                "head_diverged",
                "The pull request has new commits. Fetch and reconcile the branch, verify the result, and request a fresh review before delivery.",
            ));
        }
        Ok(Some((policy, pull)))
    }
}

/// The pull request reached the delivery target: merged, or open as the
/// target's draft or ready state.
fn target_reached(target: DeliveryTarget, pull: &Value, is_draft: Option<bool>) -> bool {
    pull["state"] == "merged"
        || (pull["state"] == "open"
            && (target == DeliveryTarget::PullRequestDraft
                || (target == DeliveryTarget::PullRequestReady && is_draft == Some(false))))
}

/// The trigger pull request is still the open, reviewable, same-repository
/// pull request the dispatch recorded.
fn trigger_identity_holds(policy: &DeliveryPolicy, pull: &PullRequestInspection) -> bool {
    let same_repository = |repository: &github_triggers_inspection::Repository| {
        repository.id == policy.repository_id
            && repository.full_name.to_lowercase() == policy.repository_name
    };
    pull.number == policy.pull_request_number
        && pull.state == "open"
        && !pull.is_draft
        && !pull.is_cross_repository
        && same_repository(&pull.base_repository)
        && pull.head_repository.as_ref().is_some_and(same_repository)
        && pull.head_branch == policy.head_branch
        && pull.base_branch == policy.base_branch
}

/// TypeScript `PullRequestTitleSchema` after trimming.
fn valid_title(title: &str) -> bool {
    !title.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
        && (1..=120).contains(&title.encode_utf16().count())
}

/// TypeScript `PullRequestBodySchema` after trimming.
fn valid_body(body: &str) -> bool {
    if !(1..=20_000).contains(&body.encode_utf16().count()) {
        return false;
    }
    let lines = body.lines().collect::<Vec<_>>();
    let mut previous = None;
    for heading in ["## Summary", "## Why", "## Validation", "## Review notes"] {
        let Some(position) = lines.iter().position(|line| *line == heading) else {
            return false;
        };
        if previous.is_some_and(|before| position <= before) {
            return false;
        }
        previous = Some(position);
    }
    true
}

/// TypeScript `TaskHost.recoverOne` delivery observation: a delivered task
/// refreshes its pull request, a waiting task re-observes its wait, and an
/// active task adopts out-of-band GitHub progress. Failures never stop recovery.
pub async fn host_observation(database_path: &Path, artifact_root: &Path, task_id: &str) {
    let (database_path, artifact_root, task_id) = (
        database_path.to_owned(),
        artifact_root.to_owned(),
        task_id.to_owned(),
    );
    let observed = tokio::task::spawn_blocking(move || {
        crate::shared::blocking::block_on(|| async {
            let operations = DeliveryOperations::new(&database_path, &artifact_root);
            let control = operations
                .get(&task_id)
                .map_err(|error| format!("{task_id}: {error}"))?;
            match control.status {
                TaskStatus::Delivered => {
                    super::completed_pull_requests::refresh(&database_path, None).await
                }
                TaskStatus::Active if control.workflow_state.delivery_wait.is_some() => {
                    operations.observe_delivery_wait(&task_id).await.map(|_| ())
                }
                TaskStatus::Active | TaskStatus::WaitingHuman => {
                    operations.observe(&task_id).await.map(|_| ())
                }
                _ => Ok(()),
            }
            .map_err(|error| format!("{task_id}: {error}"))
        })
    })
    .await;
    if let Ok(Err(error)) = observed {
        eprintln!("Delivery observation will be retried for {error}");
    }
}

/// TypeScript `RootController.observe` delivery part: the observed pull
/// request and the GitHub availability the Root sees.
pub fn observe_for_root(
    database_path: &Path,
    control: &TaskControlRow,
) -> DatabaseResult<(Value, Value)> {
    if matches!(
        control.status,
        TaskStatus::Cancelled | TaskStatus::Delivered
    ) {
        return Ok((
            serde_json::to_value(&control.pull_request)?,
            json!({"available": true}),
        ));
    }
    if control.delivery_target == DeliveryTarget::LocalWorktree {
        return Ok((Value::Null, json!({"available": true})));
    }
    let artifact_root = database_path
        .parent()
        .unwrap_or(Path::new(""))
        .join("artifacts");
    let operations = DeliveryOperations::new(database_path, &artifact_root);
    let task_id = control.task_id.as_str().to_owned();
    let observed = crate::shared::blocking::block_on(|| async {
        operations.observe(&task_id).await.map_err(|error| {
            let code = error
                .downcast_ref::<GithubFailure>()
                .map(|failure| failure.code)
                .or_else(|| DeliveryError::code_of(error.as_ref()));
            (code, error.to_string())
        })
    });
    match observed {
        Ok(pull) => Ok((pull, json!({"available": true}))),
        Err((None, message)) => Err(DeliveryError::internal(message).into()),
        Err((Some(code), message)) => Ok((
            serde_json::to_value(&control.pull_request)?,
            json!({
                "available": false, "code": code, "message": message,
                "retry": "Suplex re-observes on its normal cadence; continue local review and repair. Ask a human only for authentication or a missing executable.",
            }),
        )),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn standard_completion_uses_actual_branch_and_head_without_a_clean_tree_gate() {
        let mut control = TaskControlRow::fixture();
        control.worktree = Some(WorktreeReference {
            path: "/tmp/task".into(),
            branch: "task-one".into(),
            base_sha: "base".into(),
            head_sha: "head-one".into(),
            dirty: false,
        });
        control.delivery_intent.head_branch = "task-one".into();
        let local = LocalRevisionObservation {
            branch: "task-one".into(),
            head_sha: "head-one".into(),
            tree_sha: "tree-one".into(),
            clean: false,
        };
        assert_eq!(
            check_standard_local_completion(&control, Some("head-one"), &local),
            Ok(())
        );
        assert_eq!(
            check_standard_local_completion(&control, None, &local)
                .unwrap_err()
                .code(),
            Some("head_diverged")
        );
        assert_eq!(
            check_standard_local_completion(&control, Some("old-head"), &local)
                .unwrap_err()
                .code(),
            Some("head_diverged")
        );
        let mut wrong_branch = local.clone();
        wrong_branch.branch = "other".into();
        assert_eq!(
            check_standard_local_completion(&control, Some("head-one"), &wrong_branch)
                .unwrap_err()
                .code(),
            Some("head_diverged")
        );
        let mut wrong_target = control.clone();
        wrong_target.delivery_target = DeliveryTarget::PullRequestDraft;
        assert_eq!(
            check_standard_local_completion(&wrong_target, Some("head-one"), &local)
                .unwrap_err()
                .code(),
            Some("delivery_target_mismatch")
        );
        let mut missing_worktree = control.clone();
        missing_worktree.worktree = None;
        assert_eq!(
            standard_local_worktree_path(&missing_worktree)
                .unwrap_err()
                .code(),
            Some("worktree_missing")
        );
    }

    #[test]
    fn delivery_observation_keeps_finished_pull_requests_without_github() {
        let mut local = TaskControlRow::fixture();
        local.pull_request = Some(crate::tasks::control::PullRequestReference {
            repository: "owner/repo".into(),
            number: 7,
            url: "https://github.com/owner/repo/pull/7".into(),
            head_sha: "head".into(),
            state: "open".into(),
            merged_at: None,
        });
        assert_eq!(
            observe_for_root(Path::new(""), &local).unwrap().0,
            Value::Null
        );
        let mut delivered = local.clone();
        delivered.status = TaskStatus::Delivered;
        delivered.delivery_target = DeliveryTarget::PullRequestDraft;
        assert_eq!(
            observe_for_root(Path::new(""), &delivered).unwrap().0,
            json!({"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","headSha":"head","state":"open","mergedAt":null})
        );
    }

    #[test]
    fn target_capabilities_and_titles_match_source_schemas() {
        let bitbucket = json!({"kind":"bitbucket"});
        assert!(supports_delivery_target(
            Some(&bitbucket),
            DeliveryTarget::PullRequestDraft
        ));
        assert!(!supports_delivery_target(
            Some(&bitbucket),
            DeliveryTarget::Merged
        ));
        assert!(supports_delivery_target(None, DeliveryTarget::Merged));
        assert!(valid_title("Add retries"));
        assert!(!valid_title("Two\nlines"));
        assert!(valid_body(
            "## Summary\n- a\n## Why\nb\n## Validation\n- c\n## Review notes\nd"
        ));
        assert!(!valid_body(
            "## Why\n## Summary\n## Validation\n## Review notes"
        ));
    }

    /// One active task in `workflow` whose worktree is a real repository on its task branch.
    pub(crate) fn workflow_task(workflow: &str) -> (PathBuf, DeliveryOperations, String, String) {
        use crate::tasks::repository::{PreparedTask, TaskCreator};
        let directory =
            std::env::temp_dir().join(format!("suplex-delivery-{}", uuid::Uuid::new_v4()));
        let worktree = directory.join("worktree");
        let repository = git2::Repository::init(&worktree).unwrap();
        std::fs::write(worktree.join("a.txt"), "a\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Suplex", "suplex@localhost").unwrap();
        let head = repository
            .commit(
                Some("refs/heads/task-flow"),
                &signature,
                &signature,
                "a",
                &tree,
                &[],
            )
            .unwrap()
            .to_string();
        repository.set_head("refs/heads/task-flow").unwrap();
        let database_path = directory.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let user = crate::identity::auth::development_sign_in(&mut database, now)
            .unwrap()
            .user;
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_flow','Flow','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('project_flow','company_flow','Flow','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)", [&stamp]).unwrap();
        let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "company_flow".into(), project_id: "project_flow".into(),
            title: "Workflow task".into(), description: "Exercise delivery".into(),
            configuration: json!({"branch":"task-flow","baseBranch":"main","visualEvidence":"off"}),
            idempotency_key: "delivery-1".into(), request_hash: "delivery-hash".into(),
            creator: TaskCreator::User(user.id), delivery_target: "merged".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-flow","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(profile.clone()).unwrap(), worker_profile: serde_json::from_value(profile).unwrap(), advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![],
        }, now).unwrap().task;
        let worktree_json = json!({"path": worktree, "branch": "task-flow", "baseSha": head, "headSha": head, "dirty": false});
        database.connection().execute(
            "UPDATE suplex_task_controls SET workflow = ?1, worktree_json = ?2 WHERE task_id = ?3",
            params![workflow, worktree_json.to_string(), task.id],
        ).unwrap();
        let operations = DeliveryOperations::new(&database_path, &directory.join("artifacts"));
        (directory, operations, task.id, head)
    }

    #[tokio::test]
    async fn non_standard_merges_complete_only_on_the_accepted_head_and_record_external_merges() {
        let merged = |head: &str| json!({"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","headSha":head,"state":"merged","mergedAt":null});
        // No accepted decision: GitHub's merge is recorded truthfully as external.
        let (directory, operations, task_id, head) = workflow_task("independent_review");
        let control = operations.get(&task_id).unwrap();
        operations
            .complete_if_target_matches(&control, merged(&head), Adoption::default())
            .await
            .unwrap();
        let control = operations.get(&task_id).unwrap();
        assert_eq!(
            serde_json::json!(control.workflow_state)["completion"]["kind"],
            "external_merge"
        );
        assert_eq!(
            serde_json::json!(control.workflow_state)["completion"]["pullRequestNumber"],
            7
        );
        std::fs::remove_dir_all(directory).unwrap();

        // The accepted and reviewed head completes the workflow through the final boundary.
        let (directory, operations, task_id, head) = workflow_task("independent_review");
        let range = ReviewRange {
            base_sha: "a".repeat(40),
            head_sha: head.clone(),
            files: vec!["a.txt".into()],
            commits: vec![head.clone()],
            patch_digest: Some("d".repeat(64)),
        };
        operations
            .update_workflow_state(&task_id, |state| {
                state.accepted_delivery = Some(range.clone());
                state.reviews = serde_json::from_value(json!([{"sessionId":"s","turnId":"t","role":"reviewer","range":range,"result":{"role":"reviewer","approved":true,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"},"invalidReason":null,"recordedAt":"2026-09-25T00:00:00.000Z"}])).unwrap();
            })
            .unwrap();
        let control = operations.get(&task_id).unwrap();
        operations
            .complete_if_target_matches(&control, merged(&"f".repeat(40)), Adoption::default())
            .await
            .unwrap();
        assert_eq!(
            serde_json::json!(operations.get(&task_id).unwrap().workflow_state)["completion"]["kind"],
            "external_merge",
            "a merge of another head is never relabeled as the workflow's"
        );
        // Reopen the same task to observe the reviewed merge.
        operations
            .update_workflow_state(&task_id, |state| state.completion = None)
            .unwrap();
        operations
            .open(OpenMode::ReadWrite)
            .unwrap()
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                [&task_id],
            )
            .unwrap();
        let control = operations.get(&task_id).unwrap();
        operations
            .complete_if_target_matches(&control, merged(&head), Adoption::default())
            .await
            .unwrap();
        let control = operations.get(&task_id).unwrap();
        assert_eq!(
            serde_json::json!(control.workflow_state)["completion"]["kind"],
            "workflow"
        );
        assert_eq!(
            serde_json::json!(control.workflow_state)["completion"]["reviewedHead"],
            head.as_str()
        );
        assert_eq!(control.status, crate::tasks::control::TaskStatus::Delivered);
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// A loopback GitHub REST API answering each path and query from `replies`.
    pub(crate) async fn loopback_github(replies: Vec<(&'static str, Value)>) -> Github {
        use axum::{Json, Router, extract::OriginalUri, http::StatusCode, response::IntoResponse};
        let replies = std::sync::Arc::new(replies);
        let app = Router::new().fallback(move |OriginalUri(uri): OriginalUri| {
            let replies = replies.clone();
            async move {
                let key = uri
                    .path_and_query()
                    .map(|value| value.as_str())
                    .unwrap_or("");
                match replies.iter().find(|(path, _)| *path == key) {
                    Some((_, body)) => Json(body.clone()).into_response(),
                    None => (StatusCode::NOT_FOUND, Json(json!({"message": "Not Found"})))
                        .into_response(),
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&base, Some("test-token".into())).unwrap();
        let mut github = Github::new(access);
        github.retry_pauses.clear();
        github
    }

    #[tokio::test]
    async fn trigger_policy_blocks_changed_heads_and_protected_paths_with_a_human_question() {
        let (directory, operations, task_id, _) = workflow_task("standard");
        let database = operations.open(OpenMode::ReadWrite).unwrap();
        let policy = json!({"headSha": "a".repeat(40), "baseSha": "b".repeat(40), "headBranch": "feature", "baseBranch": "main", "protectedPaths": ["src/"], "repositoryId": 9, "repositoryName": "owner/repo", "deliveryTarget": "merged"});
        database
            .connection()
            .execute_batch("PRAGMA foreign_keys = OFF")
            .unwrap();
        database.connection().execute(
            "INSERT INTO suplex_github_trigger_dispatches (id, rule_id, company_id, project_id, repository_id, repository_name, pull_request_number, authority_user_id, request_json, policy_json, preset_json, profiles_json, idempotency_key, task_id, created_at, updated_at) VALUES ('dispatch_1', 'rule_1', 'company_flow', 'project_flow', 9, 'owner/repo', 7, 'user', '{}', ?1, '{}', '{}', 'key_1', ?2, 'now', 'now')",
            params![policy.to_string(), task_id],
        ).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                [&task_id],
            )
            .unwrap();
        drop(database);
        let side = |branch: &str, sha: char| json!({"ref": branch, "sha": sha.to_string().repeat(40), "repo": {"id": 9, "full_name": "owner/repo"}});
        let pull = json!({"number": 7, "html_url": "https://github.com/owner/repo/pull/7", "state": "open", "draft": false, "changed_files": 1, "labels": [], "title": "Candidate", "head": side("feature", 'a'), "base": side("main", 'b')});
        let file = json!({"sha": "c", "filename": "src/new.ts", "previous_filename": "docs/old.ts", "status": "renamed", "additions": 1, "deletions": 0, "changes": 1, "blob_url": "https://github.com/b", "raw_url": "https://github.com/r", "contents_url": "https://api.github.com/c"});
        let github = loopback_github(vec![
            ("/repos/owner/repo/pulls/7", pull),
            (
                "/repos/owner/repo/pulls/7/files?per_page=100&page=1",
                json!([file]),
            ),
        ])
        .await;
        let operations = DeliveryOperations::with_github(
            operations.database_path(),
            operations.artifact_root(),
            github,
        );
        let control = operations.get(&task_id).unwrap();
        let (policy, _) = operations
            .inspect_trigger_policy(&control, None, false)
            .await
            .unwrap()
            .expect("the task carries a trigger policy");
        assert_eq!(policy.dispatch_id, "dispatch_1");
        let code = |error: Box<dyn Error>| DeliveryError::code_of(error.as_ref()).unwrap();
        let moved = operations
            .inspect_trigger_policy(&control, Some(&"c".repeat(40)), false)
            .await
            .unwrap_err();
        assert_eq!(code(moved), "head_diverged");
        assert_eq!(
            operations.get(&task_id).unwrap().status,
            crate::tasks::control::TaskStatus::Active,
            "new commits are repair work, not a human question"
        );
        let protected = operations
            .inspect_trigger_policy(&control, Some(&"a".repeat(40)), true)
            .await
            .unwrap_err();
        assert_eq!(code(protected), "merge_not_eligible");
        let control = operations.get(&task_id).unwrap();
        assert_eq!(
            control.status,
            crate::tasks::control::TaskStatus::WaitingHuman
        );
        assert_eq!(
            serde_json::json!(control)["humanQuestion"],
            "The trigger pull request changes a protected path. Review delivery manually."
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn wait_fingerprint_ignores_pending_run_detail_but_not_failures() {
        let mut observed = Observation {
            exists: true,
            number: Some(7),
            head_sha: Some("a".repeat(40)),
            state: Some("open".into()),
            ..Observation::default()
        };
        observed.checks.pending = 1;
        observed.checks.total = 1;
        let stored = delivery_wait_fingerprint(&observed);
        assert!(same_delivery_wait_fingerprint(&stored, &observed));
        let legacy = format!(
            r#"{{"number":7,"head":"{}","draft":null,"review":null,"mergeable":null,"mergeState":null,"state":"open","checks":["unit:pending:"]}}"#,
            "a".repeat(40)
        );
        assert!(same_delivery_wait_fingerprint(&legacy, &observed));
        observed.checks.failing = 1;
        observed.checks.runs =
            vec![json!({"name":"unit","status":"failing","conclusion":"FAILURE"})];
        assert!(!same_delivery_wait_fingerprint(&stored, &observed));
    }
}
