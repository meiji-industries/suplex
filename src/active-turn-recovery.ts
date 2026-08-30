import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { ZodType } from "zod";

import { DeveloperDeliveryReportSchema, DeveloperMergeConflictResolutionReportSchema, DeveloperRepairReportSchema } from "./codex-developer.js";
import { DeliveryRepairLeadOutputSchema, LeadOutputSchema, LeadReviewResponseSchema, SupplementalReviewSchema } from "./codex-lead.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { detectGitHandoff } from "./git-handoff.js";
import { type HerdrClient, CliHerdrClient, snapshotHerdrRuntime } from "./herdr-client.js";
import { observeHerdrSessions, type HerdrSessionObservation } from "./herdr-recovery.js";
import { redact, type StructuredLogger } from "./logging.js";
import { classifyRecovery, type DurableTaskFacts, type LiveObservations } from "./recovery/convergence.js";
import { CiRepairPlanSchema, DeliveryReviewSchema, MergeConflictPlanSchema } from "./engine/issue-contracts.js";
import { reconcileIssueDeveloperDelivery } from "./engine/service.js";
import { json } from "./task-utils.js";

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
  roleSessionId: string;
  role: "planner" | "builder" | "reviewer" | "integrator";
  status: TurnStatus;
  resultRelativePath: string;
  executionId: string;
  executionStatus: string | null;
  executionFinishedAt: string | null;
  promptSentAt: string | null;
  isLatestActiveExecutionTurn: number;
  ledger: "agent" | "developer";
  promptKind: string;
  revision: number;
  phase: string;
  workflowId: string;
  paneId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  lastReviewedCommit: string | null;
};

type ResultObservation = { path: string; bytes: Buffer | null; valid: boolean; promptable: boolean; evidence: string };

const agentResultSchemas: Readonly<Record<string, ZodType>> = {
  "lead-plan": LeadOutputSchema,
  "lead-plan-revision": LeadOutputSchema,
  "delivery-repair-plan": DeliveryRepairLeadOutputSchema,
  "merge-conflict-plan": MergeConflictPlanSchema,
  "ci-repair-plan": CiRepairPlanSchema,
  "delivery-review": DeliveryReviewSchema,
  "final-review": DeliveryReviewSchema,
  "supplemental-review": SupplementalReviewSchema,
  "lead-consolidation": LeadReviewResponseSchema,
  "lead-consolidation-correction": LeadReviewResponseSchema,
};
const developerResultSchemas: Readonly<Record<string, ZodType>> = {
  implementation: DeveloperDeliveryReportSchema,
  "delivery-repair": DeveloperRepairReportSchema,
  "ci-repair": DeveloperRepairReportSchema,
  "merge-conflict-resolution": DeveloperMergeConflictResolutionReportSchema,
};

// Keep completed turns with a durable result in the scan so an unchanged second
// reconciliation reports the same idempotent outcome without writing again.
const activeStatuses = "'dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed'";
const activeExecutionStatuses = new Set(["starting", "running", "cancelling"]);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const safeText = (value: unknown) => String(redact(value)).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

function resultSchema(ledger: Turn["ledger"], promptKind: string): ZodType | undefined {
  return (ledger === "agent" ? agentResultSchemas : developerResultSchemas)[promptKind];
}

