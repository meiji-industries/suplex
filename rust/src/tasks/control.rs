//! TypeScript `tasks/control-contracts.ts`: the persisted task control vocabulary.

use garde::Validate;
use ts_rs::TS;

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::coordination::{
    advisor_bridge::AdvisorRole,
    workflows::{Workflow, WorkflowState},
};
use crate::shared::wire_enum;
pub use crate::tasks::worktree::WorktreeReference;

wire_enum! {
    /// TypeScript `TaskControlStatus`, which is also the public task status.
    pub enum TaskStatus {
        Backlog = "backlog",
        Queued = "queued",
        Active = "active",
        WaitingHuman = "waiting_human",
        Cancelled = "cancelled",
        Delivered = "delivered",
    }
}

impl TaskStatus {
    /// Archive keeps a task that is not running and not waiting on a person.
    pub fn archivable(self) -> bool {
        matches!(
            self,
            Self::Backlog | Self::Queued | Self::Cancelled | Self::Delivered
        )
    }
}

wire_enum! {
    pub enum TurnStatus {
        PendingPrompt = "pending_prompt",
        Prompted = "prompted",
        Unknown = "unknown",
        Completed = "completed",
        Cancelled = "cancelled",
    }
}

wire_enum! {
    pub enum SessionKind {
        Root = "root",
        Worker = "worker",
    }
}

wire_enum! {
    pub enum SessionLifecycle {
        Reserved = "reserved",
        Live = "live",
        Stopped = "stopped",
        Unknown = "unknown",
        Cancelled = "cancelled",
    }
}

wire_enum! {
    /// Declared from the least to the most delivery, so `Ord` ranks targets.
    pub enum DeliveryTarget {
        LocalWorktree = "local_worktree",
        RemoteBranch = "remote_branch",
        PullRequestDraft = "pull_request_draft",
        PullRequestReady = "pull_request_ready",
        Merged = "merged",
    }
}

impl DeliveryTarget {
    /// A target that delivers through a pull request.
    pub fn uses_pull_request(self) -> bool {
        self >= Self::PullRequestDraft
    }

    /// Bitbucket delivers up to a draft pull request.
    pub fn bitbucket_supports(self) -> bool {
        self <= Self::PullRequestDraft
    }
}

/// A present JSON field, `null` included; a missing one stays `None`.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// TypeScript `TaskProfile`: the agent profile a task or session captured.
/// The instance fields are optional in older snapshots, and a snapshot
/// serializes with exactly the fields it was saved with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskProfile {
    pub profile_id: String,
    pub provider: String,
    pub model: String,
    pub reasoning_level: String,
    pub service_tier: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[ts(optional, type = "string | null")]
    pub provider_instance_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[ts(optional, type = "string | null")]
    pub instance_home_directory: Option<Option<String>>,
}

impl TaskProfile {
    pub fn provider_instance_id(&self) -> Option<&str> {
        self.provider_instance_id.as_ref()?.as_deref()
    }

    pub fn instance_home_directory(&self) -> Option<&str> {
        self.instance_home_directory.as_ref()?.as_deref()
    }
}

/// TypeScript `DeliveryIntent`: where the task delivers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryIntent {
    pub repository: String,
    pub head_branch: String,
    pub base_branch: String,
    pub baseline_sha: String,
    pub pull_request_number: Option<u64>,
}

/// TypeScript `TaskControl`: the durable intent of one task. It serializes
/// with the field names and order of the persisted control projection.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskControlRow {
    pub task_id: String,
    pub objective: String,
    pub delivery_target: DeliveryTarget,
    pub delivery_intent: DeliveryIntent,
    pub status: TaskStatus,
    pub wake_at: Option<String>,
    pub human_question: Option<String>,
    pub human_question_options: Value,
    pub human_question_id: Option<String>,
    pub recovery_turn_id: Option<String>,
    pub limit_pause: Option<Value>,
    pub worktree: Option<WorktreeReference>,
    pub pull_request: Option<PullRequestReference>,
    pub root_session_id: Option<String>,
    pub worker_session_id: Option<String>,
    pub shell_pane_id: Option<String>,
    pub root_profile: TaskProfile,
    pub worker_profile: TaskProfile,
    pub workflow: Workflow,
    pub advisor_profiles: BTreeMap<AdvisorRole, TaskProfile>,
    pub workflow_state: WorkflowState,
}

