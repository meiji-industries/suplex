//! Public task observations, independent of command authorization.

use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::{
    coordination::advisor_bridge::AdvisorRole,
    runtimes::opencode::session_reader::PlanItem,
    tasks::control::{HarnessKind, SessionKind, SessionReplacement, TurnStatus},
};

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskActivityResponse {
    pub sessions: Vec<TaskActivitySession>,
    pub turns: Vec<TaskActivityTurn>,
    pub shell_pane_id: Option<String>,
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
    pub plan: Option<Vec<PlanItem>>,
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

#[derive(Serialize, TS)]
pub struct TaskCost {
    pub id: String,
    pub cost: Option<f64>,
    pub unpriced: bool,
    pub subsidized: bool,
    pub partial: bool,
}
