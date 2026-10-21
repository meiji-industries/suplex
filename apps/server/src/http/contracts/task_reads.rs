//! Public task observations, independent of command authorization.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::{
    coordination::advisor_bridge::AdvisorRole,
    http::contracts::typed::projects::ProjectResponse,
    moves::MoveResponse,
    profiles::connection_cache::ProviderConnectionStatus,
    runtimes::opencode::session_reader::PlanItem,
    tasks::{
        control::{HarnessKind, SessionKind, SessionReplacement, TurnStatus},
        response::{TaskListItem, TaskQueue, TaskResponse},
        timeline::TimelineResponse,
    },
};

/// One frame of the company sync socket. A task or a move in a frame is its
/// current state; the client replaces its copy.
#[derive(Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SyncMessage<'a> {
    /// The full active task list, every move, every project, and the cost of
    /// every task. Each project is an element of `GET /api/companies/{id}/projects`.
    Snapshot {
        tasks: Vec<TaskListItem>,
        moves: Vec<MoveResponse>,
        /// Absent until the server read the costs once; a later frame carries them.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        costs: Option<Vec<TaskCost>>,
        projects: Vec<ProjectResponse>,
    },
    /// What changed. A heartbeat carries no change.
    Changes {
        /// Tasks that are new or different.
        tasks: Vec<TaskListItem>,
        /// Tasks that left the active list.
        removed_task_ids: Vec<String>,
        /// Every move, when one changed.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        moves: Option<Vec<MoveResponse>>,
        /// Every task cost, when one changed.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        costs: Option<Vec<TaskCost>>,
        /// Every project, when one changed.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        projects: Option<Vec<ProjectResponse>>,
    },
    /// The agents of each watched task that changed. The first frame after a
    /// `watch` carries every watched task the server could read.
    Agents { tasks: Vec<&'a TaskAgents> },
    /// The values of the open task that changed. The first frame after a
    /// `watch` carries every value the server could read. Each value is the
    /// body of its HTTP endpoint.
    OpenTask {
        task_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        task: Option<&'a TaskResponse>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        activity: Option<&'a TaskActivityResponse>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        execution: Option<&'a TaskExecutionResponse>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        timeline: Option<&'a TimelineResponse>,
    },
}

/// A frame the browser sends on the company sync socket.
#[derive(Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SyncRequest {
    /// The tasks this tab shows now. Each request replaces the previous one.
    Watch {
        /// Tasks whose agents the tab shows. The server uses at most 50 and ignores ids outside the company.
        agent_task_ids: Vec<String>,
        /// The task whose page is open, archived or not. The server ignores a task outside the company.
        open_task_id: Option<String>,
    },
}

crate::shared::wire_enum! {
    pub enum TaskAgentStatus {
        Queued = "queued",
        Working = "working",
        Retrying = "retrying",
        Idle = "idle",
        WaitingHuman = "waiting_human",
        Stopped = "stopped",
        Unknown = "unknown",
    }
}

/// One current agent of a task: saved session intent and its native status.
#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgent {
    pub id: String,
    pub role: SessionKind,
    pub advisor_role: Option<AdvisorRole>,
    pub label: String,
    pub pane_id: Option<String>,
    pub status: TaskAgentStatus,
    pub status_changed_at: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TaskAgentsResponse {
    pub setup: crate::tasks::preparation::TaskSetup,
    pub agents: Vec<TaskAgent>,
    pub health: TaskHealth,
}

#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgents {
    pub setup: crate::tasks::preparation::TaskSetup,
    pub task_id: String,
    pub agents: Vec<TaskAgent>,
    pub health: TaskHealth,
}