async function resultAt(runtimeRoot: string, turn: Pick<Turn, "ledger" | "promptKind" | "resultRelativePath">): Promise<ResultObservation> {
  const path = resolve(runtimeRoot, turn.resultRelativePath);
  const relativePath = relative(runtimeRoot, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return { path, bytes: null, valid: false, promptable: false, evidence: "result:path outside runtime root" };
  const schema = resultSchema(turn.ledger, turn.promptKind);
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

function sessionObservation(observation: HerdrSessionObservation | undefined): LiveObservations["herdr"] {
  if (!observation || observation.classification !== "active") return { session: "missing", stalledBeyondPolicy: false };
  const status = observation.lifecycleStatus ?? undefined;
  if (status === "blocked") return { session: "live_blocked", stalledBeyondPolicy: false };
  if (status === "idle") return { session: "live_idle", stalledBeyondPolicy: false };
  if (status === "done" || status === "cancelled") return { session: "terminal", stalledBeyondPolicy: false };
  return { session: "live_progress", stalledBeyondPolicy: false };
}

function candidates(database: ForgeDatabase, taskId?: string): Turn[] {
  return database.authQuery((db) => db.prepare(`SELECT turn.turn_id AS turnId, turn.task_id AS taskId, session.id AS roleSessionId, session.session_role AS role, turn.status, turn.result_relative_path AS resultRelativePath, turn.execution_id AS executionId, COALESCE(agent.status, developer.status) AS executionStatus, COALESCE(agent.finished_at, developer.finished_at) AS executionFinishedAt, turn.prompt_sent_at AS promptSentAt, CASE WHEN turn.turn_id = (
      SELECT latest.turn_id FROM forge_herdr_turns latest
      JOIN forge_agent_executions latest_agent ON latest_agent.id = latest.execution_id AND latest.ledger = 'agent'
      WHERE latest.role_session_id = turn.role_session_id AND latest_agent.status IN ('starting', 'running', 'cancelling')
      ORDER BY latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1
    ) THEN 1 ELSE 0 END AS isLatestActiveExecutionTurn, turn.ledger, turn.prompt_kind AS promptKind, projection.revision, projection.phase, projection.workflow_id AS workflowId, session.pane_id AS paneId, worktree.branch_name AS branchName, worktree.worktree_path AS worktreePath, review.subject_commit AS lastReviewedCommit
    FROM forge_herdr_turns turn
    JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.is_current = 1
    JOIN forge_issue_projections projection ON projection.task_id = turn.task_id
    LEFT JOIN forge_issue_worktrees worktree ON worktree.task_id = turn.task_id AND worktree.status <> 'released'
    LEFT JOIN forge_agent_executions agent ON agent.id = turn.execution_id AND turn.ledger = 'agent'
    LEFT JOIN forge_developer_executions developer ON developer.id = turn.execution_id AND turn.ledger = 'developer'
    LEFT JOIN forge_delivery_reviews review ON review.id = (SELECT id FROM forge_delivery_reviews WHERE workflow_id = projection.workflow_id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE turn.status IN (${activeStatuses}) AND (projection.phase NOT IN ('done', 'cancelled', 'failed') OR datetime(COALESCE(projection.state_changed_at, projection.updated_at)) >= datetime('now', '-1 day'))${taskId ? " AND turn.task_id = ?" : ""}
    ORDER BY turn.task_id, turn.turn_id`).all(...(taskId ? [taskId] : [])) as Turn[]);
}

function eligibleResumeIdentity(turn: Turn, observation: HerdrSessionObservation | undefined): observation is HerdrSessionObservation {
  const live = sessionObservation(observation).session;
  return (turn.role === "planner" || turn.role === "reviewer")
    && Boolean(turn.paneId && observation?.agentName)
    && observation?.sessionId === turn.roleSessionId
    && observation.paneId === turn.paneId
    && observation.classification === "active"
    && observation.identityFailure === null
    && (live === "live_idle" || live === "terminal");
}

function eligibleResumeExecution(turn: Turn): boolean {
  return turn.ledger === "agent"
    && turn.promptSentAt !== null
    && turn.isLatestActiveExecutionTurn === 1
    && turn.executionStatus !== null
    && activeExecutionStatuses.has(turn.executionStatus);
}

function claimResumeReceipt(database: ForgeDatabase, turn: Turn, observedStatus: TurnStatus, excerpt: string, timestamp: string): boolean {
  return database.authTransaction((db) => {
    const claimed = db.prepare(`UPDATE forge_herdr_turns SET status = 'awaiting_human', attention_excerpt = ?, updated_at = ?
      WHERE turn_id = ? AND role_session_id = ? AND status = ?
        AND EXISTS (SELECT 1 FROM forge_herdr_role_sessions session WHERE session.id = ? AND session.is_current = 1 AND session.pane_id IS ?)
        AND EXISTS (SELECT 1 FROM forge_agent_executions execution WHERE execution.id = ? AND execution.task_id = ? AND execution.status = ? AND execution.status IN ('starting', 'running', 'cancelling'))
      RETURNING turn_id`).get(excerpt, timestamp, turn.turnId, turn.roleSessionId, observedStatus, turn.roleSessionId, turn.paneId, turn.executionId, turn.taskId, turn.executionStatus);
    if (!claimed) return false;
    db.prepare("UPDATE forge_herdr_role_sessions SET status = 'ready', attention_activated_at = COALESCE(attention_activated_at, ?), updated_at = ? WHERE id = ? AND is_current = 1").run(timestamp, timestamp, turn.roleSessionId);
    return true;
  });
}

function completeTurn(database: ForgeDatabase, turn: Turn, bytes: Buffer, timestamp: string, handoff?: { headSha: string }): boolean {
  return database.authTransaction((db) => {
    const completed = db.prepare(`UPDATE forge_herdr_turns SET result_sha256 = ?, task_complete_seen_at = ?, status = 'completed', attention_excerpt = NULL, finished_at = ?, updated_at = ?
      WHERE turn_id = ? AND role_session_id = ? AND status = ?
        AND EXISTS (SELECT 1 FROM forge_herdr_role_sessions session WHERE session.id = ? AND session.is_current = 1 AND session.pane_id IS ?)
      RETURNING turn_id`).get(sha256(bytes), timestamp, timestamp, timestamp, turn.turnId, turn.roleSessionId, turn.status, turn.roleSessionId, turn.paneId);
    if (!completed) return false;
    if (handoff) {
      const sequence = (db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM forge_developer_execution_events WHERE execution_id = ?").get(turn.executionId) as { value: number }).value;
      db.prepare("INSERT OR IGNORE INTO forge_developer_execution_events (event_id, execution_id, attempt, sequence, kind, occurred_at, summary, idempotency_key) VALUES (?, ?, 0, ?, 'git_handoff', ?, ?, ?)").run(randomUUID(), turn.executionId, sequence, timestamp, `Delivery taken from Git commit ${handoff.headSha.slice(0, 7)}; the Developer's completion message was not received.`, `git-handoff:${handoff.headSha}`);
    }
    db.prepare("UPDATE forge_herdr_role_sessions SET status = 'ready', attention_activated_at = NULL, updated_at = ? WHERE id = ? AND is_current = 1 AND status <> 'closed'").run(timestamp, turn.roleSessionId);
    return true;
  });
}

export async function reconcileActiveTurns(database: ForgeDatabase, config: ForgeConfig, deps: {
  herdr?: HerdrClient;
  detectHandoff?: typeof detectGitHandoff;
  now?: () => string;
  reconcileDeveloper?: typeof reconcileIssueDeveloperDelivery;
  logger?: Pick<StructuredLogger, "error">;
} = {}, taskId?: string): Promise<ActiveTurnOutcome[]> {
  const herdr = deps.herdr ?? new CliHerdrClient();
  const detectHandoff = deps.detectHandoff ?? detectGitHandoff;
  const now = deps.now ?? (() => new Date().toISOString());
  const runtimeSnapshot = await snapshotHerdrRuntime(herdr);
  const observations = await observeHerdrSessions(database, herdr, taskId, runtimeSnapshot);
  const observationsBySession = new Map(observations.map((observation) => [observation.sessionId, observation]));
  const outcomes: ActiveTurnOutcome[] = [];
  for (const turn of candidates(database, taskId)) {
    try {
      const result = await resultAt(config.runtimeRoot, turn);
      const observation = observationsBySession.get(turn.roleSessionId);
      const handoff = (turn.role === "builder" || turn.role === "integrator") && turn.worktreePath && turn.branchName
        ? await detectHandoff({ worktreePath: turn.worktreePath, branchName: turn.branchName, previousCommit: turn.lastReviewedCommit, taskId: turn.taskId, database })
        : null;
      const git = handoff ? {
        worktreePresent: handoff.kind !== "missing_worktree",
        onRecordedBranch: handoff.kind !== "wrong_branch",
        dirty: handoff.kind === "dirty",
        headCommit: "headSha" in handoff ? handoff.headSha : null,
      } : null;
      const facts: DurableTaskFacts = {
        taskId: turn.taskId, phase: turn.phase, revision: turn.revision, terminal: false, cancelled: false,
        branchName: turn.branchName, worktreePath: turn.worktreePath, lastReviewedCommit: turn.lastReviewedCommit,
        turn: { turnId: turn.turnId, role: turn.role, status: turn.status, resultPresent: Boolean(result.bytes), resultValid: result.valid, resumeRequestsSent: turn.status === "awaiting_human" ? 1 : 0 },
        failure: null,
      };
      const classified = classifyRecovery(facts, { herdr: sessionObservation(observation), git, github: null });
      let action: ActiveTurnOutcome["action"] = classified.action === "advance" || classified.action === "resume" || classified.action === "attention" ? classified.action : "no_change";
      const evidence = [...classified.evidence, result.evidence];
      if (action === "advance" && turn.status !== "completed") {
        const handoffBytes = handoff?.kind === "clean_commit"
          ? Buffer.from(JSON.stringify({ kind: "delivery", summary: `Delivery taken from Git commit ${handoff.headSha.slice(0, 7)}; the Developer's completion message was not received.`, steps: [{ number: 1, status: "completed", filesChanged: [], notes: "Git handoff." }], authorizedStepsNotCompleted: [], resultCommit: handoff.headSha, resultTree: handoff.treeSha, dirtyState: "clean", blocker: null }))
          : result.valid ? result.bytes : null;
        if (handoffBytes && !completeTurn(database, turn, handoffBytes, now(), handoff?.kind === "clean_commit" && turn.ledger === "developer" ? handoff : undefined)) {
          action = "no_change";
          evidence.push("advance:completion CAS lost");
        }
      }
      if (action === "resume") {
        if (!result.promptable) {
          action = "no_change";
          evidence.push("resume:result target not promptable");
        } else if (turn.promptSentAt === null) {
          action = "no_change";
          evidence.push("resume:initial prompt receipt absent");
        } else if (!eligibleResumeExecution(turn)) {
          action = "no_change";
          evidence.push("resume:not latest active execution");
        } else if (!eligibleResumeIdentity(turn, observation)) {
          action = "no_change";
          evidence.push("resume:not exact current live binding");
        } else {
          const marker = `[forge-turn:${turn.turnId}]`;
          const prompt = `Resume the existing Forge turn with turn_id ${turn.turnId}. Write the required JSON result to ${result.path} using the exact schema already provided. The turn is complete only after that file exists and you reply with the completion marker ${marker}. Do not create a new turn or session.`;
          const excerpt = safeText(`Recovery requested once for turn ${turn.turnId}; required result: ${result.path}`);
          if (claimResumeReceipt(database, turn, turn.status, excerpt, now())) {
            evidence.push("resume:receipt persisted before prompt");
            await herdr.prompt(observation.agentName!, prompt);
          } else {
            action = "no_change";
            evidence.push("resume:receipt not claimed");
          }
        }
      }
      if (action === "advance" && (turn.role === "builder" || turn.role === "integrator") && turn.executionStatus === "failed" && result.valid) {
        await (deps.reconcileDeveloper ?? reconcileIssueDeveloperDelivery)(config, turn.workflowId, { expectedRevision: turn.revision, actorUserId: "system", commandId: `late-result-${turn.turnId}-${turn.executionFinishedAt ?? "unknown"}`, reconcileOnly: true });
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
