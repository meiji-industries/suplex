import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { detectGitHandoff } from "./git-handoff.js";
import { type HerdrClient, CliHerdrClient } from "./herdr-client.js";
import { reconcileHerdrSessions } from "./herdr-recovery.js";
import { classifyRecovery, type DurableTaskFacts, type LiveObservations } from "./recovery/convergence.js";
import { json } from "./task-utils.js";
import { reconcileIssueDeveloperDelivery } from "./engine/service.js";

export interface ActiveTurnOutcome {
  taskId: string;
  turnId: string;
  role: "planner" | "builder" | "reviewer" | "integrator";
  action: "advance" | "resume" | "attention" | "no_change";
  idempotencyKey: string;
  evidence: string[];
}

type Turn = { turnId: string; taskId: string; role: "planner" | "builder" | "reviewer" | "integrator"; status: DurableTaskFacts["turn"] extends infer T ? T extends { status: infer S } ? S : never : never; resultRelativePath: string; executionId: string; executionStatus: string | null; executionFinishedAt: string | null; ledger: "agent" | "developer"; executionRole: string; revision: number; phase: string; workflowId: string; agentName: string | null; branchName: string | null; worktreePath: string | null; lastReviewedCommit: string | null; correctionIndex: number };

// Keep completed turns with a durable result in the scan so an unchanged second
// reconciliation reports the same idempotent outcome without writing again.
const activeStatuses = "'dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed'";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function resultAt(runtimeRoot: string, value: string): Promise<Buffer | null> {
  const path = join(runtimeRoot, value);
  if (relative(runtimeRoot, path).startsWith("..")) return null;
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;
  try {
    const parsed: unknown = json(bytes.toString("utf8"), null);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? bytes : null;
  } catch { return null; }
}

function sessionObservation(status: string | undefined, missing: boolean): LiveObservations["herdr"] {
  if (missing) return { session: "missing", stalledBeyondPolicy: false };
  if (status === "working") return { session: "live_progress", stalledBeyondPolicy: false };
  if (status === "blocked") return { session: "live_blocked", stalledBeyondPolicy: false };
  if (status === "idle") return { session: "live_idle", stalledBeyondPolicy: false };
  return { session: "terminal", stalledBeyondPolicy: false };
}

function candidates(database: ForgeDatabase, taskId?: string): Turn[] {
  return database.authQuery((db) => db.prepare(`SELECT turn.turn_id AS turnId, turn.task_id AS taskId, session.session_role AS role, turn.status, turn.result_relative_path AS resultRelativePath, turn.execution_id AS executionId, developer.status AS executionStatus, developer.finished_at AS executionFinishedAt, turn.ledger, turn.execution_role AS executionRole, projection.revision, projection.phase, projection.workflow_id AS workflowId, session.agent_name AS agentName, worktree.branch_name AS branchName, worktree.worktree_path AS worktreePath, review.subject_commit AS lastReviewedCommit, turn.correction_index AS correctionIndex
    FROM forge_herdr_turns turn
    JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.is_current = 1
    JOIN forge_issue_projections projection ON projection.task_id = turn.task_id
    LEFT JOIN forge_issue_worktrees worktree ON worktree.task_id = turn.task_id AND worktree.status <> 'released'
    LEFT JOIN forge_developer_executions developer ON developer.id = turn.execution_id AND turn.ledger = 'developer'
    LEFT JOIN forge_delivery_reviews review ON review.id = (SELECT id FROM forge_delivery_reviews WHERE workflow_id = projection.workflow_id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE turn.status IN (${activeStatuses}) AND (projection.phase NOT IN ('done', 'cancelled', 'failed') OR session.updated_at >= datetime('now', '-1 day'))${taskId ? " AND turn.task_id = ?" : ""}
    ORDER BY turn.task_id, turn.turn_id`).all(...(taskId ? [taskId] : [])) as Turn[]);
}

