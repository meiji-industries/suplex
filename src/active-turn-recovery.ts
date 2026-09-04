import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { DeveloperDeliveryReportSchema, turnResultSchema } from "./turn-result-schemas.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { detectGitHandoff } from "./git-handoff.js";
import { type HerdrClient, CliHerdrClient, snapshotHerdrRuntime } from "./herdr-client.js";
import { observeHerdrSessions, type HerdrSessionObservation } from "./herdr-recovery.js";
import { redact, type StructuredLogger } from "./logging.js";
import { classifyRecovery, type DurableTaskFacts, type LiveObservations } from "./recovery/convergence.js";
import { json } from "./task-utils.js";
import { HerdrSessionStore, type LaunchSettings, type RoleSessionTask } from "./herdr-session-store.js";

export interface ActiveTurnOutcome {
  taskId: string;
  turnId: string;
  role: "planner" | "builder" | "reviewer" | "integrator";
  action: "advance" | "resume" | "attention" | "no_change" | "error";
  idempotencyKey: string;
  evidence: string[];
}

type TurnStatus = NonNullable<DurableTaskFacts["turn"]>["status"];
type Turn = {
  turnId: string;
  taskId: string;
  companyId: string;
  roleSessionId: string;
  role: "planner" | "builder" | "reviewer" | "integrator";
  status: TurnStatus;
  resultRelativePath: string;
  executionId: string;
  executionRole: "planner" | "builder" | "reviewer" | "integrator";
  executionStatus: string | null;
  executionFinishedAt: string | null;
  promptSentAt: string | null;
  recoveryPromptSentAt: string | null;
  isLatestSessionTurn: number;
  ledger: "agent" | "developer";
  promptKind: string;
  revision: number;
  phase: string;
  workflowId: string;
  paneId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  lastReviewedCommit: string | null;
  executionSessionRef: string | null;
  deliveryArtifactId: string | null;
  evidenceArtifactId: string | null;
};

type ResultObservation = { path: string; bytes: Buffer | null; valid: boolean; promptable: boolean; evidence: string };


// Keep completed turns with a durable result in the scan so an unchanged second
// reconciliation reports the same idempotent outcome without writing again.
const activeStatuses = "'dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed'";
const activeExecutionStatuses = new Set(["starting", "running"]);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const safeText = (value: unknown) => String(redact(value)).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

async function resultAt(runtimeRoot: string, turn: Pick<Turn, "ledger" | "promptKind" | "resultRelativePath">): Promise<ResultObservation> {
  const path = resolve(runtimeRoot, turn.resultRelativePath);
  const relativePath = relative(runtimeRoot, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return { path, bytes: null, valid: false, promptable: false, evidence: "result:path outside runtime root" };
  const schema = turnResultSchema(turn.ledger, turn.promptKind);
  if (!schema) return { path, bytes: null, valid: false, promptable: false, evidence: `result:unknown schema ${turn.ledger}/${turn.promptKind}` };
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, bytes: null, valid: false, promptable: true, evidence: "result:missing" };
    throw error;
  }
  const malformed = Symbol("malformed-result");
  const parsed = json(bytes.toString("utf8"), malformed);
  if (parsed === malformed) return { path, bytes, valid: false, promptable: true, evidence: "result:malformed JSON" };
  const valid = schema.safeParse(parsed).success;
  return { path, bytes, valid, promptable: true, evidence: valid ? `result:valid ${turn.ledger}/${turn.promptKind}` : `result:invalid ${turn.ledger}/${turn.promptKind}` };
}

function sessionObservation(observation: HerdrSessionObservation | undefined, unavailable = false): LiveObservations["herdr"] {
  if (unavailable) return { session: "unavailable", stalledBeyondPolicy: false };
  if (observation?.classification === "unverifiable") return { session: "unverifiable", stalledBeyondPolicy: false };
  if (!observation || observation.classification === "missing" || observation.classification === "unbound") return { session: "missing", stalledBeyondPolicy: false };
  if (observation.identityFailure) return { session: "identity_conflict", stalledBeyondPolicy: false };
  const status = observation.lifecycleStatus ?? undefined;
  if (status === "blocked") return { session: "live_blocked", stalledBeyondPolicy: false };
  if (status === "idle") return { session: "live_idle", stalledBeyondPolicy: false };
  if (status === "done" || status === "cancelled") return { session: "terminal", stalledBeyondPolicy: false };
  return { session: "live_progress", stalledBeyondPolicy: false };
}