#[cfg(test)]
impl TaskControlRow {
    /// An active Standard local-worktree control for tests to adjust.
    pub fn fixture() -> Self {
        let profile = |id: &str| TaskProfile {
            profile_id: id.into(),
            provider: "codex".into(),
            model: "gpt-6-sol".into(),
            reasoning_level: "medium".into(),
            service_tier: "default".into(),
            provider_instance_id: None,
            instance_home_directory: None,
        };
        Self {
            task_id: "task".into(),
            objective: "Objective".into(),
            delivery_target: DeliveryTarget::LocalWorktree,
            delivery_intent: DeliveryIntent {
                repository: "owner/repo".into(),
                head_branch: "task-branch".into(),
                base_branch: "main".into(),
                baseline_sha: "head".into(),
                pull_request_number: None,
            },
            status: TaskStatus::Active,
            wake_at: None,
            human_question: None,
            human_question_options: Value::Array(Vec::new()),
            human_question_id: None,
            recovery_turn_id: None,
            limit_pause: None,
            worktree: None,
            pull_request: None,
            root_session_id: None,
            worker_session_id: None,
            shell_pane_id: None,
            root_profile: profile("profile_root"),
            worker_profile: profile("profile_worker"),
            workflow: Workflow::Standard,
            advisor_profiles: BTreeMap::new(),
            workflow_state: WorkflowState::default(),
        }
    }
}

impl TaskControlRow {
    /// The worktree path; a stored path is JSON text, so it is always UTF-8.
    pub fn worktree_path(&self) -> Option<&str> {
        self.worktree.as_ref()?.path.to_str()
    }

    /// The pull request this task delivers through: the observed one, else the
    /// one its intent pins.
    pub fn pull_request_number(&self) -> Option<u64> {
        self.pull_request
            .as_ref()
            .map(|pull| pull.number)
            .or(self.delivery_intent.pull_request_number)
    }
}

/// One prerequisite task; a task without a control row is in the backlog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DependencyRow {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
}

impl DependencyRow {
    /// `id "title" (status)`, as the Coordinator prompts name a prerequisite.
    pub fn describe(&self) -> String {
        format!("{} \"{}\" ({})", self.id, self.title, self.status)
    }
}

/// TypeScript `TaskSession`: one Coordinator, Worker, or Advisor session row.
/// It serializes with the field names and order of the persisted session
/// projection that the Coordinator observes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub profile: Option<TaskProfile>,
    pub replacement: Option<SessionReplacement>,
    pub id: String,
    pub task_id: String,
    pub kind: SessionKind,
    pub generation: i64,
    pub current: bool,
    pub pane_id: Option<String>,
    pub native_session_id: Option<String>,
    pub lifecycle: SessionLifecycle,
    pub assignment_hash: Option<String>,
    pub launch_owner: Option<String>,
    pub launch_owner_pid: Option<i64>,
    pub launch_owner_start_time: Option<String>,
    pub stop_requested_at: Option<String>,
    pub stopped_at: Option<String>,
    pub advisor_role: Option<AdvisorRole>,
    pub delegate_slot: Option<String>,
    pub workflow_input: Option<Value>,
}

#[cfg(test)]
impl SessionRow {
    /// A current reserved generation-1 session for tests to adjust.
    pub fn fixture(id: &str, kind: SessionKind) -> Self {
        Self {
            profile: None,
            replacement: None,
            id: id.into(),
            task_id: "task".into(),
            kind,
            generation: 1,
            current: true,
            pane_id: None,
            native_session_id: None,
            lifecycle: SessionLifecycle::Reserved,
            assignment_hash: None,
            launch_owner: None,
            launch_owner_pid: None,
            launch_owner_start_time: None,
            stop_requested_at: None,
            stopped_at: None,
            advisor_role: None,
            delegate_slot: None,
            workflow_input: None,
        }
    }
}

#[cfg(test)]
impl TurnRow {
    /// A generation-1 turn of `session_id` for tests to adjust.
    pub fn fixture(id: &str, session_id: &str, status: TurnStatus) -> Self {
        Self {
            id: id.into(),
            task_id: "task".into(),
            session_id: session_id.into(),
            generation: 1,
            assignment_hash: None,
            prompt_hash: String::new(),
            prompt_text: String::new(),
            status,
            prompted_at: None,
            completed_at: None,
            result_receipt_id: None,
            terminal_observation: None,
            native_turn_id: None,
            dispatch_attempt: None,
            workflow_input: None,
        }
    }
}

impl SessionRow {
    /// A Worker with no Advisor role.
    pub fn is_plain_worker(&self) -> bool {
        self.kind == SessionKind::Worker && self.advisor_role.is_none()
    }
}

/// The session a replacement session succeeded, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplacement {
    pub session_id: String,
    pub reason: Option<String>,
    pub handoff: Option<String>,
}

