//! TypeScript `DeliveryOperations`: Git and GitHub are observed before every
//! deterministic delivery operation. The durable task control is rechecked
//! after each provider await and before each mutation.
//! Non-Standard workflow decisions and Bitbucket delivery are not ported here;
//! they return 501 at the one seam that needs them.

use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
};

use chrono::{Duration, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use tokio::sync::OnceCell;

use super::{
    inspection::{self, DeliveryDiff, ReviewRange},
    issue_evidence,
};
use crate::{
    coordination::{root_bridge::RootIdentity, root_session_store},
    integrations::github_delivery::{
        self, Github, GithubFailure, MergeResult, Observation, PullRequest,
    },
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    tasks::{
        commands::TaskFailure,
        repository,
        worktree::{self, LocalRevisionObservation},
    },
};

pub const DELIVERY_WAIT_NEXT: &str =
    "End this Coordinator turn. Suplex will resume it when delivery state changes.";

#[derive(Debug, Eq, PartialEq)]
pub struct DeliveryOperationFailure {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for DeliveryOperationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for DeliveryOperationFailure {}

pub fn delivery_failure(code: &'static str, message: impl Into<String>) -> Box<dyn Error> {
    Box::new(DeliveryOperationFailure {
        code,
        message: message.into(),
    })
}

fn not_ported(message: &str) -> Box<dyn Error> {
    Box::new(TaskFailure::not_ported(message))
}

fn timestamp(time: chrono::DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Run one provider future to completion from synchronous code on any
/// thread, including inside an async context. The future is built and run
/// on its own thread; only its output crosses back.
pub fn block_on<F, Fut>(make: F) -> Fut::Output
where
    F: FnOnce() -> Fut + Send,
    Fut: Future,
    Fut::Output: Send,
{
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("delivery runtime")
                    .block_on(make())
            })
            .join()
            .expect("delivery thread")
    })
}

/// Check source control state before waiting for a Git observation.
pub fn standard_local_worktree_path(control: &Value) -> Result<&str, DeliveryOperationFailure> {
    if control["deliveryTarget"] != "local_worktree" {
        return Err(DeliveryOperationFailure {
            code: "delivery_target_mismatch",
            message: "This task has a different delivery target".into(),
        });
    }
    control["worktree"]["path"]
        .as_str()
        .ok_or(DeliveryOperationFailure {
            code: "worktree_missing",
            message: "The task has no worktree".into(),
        })
}