function candidates(database: ForgeDatabase, taskId?: string): Turn[] {
  return database.authQuery((db) => db.prepare(`SELECT turn.turn_id AS turnId, turn.task_id AS taskId, projection.company_id AS companyId, session.id AS roleSessionId, session.session_role AS role, turn.status, turn.result_relative_path AS resultRelativePath, turn.execution_id AS executionId, turn.execution_role AS executionRole, COALESCE(agent.status, developer.status) AS executionStatus, COALESCE(agent.finished_at, developer.finished_at) AS executionFinishedAt, turn.prompt_sent_at AS promptSentAt, turn.recovery_prompt_sent_at AS recoveryPromptSentAt, CASE WHEN turn.turn_id = (
      SELECT latest.turn_id FROM forge_herdr_turns latest
      WHERE latest.role_session_id = turn.role_session_id
      ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1
    ) THEN 1 ELSE 0 END AS isLatestSessionTurn, turn.ledger, turn.prompt_kind AS promptKind, projection.revision, projection.phase, projection.workflow_id AS workflowId, session.pane_id AS paneId, worktree.branch_name AS branchName, worktree.worktree_path AS worktreePath, review.subject_commit AS lastReviewedCommit, developer.session_ref AS executionSessionRef, developer.delivery_artifact_id AS deliveryArtifactId, developer.evidence_artifact_id AS evidenceArtifactId
    FROM forge_herdr_turns turn
    JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.is_current = 1
    JOIN forge_issue_projections projection ON projection.task_id = turn.task_id
    LEFT JOIN forge_issue_worktrees worktree ON worktree.task_id = turn.task_id
    LEFT JOIN forge_agent_executions agent ON agent.id = turn.execution_id AND turn.ledger = 'agent'
    LEFT JOIN forge_developer_executions developer ON developer.id = turn.execution_id AND turn.ledger = 'developer'
    LEFT JOIN forge_delivery_reviews review ON review.id = (SELECT id FROM forge_delivery_reviews WHERE workflow_id = projection.workflow_id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE turn.status IN (${activeStatuses})
      AND projection.phase NOT IN ('done', 'cancelled', 'failed')
      AND NOT EXISTS (SELECT 1 FROM forge_tasks task WHERE task.id = turn.task_id AND task.archived_at IS NOT NULL)${taskId ? " AND turn.task_id = ?" : ""}

    ORDER BY turn.task_id, turn.turn_id`).all(...(taskId ? [taskId] : [])) as Turn[]);
}

function supersedeLateResult(database: ForgeDatabase, turn: Turn, bytes: Buffer, timestamp: string): boolean {
  const summary = "The late Developer result was superseded before Forge could apply it.";
  return database.authTransaction((db) => {
    const completed = db.prepare(`UPDATE forge_herdr_turns
      SET result_sha256 = ?, status = 'completed', task_complete_seen_at = COALESCE(task_complete_seen_at, ?), finished_at = COALESCE(finished_at, ?), attention_excerpt = ?, updated_at = ?
      WHERE turn_id = ? AND task_id = ? AND status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed')`).run(sha256(bytes), timestamp, timestamp, summary, timestamp, turn.turnId, turn.taskId);
    if (completed.changes !== 1) return false;
    const metadata = JSON.stringify({ turnId: turn.turnId, executionId: turn.executionId, summary });
    const eventHash = sha256(metadata);
    db.prepare("INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, 'workflow', 'late_result_superseded', ?, ?, ?)")
      .run(`${turn.workflowId}:late-result-superseded:${turn.turnId}`, turn.taskId, turn.companyId, turn.workflowId, turn.revision, metadata, timestamp, eventHash);
    return true;
  });
}

