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
) -> Result<EvidenceAttachment, Box<dyn std::error::Error>> {
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
) -> Result<AdvisorEvidence, Box<dyn std::error::Error>> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth,
        integrations::github_delivery::Checks,
        platform::database::OpenMode,
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use chrono::Utc;
    use std::fs;

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
    fn advisor_sees_the_pull_request_checks_github_reports() {
        let directory =
            std::env::temp_dir().join(format!("suplex-advisor-checks-{}", uuid::Uuid::new_v4()));
        let worktree = directory.join("work");
        fs::create_dir_all(&worktree).unwrap();
        git(&worktree, &["init", "-q", "-b", "main"]);
        git(&worktree, &["config", "user.name", "Evidence"]);
        git(
            &worktree,
            &["config", "user.email", "evidence@example.invalid"],
        );
        fs::write(worktree.join("a.txt"), "before\n").unwrap();
        git(&worktree, &["add", "."]);
        git(&worktree, &["commit", "-q", "-m", "base"]);
        let base_sha = git(&worktree, &["rev-parse", "HEAD"]);
        fs::write(worktree.join("a.txt"), "after\n").unwrap();
        git(&worktree, &["commit", "-q", "-am", "change"]);
        let head_sha = git(&worktree, &["rev-parse", "HEAD"]);

        let database_path = directory.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_checks','Checks','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('project_checks','company_checks','Checks','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)", [&stamp]).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "company_checks".into(), project_id: "project_checks".into(),
            title: "Refine the pull request".into(), description: "Review it".into(),
            configuration: json!({"branch":"task-checks","baseBranch":"main","verificationCommand":"make test","runProjectTests":true,"visualEvidence":"off"}),
            idempotency_key: "checks-1".into(), request_hash: "checks-hash".into(),
            creator: TaskCreator::User(user.id), delivery_target: "merged".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-checks","baseBranch":"main","baselineSha":base_sha,"pullRequestNumber":7})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"profile_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        }, now).unwrap().task;
        database.connection().execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
            rusqlite::params![json!({"path":worktree,"branch":"task-checks","baseSha":base_sha,"headSha":head_sha,"dirty":false}).to_string(), task.id],
        ).unwrap();
        let rows = root_session_store::root_observation_rows(&database, &task.id).unwrap();
        let range = ReviewRange {
            base_sha,
            head_sha: head_sha.clone(),
            files: vec!["a.txt".into()],
            commits: vec![head_sha.clone()],
            patch_digest: None,
        };
        let checks = Observation {
            exists: true,
            number: Some(7),
            head_sha: Some(head_sha.clone()),
            checks: Checks {
                total: 2,
                successful: 2,
                ..Checks::default()
            },
            ..Observation::default()
        };
        let verification = |checks: Option<&Observation>| -> Value {
            let written = prepare_advisor_evidence(
                &database,
                &database_path,
                &directory.join("artifacts"),
                &rows,
                &range,
                checks,
            )
            .unwrap();
            serde_json::from_str(
                &fs::read_to_string(written.evidence.directory.join("verification.json")).unwrap(),
            )
            .unwrap()
        };

        let observed = verification(Some(&checks));
        assert_eq!(observed["pullRequestChecks"]["headSha"], head_sha);
        assert_eq!(observed["pullRequestChecks"]["checks"]["successful"], 2);
        assert_eq!(verification(None)["pullRequestChecks"], Value::Null);
        fs::remove_dir_all(directory).unwrap();
    }
}