/// Check only the conditions in the source Standard `completeLocal` path.
/// An uncommitted working tree is valid local delivery evidence.
pub fn check_standard_local_completion(
    control: &Value,
    expected_head: Option<&str>,
    local: &LocalRevisionObservation,
) -> Result<(), DeliveryOperationFailure> {
    standard_local_worktree_path(control)?;
    if expected_head.is_none_or(|head| head != local.head_sha)
        || control["deliveryIntent"]["headBranch"] != local.branch
    {
        return Err(DeliveryOperationFailure {
            code: "head_diverged",
            message: "Review the current worktree before completing the task".into(),
        });
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
    if control["workflow"] != "standard" {
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
    .await?
    .map_err(io::Error::other)?;
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
    let mut worktree = current["worktree"].clone();
    worktree["headSha"] = json!(local.head_sha);
    worktree["dirty"] = json!(!local.clean);
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
    pull_request_number: Option<i64>,
    require_accepted: bool,
    recheck: impl FnOnce(&SuplexDatabase) -> DatabaseResult<()>,
) -> DatabaseResult<WorkflowCompletion> {
    use crate::coordination::workflows::{self, LocalSourceFacts, ReviewRange};
    database.transaction(true, |database| {
        let rows = root_session_store::root_observation_rows(database, task_id)?;
        let control = &rows.control;
        if control["status"] == "cancelled" {
            return Ok(WorkflowCompletion::Cancelled);
        }
        let state = root_session_store::workflow_state(database, task_id)?;
        if !state["completion"].is_null() || control["status"] == "delivered" {
            if control["status"] != "delivered" {
                root_session_store::mark_delivered(database, task_id, Utc::now())?;
            }
            return Ok(WorkflowCompletion::Already);
        }
        let accepted = ReviewRange::from_value(&state["acceptedDelivery"]);
        if require_accepted && accepted.is_none_or(|accepted| !workflows::same_range(&accepted, range)) {
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
        let mut state = state;
        state["acceptedDelivery"] = json!(range);
        state["deliveryWait"] = Value::Null;
        state["completion"] = json!({
            "kind":"workflow","reviewedHead":range.head_sha,"pullRequestNumber":pull_request_number,
            "observedAt":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        root_session_store::write_workflow_state(database, task_id, &state, Utc::now())?;
        root_session_store::mark_delivered(database, task_id, Utc::now())?;
        Ok(WorkflowCompletion::Completed)
    })
}

/// TypeScript `matchesDeliveryIntent`.
pub fn matches_delivery_intent(control: &Value, pull: &PullRequest) -> bool {
    let intent = &control["deliveryIntent"];
    intent["repository"] == pull.repository.as_str()
        && intent["headBranch"] == pull.head_branch.as_str()
        && pull.is_cross_repository != Some(true)
        && match intent["pullRequestNumber"].as_u64() {
            None => intent["baseBranch"] == pull.base_branch.as_str(),
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
pub fn supports_delivery_target(connection: Option<&Value>, target: &str) -> bool {
    connection.and_then(|connection| connection["kind"].as_str()) != Some("bitbucket")
        || (target != "pull_request_ready" && target != "merged")
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
    control: &Value,
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

#[derive(Clone, Copy, Default)]
struct Adoption<'a> {
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

    fn get(&self, task_id: &str) -> DatabaseResult<Value> {
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
    pub async fn github(&self, task_id: &str) -> DatabaseResult<&Github> {
        if self.context(task_id)?["configuration"]["integration"]["repository"]["kind"]
            == "bitbucket"
        {
            return Err(not_ported("Bitbucket delivery is not ported"));
        }
        Ok(self
            .github
            .get_or_try_init(Github::load)
            .await
            .map_err(Box::new)?)
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
        worktree: &Value,
        local: &LocalRevisionObservation,
    ) -> DatabaseResult<()> {
        let mut worktree = worktree.clone();
        worktree["branch"] = json!(local.branch);
        worktree["headSha"] = json!(local.head_sha);
        worktree["dirty"] = json!(!local.clean);
        root_session_store::set_worktree(
            &mut self.open(OpenMode::ReadWrite)?,
            task_id,
            &worktree,
            Utc::now(),
        )
    }

    /// TypeScript `TaskControlStore.setPullRequest`.
    pub fn set_pull_request(&self, task_id: &str, pull: Option<&Value>) -> DatabaseResult<()> {
        let mut database = self.open(OpenMode::ReadWrite)?;
        let value = pull.map(crate::shared::js_json::stringify);
        let changed = database.transaction(true, |database| {
            let status: Option<String> = database
                .connection()
                .query_row(
                    "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(pull) = pull
                && matches!(status.as_deref(), Some("active" | "waiting_human"))
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
                params![value, timestamp(Utc::now()), task_id],
            )?)
        })?;
        if changed != 1 {
            return Err(io::Error::other("task_not_active").into());
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
        mutate: impl FnOnce(&mut Value),
    ) -> DatabaseResult<()> {
        let mut database = self.open(OpenMode::ReadWrite)?;
        database.transaction(false, |database| {
            let raw: String = database.connection().query_row(
                "SELECT workflow_state_json FROM suplex_task_controls WHERE task_id = ?1",
                [task_id],
                |row| row.get(0),
            )?;
            let mut state: Value = serde_json::from_str(&raw)?;
            mutate(&mut state);
            database.connection().execute(
                "UPDATE suplex_task_controls SET workflow_state_json = ?1, updated_at = ?2 WHERE task_id = ?3",
                params![crate::shared::js_json::stringify(&state), timestamp(Utc::now()), task_id],
            )?;
            Ok(())
        })
    }

    fn schedule_wake(&self, task_id: &str, seconds: i64) -> DatabaseResult<()> {
        let now = Utc::now();
        self.open(OpenMode::ReadWrite)?.connection().execute(
            "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![
                timestamp(now + Duration::seconds(seconds)),
                timestamp(now),
                task_id
            ],
        )?;
        Ok(())
    }

    /// TypeScript `askHuman` without a Root binding; the delivery wait is cleared with it.
    fn ask_human(&self, task_id: &str, question: &str) -> DatabaseResult<bool> {
        let mut database = self.open(OpenMode::ReadWrite)?;
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = ?1, human_question_options_json = '[]', human_question_id = ?2, limit_pause_json = NULL, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?3 WHERE task_id = ?4 AND status = 'active'",
            params![question.trim(), uuid::Uuid::new_v4().to_string(), timestamp(Utc::now()), task_id],
        )? == 1;
        if changed {
            root_session_store::observe_lifecycle(&mut database, task_id)?;
        }
        Ok(changed)
    }

    fn same_wait(current: &Value, expected: &Value) -> bool {
        !current.is_null()
            && ["headSha", "fingerprint", "since", "reason"]
                .iter()
                .all(|key| current[key] == expected[key])
    }

    /// TypeScript `resumeDeliveryWait`: clear exactly the expected wait and wake the Root once.
    fn resume_delivery_wait(
        &self,
        task_id: &str,
        expected: &Value,
        prompt: &str,
    ) -> DatabaseResult<bool> {
        let mut database = self.open(OpenMode::ReadWrite)?;
        let now = Utc::now();
        let turn_id = root_session_store::new_turn_id(now)?;
        database.transaction(true, |database| {
            let row = database.connection().query_row(
                "SELECT c.status, c.workflow_state_json, s.id, s.generation, s.lifecycle FROM suplex_task_controls c LEFT JOIN suplex_task_sessions s ON s.task_id = c.task_id AND s.kind = 'root' AND s.is_current = 1 WHERE c.task_id = ?1",
                [task_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, Option<String>>(4)?)),
            )?;
            let (status, state, root_id, generation, lifecycle) = row;
            let mut state: Value = serde_json::from_str(&state)?;
            let (Some(root_id), Some(generation)) = (root_id, generation) else { return Ok(false) };
            if status != "active" || lifecycle.as_deref() == Some("cancelled") || !Self::same_wait(&state["deliveryWait"], expected) {
                return Ok(false);
            }
            state["deliveryWait"] = Value::Null;
            let time = timestamp(now);
            use sha2::Digest;
            database.connection().execute(
                "UPDATE suplex_task_controls SET workflow_state_json = ?1, wake_at = ?2, updated_at = ?2 WHERE task_id = ?3",
                params![crate::shared::js_json::stringify(&state), time, task_id],
            )?;
            database.connection().execute(
                "INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending_prompt', ?7, ?7)",
                params![turn_id, task_id, root_id, generation, format!("{:x}", sha2::Sha256::digest(prompt.as_bytes())), prompt, time],
            )?;
            Ok(true)
        })
    }

    fn clear_delivery_wait(&self, task_id: &str, expected: &Value) -> DatabaseResult<bool> {
        let mut cleared = false;
        self.update_workflow_state(task_id, |state| {
            if Self::same_wait(&state["deliveryWait"], expected) {
                state["deliveryWait"] = Value::Null;
                cleared = true;
            }
        })?;
        Ok(cleared)
    }

    fn fail_delivery_wait(
        &self,
        task_id: &str,
        expected: &Value,
        question: &str,
    ) -> DatabaseResult<bool> {
        let control = self.get(task_id)?;
        if control["status"] != "active"
            || !Self::same_wait(&control["workflowState"]["deliveryWait"], expected)
        {
            return Ok(false);
        }
        self.ask_human(task_id, question)
    }

    /// TypeScript `observe`: a finished task keeps its recorded pull request.
    pub async fn observe(&self, task_id: &str) -> DatabaseResult<Value> {
        let control = self.get(task_id)?;
        if matches!(control["status"].as_str(), Some("cancelled" | "delivered")) {
            return Ok(control["pullRequest"].clone());
        }
        if control["deliveryTarget"] == "local_worktree" {
            return Ok(Value::Null);
        }
        self.observe_known_pull(&control, Adoption::default()).await
    }

    /// TypeScript `observeDeliveryWait`: one persisted wait is consumed at most once.
    pub async fn observe_delivery_wait(&self, task_id: &str) -> DatabaseResult<&'static str> {
        let control = self.get(task_id)?;
        let wait = control["workflowState"]["deliveryWait"].clone();
        if wait.is_null() || control["status"] != "active" {
            return Ok("none");
        }
        let repository = control["deliveryIntent"]["repository"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let github = self.github(task_id).await?;
        let number = control["pullRequest"]["number"]
            .as_u64()
            .or_else(|| control["deliveryIntent"]["pullRequestNumber"].as_u64());
        let observed = match github
            .observe_pull_request(
                &repository,
                control["deliveryIntent"]["headBranch"]
                    .as_str()
                    .unwrap_or(""),
                number,
            )
            .await
        {
            Ok(observed) => observed,
            Err(error) if error.code == "authentication-required" => {
                let asked = self.fail_delivery_wait(task_id, &wait, &format!("GitHub could not access this pull request. Restore the GitHub CLI login or repository permission, then continue. {}", error.summary))?;
                return Ok(if asked { "changed" } else { "none" });
            }
            Err(error) => return Err(Box::new(error)),
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
        if wait["reason"] == "observation" {
            let (branch, sha) = self.resolve_delivery_base(&control).await?;
            if sha.is_none() {
                return Ok("unchanged");
            }
            let prompt = format!(
                "GitHub evidence is available again (the head of {branch}). Retry the delivery operation with your current review; no source change is needed."
            );
            return Ok(if self.resume_delivery_wait(task_id, &wait, &prompt)? {
                "changed"
            } else {
                "none"
            });
        }
        if observed.exists
            && same_delivery_wait_fingerprint(wait["fingerprint"].as_str().unwrap_or(""), &observed)
        {
            return Ok("unchanged");
        }
        let summary = crate::shared::js_json::stringify(&json!({
            "exists": observed.exists, "state": observed.state, "headSha": observed.head_sha,
            "isDraft": observed.is_draft, "mergeable": observed.mergeable,
            "mergeStateStatus": observed.merge_state_status, "reviewDecision": observed.review_decision,
            "checks": observed.checks,
        }));
        let prompt = format!(
            "Delivery state changed while Suplex waited ({}). Current observation: {summary}. If checks failed, obtain their evidence and continue the workflow; if the pull request is eligible, request merge_pull_request with your current review; otherwise observe_checks again.",
            wait["reason"].as_str().unwrap_or("")
        );
        Ok(if self.resume_delivery_wait(task_id, &wait, &prompt)? {
            "changed"
        } else {
            "none"
        })
    }

    /// TypeScript `checksObservation`: null without a pull request or when GitHub cannot answer.
    pub async fn checks_observation(&self, task_id: &str) -> DatabaseResult<Option<Observation>> {
        let control = self.get(task_id)?;
        let Some(number) = control["pullRequest"]["number"]
            .as_u64()
            .or_else(|| control["deliveryIntent"]["pullRequestNumber"].as_u64())
        else {
            return Ok(None);
        };
        let Ok(github) = self.github(task_id).await else {
            return Ok(None);
        };
        Ok(github
            .observe_pull_request(
                control["deliveryIntent"]["repository"]
                    .as_str()
                    .unwrap_or(""),
                control["deliveryIntent"]["headBranch"]
                    .as_str()
                    .unwrap_or(""),
                Some(number),
            )
            .await
            .ok())
    }

    /// TypeScript `currentRange`: the live GitHub-base-to-local-head range with the tree state.
    pub async fn current_range(&self, task_id: &str) -> DatabaseResult<Value> {
        let control = self.get(task_id)?;
        let path = control["worktree"]["path"]
            .as_str()
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
        control: &Value,
    ) -> DatabaseResult<(String, Option<String>)> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        let repository = control["deliveryIntent"]["repository"]
            .as_str()
            .unwrap_or("");
        let github = self.github(task_id).await?;
        let mut branch = control["deliveryIntent"]["baseBranch"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        if let Some(number) = control["deliveryIntent"]["pullRequestNumber"].as_u64() {
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

    async fn delivery_diff(&self, control: &Value, head_sha: &str) -> DatabaseResult<DeliveryDiff> {
        let (branch, sha) = self.resolve_delivery_base(control).await?;
        let Some(sha) = sha else {
            return Err(delivery_failure(
                "observation_unavailable",
                format!(
                    "GitHub did not return the head of {branch}. Suplex cannot compute the delivery range until that observation is available; no source change is needed."
                ),
            ));
        };
        let path = PathBuf::from(control["worktree"]["path"].as_str().unwrap_or(""));
        let token = self
            .github(control["taskId"].as_str().unwrap_or(""))
            .await?
            .token()
            .map(str::to_owned);
        let head = head_sha.to_owned();
        tokio::task::spawn_blocking(move || {
            inspection::inspect_revisions(&path, &sha, &head, token.as_deref(), &branch)
                .map_err(|error| error.to_string())
        })
        .await?
        .map_err(|error| io::Error::other(error).into())
    }

    fn observation_unavailable(error: &(dyn Error + 'static)) -> bool {
        error
            .downcast_ref::<DeliveryOperationFailure>()
            .is_some_and(|failure| failure.code == "observation_unavailable")
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
        control: &Value,
        head_sha: &str,
        evidence: &str,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        let wait = json!({"headSha": head_sha, "fingerprint": format!("observation:{evidence}"), "since": timestamp(Utc::now()), "reason": "observation"});
        self.update_workflow_state(task_id, |state| state["deliveryWait"] = wait.clone())?;
        self.schedule_wake(task_id, 30)?;
        Ok(
            json!({"kind": "waiting", "problems": [format!("{evidence} is unavailable")], "wait": wait, "next": DELIVERY_WAIT_NEXT}),
        )
    }

    /// TypeScript `deliveryDecision`: always accepted for the Standard workflow.
    fn workflow_decision(&self, control: &Value) -> DatabaseResult<()> {
        if control["workflow"] == "standard" {
            return Ok(());
        }
        Err(not_ported("Non-Standard delivery decisions are not ported"))
    }

    async fn final_recheck(&self, control: &Value, recheck: &Recheck<'_>) -> DatabaseResult<()> {
        self.workflow_decision(control)?;
        self.recheck(recheck)
    }

    /// The whole TypeScript `execute` for the Standard workflow.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute(
        &self,
        root: &RootIdentity,
        owner_token: Option<&str>,
        operation: &str,
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
        if operation == "inspect_delivery_diff" {
            let path = control["worktree"]["path"]
                .as_str()
                .ok_or_else(|| delivery_failure("worktree_missing", "The task has no worktree"))?;
            let local =
                github_delivery::inspect_local_revision(Path::new(path)).map_err(Box::new)?;
            return Ok(serde_json::to_value(
                self.delivery_diff(&control, &local.head_sha).await?,
            )?);
        }
        if operation == "complete_local_work" {
            let Some(token) = owner_token else {
                return Err(io::Error::other("task_tool_owner_lost").into());
            };
            if control["deliveryTarget"] != "local_worktree" {
                return Err(delivery_failure(
                    "delivery_target_mismatch",
                    "This task has a different delivery target",
                ));
            }
            return complete_local_work(&self.database_path, root, token, expected_head).await;
        }
        self.workflow_decision(&control)?;
        let known = if operation == "push_branch" {
            Value::Null
        } else {
            self.observe_known_pull(
                &control,
                Adoption {
                    recheck: Some(&recheck),
                    defer_completion: review.is_some(),
                    ..Adoption::default()
                },
            )
            .await?
        };
        if self.get(task_id)?["status"] == "delivered" || known["state"] == "merged" {
            return Ok(known);
        }
        let Some(path) = control["worktree"]["path"].as_str().map(PathBuf::from) else {
            return Err(delivery_failure(
                "worktree_missing",
                "Suplex has no observed worktree for this task",
            ));
        };
        let local = github_delivery::inspect_local_revision(&path).map_err(Box::new)?;
        if control["deliveryIntent"]["headBranch"] != local.branch.as_str() {
            return Err(delivery_failure(
                "head_diverged",
                "The worktree branch does not match this task intent",
            ));
        }
        self.set_worktree(task_id, &control["worktree"], &local)?;
        let refreshed = self.get(task_id)?;
        let repository = refreshed["deliveryIntent"]["repository"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let github = self.github(task_id).await?;
        let remote = github_delivery::remote_repository(&path).map_err(Box::new)?;
        if remote != repository {
            return Err(delivery_failure(
                "head_diverged",
                "The worktree remote does not match this task intent",
            ));
        }
        let mutation = matches!(
            operation,
            "push_branch"
                | "create_or_adopt_pull_request"
                | "request_review"
                | "merge_pull_request"
        );
        let mut actual = None;
        if mutation {
            let Some(review) = review.filter(|_| expected_head == Some(local.head_sha.as_str()))
            else {
                return Err(delivery_failure(
                    "delivery_review_required",
                    "Inspect delivery with inspect_delivery_diff. Independently review the entire GitHub-base-to-head diff and every commit, then supply expectedHead and review { baseSha, headSha, files, commits }. Do not approve unrelated changes or import unpublished local main; ask the human if the task depends on unpublished work.",
                ));
            };
            let diff = match self.delivery_diff(&refreshed, &local.head_sha).await {
                Ok(diff) => diff,
                Err(error)
                    if operation == "merge_pull_request"
                        && !refreshed["pullRequest"].is_null()
                        && Self::observation_unavailable(error.as_ref()) =>
                {
                    return self.observation_wait(
                        &refreshed,
                        &local.head_sha,
                        "the current delivery base",
                    );
                }
                Err(error) => return Err(error),
            };
            let mut range = ReviewRange::from(&diff);
            if review.base_sha == range.base_sha {
                if !inspection::same_range(review, &range) {
                    return Err(delivery_failure(
                        "delivery_review_required",
                        format!(
                            "The reviewed delivery range differs in: {}. Inspect delivery again and review the new range before retrying.",
                            inspection::range_differences(review, &range).join(", ")
                        ),
                    ));
                }
            } else {
                let (review, base, token) = (
                    review.clone(),
                    range.base_sha.clone(),
                    github.token().map(str::to_owned),
                );
                let path = path.clone();
                range = tokio::task::spawn_blocking(move || inspection::review_equivalence(&path, &review, &base, token.as_deref()))
                    .await?
                    .map_err(|reason| delivery_failure("delivery_review_required", format!("{reason} Inspect delivery again and review the new range before retrying.")))?;
            }
            self.recheck(&recheck)?;
            actual = Some(range);
        }
        let pull = if operation == "push_branch" {
            Value::Null
        } else {
            self.observe_pull(&refreshed, &repository, &local.branch)
                .await?
        };
        if pull["state"] == "merged" {
            let number = pull["number"].as_u64().unwrap_or(0);
            let full = github.get_pull_request(&repository, number).await?;
            return self
                .adopt_known_pull(
                    &refreshed,
                    &full,
                    Adoption {
                        recheck: Some(&recheck),
                        ..Adoption::default()
                    },
                )
                .await;
        }
        if let Some(actual) = &actual {
            let accepted = serde_json::to_value(actual)?;
            self.update_workflow_state(task_id, |state| state["acceptedDelivery"] = accepted)?;
        }
        match operation {
            "observe_pull_request" => Ok(pull),
            "push_branch" => {
                self.push(
                    &recheck,
                    &refreshed,
                    &repository,
                    &local,
                    actual.as_ref().expect("reviewed"),
                )
                .await
            }
            "create_or_adopt_pull_request" => {
                self.create_or_adopt(
                    &recheck,
                    &refreshed,
                    &repository,
                    &local,
                    &pull,
                    pull_request_title,
                    pull_request_body,
                )
                .await
            }
            "observe_checks" => self.observe_checks(&refreshed, &repository, &local).await,
            "request_review" => {
                self.request_review(
                    &recheck,
                    &refreshed,
                    &repository,
                    &local.branch,
                    expected_head,
                )
                .await
            }
            "merge_pull_request" => {
                self.merge(
                    &recheck,
                    &refreshed,
                    &repository,
                    &local.branch,
                    expected_head,
                    actual.as_ref().expect("reviewed"),
                )
                .await
            }
            _ => Err(io::Error::other("delivery_operation_invalid").into()),
        }
    }

    async fn observe_known_pull(
        &self,
        control: &Value,
        options: Adoption<'_>,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        let repository = control["deliveryIntent"]["repository"]
            .as_str()
            .unwrap_or("");
        let github = self.github(task_id).await?;
        if let Some(number) = control["deliveryIntent"]["pullRequestNumber"].as_u64() {
            let pull = github.get_pull_request(repository, number).await?;
            return self.adopt_known_pull(control, &pull, options).await;
        }
        let pulls = github
            .list_pull_requests(
                repository,
                control["deliveryIntent"]["headBranch"]
                    .as_str()
                    .unwrap_or(""),
            )
            .await?;
        if let Some(pull) = select_discovered_pull(control, pulls)? {
            return self.adopt_known_pull(control, &pull, options).await;
        }
        if !control["pullRequest"].is_null() {
            self.set_pull_request(task_id, None)?;
        }
        Ok(Value::Null)
    }

    async fn adopt_known_pull(
        &self,
        control: &Value,
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
            self.set_pull_request(control["taskId"].as_str().unwrap_or(""), Some(&reference))?;
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
        control: &Value,
        repository: &str,
        branch: &str,
    ) -> DatabaseResult<Value> {
        let Some(number) = control["pullRequest"]["number"].as_u64() else {
            return Ok(Value::Null);
        };
        let task_id = control["taskId"].as_str().unwrap_or("");
        let observed = self
            .github(task_id)
            .await?
            .observe_pull_request(repository, branch, Some(number))
            .await?;
        let pull = observed_pull_reference(repository, &observed);
        if let Some(pull) = &pull {
            self.set_pull_request(task_id, Some(pull))?;
        }
        Ok(pull.unwrap_or(Value::Null))
    }

    /// TypeScript `completeIfTargetMatches` for the Standard workflow.
    async fn complete_if_target_matches(
        &self,
        control: &Value,
        pull: Value,
        options: Adoption<'_>,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        self.set_pull_request(task_id, Some(&pull))?;
        let target = control["deliveryTarget"].as_str().unwrap_or("");
        let reached = pull["state"] == "merged"
            || (pull["state"] == "open"
                && (target == "pull_request_draft"
                    || (target == "pull_request_ready" && options.is_draft == Some(false))));
        if !reached {
            return Ok(pull);
        }
        let current = self.get(task_id)?;
        if current["status"] == "cancelled" {
            return Ok(pull);
        }
        if current["workflowState"]["followUp"] == true
            && !options.explicit
            && options.validated_range.is_none()
        {
            return Ok(pull);
        }
        self.workflow_decision(control)?;
        issue_evidence::complete(
            self,
            task_id,
            pull["number"].as_u64().unwrap_or(0),
            pull["headSha"].as_str().unwrap_or(""),
            options.recheck,
        )
        .await?;
        if let Some(recheck) = options.recheck {
            self.recheck(recheck)?;
        }
        if self.get(task_id)?["status"] != "cancelled" {
            self.mark_delivered(task_id)?;
        }
        Ok(pull)
    }

    /// TypeScript `pushPublication`.
    async fn push(
        &self,
        recheck: &Recheck<'_>,
        control: &Value,
        repository: &str,
        local: &LocalRevisionObservation,
        _actual: &ReviewRange,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        self.trigger_policy(task_id)?;
        let github = self.github(task_id).await?;
        let remote_head = github.get_branch_head(repository, &local.branch).await?;
        self.final_recheck(control, recheck).await?;
        if remote_head.as_deref() == Some(local.head_sha.as_str()) {
            if control["deliveryTarget"] == "remote_branch" {
                self.mark_delivered(task_id)?;
            }
            return Ok(json!({"kind": "adopted", "headSha": local.head_sha}));
        }
        let (path, branch, head, token) = (
            PathBuf::from(control["worktree"]["path"].as_str().unwrap_or("")),
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
        self.recheck(recheck)?;
        if control["deliveryTarget"] == "remote_branch" {
            self.mark_delivered(task_id)?;
        }
        Ok(json!({"kind": "pushed", "headSha": observed}))
    }

    /// TypeScript `createOrAdoptPublication`.
    #[allow(clippy::too_many_arguments)]
    async fn create_or_adopt(
        &self,
        recheck: &Recheck<'_>,
        control: &Value,
        repository: &str,
        local: &LocalRevisionObservation,
        pull: &Value,
        title: Option<&str>,
        body: Option<&str>,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        let github = self.github(task_id).await?;
        let adopt = Adoption {
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
            self.recheck(recheck)?;
            return self.adopt_known_pull(control, &full, adopt).await;
        }
        if !control["deliveryIntent"]["pullRequestNumber"].is_null() {
            return Err(delivery_failure(
                "pull_request_closed",
                "GitHub did not return the pinned pull request",
            ));
        }
        if control["deliveryIntent"]["headBranch"] != local.branch.as_str() {
            return Err(delivery_failure(
                "head_diverged",
                "The worktree branch does not match this task intent",
            ));
        }
        let candidate = select_discovered_pull(
            control,
            github.list_pull_requests(repository, &local.branch).await?,
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
        self.recheck(recheck)?;
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
        let base = control["deliveryIntent"]["baseBranch"]
            .as_str()
            .unwrap_or("");
        let created = github
            .create_draft_pull_request(repository, &local.branch, base, title, body)
            .await?;
        self.adopt_known_pull(control, &created, adopt).await
    }

    async fn checks(
        &self,
        control: &Value,
        repository: &str,
        branch: &str,
    ) -> DatabaseResult<Observation> {
        let Some(number) = control["pullRequest"]["number"].as_u64() else {
            return Err(delivery_failure(
                "pull_request_closed",
                "No matching pull request was found for this task",
            ));
        };
        let observed = self
            .github(control["taskId"].as_str().unwrap_or(""))
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
        control: &Value,
        repository: &str,
        local: &LocalRevisionObservation,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
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
            let current = self.get(task_id)?["workflowState"]["deliveryWait"].clone();
            let wait = if current["reason"] == "checks"
                && current["headSha"] == json!(observed.head_sha)
                && current["fingerprint"] == fingerprint.as_str()
            {
                current
            } else {
                json!({"headSha": observed.head_sha, "fingerprint": fingerprint, "since": timestamp(Utc::now()), "reason": "checks"})
            };
            self.update_workflow_state(task_id, |state| state["deliveryWait"] = wait.clone())?;
            self.schedule_wake(task_id, 30)?;
            summary["wait"] = wait;
            summary["next"] = json!(DELIVERY_WAIT_NEXT);
        }
        Ok(summary)
    }

    async fn request_review(
        &self,
        recheck: &Recheck<'_>,
        control: &Value,
        repository: &str,
        branch: &str,
        expected_head: Option<&str>,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        let observed = self.checks(control, repository, branch).await?;
        if observed.head_sha.as_deref() != control["worktree"]["headSha"].as_str() {
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
        self.final_recheck(control, recheck).await?;
        let github = self.github(task_id).await?;
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

    async fn merge(
        &self,
        recheck: &Recheck<'_>,
        control: &Value,
        repository: &str,
        branch: &str,
        expected_head: Option<&str>,
        actual: &ReviewRange,
    ) -> DatabaseResult<Value> {
        let task_id = control["taskId"].as_str().unwrap_or("");
        let github = self.github(task_id).await?;
        let observed = self.checks(control, repository, branch).await?;
        if observed.state.as_deref() == Some("merged")
            && let Some(number) = observed.number
        {
            let pull = github.get_pull_request(repository, number).await?;
            return self
                .adopt_known_pull(
                    control,
                    &pull,
                    Adoption {
                        recheck: Some(recheck),
                        ..Adoption::default()
                    },
                )
                .await;
        }
        let head = observed.head_sha.clone().unwrap_or_default();
        if Some(head.as_str()) != control["worktree"]["headSha"].as_str() {
            return Err(delivery_failure(
                "head_diverged",
                "The pull request head changed after review",
            ));
        }
        if expected_head != Some(head.as_str()) {
            return Err(delivery_failure(
                "head_diverged",
                "The pull request head changed after the Coordinator reviewed it",
            ));
        }
        self.trigger_policy(task_id)?;
        self.final_recheck(control, recheck).await?;
        let rows =
            root_session_store::root_observation_rows(&self.open(OpenMode::ReadOnly)?, task_id)?;
        let blockers = rows
            .dependencies
            .iter()
            .filter(|dependency| dependency["status"] != "delivered")
            .map(|dependency| {
                format!(
                    "{} \"{}\" ({})",
                    dependency["id"].as_str().unwrap_or(""),
                    dependency["title"].as_str().unwrap_or(""),
                    dependency["status"].as_str().unwrap_or("")
                )
            })
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
        self.recheck(recheck)?;
        let requested = observed.number.unwrap_or(0);
        // TypeScript `mergePullRequest` discards the conditional result and observes the pull request.
        github
            .merge_conditionally(repository, requested, &head, true)
            .await
            .map(|result| matches!(result, MergeResult::Merged { .. }))?;
        let last = github.get_pull_request(repository, requested).await?;
        if last.state != "merged" {
            let wait = json!({"headSha": head, "fingerprint": delivery_wait_fingerprint(&observed), "since": timestamp(Utc::now()), "reason": "merge_queue"});
            self.update_workflow_state(task_id, |state| state["deliveryWait"] = wait.clone())?;
            self.schedule_wake(task_id, 30)?;
            return Ok(
                json!({"kind": "merge_requested", "pullRequest": last.reference(), "checkSummary": check_summary(&observed), "wait": wait, "next": DELIVERY_WAIT_NEXT}),
            );
        }
        let captured = control["pullRequest"]["number"]
            .as_u64()
            .or_else(|| control["deliveryIntent"]["pullRequestNumber"].as_u64());
        if last.repository != repository
            || last.number != requested
            || captured.is_some_and(|number| number != last.number)
            || control["deliveryIntent"]["headBranch"] != last.head_branch.as_str()
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

    /// GitHub trigger tasks carry a stored delivery policy that is not ported.
    fn trigger_policy(&self, task_id: &str) -> DatabaseResult<()> {
        let present: bool = self.open(OpenMode::ReadOnly)?.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_github_trigger_dispatches WHERE task_id = ?1)",
            [task_id],
            |row| row.get(0),
        )?;
        if present {
            return Err(not_ported("GitHub trigger delivery is not ported"));
        }
        Ok(())
    }
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
        block_on(|| async {
            let operations = DeliveryOperations::new(&database_path, &artifact_root);
            let control = operations
                .get(&task_id)
                .map_err(|error| format!("{task_id}: {error}"))?;
            match control["status"].as_str() {
                Some("delivered") => {
                    super::completed_pull_requests::refresh(&database_path, None).await
                }
                Some("active") if !control["workflowState"]["deliveryWait"].is_null() => {
                    operations.observe_delivery_wait(&task_id).await.map(|_| ())
                }
                Some("active" | "waiting_human") => operations.observe(&task_id).await.map(|_| ()),
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
pub fn observe_for_root(database_path: &Path, control: &Value) -> DatabaseResult<(Value, Value)> {
    if matches!(control["status"].as_str(), Some("cancelled" | "delivered")) {
        return Ok((control["pullRequest"].clone(), json!({"available": true})));
    }
    if control["deliveryTarget"] == "local_worktree" {
        return Ok((Value::Null, json!({"available": true})));
    }
    let artifact_root = database_path
        .parent()
        .unwrap_or(Path::new(""))
        .join("artifacts");
    let operations = DeliveryOperations::new(database_path, &artifact_root);
    let task_id = control["taskId"].as_str().unwrap_or("").to_owned();
    let observed = block_on(|| async {
        operations.observe(&task_id).await.map_err(|error| {
            let code = error
                .downcast_ref::<GithubFailure>()
                .map(|failure| failure.code)
                .or_else(|| {
                    error
                        .downcast_ref::<DeliveryOperationFailure>()
                        .map(|failure| failure.code)
                });
            (code, error.to_string())
        })
    });
    match observed {
        Ok(pull) => Ok((pull, json!({"available": true}))),
        Err((None, message)) => Err(io::Error::other(message).into()),
        Err((Some(code), message)) => Ok((
            control["pullRequest"].clone(),
            json!({
                "available": false, "code": code, "message": message,
                "retry": "Suplex re-observes on its normal cadence; continue local review and repair. Ask a human only for authentication or a missing executable.",
            }),
        )),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn standard_completion_uses_actual_branch_and_head_without_a_clean_tree_gate() {
        let control = json!({
            "deliveryTarget":"local_worktree",
            "worktree":{"path":"/tmp/task"},
            "deliveryIntent":{"headBranch":"task-one"}
        });
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
                .code,
            "head_diverged"
        );
        assert_eq!(
            check_standard_local_completion(&control, Some("old-head"), &local)
                .unwrap_err()
                .code,
            "head_diverged"
        );
        let mut wrong_branch = local.clone();
        wrong_branch.branch = "other".into();
        assert_eq!(
            check_standard_local_completion(&control, Some("head-one"), &wrong_branch)
                .unwrap_err()
                .code,
            "head_diverged"
        );
        let mut wrong_target = control.clone();
        wrong_target["deliveryTarget"] = json!("pull_request");
        assert_eq!(
            check_standard_local_completion(&wrong_target, Some("head-one"), &local)
                .unwrap_err()
                .code,
            "delivery_target_mismatch"
        );
        let mut missing_worktree = control.clone();
        missing_worktree["worktree"] = Value::Null;
        assert_eq!(
            standard_local_worktree_path(&missing_worktree)
                .unwrap_err()
                .code,
            "worktree_missing"
        );
    }

    #[test]
    fn delivery_observation_keeps_finished_pull_requests_without_github() {
        let local =
            json!({"status":"active","deliveryTarget":"local_worktree","pullRequest":{"number":7}});
        assert_eq!(
            observe_for_root(Path::new(""), &local).unwrap().0,
            Value::Null
        );
        let delivered = json!({"status":"delivered","deliveryTarget":"pull_request_draft","pullRequest":{"number":7}});
        assert_eq!(
            observe_for_root(Path::new(""), &delivered).unwrap().0,
            json!({"number":7})
        );
    }

    #[test]
    fn target_capabilities_and_titles_match_source_schemas() {
        let bitbucket = json!({"kind":"bitbucket"});
        assert!(supports_delivery_target(
            Some(&bitbucket),
            "pull_request_draft"
        ));
        assert!(!supports_delivery_target(Some(&bitbucket), "merged"));
        assert!(supports_delivery_target(None, "merged"));
        assert!(valid_title("Add retries"));
        assert!(!valid_title("Two\nlines"));
        assert!(valid_body(
            "## Summary\n- a\n## Why\nb\n## Validation\n- c\n## Review notes\nd"
        ));
        assert!(!valid_body(
            "## Why\n## Summary\n## Validation\n## Review notes"
        ));
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