/// Display observations that tell a task that does not advance from a task
/// that works. They never gate a command. `tasks::health` defines each value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskHealth {
    /// The sign-in of each provider login that the task's profiles use.
    pub providers: Vec<TaskProviderConnection>,
    /// The retries and continuations of the current work; 0 when nothing was
    /// retried.
    pub retries: u32,
    /// The newest progress of an active task, to the minute (RFC 3339).
    /// `null` when the task is not active or has no progress yet.
    pub last_progress_at: Option<String>,
    /// The median time of the task's completed turns, in whole minutes as
    /// seconds. `null` with fewer than 2 completed turns.
    pub usual_turn_seconds: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderConnection {
    pub provider: HarnessKind,
    pub status: ProviderConnectionStatus,
    pub summary: String,
    pub observed_at: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TaskAgentsBatchResponse {
    pub tasks: Vec<TaskAgents>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TaskSetupLogResponse {
    pub setup: crate::tasks::preparation::TaskSetup,
    pub output: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskActivityResponse {
    pub setup: crate::tasks::preparation::TaskSetup,
    pub sessions: Vec<TaskActivitySession>,
    pub turns: Vec<TaskActivityTurn>,
    /// The commands that people and paired agents sent for this task, oldest first.
    pub actions: Vec<TaskActivityAction>,
    pub shell_pane_id: Option<String>,
    /// Why the host has not dispatched the next turn. A display observation only.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dispatch_notice: Option<crate::coordination::dispatch_notice::DispatchNotice>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivitySession {
    pub id: String,
    pub kind: SessionKind,
    pub advisor_role: Option<AdvisorRole>,
    pub label: String,
    pub profile_id: String,
    pub generation: i64,
    pub native_session_id: Option<String>,
    pub pane_id: Option<String>,
    pub current: bool,
    pub replacement: Option<SessionReplacement>,
    pub harness: HarnessKind,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityTurn {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub status: TurnStatus,
    pub prompted_at: Option<String>,
    pub completed_at: Option<String>,
    pub result: Option<String>,
    /// The Coordinator's delegation that started this Worker turn.
    pub assignment: Option<TaskWorkerAssignment>,
    /// The current name of the paired agent that sent this note. Absent on other turns.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note_agent_name: Option<String>,
}

crate::shared::wire_enum! {
    /// The audited task commands that the task activity shows. Each value is its audit action.
    pub enum TaskActivityActionKind {
        Started = "task_started",
        ForceStarted = "task_force_started",
        MovedToFront = "task_moved_to_front",
        Disarmed = "task_disarmed",
        Cancelled = "task_cancelled",
        Answered = "task_answered",
        DetailsUpdated = "task_details_updated",
        DependenciesUpdated = "task_dependencies_updated",
        Archived = "task_archived",
        Unarchived = "task_unarchived",
    }
}

/// One audited command for the task and who sent it.
#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityAction {
    pub id: String,
    pub action: TaskActivityActionKind,
    /// The display name of the person, or the name of the paired agent.
    pub actor_name: String,
    pub created_at: String,
    /// What held the queued task when it was started anyway. Absent on other
    /// actions and on records from before Suplex saved it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue: Option<TaskQueue>,
}

crate::shared::wire_enum! {
    pub enum WorkerAssignmentMode {
        Planned = "planned",
        Direct = "direct",
    }
}

crate::shared::wire_enum! {
    pub enum WorkerAssignmentPurpose {
        Implementation = "implementation",
        Verification = "verification",
    }
}

/// The saved Worker workflow input, read without its range and report references.
#[derive(Debug, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkerAssignment {
    pub mode: WorkerAssignmentMode,
    pub purpose: WorkerAssignmentPurpose,
    pub plan: Option<String>,
    pub acceptance_criteria: Vec<String>,
    pub instruction: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TaskExecutionResponse {
    pub sessions: Vec<TaskExecutionSession>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionSession {
    pub id: String,
    pub role: SessionKind,
    pub advisor_role: Option<AdvisorRole>,
    pub label: String,
    pub generation: i64,
    pub available: bool,
    pub limited: bool,
    pub tools: Vec<TaskExecutionTool>,
    pub reasoning: Vec<TaskExecutionReasoning>,
    pub plan: Option<Vec<PlanItem>>,
}

#[derive(Serialize, TS)]
pub struct TaskExecutionReasoning {
    pub id: String,
    pub text: String,
}

crate::shared::wire_enum! {
    pub enum TaskToolStatus {
        Pending = "pending",
        Running = "running",
        Completed = "completed",
        Error = "error",
    }
}

#[derive(Serialize, TS)]
pub struct TaskExecutionTool {
    pub id: String,
    pub name: String,
    pub status: TaskToolStatus,
    #[ts(type = "unknown")]
    pub input: Value,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TaskDiffResponse {
    pub available: bool,
    pub patch: String,
    pub truncated: bool,
}

crate::shared::wire_enum! {
    pub enum WorktreeApp {
        Finder = "finder",
        Cursor = "cursor",
        Vscode = "vscode",
        Devin = "devin",
        Xcode = "xcode",
        Ghostty = "ghostty",
        Iterm = "iterm",
        Terminal = "terminal",
        Antigravity = "antigravity",
        Conductor = "conductor",
    }
}

#[derive(Serialize, TS)]
pub struct WorktreeAppOption {
    pub id: WorktreeApp,
    pub label: String,
    /// A PNG data URL of the installed application icon.
    pub icon: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct WorktreeAppsResponse {
    pub apps: Vec<WorktreeAppOption>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TaskDiffSummaryResponse {
    pub available: bool,
    pub files: usize,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TaskCostsResponse {
    pub tasks: Vec<TaskCost>,
}

#[derive(Clone, PartialEq, Serialize, TS)]
pub struct TaskCost {
    pub id: String,
    pub cost: Option<f64>,
    pub unpriced: bool,
    pub subsidized: bool,
    pub partial: bool,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
}