export async function reconcileActiveTurns(database: ForgeDatabase, config: ForgeConfig, deps: { herdr?: HerdrClient; detectHandoff?: typeof detectGitHandoff; now?: () => string; reconcileDeveloper?: typeof reconcileIssueDeveloperDelivery } = {}, taskId?: string): Promise<ActiveTurnOutcome[]> {
  const herdr = deps.herdr ?? new CliHerdrClient();
  const detectHandoff = deps.detectHandoff ?? detectGitHandoff;
  const now = deps.now ?? (() => new Date().toISOString());
  await reconcileHerdrSessions(database, herdr, taskId);
  const outcomes: ActiveTurnOutcome[] = [];
  for (const turn of candidates(database, taskId)) {
    const bytes = await resultAt(config.runtimeRoot, turn.resultRelativePath);
    const liveAgent = turn.agentName ? await herdr.getAgent(turn.agentName) : null;
    const handoff = (turn.role === "builder" || turn.role === "integrator") && turn.worktreePath && turn.branchName
      ? await detectHandoff({ worktreePath: turn.worktreePath, branchName: turn.branchName, previousCommit: turn.lastReviewedCommit, taskId: turn.taskId, database })
      : null;
    const git = handoff ? {
      worktreePresent: handoff.kind !== "missing_worktree",
      onRecordedBranch: handoff.kind !== "wrong_branch",
      dirty: handoff.kind === "dirty",
      headCommit: "headSha" in handoff ? handoff.headSha : null,
    } : null;
    const facts: DurableTaskFacts = { taskId: turn.taskId, phase: turn.phase, revision: turn.revision, terminal: false, cancelled: false, branchName: turn.branchName, worktreePath: turn.worktreePath, lastReviewedCommit: turn.lastReviewedCommit, turn: { turnId: turn.turnId, role: turn.role, status: turn.status, resultPresent: Boolean(bytes), resultValid: Boolean(bytes), resumeRequestsSent: turn.status === "awaiting_human" ? 1 : 0 }, failure: null };
    const classified = classifyRecovery(facts, { herdr: sessionObservation(liveAgent?.status, !liveAgent), git, github: null });
    const action: ActiveTurnOutcome["action"] = classified.action === "advance" || classified.action === "resume" || classified.action === "attention" ? classified.action : "no_change";
    if (action === "advance" && turn.status !== "completed") {
      const handoffBytes = handoff?.kind === "clean_commit" ? Buffer.from(JSON.stringify({ kind: "delivery", summary: `Delivery taken from Git commit ${handoff.headSha.slice(0, 7)}; the Developer's completion message was not received.`, steps: [{ number: 1, status: "completed", filesChanged: [], notes: "Git handoff." }], authorizedStepsNotCompleted: [], resultCommit: handoff.headSha, resultTree: handoff.treeSha, dirtyState: "clean", blocker: null })) : bytes;
      if (handoffBytes) database.authTransaction((db) => {
        if (handoff?.kind === "clean_commit" && turn.ledger === "developer") {
          const sequence = (db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM forge_developer_execution_events WHERE execution_id = ?").get(turn.executionId) as { value: number }).value;
          db.prepare("INSERT OR IGNORE INTO forge_developer_execution_events (event_id, execution_id, attempt, sequence, kind, occurred_at, summary, idempotency_key) VALUES (?, ?, 0, ?, 'git_handoff', ?, ?, ?)").run(randomUUID(), turn.executionId, sequence, now(), `Delivery taken from Git commit ${handoff.headSha.slice(0, 7)}; the Developer's completion message was not received.`, `git-handoff:${handoff.headSha}`);
        }
        db.prepare("UPDATE forge_herdr_turns SET result_sha256 = ?, task_complete_seen_at = ?, status = 'completed', finished_at = ?, updated_at = ? WHERE turn_id = ? AND status <> 'completed'").run(sha256(handoffBytes), now(), now(), now(), turn.turnId);
      });
    }
    // A result that arrived after Forge failed the execution is still the
    // Developer's delivery: reopen the execution through the reconcile-only
    // retry. The execution leaves `failed` once adopted, so this fires once.
    if ((turn.role === "builder" || turn.role === "integrator") && turn.executionStatus === "failed" && bytes) {
      await (deps.reconcileDeveloper ?? reconcileIssueDeveloperDelivery)(config, turn.workflowId, { expectedRevision: turn.revision, actorUserId: "system", commandId: `late-result-${turn.turnId}-${turn.executionFinishedAt ?? "unknown"}`, reconcileOnly: true }).catch(() => undefined);
    }
    outcomes.push({ taskId: turn.taskId, turnId: turn.turnId, role: turn.role, action, idempotencyKey: classified.idempotencyKey, evidence: classified.evidence });
  }
  return outcomes;
}
