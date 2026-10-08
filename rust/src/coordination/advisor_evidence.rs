//! TypeScript `coordination/advisor-evidence.ts`: pins the Worker evidence,
//! task configuration, and task images an Advisor reviews.

use crate::shared::hash::sha256_hex;
use std::path::Path;

use serde_json::{Value, json};

use crate::integrations::github_delivery::Observation;
use crate::platform::{artifacts, database::SuplexDatabase};
use crate::tasks::control::{SessionRow, TurnRow, TurnStatus};

use super::{
    root_session_store::{self, RootObservationRows},
    workflow_evidence::{self, EvidenceAttachment, WrittenEvidence},
    workflows::{ReviewRange, turn_outcome, turn_workflow_input},
};

/// TypeScript `parseObservation` fields that describe one Worker turn.
fn parsed_observation(turn: &TurnRow) -> Value {
    let raw = turn.terminal_observation.as_deref();
    let outcome = turn_outcome(raw);
    let parsed = raw
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);
    json!({
        "state": outcome.state, "text": outcome.text,
        "tools": parsed.get("tools").filter(|tools| tools.is_array()).cloned().unwrap_or(Value::Null),
        "toolsLimit": parsed.get("toolsLimit").cloned().unwrap_or(Value::Null),
        "verificationRange": parsed.get("verificationRange").cloned().unwrap_or(Value::Null),
    })
}

/// Completed plain Worker turns in task order, as `(turn, parsed observation)`.
pub fn completed_worker_turns(rows: &RootObservationRows) -> Vec<(&TurnRow, Value)> {
    rows.turns
        .iter()
        .filter(|turn| {
            turn.status == TurnStatus::Completed
                && rows
                    .session(&turn.session_id)
                    .is_some_and(SessionRow::is_plain_worker)
        })
        .map(|turn| (turn, parsed_observation(turn)))
        .collect()
}

pub struct AdvisorEvidence {
    pub evidence: WrittenEvidence,
    pub worker_turn_ids: Vec<String>,
}

fn image(
    database: &SuplexDatabase,
    artifact_root: &Path,
    task_id: &str,
    artifact_id: &str,
) -> Result<EvidenceAttachment, Box<dyn std::error::Error + Send + Sync>> {
    let artifact = root_session_store::task_artifact(database, task_id, artifact_id)?
        .ok_or("Task image is not available")?;
    let bytes = artifacts::read(artifact_root, &artifact.company_id, &artifact.storage_path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            if sha256_hex(&bytes) == artifact.sha256 {
                Ok(bytes)
            } else {
                Err("The task image changed in storage".to_owned())
            }
        });
    Ok(EvidenceAttachment {
        artifact_id: artifact_id.to_owned(),
        mime_type: artifact.mime_type,
        bytes,
    })
}

/// TypeScript `prepareAdvisorEvidence`. `pullRequestChecks` is the pull
/// request check observation; it is null when none is available.
pub fn prepare_advisor_evidence(
    database: &SuplexDatabase,
    database_path: &Path,
    artifact_root: &Path,
    rows: &RootObservationRows,
    range: &ReviewRange,
    pull_request_checks: Option<&Observation>,
) -> Result<AdvisorEvidence, Box<dyn std::error::Error + Send + Sync>> {
    let task_id = rows.control.task_id.as_str();
    let worktree = rows
        .control
        .worktree_path()
        .ok_or("The task has no worktree")?;
    let configuration = &rows.context["configuration"];
    let workers = completed_worker_turns(rows);
    let worker_turns = workers
        .iter()
        .map(|(turn, parsed)| {
            let input = turn_workflow_input(&rows.sessions, turn).filter(|input| input["kind"] == "worker");
            let verification_range = &parsed["verificationRange"];
            json!({
                "turnId": turn.id, "sessionId": turn.session_id,
                "mode": input.map_or(json!("planned"), |input| input["mode"].clone()),
                "purpose": input.map_or(json!("implementation"), |input| input["purpose"].clone()),
                "range": input.map_or(Value::Null, |input| input["range"].clone()),
                "state": parsed["state"], "text": parsed["text"], "tools": parsed["tools"],
                "limit": if parsed["toolsLimit"].is_null() && parsed["tools"].is_null() { json!("Native tool evidence was not captured for this turn") } else { parsed["toolsLimit"].clone() },
                "verificationRange": verification_range,
                "sourceRangeProof": if verification_range.is_null() { "none" } else if verification_range["valid"] == true { "valid" } else { "invalid" },
            })
        })
        .collect::<Vec<_>>();
    let verification = json!({
        "configuration": {"verificationCommand": configuration["verificationCommand"], "runProjectTests": configuration["runProjectTests"], "visualEvidence": configuration["visualEvidence"]},
        "pullRequest": rows.control.pull_request, "pullRequestChecks": pull_request_checks, "workerTurns": worker_turns,
    });
    let attachments = rows.context["images"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|item| {
            image(
                database,
                artifact_root,
                task_id,
                item["artifactId"].as_str().unwrap_or_default(),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let evidence = workflow_evidence::write_task_evidence(
        &workflow_evidence::task_evidence_root(database_path),
        task_id,
        Path::new(worktree),
        range,
        attachments,
        &verification,
    )?;
    Ok(AdvisorEvidence {
        evidence,
        worker_turn_ids: workers.iter().map(|(turn, _)| turn.id.clone()).collect(),
    })
}

include!("../../tests/coordination/advisor_evidence.rs");
