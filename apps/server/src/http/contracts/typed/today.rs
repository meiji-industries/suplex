use serde::Serialize;
use ts_rs::TS;

use crate::tasks::{
    control::{DeliveryTarget, TaskStatus},
    response::TaskHumanQuestion,
};

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodayCompany {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodayTask {
    pub task_id: String,
    pub title: String,
    pub company_id: String,
    pub company_name: String,
    pub project_id: String,
    pub project_name: String,
    pub issue_key: Option<String>,
    pub status: TaskStatus,
    pub delivery_target: DeliveryTarget,
    pub last_updated: String,
    pub shipped_at: Option<String>,
    pub human_question: Option<TaskHumanQuestion>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodaySpend {
    pub company_id: String,
    pub company_name: String,
    pub known_cost_usd: Option<f64>,
    pub measured_messages: usize,
    pub unpriced_messages: usize,
    pub partial: bool,
    pub subsidized: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct TodayResponse {
    pub generated_at: String,
    pub week_starts_at: String,
    pub week_ends_at: String,
    pub companies: Vec<TodayCompany>,
    pub needs_you: Vec<TodayTask>,
    pub in_progress: Vec<TodayTask>,
    pub shipped_this_week: Vec<TodayTask>,
    pub spend_by_company: Vec<TodaySpend>,
}