async function recreateMissingRuntime(database: ForgeDatabase, config: ForgeConfig, herdr: HerdrClient, turn: Turn): Promise<boolean> {
  const launch = database.authQuery((db) => db.prepare(`SELECT task.project_id AS projectId, project.name AS projectSlug, task.issue_number AS issueNumber,
    worktree.worktree_path AS worktreePath, profile.provider, profile.model, profile.reasoning_level AS reasoningLevel, profile.service_priority AS servicePriority
    FROM forge_tasks task
    JOIN forge_projects project ON project.id = task.project_id
    JOIN forge_herdr_role_sessions session ON session.id = ? AND session.task_id = task.id AND session.session_role = ? AND session.is_current = 1
    JOIN forge_agents agent ON agent.id = json_extract(task.role_agents_json, '$.' || session.session_role)
    JOIN forge_profiles profile ON profile.id = agent.profile_id
    LEFT JOIN forge_issue_worktrees worktree ON worktree.task_id = task.id
    WHERE task.id = ?`).get(turn.roleSessionId, turn.role, turn.taskId) as {
      projectId: string; projectSlug: string; issueNumber: number | null; worktreePath: string | null;
      provider: LaunchSettings["provider"]; model: string; reasoningLevel: string; servicePriority: LaunchSettings["serviceTier"];
    } | undefined);
  if (!launch?.worktreePath) return false;
  const task: RoleSessionTask = { taskId: turn.taskId, projectId: launch.projectId, projectSlug: launch.projectSlug, ...(launch.issueNumber ? { issueKey: String(launch.issueNumber) } : {}), worktreePath: launch.worktreePath, runtimeRoot: config.runtimeRoot };
  const settings: LaunchSettings = { model: launch.model, reasoningLevel: launch.reasoningLevel, serviceTier: launch.servicePriority, ...(launch.provider ? { provider: launch.provider } : {}) };
  await new HerdrSessionStore(database, herdr).ensureRoleSession(task, turn.role, settings);
  return true;
}
function persistAttention(database: ForgeDatabase, turn: Turn, reason: string, timestamp: string): boolean {
  return database.authTransaction((db) => db.prepare(`UPDATE forge_herdr_turns AS current
    SET status = 'awaiting_human', attention_excerpt = ?, updated_at = ?
    WHERE current.turn_id = ? AND current.task_id = ? AND current.role_session_id = ?
      AND current.execution_id = ? AND current.execution_role = ? AND current.status IN ('created', 'dispatching', 'waiting', 'blocked', 'validating', 'correction_required')
      AND current.turn_id = (SELECT latest.turn_id FROM forge_herdr_turns latest WHERE latest.role_session_id = current.role_session_id ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1)
      AND EXISTS (SELECT 1 FROM forge_herdr_role_sessions session WHERE session.id = current.role_session_id AND session.task_id = current.task_id AND session.is_current = 1)
      AND EXISTS (SELECT 1 FROM forge_issue_projections projection WHERE projection.task_id = current.task_id AND projection.workflow_id = ? AND projection.revision = ? AND projection.phase NOT IN ('done', 'cancelled', 'failed'))
      AND ((current.ledger = 'agent' AND EXISTS (SELECT 1 FROM forge_agent_executions execution WHERE execution.id = current.execution_id AND execution.task_id = current.task_id AND execution.workflow_id = ? AND execution.role = current.execution_role AND execution.status IN ('starting', 'running')))
        OR (current.ledger = 'developer' AND EXISTS (SELECT 1 FROM forge_developer_executions execution WHERE execution.id = current.execution_id AND execution.task_id = current.task_id AND execution.workflow_id = ? AND execution.status IN ('starting', 'running'))))`)
    .run(safeText(reason), timestamp, turn.turnId, turn.taskId, turn.roleSessionId, turn.executionId, turn.executionRole, turn.workflowId, turn.revision, turn.workflowId, turn.workflowId).changes === 1);
}



function eligibleRuntimeRecreation(turn: Turn): boolean {
  return turn.promptSentAt !== null
    && turn.recoveryPromptSentAt === null
    && turn.isLatestSessionTurn === 1
    && turn.executionStatus !== null
    && activeExecutionStatuses.has(turn.executionStatus);
}