/// TypeScript `TaskTurn`: one prompt to a session and its terminal result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRow {
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    pub generation: i64,
    pub assignment_hash: Option<String>,
    pub prompt_hash: String,
    pub prompt_text: String,
    pub status: TurnStatus,
    pub prompted_at: Option<String>,
    pub completed_at: Option<String>,
    pub result_receipt_id: Option<String>,
    pub terminal_observation: Option<String>,
    pub native_turn_id: Option<String>,
    pub dispatch_attempt: Option<PromptDispatchAttempt>,
    pub workflow_input: Option<Value>,
}

impl TurnStatus {
    /// A turn that native work may still answer.
    pub fn is_open(self) -> bool {
        matches!(self, Self::PendingPrompt | Self::Prompted | Self::Unknown)
    }
}

/// TypeScript `PromptDispatchAttempt`: the server generation that claimed a prompt.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchAttempt {
    pub server_generation: String,
    pub claimed_at: String,
}

/// TypeScript `PullRequestReference`: the pull request GitHub last reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReference {
    pub repository: String,
    pub number: u64,
    pub url: String,
    pub head_sha: String,
    pub state: String,
    pub merged_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_round_trip_through_serde_and_sqlite() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        for target in [
            DeliveryTarget::LocalWorktree,
            DeliveryTarget::RemoteBranch,
            DeliveryTarget::PullRequestDraft,
            DeliveryTarget::PullRequestReady,
            DeliveryTarget::Merged,
        ] {
            assert_eq!(serde_json::to_value(target).unwrap(), target.as_str());
            let stored: DeliveryTarget = connection
                .query_row("SELECT ?1", [target], |row| row.get(0))
                .unwrap();
            assert_eq!(stored, target);
        }
        assert!(DeliveryTarget::PullRequestDraft < DeliveryTarget::Merged);
        assert!(!DeliveryTarget::Merged.bitbucket_supports());
        assert_eq!(
            TaskStatus::parse("waiting_human"),
            Some(TaskStatus::WaitingHuman)
        );
        assert!(
            connection
                .query_row("SELECT 'paused'", [], |row| row.get::<_, TaskStatus>(0))
                .is_err()
        );
    }

    #[test]
    fn a_profile_snapshot_serializes_with_the_fields_it_was_saved_with() {
        for saved in [
            r#"{"profileId":"p","provider":"codex","model":"m","reasoningLevel":"medium","serviceTier":"default"}"#,
            r#"{"profileId":"p","provider":"codex","model":"m","reasoningLevel":"medium","serviceTier":"default","providerInstanceId":null,"instanceHomeDirectory":"/home"}"#,
        ] {
            let profile: TaskProfile = serde_json::from_str(saved).unwrap();
            assert_eq!(serde_json::to_string(&profile).unwrap(), saved);
        }
        assert!(serde_json::from_str::<TaskProfile>(r#"{"profileId":"p"}"#).is_err());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskWorkerReplacementBody {
    #[garde(length(utf16, min = 1))]
    pub session_id: String,
    #[serde(deserialize_with = "trimmed")]
    #[garde(length(utf16, min = 1))]
    pub reason: String,
    #[serde(
        default,
        deserialize_with = "optional_trimmed",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(skip)]
    pub handoff: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(inner(length(utf16, min = 1)))]
    pub worker_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCoordinatorReplacementBody {
    #[garde(length(utf16, min = 1))]
    pub session_id: String,
    #[garde(length(utf16, min = 1))]
    pub root_profile_id: String,
    #[serde(
        default,
        deserialize_with = "optional_trimmed",
        skip_serializing_if = "Option::is_none"
    )]
    #[garde(skip)]
    pub handoff: Option<String>,
    #[garde(skip)]
    pub resume: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[garde(inner(length(utf16, min = 1)))]
    pub question_id: Option<String>,
}

pub(crate) fn optional_trimmed<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    trimmed(deserializer).map(Some)
}

pub(crate) fn trimmed<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Ok(value
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_owned())
}

fn optional_nonnull<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskLimitDecision {
    AddAllowance,
    ChangeLimits { limits: TaskLimits },
    CancelTask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskLimits {
    #[serde(serialize_with = "serialize_js_number")]
    pub budget_usd: f64,
    #[serde(deserialize_with = "nonnegative_integer")]
    pub max_turns: u64,
}

fn serialize_js_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER as f64 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

fn nonnegative_integer<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    value
        .as_number()
        .and_then(|number| number.as_f64())
        .filter(|number| number.is_finite() && *number >= 0.0 && number.fract() == 0.0)
        .filter(|number| *number <= u64::MAX as f64)
        .map(|number| number as u64)
        .ok_or_else(|| serde::de::Error::custom("expected nonnegative integer"))
}
