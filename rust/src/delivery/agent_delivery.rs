//! TypeScript `delivery/agent-delivery.ts`: the Suplex-owned delivery repair
//! and merge-train commands for a paired agent. Every command observes GitHub
//! before it decides and records an audit event. The agent API routes (W8)
//! resolve the principal and call these functions.

use crate::shared::hash::sha256_hex;
use crate::shared::time::{now_millis_rfc3339, rfc3339_millis};
use crate::tasks::TaskError;
use crate::tasks::control::{TaskControlRow, TaskStatus};
use std::path::Path;

use chrono::{Duration, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::{inspection::ReviewRange, operations::DeliveryOperations};
use crate::{
    coordination::root_bridge::RootIdentity,
    integrations::github_delivery::Observation,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
};

const APPROVAL_TTL_MINUTES: i64 = 15;

pub const HEAD_NOT_ACCEPTED: &str = "Suplex has not accepted this pull request head. The Coordinator must review and publish it first.";

/// The authenticated external agent.
pub struct AgentPrincipal {
    pub agent_id: String,
    pub company_id: String,
}

/// TypeScript `mergeBlocker`: the single reason this pull request cannot merge now.
pub fn merge_blocker(
    observation: Option<&Observation>,
    blocking_dependency: Option<&str>,
    accepted_head_sha: Option<&str>,
) -> Option<String> {
    if let Some(dependency) = blocking_dependency {
        return Some(format!("Task {dependency} is not delivered."));
    }
    let Some(observed) =
        observation.filter(|observed| observed.exists && observed.number.is_some())
    else {
        return Some("The task has no pull request.".into());
    };
    let reason = match observed.state.as_deref() {
        Some("merged") => "GitHub merged the pull request.",
        Some("open") if observed.is_draft == Some(true) => "The pull request is a draft.",
        Some("open")
            if accepted_head_sha.is_none() || accepted_head_sha != observed.head_sha.as_deref() =>
        {
            HEAD_NOT_ACCEPTED
        }
        Some("open") if observed.checks.failing > 0 => "A necessary check failed.",
        Some("open") if observed.checks.pending > 0 => "GitHub still runs the checks.",
        Some("open")
            if observed.mergeable.as_deref() == Some("CONFLICTING")
                || observed.merge_state_status.as_deref() == Some("DIRTY") =>
        {
            "The pull request conflicts with the base branch."
        }
        Some("open") if observed.merge_state_status.as_deref() == Some("BEHIND") => {
            "The pull request is behind the base branch."
        }
        Some("open") if observed.review_decision.as_deref() != Some("APPROVED") => {
            "GitHub does not report an approved review."
        }
        Some("open") => return None,
        _ => "The pull request is not open.",
    };
    Some(reason.into())
}

/// TypeScript `needsReconciliation`.
pub fn needs_reconciliation(observed: Option<&Observation>) -> bool {
    let Some(observed) =
        observed.filter(|observed| observed.exists && observed.state.as_deref() == Some("open"))
    else {
        return false;
    };
    observed.checks.failing > 0
        || observed.mergeable.as_deref() == Some("CONFLICTING")
        || matches!(
            observed.merge_state_status.as_deref(),
            Some("DIRTY" | "BEHIND" | "BLOCKED")
        )
}

fn receipt_hash(receipt: &str) -> String {
    sha256_hex(receipt.as_bytes())
}

fn reconciliation_prompt(base_branch: &str, observed: &Observation) -> String {
    [
        "Suplex received a delivery repair request for this task.".to_owned(),
        format!(
            "GitHub reports pull request #{} at head {} with mergeable {}, merge state {}, and {} failing checks.",
            observed.number.map_or("null".into(), |n| n.to_string()),
            observed.head_sha.as_deref().unwrap_or("unknown"),
            observed.mergeable.as_deref().unwrap_or("unknown"),
            observed.merge_state_status.as_deref().unwrap_or("unknown"),
            observed.checks.failing
        ),
        format!("Observe GitHub and Git yourself. Integrate the current {base_branch} head, resolve every conflict, and repair every failing check."),
        format!("The upstream work is already merged into {base_branch}. Integrate it. Do not rewrite it and do not reimplement it."),
        "Preserve the reviewed intent of both sides. Review the new range and continue the delivery workflow.".to_owned(),
    ]
    .join("\n")
}

fn resume_prompt(base_branch: &str) -> String {
    [
        "Every dependency of this task is delivered.".to_owned(),
        format!("Suplex merged their work into {base_branch}. Integrate that work. Do not rewrite it and do not reimplement it."),
        "Observe the current task, worktree, and GitHub state, then continue toward the delivery target.".to_owned(),
    ]
    .join("\n")
}

/// TypeScript `topologicalTaskOrder`: dependencies first, input order otherwise.
pub fn topological_order(entries: Vec<(String, Vec<String>)>) -> Vec<(String, Vec<String>)> {
    let mut remaining = entries;
    let mut emitted = std::collections::HashSet::new();
    let mut ordered = Vec::new();
    while !remaining.is_empty() {
        let ids = remaining
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<std::collections::HashSet<_>>();
        let ready = remaining
            .iter()
            .filter(|(_, depends)| {
                depends
                    .iter()
                    .all(|id| !ids.contains(id) || emitted.contains(id))
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let batch = if ready.is_empty() {
            ids.into_iter().collect()
        } else {
            ready
        };
        let (now, later): (Vec<_>, Vec<_>) = remaining
            .into_iter()
            .partition(|(id, _)| batch.contains(id));
        for entry in now {
            emitted.insert(entry.0.clone());
            ordered.push(entry);
        }
        remaining = later;
    }
    ordered
}

/// One `suplex_delivery_provenance` observation of a pull request.
struct Provenance<'a> {
    kind: &'a str,
    number: Option<u64>,
    original: Option<&'a str>,
    head: Option<&'a str>,
    base: Option<&'a str>,
    checks: Option<Value>,
    merge: Option<&'a Value>,
}

pub struct AgentDelivery {
    operations: DeliveryOperations,
}

impl AgentDelivery {
    pub fn new(database_path: &Path, artifact_root: &Path) -> Self {
        Self {
            operations: DeliveryOperations::new(database_path, artifact_root),
        }
    }

    fn open(&self, mode: OpenMode) -> DatabaseResult<SuplexDatabase> {
        SuplexDatabase::open(self.operations.database_path(), mode)
    }

    /// Creator-only task access for delivery management; another agent's task is not found.
    fn task(&self, principal: &AgentPrincipal, task_id: &str) -> DatabaseResult<(String, String)> {
        let row: Option<(String, String)> = self.open(OpenMode::ReadOnly)?.connection().query_row(
            "SELECT company_id, project_id FROM suplex_tasks WHERE id = ?1 AND company_id = ?2 AND creator_agent_id = ?3",
            params![task_id, principal.company_id, principal.agent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        Ok(row.ok_or_else(TaskError::not_found)?)
    }

    fn control(&self, task_id: &str) -> DatabaseResult<TaskControlRow> {
        Ok(
            crate::coordination::root_session_store::root_observation_rows(
                &self.open(OpenMode::ReadOnly)?,
                task_id,
            )?
            .control,
        )
    }

    fn blocking_dependencies(&self, task_id: &str) -> DatabaseResult<Vec<String>> {
        let database = self.open(OpenMode::ReadOnly)?;
        let mut statement = database.connection().prepare(
            "SELECT d.depends_on_task_id FROM suplex_task_dependencies d LEFT JOIN suplex_task_controls c ON c.task_id = d.depends_on_task_id WHERE d.task_id = ?1 AND COALESCE(c.status, 'backlog') <> 'delivered' ORDER BY d.depends_on_task_id",
        )?;
        let rows = statement
            .query_map([task_id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    fn accepted(&self, task_id: &str) -> DatabaseResult<Option<ReviewRange>> {
        Ok(self.control(task_id)?.workflow_state.accepted_delivery)
    }

    fn audit(
        &self,
        principal: &AgentPrincipal,
        company_id: &str,
        task_id: Option<&str>,
        action: &str,
        mut metadata: Value,
    ) -> DatabaseResult<()> {
        if let Some(task_id) = task_id {
            let mut ordered = serde_json::Map::new();
            ordered.insert("taskId".into(), json!(task_id));
            ordered.extend(metadata.as_object().cloned().unwrap_or_default());
            metadata = Value::Object(ordered);
        }
        crate::identity::audit::record(
            &self.open(OpenMode::ReadWrite)?,
            &crate::identity::audit::AuditEvent {
                id: &format!("audit_{}", uuid::Uuid::new_v4().simple()),
                actor_user_id: None,
                actor_agent_id: Some(&principal.agent_id),
                action,
                target_user_id: None,
                company_id: Some(company_id),
                metadata_json: &crate::shared::js_json::stringify(&metadata),
                created_at: &now_millis_rfc3339(),
            },
        )?;
        Ok(())
    }

    fn open_attempt(&self, task_id: &str) -> DatabaseResult<Option<(String, Option<String>)>> {
        Ok(self.open(OpenMode::ReadOnly)?.connection().query_row(
            "SELECT id, original_head_sha FROM suplex_delivery_provenance WHERE task_id = ?1 AND kind = 'reconciliation' ORDER BY recorded_at DESC, id DESC LIMIT 1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?)
    }

    fn insert_provenance(
        &self,
        id: Option<&str>,
        task_id: &str,
        attempt_id: Option<&str>,
        agent_id: &str,
        row: Provenance<'_>,
    ) -> DatabaseResult<()> {
        let Provenance {
            kind,
            number,
            original,
            head,
            base,
            checks,
            merge,
        } = row;
        let id = id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("dpv_{}", uuid::Uuid::new_v4().simple()));
        self.open(OpenMode::ReadWrite)?.connection().execute(
            "INSERT INTO suplex_delivery_provenance (id, task_id, attempt_id, agent_id, kind, pull_request_number, original_head_sha, head_sha, base_sha, checks_json, merge_json, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![id, task_id, attempt_id, agent_id, kind, number.map(|n| n as i64), original, head, base,
                checks.map(|checks| crate::shared::js_json::stringify(&checks)), merge.map(crate::shared::js_json::stringify), now_millis_rfc3339()],
        )?;
        Ok(())
    }

    fn wake_root(&self, task_id: &str, prompt: &str) -> DatabaseResult<()> {
        let mut database = self.open(OpenMode::ReadWrite)?;
        let turn_id = crate::coordination::root_session_store::new_turn_id(Utc::now())?;
        database.transaction(true, |database| {
            let root: Option<(String, i64)> = database.connection().query_row(
                "SELECT id, generation FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
                [task_id], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            let (root_id, generation) = root.ok_or_else(|| TaskError::new("Coordinator is not ready. Retry the request.", 409))?;
            let time = now_millis_rfc3339();
            crate::coordination::root_session_store::insert_pending_turn(database, &crate::coordination::root_session_store::NewTurn { id: &turn_id, task_id, session_id: &root_id, generation, assignment_hash: None, prompt, workflow_input: None }, &time)?;
            Ok(())
        })
    }

    /// Re-observe the pull request and its checks; append to an open repair attempt.
    pub async fn refresh(
        &self,
        principal: &AgentPrincipal,
        task_id: &str,
    ) -> DatabaseResult<Value> {
        let (company, _) = self.task(principal, task_id)?;
        let pull_request = self.operations.observe(task_id).await?;
        let observation = self.operations.checks_observation(task_id).await?;
        if let (Some((attempt, original)), Some(observed)) =
            (self.open_attempt(task_id)?, &observation)
        {
            self.insert_provenance(
                None,
                task_id,
                Some(&attempt),
                &principal.agent_id,
                Provenance {
                    kind: "observation",
                    number: observed.number,
                    original: original.as_deref(),
                    head: observed.head_sha.as_deref(),
                    base: observed.base_sha.as_deref(),
                    checks: Some(serde_json::to_value(&observed.checks)?),
                    merge: None,
                },
            )?;
        }
        let observed = observation.as_ref();
        self.audit(principal, &company, Some(task_id), "agent_api_delivery_observed", json!({
            "pullRequestNumber": observed.and_then(|o| o.number).map(|n| n.to_string()).unwrap_or_default(),
            "headSha": observed.and_then(|o| o.head_sha.clone()).unwrap_or_default(),
            "baseSha": observed.and_then(|o| o.base_sha.clone()).unwrap_or_default(),
        }))?;
        Ok(
            json!({"taskId": task_id, "pullRequest": pull_request, "observation": observation.map(|o| o.to_value())}),
        )
    }

    /// Wake the Coordinator with a repair instruction and open a provenance attempt.
    pub async fn request_reconciliation(
        &self,
        principal: &AgentPrincipal,
        task_id: &str,
    ) -> DatabaseResult<Value> {
        let (company, _) = self.task(principal, task_id)?;
        let control = self.control(task_id)?;
        if control.status != TaskStatus::Active {
            return Err(
                TaskError::new("Start the task before you request delivery repair.", 409).into(),
            );
        }
        if let Some(blocking) = self.blocking_dependencies(task_id)?.first() {
            return Err(TaskError::new(
                format!(
                    "Task {blocking} is not delivered. Wait for its delivery instead of a delivery repair."
                ),
                409,
            ).into());
        }
        let observation = self.operations.checks_observation(task_id).await?;
        let Some(observed) = observation.filter(|o| o.exists && o.number.is_some()) else {
            return Err(TaskError::new("The task has no pull request.", 409).into());
        };
        if !needs_reconciliation(Some(&observed)) {
            return Err(TaskError::new(
                "GitHub reports no delivery problem for this pull request.",
                409,
            )
            .into());
        }
        let attempt = format!("dpr_{}", uuid::Uuid::new_v4().simple());
        self.wake_root(
            task_id,
            &reconciliation_prompt(&control.delivery_intent.base_branch, &observed),
        )?;
        self.insert_provenance(
            Some(&attempt),
            task_id,
            Some(&attempt),
            &principal.agent_id,
            Provenance {
                kind: "reconciliation",
                number: observed.number,
                original: observed.head_sha.as_deref(),
                head: observed.head_sha.as_deref(),
                base: observed.base_sha.as_deref(),
                checks: Some(serde_json::to_value(&observed.checks)?),
                merge: None,
            },
        )?;
        self.audit(principal, &company, Some(task_id), "agent_api_delivery_repair_requested", json!({
            "attemptId": attempt, "pullRequestNumber": observed.number.unwrap_or(0).to_string(),
            "headSha": observed.head_sha.clone().unwrap_or_default(), "baseSha": observed.base_sha.clone().unwrap_or_default(),
        }))?;
        Ok(json!({"taskId": task_id, "attemptId": attempt, "observation": observed.to_value()}))
    }

    /// Accept a wait only while a dependency blocks, and a resume only when none does.
    pub fn decide(
        &self,
        principal: &AgentPrincipal,
        task_id: &str,
        decision: &str,
    ) -> DatabaseResult<Value> {
        let (company, _) = self.task(principal, task_id)?;
        let blocking = self.blocking_dependencies(task_id)?;
        if decision == "wait_for_dependency" && blocking.is_empty() {
            return Err(TaskError::new(
                "Every dependency of this task is delivered. Resume the task.",
                409,
            )
            .into());
        }
        if decision == "resume" {
            if let Some(first) = blocking.first() {
                return Err(TaskError::new(
                    format!("Task {first} is not delivered. Wait for its delivery."),
                    409,
                )
                .into());
            }
            let control = self.control(task_id)?;
            if control.status != TaskStatus::Active {
                return Err(TaskError::new("Start the task before you resume it.", 409).into());
            }
            self.wake_root(
                task_id,
                &resume_prompt(&control.delivery_intent.base_branch),
            )?;
        }
        self.audit(
            principal,
            &company,
            Some(task_id),
            if decision == "resume" {
                "agent_api_delivery_resumed"
            } else {
                "agent_api_delivery_wait_accepted"
            },
            json!({"blockingTaskId": blocking.first().cloned().unwrap_or_default()}),
        )?;
        Ok(json!({"taskId": task_id, "decision": decision, "blockingTaskIds": blocking}))
    }

    /// The agent's pull requests in dependency-first order with live GitHub facts.
    pub async fn merge_train(
        &self,
        principal: &AgentPrincipal,
        project_id: Option<&str>,
    ) -> DatabaseResult<Value> {
        let rows = {
            let database = self.open(OpenMode::ReadOnly)?;
            let mut statement = database.connection().prepare(
                "SELECT t.id, t.title, t.project_id FROM suplex_tasks t WHERE t.company_id = ?1 AND t.creator_agent_id = ?2 AND t.archived_at IS NULL ORDER BY t.created_at, t.id",
            )?;
            let rows = statement
                .query_map(params![principal.company_id, principal.agent_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut entries = Vec::new();
            for (id, title, _) in rows
                .into_iter()
                .filter(|row| project_id.is_none_or(|wanted| wanted == row.2))
            {
                let mut edges = database.connection().prepare("SELECT depends_on_task_id FROM suplex_task_dependencies WHERE task_id = ?1 ORDER BY depends_on_task_id")?;
                let depends = edges
                    .query_map([&id], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
                entries.push((id, title, depends));
            }
            entries
        };
        let titles = rows
            .iter()
            .map(|(id, title, _)| (id.clone(), title.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let ordered = topological_order(
            rows.into_iter()
                .map(|(id, _, depends)| (id, depends))
                .collect(),
        );
        let mut entries = Vec::new();
        for (id, depends) in ordered {
            let observation = self.operations.checks_observation(&id).await?;
            let blocking = self.blocking_dependencies(&id)?;
            let accepted = self.accepted(&id)?;
            let observed = observation.as_ref();
            entries.push(json!({
                "taskId": id, "title": titles[&id], "status": self.control(&id)?.status, "dependsOn": depends,
                "pullRequestNumber": observed.and_then(|o| o.number), "headSha": observed.and_then(|o| o.head_sha.clone()),
                "baseSha": observed.and_then(|o| o.base_sha.clone()), "isDraft": observed.and_then(|o| o.is_draft),
                "reviewDecision": observed.and_then(|o| o.review_decision.clone()),
                "checks": {"total": observed.map_or(0, |o| o.checks.total), "pending": observed.map_or(0, |o| o.checks.pending), "failing": observed.map_or(0, |o| o.checks.failing), "successful": observed.map_or(0, |o| o.checks.successful)},
                "blocker": merge_blocker(observed, blocking.first().map(String::as_str), accepted.as_ref().map(|a| a.head_sha.as_str())),
            }));
        }
        self.audit(
            principal,
            &principal.company_id,
            None,
            "agent_api_merge_train_observed",
            json!({"projectId": project_id.unwrap_or(""), "entries": entries.len().to_string()}),
        )?;
        Ok(json!({"entries": entries}))
    }

    async fn require_eligible(
        &self,
        task_id: &str,
        number: u64,
        head_sha: &str,
    ) -> DatabaseResult<Observation> {
        let observation = self
            .operations
            .checks_observation(task_id)
            .await?
            .ok_or_else(|| {
                TaskError::new(
                    "GitHub did not return the pull request. Retry the request.",
                    409,
                )
            })?;
        if observation.number != Some(number) {
            return Err(
                TaskError::new("The pull request number does not match this task.", 422).into(),
            );
        }
        let blocking = self.blocking_dependencies(task_id)?;
        let accepted = self.accepted(task_id)?;
        if let Some(blocker) = merge_blocker(
            Some(&observation),
            blocking.first().map(String::as_str),
            accepted.as_ref().map(|a| a.head_sha.as_str()),
        ) {
            return Err(TaskError::new(blocker, 409).into());
        }
        // A moved base is not an authorization failure: `execute` checks the
        // review against the current base.
        if observation.head_sha.as_deref() != Some(head_sha) {
            return Err(TaskError::new(
                "GitHub reports a different head. Refresh the observation before you merge.",
                409,
            )
            .into());
        }
        Ok(observation)
    }

    /// Issue a single-use receipt bound to the observed pull request and head.
    pub async fn issue_approval(
        &self,
        principal: &AgentPrincipal,
        task_id: &str,
        number: u64,
        head_sha: &str,
    ) -> DatabaseResult<Value> {
        let (company, _) = self.task(principal, task_id)?;
        let observed = self.require_eligible(task_id, number, head_sha).await?;
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)?;
        let receipt = format!(
            "fma_{}",
            base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
        );
        let created = Utc::now();
        let expires = rfc3339_millis(created + Duration::minutes(APPROVAL_TTL_MINUTES));
        let mut database = self.open(OpenMode::ReadWrite)?;
        database.transaction(false, |database| {
            database.connection().execute(
                "INSERT INTO suplex_merge_approvals (id, task_id, agent_id, pull_request_number, head_sha, base_sha, receipt_hash, created_at, expires_at, consumed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
                params![format!("mar_{}", uuid::Uuid::new_v4().simple()), task_id, principal.agent_id, number as i64, observed.head_sha, observed.base_sha, receipt_hash(&receipt), rfc3339_millis(created), expires],
            )?;
            Ok(())
        })?;
        self.audit(principal, &company, Some(task_id), "agent_api_merge_approval_issued", json!({"pullRequestNumber": number.to_string(), "headSha": observed.head_sha.clone().unwrap_or_default(), "baseSha": observed.base_sha.clone().unwrap_or_default()}))?;
        Ok(
            json!({"taskId": task_id, "receipt": receipt, "expiresAt": expires, "pullRequestNumber": number, "headSha": observed.head_sha, "baseSha": observed.base_sha}),
        )
    }

    /// Merge one pull request of the train after consuming its receipt exactly once.
    pub async fn merge(
        &self,
        principal: &AgentPrincipal,
        task_id: &str,
        number: u64,
        expected_head_sha: &str,
        expected_base_sha: &str,
        approval_receipt: &str,
    ) -> DatabaseResult<Value> {
        let (company, _) = self.task(principal, task_id)?;
        let valid_receipt = approval_receipt.strip_prefix("fma_").is_some_and(|rest| {
            rest.len() == 43
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
        if !valid_receipt {
            return Err(TaskError::new("The approval receipt is not valid.", 403).into());
        }
        if self.control(task_id)?.status != TaskStatus::Active {
            return Err(TaskError::new("The task is not active.", 409).into());
        }
        let observation = self
            .require_eligible(task_id, number, expected_head_sha)
            .await?;
        let time = now_millis_rfc3339();
        let consumed = self.open(OpenMode::ReadWrite)?.connection().execute(
            "UPDATE suplex_merge_approvals SET consumed_at = ?1 WHERE receipt_hash = ?2 AND task_id = ?3 AND agent_id = ?4 AND pull_request_number = ?5 AND head_sha = ?6 AND consumed_at IS NULL AND expires_at > ?1",
            params![time, receipt_hash(approval_receipt), task_id, principal.agent_id, number as i64, expected_head_sha],
        )?;
        if consumed != 1 {
            return Err(TaskError::new("The approval receipt is not valid.", 403).into());
        }
        let control = self.control(task_id)?;
        let root_id = control.root_session_id;
        let root = self.open(OpenMode::ReadOnly)?.connection().query_row(
            "SELECT id, generation FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
            [task_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).optional()?.filter(|(id, _)| root_id.as_deref().is_none_or(|root| root == id));
        let (session_id, generation) = root
            .ok_or_else(|| TaskError::new("Coordinator is not ready. Retry the request.", 409))?;
        // The accepted range is the Coordinator's own review. Suplex never rebuilds it for the agent.
        let accepted = self
            .accepted(task_id)?
            .filter(|accepted| Some(accepted.head_sha.as_str()) == observation.head_sha.as_deref())
            .ok_or_else(|| TaskError::new(HEAD_NOT_ACCEPTED, 409))?;
        let identity = RootIdentity {
            task_id: task_id.to_owned(),
            session_id,
            generation,
        };
        let result = self
            .operations
            .execute(
                &identity,
                None,
                &crate::delivery::operations::DeliveryRequest {
                    operation: crate::delivery::DeliveryOperation::MergePullRequest,
                    expected_head: Some(&accepted.head_sha),
                    review: Some(&accepted),
                    pull_request_title: None,
                    pull_request_body: None,
                },
            )
            .await?;
        let merged = self.operations.checks_observation(task_id).await?;
        let attempt = self.open_attempt(task_id)?.map(|(id, _)| id);
        self.insert_provenance(
            None,
            task_id,
            attempt.as_deref(),
            &principal.agent_id,
            Provenance {
                kind: "merge",
                number: Some(number),
                original: Some(expected_head_sha),
                head: Some(
                    merged
                        .as_ref()
                        .and_then(|m| m.head_sha.as_deref())
                        .unwrap_or(expected_head_sha),
                ),
                base: Some(
                    merged
                        .as_ref()
                        .and_then(|m| m.base_sha.as_deref())
                        .unwrap_or(expected_base_sha),
                ),
                checks: merged
                    .as_ref()
                    .map(|m| serde_json::to_value(&m.checks))
                    .transpose()?,
                merge: Some(&result),
            },
        )?;
        self.audit(principal, &company, Some(task_id), "agent_api_pull_request_merged", json!({"pullRequestNumber": number.to_string(), "headSha": expected_head_sha, "baseSha": expected_base_sha}))?;
        Ok(json!({"taskId": task_id, "pullRequestNumber": number, "result": result}))
    }

    /// The append-only provenance trail of one task.
    pub fn provenance(
        &self,
        principal: &AgentPrincipal,
        task_id: &str,
    ) -> DatabaseResult<Vec<Value>> {
        self.task(principal, task_id)?;
        let database = self.open(OpenMode::ReadOnly)?;
        let mut statement = database.connection().prepare(
            "SELECT json_object('id',id,'task_id',task_id,'attempt_id',attempt_id,'agent_id',agent_id,'kind',kind,'pull_request_number',pull_request_number,'original_head_sha',original_head_sha,'head_sha',head_sha,'base_sha',base_sha,'checks_json',checks_json,'merge_json',merge_json,'recorded_at',recorded_at) FROM suplex_delivery_provenance WHERE task_id = ?1 ORDER BY recorded_at, id",
        )?;
        let rows = statement
            .query_map([task_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|row| serde_json::from_str(row).map_err(Into::into))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_pull() -> Observation {
        Observation {
            exists: true,
            number: Some(7),
            state: Some("open".into()),
            is_draft: Some(false),
            head_sha: Some("a".repeat(40)),
            review_decision: Some("APPROVED".into()),
            ..Observation::default()
        }
    }

    #[test]
    fn merge_blocker_reports_reasons_in_source_order() {
        let head = "a".repeat(40);
        assert_eq!(
            merge_blocker(None, Some("t0"), None).unwrap(),
            "Task t0 is not delivered."
        );
        assert_eq!(
            merge_blocker(None, None, None).unwrap(),
            "The task has no pull request."
        );
        let mut observed = open_pull();
        assert_eq!(
            merge_blocker(Some(&observed), None, None).unwrap(),
            HEAD_NOT_ACCEPTED
        );
        assert_eq!(merge_blocker(Some(&observed), None, Some(&head)), None);
        observed.is_draft = Some(true);
        assert_eq!(
            merge_blocker(Some(&observed), None, Some(&head)).unwrap(),
            "The pull request is a draft."
        );
        observed.is_draft = Some(false);
        observed.checks.failing = 1;
        assert_eq!(
            merge_blocker(Some(&observed), None, Some(&head)).unwrap(),
            "A necessary check failed."
        );
        assert!(needs_reconciliation(Some(&observed)));
        observed.checks.failing = 0;
        observed.merge_state_status = Some("BEHIND".into());
        assert_eq!(
            merge_blocker(Some(&observed), None, Some(&head)).unwrap(),
            "The pull request is behind the base branch."
        );
        observed.merge_state_status = None;
        observed.review_decision = None;
        assert_eq!(
            merge_blocker(Some(&observed), None, Some(&head)).unwrap(),
            "GitHub does not report an approved review."
        );
        assert!(!needs_reconciliation(Some(&observed)));
        observed.state = Some("merged".into());
        assert_eq!(
            merge_blocker(Some(&observed), None, Some(&head)).unwrap(),
            "GitHub merged the pull request."
        );
    }

    #[test]
    fn train_order_puts_dependencies_first() {
        let ordered = topological_order(vec![
            ("c".into(), vec!["b".into()]),
            ("b".into(), vec!["a".into()]),
            ("a".into(), vec![]),
            ("x".into(), vec!["outside".into()]),
        ]);
        assert_eq!(
            ordered
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            ["a", "x", "b", "c"]
        );
    }

    #[tokio::test]
    async fn a_merge_after_the_base_advanced_reaches_the_delivery_operation() {
        use crate::delivery::operations::tests::{loopback_github, workflow_task};
        let (directory, operations, task_id, head) = workflow_task("standard");
        let stale_base = "a".repeat(40);
        let range = ReviewRange {
            base_sha: stale_base.clone(),
            head_sha: head.clone(),
            files: vec!["a.txt".into()],
            commits: vec![head.clone()],
            patch_digest: None,
        };
        {
            let database =
                SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite).unwrap();
            database
                .connection()
                .execute_batch(
                    "INSERT INTO suplex_agents (id, kind, name, avatar_seed, created_at, updated_at) VALUES ('agent_1', 'external', 'Agent', 'seed', 'now', 'now');
                     INSERT INTO suplex_external_agents (id, company_id, status, paired_at, created_at, updated_at) VALUES ('agent_1', 'company_flow', 'paired', 'now', 'now', 'now');",
                )
                .unwrap();
            database
                .connection()
                .execute(
                    "UPDATE suplex_tasks SET creator_user_id = NULL, creator_agent_id = 'agent_1' WHERE id = ?1",
                    [&task_id],
                )
                .unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'active', delivery_intent_json = json_set(delivery_intent_json, '$.pullRequestNumber', 7), workflow_state_json = json_set(workflow_state_json, '$.acceptedDelivery', json(?1)) WHERE task_id = ?2",
                params![serde_json::to_string(&range).unwrap(), task_id],
            ).unwrap();
        }
        crate::coordination::root_controller::prepare_root(
            &mut SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        // GitHub reports the accepted head on a base that moved after the review.
        let github = loopback_github(vec![(
            "/graphql",
            json!({"data":{"repository":{"pullRequest":{
                "number":7,"url":"https://github.com/owner/repo/pull/7","state":"OPEN","isDraft":false,
                "headRefOid":head,"baseRefOid":"b".repeat(40),"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN",
                "autoMergeRequest":null,"reviewDecision":"APPROVED","author":null,"changedFiles":1,"additions":1,
                "deletions":0,"title":"Task","commits":{"nodes":[]}}}}}),
        )])
        .await;
        let delivery = AgentDelivery {
            operations: DeliveryOperations::with_github(
                operations.database_path(),
                &directory.join("artifacts"),
                github,
            ),
        };
        let principal = AgentPrincipal {
            agent_id: "agent_1".into(),
            company_id: "company_flow".into(),
        };
        let receipt = delivery
            .issue_approval(&principal, &task_id, 7, &head)
            .await
            .unwrap()["receipt"]
            .as_str()
            .unwrap()
            .to_owned();
        let error = delivery
            .merge(&principal, &task_id, 7, &head, &stale_base, &receipt)
            .await
            .unwrap_err();
        // Eligibility, the receipt, and the Coordinator checks fail with a
        // TaskError::Failure. This one passed them; the delivery operation decides.
        assert!(
            !matches!(error.downcast_ref(), Some(TaskError::Failure { .. })),
            "{error}"
        );
        let consumed: Option<String> = delivery
            .open(OpenMode::ReadOnly)
            .unwrap()
            .connection()
            .query_row(
                "SELECT consumed_at FROM suplex_merge_approvals WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(consumed.is_some());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