function completeTurn(database: ForgeDatabase, turn: Turn, bytes: Buffer, timestamp: string, handoff?: { headSha: string }): boolean {
  return database.authTransaction((db) => {
    const completed = db.prepare(`UPDATE forge_herdr_turns AS current
      SET result_sha256 = ?, task_complete_seen_at = ?, status = 'completed', attention_excerpt = NULL, finished_at = ?, updated_at = ?
      WHERE current.turn_id = ? AND current.task_id = ? AND current.role_session_id = ?
        AND current.ledger = ? AND current.execution_id = ? AND current.execution_role = ?
        AND current.prompt_kind = ? AND current.prompt_sent_at IS ? AND current.recovery_prompt_sent_at IS ?
        AND current.result_relative_path = ? AND current.status = ?
        AND current.turn_id = (
          SELECT latest.turn_id FROM forge_herdr_turns latest
          WHERE latest.role_session_id = current.role_session_id
          ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1
        )
        AND EXISTS (
          SELECT 1 FROM forge_herdr_role_sessions session
          WHERE session.id = current.role_session_id AND session.task_id = current.task_id
            AND session.session_role = ? AND session.is_current = 1 AND session.pane_id IS ?
        )
        AND EXISTS (
          SELECT 1 FROM forge_issue_projections projection
          WHERE projection.task_id = current.task_id AND projection.workflow_id = ?
            AND projection.revision = ? AND projection.phase NOT IN ('done', 'cancelled', 'failed')
        )
        AND ((current.ledger = 'agent' AND EXISTS (
          SELECT 1 FROM forge_agent_executions execution
          WHERE execution.id = current.execution_id AND execution.task_id = current.task_id
            AND execution.workflow_id = ? AND execution.role = current.execution_role
            AND execution.status = ? AND execution.status IN ('starting', 'running')
        )) OR (current.ledger = 'developer' AND EXISTS (
          SELECT 1 FROM forge_developer_executions execution
          WHERE execution.id = current.execution_id AND execution.task_id = current.task_id
            AND execution.workflow_id = ? AND execution.status = ?
            AND execution.status IN ('starting', 'running')
        )))
      RETURNING turn_id`).get(
        sha256(bytes), timestamp, timestamp, timestamp,
        turn.turnId, turn.taskId, turn.roleSessionId,
        turn.ledger, turn.executionId, turn.executionRole,
        turn.promptKind, turn.promptSentAt, turn.recoveryPromptSentAt,
        turn.resultRelativePath, turn.status,
        turn.role, turn.paneId,
        turn.workflowId, turn.revision,
        turn.workflowId, turn.executionStatus,
        turn.workflowId, turn.executionStatus,
      );
    if (!completed) return false;
    if (handoff) {
      const sequence = (db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM forge_developer_execution_events WHERE execution_id = ?").get(turn.executionId) as { value: number }).value;
      db.prepare("INSERT OR IGNORE INTO forge_developer_execution_events (event_id, execution_id, attempt, sequence, kind, occurred_at, summary, idempotency_key) VALUES (?, ?, 0, ?, 'git_handoff', ?, ?, ?)").run(randomUUID(), turn.executionId, sequence, timestamp, `Delivery taken from Git commit ${handoff.headSha.slice(0, 7)}; the Developer's completion message was not received.`, `git-handoff:${handoff.headSha}`);
    }
    return true;
  });
}

async function writeResultAtomically(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.recovery-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function reconcileActiveTurns(database: ForgeDatabase, config: ForgeConfig, deps: {
  herdr?: HerdrClient;
  detectHandoff?: typeof detectGitHandoff;
  now?: () => string;
  logger?: Pick<StructuredLogger, "error">;
} = {}, taskId?: string): Promise<ActiveTurnOutcome[]> {
  const herdr = deps.herdr ?? new CliHerdrClient();
  const detectHandoff = deps.detectHandoff ?? detectGitHandoff;
  const now = deps.now ?? (() => new Date().toISOString());
  let observations: HerdrSessionObservation[] = [];
  let herdrUnavailable = false;
  try {
    const runtimeSnapshot = await snapshotHerdrRuntime(herdr);
    observations = await observeHerdrSessions(database, herdr, taskId, runtimeSnapshot);
  } catch {
    herdrUnavailable = true;
  }
  const observationsBySession = new Map(observations.map((observation) => [observation.sessionId, observation]));
  const outcomes: ActiveTurnOutcome[] = [];
  for (const turn of candidates(database, taskId)) {
    try {
      const result = await resultAt(config.runtimeRoot, turn);
      const observation = observationsBySession.get(turn.roleSessionId);
      const handoffCompatible = turn.ledger === "developer"
        && turn.promptKind === "implementation"
        && turn.role === "builder"
        && result.promptable
        && result.bytes === null;
      const handoff = handoffCompatible && turn.worktreePath && turn.branchName
        ? await detectHandoff({ worktreePath: turn.worktreePath, branchName: turn.branchName, previousCommit: turn.lastReviewedCommit, taskId: turn.taskId, database })
        : null;
      const git = handoff ? {
        worktreePresent: handoff.kind !== "missing_worktree",
        onRecordedBranch: handoff.kind !== "wrong_branch",
        dirty: handoff.kind === "dirty",
        headCommit: "headSha" in handoff ? handoff.headSha : null,
      } : null;
      const terminal = ["done", "cancelled", "failed"].includes(turn.phase);
      const facts: DurableTaskFacts = {
        taskId: turn.taskId, phase: turn.phase, revision: turn.revision, terminal, cancelled: turn.phase === "cancelled",
        branchName: turn.branchName, worktreePath: turn.worktreePath, lastReviewedCommit: turn.lastReviewedCommit,
        turn: { turnId: turn.turnId, role: turn.role, status: turn.status, resultPresent: Boolean(result.bytes), resultValid: result.valid, resumeRequestsSent: turn.recoveryPromptSentAt === null ? 0 : 1 },
        failure: null,
      };
      const classified = classifyRecovery(facts, { herdr: sessionObservation(observation, herdrUnavailable), git, github: null });
      let action: ActiveTurnOutcome["action"] = classified.action === "advance" || classified.action === "resume" || classified.action === "attention" ? classified.action : "no_change";
      const evidence = [...classified.evidence, result.evidence];
      const exactActiveExecution = turn.isLatestSessionTurn === 1 && turn.executionStatus !== null && activeExecutionStatuses.has(turn.executionStatus);
      const lateDeveloperResult = turn.ledger === "developer"
        && result.valid
        && (turn.executionStatus === "failed" || turn.executionStatus === "cancelled" || turn.executionStatus === "timeout" || !exactActiveExecution);
      const expectsResult = turn.promptSentAt !== null && exactActiveExecution;
      if (action === "attention" && !expectsResult) {
        action = "no_change";
        evidence.push("attention:not a current dispatched execution");
      }
      if (action === "advance" && !lateDeveloperResult && !exactActiveExecution) {
        action = "no_change";
        evidence.push("advance:not latest active execution");
      }
      if (action === "advance" && turn.status !== "completed") {
        let completionBytes = result.valid ? result.bytes : null;
        let completedHandoff: { headSha: string } | undefined;
        if (!completionBytes && handoff?.kind === "clean_commit") {
          const candidate = { kind: "delivery", summary: `Delivery taken from Git commit ${handoff.headSha.slice(0, 7)}; the Developer's completion message was not received.`, steps: [{ number: 1, status: "completed", filesChanged: [], notes: "Git handoff." }], authorizedStepsNotCompleted: [], resultCommit: handoff.headSha, resultTree: handoff.treeSha, dirtyState: "clean", blocker: null };
          const parsed = DeveloperDeliveryReportSchema.safeParse(candidate);
          if (parsed.success) {
            completionBytes = Buffer.from(JSON.stringify(parsed.data));
            await writeResultAtomically(result.path, completionBytes);
            completedHandoff = handoff;
          } else {
            action = "no_change";
            evidence.push("advance:Git handoff result invalid");
          }
        }
        if (action === "advance" && completionBytes && !completeTurn(database, turn, completionBytes, now(), completedHandoff)) {
          action = "no_change";
          evidence.push("advance:completion CAS lost");
        }
      }
      // Repeated snapshots retain the same derived action without rewriting an
      // already-attended row. A lost CAS is a stale/non-active turn.
      if (action === "attention" && turn.status !== "awaiting_human" && !persistAttention(database, turn, classified.reason, now())) {
        action = "no_change";
        evidence.push("attention:CAS lost");
      } else if (action === "attention" && turn.status !== "awaiting_human") {
        evidence.push("attention:receipt persisted");
      }
      if (action === "resume") {
        if (!result.promptable || !eligibleRuntimeRecreation(turn)) {
          action = "no_change";
          evidence.push("resume:not an active promptable execution");
        } else if (await recreateMissingRuntime(database, config, herdr, turn)) {
          evidence.push("resume:missing binding recreated");
        } else {
          action = "no_change";
          evidence.push("resume:runtime recreation not eligible");
        }
      }
      if (lateDeveloperResult) {
        if (supersedeLateResult(database, turn, result.bytes!, now())) {
          action = "no_change";
          evidence.push("late-result:superseded");
        } else {
          action = "no_change";
          evidence.push("late-result:completion CAS lost");
        }
      }
      outcomes.push({ taskId: turn.taskId, turnId: turn.turnId, role: turn.role, action, idempotencyKey: classified.idempotencyKey, evidence });
    } catch (error) {
      const message = safeText(error instanceof Error ? error.message : String(error)) || "unknown error";
      deps.logger?.error("Active turn recovery candidate failed", { taskId: turn.taskId, turnId: turn.turnId }, { error: message });
      outcomes.push({ taskId: turn.taskId, turnId: turn.turnId, role: turn.role, action: "error", idempotencyKey: sha256(`${turn.taskId}|${turn.turnId}|error`), evidence: [`recovery:error ${message}`] });
    }
  }
  return outcomes;
}
