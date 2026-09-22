import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthService } from "../identity/auth.js";
import type { SuplexDatabase } from "../platform/database.js";
import type { ExternalAgentPrincipal } from "../identity/external-agents.js";
import type { GithubPullRequestObservation } from "../integrations/github/delivery.js";
import type { TaskControlStore } from "../coordination/root-session-store.js";
import { TaskFailure, type TaskService } from "../tasks/tasks.js";
import type { TaskRow } from "../tasks/repository.js";
import { taskDependencyMap, topologicalTaskOrder } from "../tasks/dependencies.js";
import type { DeliveryOperations } from "./operations.js";

/** bound: approval receipt lifetime */
const APPROVAL_TTL_MS = 15 * 60_000;
const RECEIPT_PATTERN = /^fma_[A-Za-z0-9_-]{43}$/;

export class AgentDeliveryFailure extends TaskFailure {
  constructor(publicMessage: string, statusCode = 409) { super(publicMessage, statusCode); }
}

export type MergeTrainEntry = {
  taskId: string;
  title: string;
  status: string;
  dependsOn: string[];
  pullRequestNumber: number | null;
  headSha: string | null;
  baseSha: string | null;
  isDraft: boolean | null;
  reviewDecision: string | null;
  checks: { total: number; pending: number; failing: number; successful: number };
  blocker: string | null;
};

type Delivery = Pick<DeliveryOperations, "observe" | "checksObservation" | "execute">;

export interface AgentDeliveryDependencies {
  database: SuplexDatabase;
  tasks: Pick<TaskService, "agentApiTaskRow" | "listAgentApiTaskRows" | "repository">;
  store: Pick<TaskControlStore, "get" | "currentSession" | "wakeRoot">;
  delivery: Delivery;
  auth: Pick<AuthService, "recordAgentAuditEventInTransaction">;
}

const ProvenanceRowSchema = z.object({
  id: z.string(), task_id: z.string(), attempt_id: z.string().nullable(), agent_id: z.string().nullable(), kind: z.string(),
  pull_request_number: z.number().nullable(), original_head_sha: z.string().nullable(), head_sha: z.string().nullable(),
  base_sha: z.string().nullable(), checks_json: z.string().nullable(), merge_json: z.string().nullable(), recorded_at: z.string(),
});
export type DeliveryProvenanceRecord = z.infer<typeof ProvenanceRowSchema>;

export const HEAD_NOT_ACCEPTED = "Suplex has not accepted this pull request head. The Coordinator must review and publish it first.";

/** The single reason this pull request cannot merge now, in the order Suplex checks them. */
export function mergeBlocker(input: { observation: GithubPullRequestObservation | null; blockingDependency: string | null; acceptedHeadSha: string | null }): string | null {
  if (input.blockingDependency) return `Task ${input.blockingDependency} is not delivered.`;
  const observed = input.observation;
  if (!observed || !observed.exists || observed.number === null) return "The task has no pull request.";
  if (observed.state === "merged") return "GitHub merged the pull request.";
  if (observed.state !== "open") return "The pull request is not open.";
  if (observed.isDraft) return "The pull request is a draft.";
  // Suplex's own acceptance, not a self-review, authorizes the head an agent can merge.
  if (input.acceptedHeadSha === null || input.acceptedHeadSha !== observed.headSha) return HEAD_NOT_ACCEPTED;
  if (observed.checks.failing > 0) return "A necessary check failed.";
  if (observed.checks.pending > 0) return "GitHub still runs the checks.";
  if (observed.mergeable === "CONFLICTING" || observed.mergeStateStatus === "DIRTY") return "The pull request conflicts with the base branch.";
  if (observed.mergeStateStatus === "BEHIND") return "The pull request is behind the base branch.";
  if (observed.reviewDecision !== "APPROVED") return "GitHub does not report an approved review.";
  return null;
}

/** GitHub reports a delivery problem that a Coordinator repair turn can address. */
export function needsReconciliation(observed: GithubPullRequestObservation | null): boolean {
  if (!observed || !observed.exists || observed.state !== "open") return false;
  return observed.checks.failing > 0 || observed.mergeable === "CONFLICTING" || ["DIRTY", "BEHIND", "BLOCKED"].includes(observed.mergeStateStatus ?? "");
}

function receiptHash(receipt: string): string { return createHash("sha256").update(receipt).digest("hex"); }

/**
 * The Suplex-owned command surface for a paired agent that manages delivery repairs and a merge train.
 * Every command resolves its task through TaskService, observes GitHub before it decides, and records
 * an audit event. There is no shell and no GitHub passthrough.
 */
export class AgentDeliveryService {
  constructor(private readonly dependencies: AgentDeliveryDependencies) {}

  /** Re-observes the pull request and its checks, and appends the observation to any open repair attempt. */
  async refresh(principal: ExternalAgentPrincipal, taskId: string) {
    const row = this.dependencies.tasks.agentApiTaskRow(principal, taskId);
    const pullRequest = await this.dependencies.delivery.observe(taskId);
    const observation = await this.dependencies.delivery.checksObservation(taskId);
    const attempt = this.openAttempt(taskId);
    if (attempt && observation) {
      this.insertProvenance({
        taskId, attemptId: attempt.id, agentId: principal.agentId, kind: "observation",
        pullRequestNumber: observation.number, originalHeadSha: attempt.original_head_sha, headSha: observation.headSha,
        baseSha: observation.baseSha, checks: observation.checks,
      });
    }
    this.audit(principal, row, "agent_api_delivery_observed", { pullRequestNumber: String(observation?.number ?? ""), headSha: observation?.headSha ?? "", baseSha: observation?.baseSha ?? "" });
    return { taskId, pullRequest, observation };
  }

  /** Wakes the task's Coordinator with a delivery repair instruction and opens an append-only provenance attempt. */
  async requestReconciliation(principal: ExternalAgentPrincipal, taskId: string) {
    const row = this.dependencies.tasks.agentApiTaskRow(principal, taskId);
    const control = this.dependencies.store.get(taskId);
    if (control.status !== "active") throw new AgentDeliveryFailure("Start the task before you request delivery repair.");
    // A repair before the upstream delivery tempts the Coordinator to rewrite the foundation. Wait instead.
    const blocking = this.blockingDependencies(taskId)[0];
    if (blocking) throw new AgentDeliveryFailure(`Task ${blocking} is not delivered. Wait for its delivery instead of a delivery repair.`);
    const observation = await this.dependencies.delivery.checksObservation(taskId);
    if (!observation || !observation.exists || observation.number === null) throw new AgentDeliveryFailure("The task has no pull request.");
    if (!needsReconciliation(observation)) throw new AgentDeliveryFailure("GitHub reports no delivery problem for this pull request.");
    const root = this.dependencies.store.currentSession(taskId, "root");
    if (!root) throw new AgentDeliveryFailure("Coordinator is not ready. Retry the request.");
    const attemptId = `dpr_${randomUUID().replaceAll("-", "")}`;
    this.dependencies.store.wakeRoot({
      taskId, rootSessionId: root.id, generation: root.generation,
      prompt: reconciliationPrompt(control.deliveryIntent.baseBranch, observation),
    });
    this.insertProvenance({
      id: attemptId, taskId, attemptId, agentId: principal.agentId, kind: "reconciliation",
      pullRequestNumber: observation.number, originalHeadSha: observation.headSha, headSha: observation.headSha,
      baseSha: observation.baseSha, checks: observation.checks,
    });
    this.audit(principal, row, "agent_api_delivery_repair_requested", { attemptId, pullRequestNumber: String(observation.number), headSha: observation.headSha ?? "", baseSha: observation.baseSha ?? "" });
    return { taskId, attemptId, observation };
  }

  /**
   * Accepts a wait only while the dependency graph shows an undelivered upstream task, and a resume only
   * when every dependency is delivered. The refusal names the blocking task.
   */
  decide(principal: ExternalAgentPrincipal, taskId: string, decision: "wait_for_dependency" | "resume") {
    const row = this.dependencies.tasks.agentApiTaskRow(principal, taskId);
    const blocking = this.blockingDependencies(taskId);
    if (decision === "wait_for_dependency" && !blocking.length) throw new AgentDeliveryFailure("Every dependency of this task is delivered. Resume the task.");
    if (decision === "resume" && blocking.length) throw new AgentDeliveryFailure(`Task ${blocking[0]} is not delivered. Wait for its delivery.`);
    if (decision === "resume") {
      const control = this.dependencies.store.get(taskId);
      if (control.status !== "active") throw new AgentDeliveryFailure("Start the task before you resume it.");
      const root = this.dependencies.store.currentSession(taskId, "root");
      if (!root) throw new AgentDeliveryFailure("Coordinator is not ready. Retry the request.");
      this.dependencies.store.wakeRoot({ taskId, rootSessionId: root.id, generation: root.generation, prompt: resumePrompt(control.deliveryIntent.baseBranch) });
    }
    this.audit(principal, row, decision === "resume" ? "agent_api_delivery_resumed" : "agent_api_delivery_wait_accepted", { blockingTaskId: blocking[0] ?? "" });
    return { taskId, decision, blockingTaskIds: blocking };
  }

  /** The agent's eligible pull requests in dependency-first order, each with its live GitHub facts. */
  async mergeTrain(principal: ExternalAgentPrincipal, projectId?: string): Promise<{ entries: MergeTrainEntry[] }> {
    const rows = this.dependencies.tasks.listAgentApiTaskRows(principal).filter(row => !projectId || row.project_id === projectId);
    const dependencies = taskDependencyMap(this.dependencies.database, rows.map(row => row.id));
    const ordered = topologicalTaskOrder(rows.map(row => ({ id: row.id, dependsOn: dependencies.get(row.id) ?? [], row })));
    const entries: MergeTrainEntry[] = [];
    for (const entry of ordered) {
      const observation = await this.dependencies.delivery.checksObservation(entry.id);
      const blockingDependency = this.blockingDependencies(entry.id)[0] ?? null;
      entries.push({
        taskId: entry.id, title: entry.row.title, status: this.dependencies.store.get(entry.id).status, dependsOn: entry.dependsOn,
        pullRequestNumber: observation?.number ?? null, headSha: observation?.headSha ?? null, baseSha: observation?.baseSha ?? null,
        isDraft: observation?.isDraft ?? null, reviewDecision: observation?.reviewDecision ?? null,
        checks: { total: observation?.checks.total ?? 0, pending: observation?.checks.pending ?? 0, failing: observation?.checks.failing ?? 0, successful: observation?.checks.successful ?? 0 },
        blocker: mergeBlocker({ observation, blockingDependency, acceptedHeadSha: this.acceptedHead(entry.id) }),
      });
    }
    this.audit(principal, null, "agent_api_merge_train_observed", { projectId: projectId ?? "", entries: String(entries.length) });
    return { entries };
  }

  /** Issues a single-use receipt bound to the observed pull request, head, and base of one eligible task. */
  async issueApproval(principal: ExternalAgentPrincipal, taskId: string, input: { pullRequestNumber: number; headSha: string; baseSha: string }) {
    const row = this.dependencies.tasks.agentApiTaskRow(principal, taskId);
    const observation = await this.requireEligible(taskId, input);
    const receipt = `fma_${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date();
    this.dependencies.database.authTransaction(db => {
      db.prepare("INSERT INTO suplex_merge_approvals (id, task_id, agent_id, pull_request_number, head_sha, base_sha, receipt_hash, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
        .run(`mar_${randomUUID().replaceAll("-", "")}`, taskId, principal.agentId, input.pullRequestNumber, observation.headSha, observation.baseSha, receiptHash(receipt), createdAt.toISOString(), new Date(createdAt.getTime() + APPROVAL_TTL_MS).toISOString());
      this.dependencies.auth.recordAgentAuditEventInTransaction(db, principal.agentId, "agent_api_merge_approval_issued", undefined, row.company_id, { taskId, pullRequestNumber: String(input.pullRequestNumber), headSha: observation.headSha ?? "", baseSha: observation.baseSha ?? "" });
    });
    return { taskId, receipt, expiresAt: new Date(createdAt.getTime() + APPROVAL_TTL_MS).toISOString(), pullRequestNumber: input.pullRequestNumber, headSha: observation.headSha, baseSha: observation.baseSha };
  }

  /**
   * Merges one pull request of the train. Suplex re-observes GitHub, refuses every ineligible or stale
   * revision, consumes the receipt exactly once, and then runs the existing delivery merge operation.
   */
  async merge(principal: ExternalAgentPrincipal, taskId: string, input: { pullRequestNumber: number; expectedHeadSha: string; expectedBaseSha: string; approvalReceipt: string }) {
    const row = this.dependencies.tasks.agentApiTaskRow(principal, taskId);
    if (!RECEIPT_PATTERN.test(input.approvalReceipt)) throw new AgentDeliveryFailure("The approval receipt is not valid.", 403);
    if (this.dependencies.store.get(taskId).status !== "active") throw new AgentDeliveryFailure("The task is not active.");
    const observation = await this.requireEligible(taskId, { pullRequestNumber: input.pullRequestNumber, headSha: input.expectedHeadSha, baseSha: input.expectedBaseSha });
    this.consumeApproval(principal, taskId, input);
    const root = this.dependencies.store.currentSession(taskId, "root");
    if (!root) throw new AgentDeliveryFailure("Coordinator is not ready. Retry the request.");
    // The accepted range is the Coordinator's own review. Suplex never rebuilds it for the agent.
    const accepted = this.dependencies.store.get(taskId).workflowState.acceptedDelivery;
    if (!accepted || accepted.headSha !== observation.headSha) throw new AgentDeliveryFailure(HEAD_NOT_ACCEPTED);
    const result = await this.dependencies.delivery.execute(
      { taskId, sessionId: root.id, generation: root.generation }, "merge_pull_request", accepted.headSha, accepted,
    );
    const merged = await this.dependencies.delivery.checksObservation(taskId);
    this.insertProvenance({
      taskId, attemptId: this.openAttempt(taskId)?.id ?? null, agentId: principal.agentId, kind: "merge",
      pullRequestNumber: input.pullRequestNumber, originalHeadSha: input.expectedHeadSha, headSha: merged?.headSha ?? input.expectedHeadSha,
      baseSha: merged?.baseSha ?? input.expectedBaseSha, checks: merged?.checks ?? null, merge: result,
    });
    this.audit(principal, row, "agent_api_pull_request_merged", { pullRequestNumber: String(input.pullRequestNumber), headSha: input.expectedHeadSha, baseSha: input.expectedBaseSha });
    return { taskId, pullRequestNumber: input.pullRequestNumber, result };
  }

  /** The append-only provenance trail of one task. */
  provenance(principal: ExternalAgentPrincipal, taskId: string): DeliveryProvenanceRecord[] {
    this.dependencies.tasks.agentApiTaskRow(principal, taskId);
    return this.dependencies.database.authQuery(db => z.array(ProvenanceRowSchema).parse(db.prepare("SELECT * FROM suplex_delivery_provenance WHERE task_id = ? ORDER BY recorded_at, id").all(taskId)));
  }

  private async requireEligible(taskId: string, input: { pullRequestNumber: number; headSha: string; baseSha: string }): Promise<GithubPullRequestObservation> {
    const observation = await this.dependencies.delivery.checksObservation(taskId);
    if (!observation) throw new AgentDeliveryFailure("GitHub did not return the pull request. Retry the request.");
    if (observation.number !== input.pullRequestNumber) throw new AgentDeliveryFailure("The pull request number does not match this task.", 422);
    const blocker = mergeBlocker({ observation, blockingDependency: this.blockingDependencies(taskId)[0] ?? null, acceptedHeadSha: this.acceptedHead(taskId) });
    if (blocker) throw new AgentDeliveryFailure(blocker);
    if (observation.headSha !== input.headSha || observation.baseSha !== input.baseSha) throw new AgentDeliveryFailure("GitHub reports a different head or base. Refresh the observation before you merge.");
    return observation;
  }

  private consumeApproval(principal: ExternalAgentPrincipal, taskId: string, input: { pullRequestNumber: number; expectedHeadSha: string; expectedBaseSha: string; approvalReceipt: string }): void {
    const hash = receiptHash(input.approvalReceipt);
    const consumed = this.dependencies.database.authImmediateTransaction(db => db.prepare("UPDATE suplex_merge_approvals SET consumed_at = ? WHERE receipt_hash = ? AND task_id = ? AND agent_id = ? AND pull_request_number = ? AND head_sha = ? AND base_sha = ? AND consumed_at IS NULL AND expires_at > ?")
      .run(new Date().toISOString(), hash, taskId, principal.agentId, input.pullRequestNumber, input.expectedHeadSha, input.expectedBaseSha, new Date().toISOString()).changes);
    if (consumed !== 1) throw new AgentDeliveryFailure("The approval receipt is not valid.", 403);
  }

  /** The head Suplex accepted for delivery, which is the Coordinator's reviewed head. */
  private acceptedHead(taskId: string): string | null {
    return this.dependencies.store.get(taskId).workflowState.acceptedDelivery?.headSha ?? null;
  }

  private blockingDependencies(taskId: string): string[] {
    const dependencies = taskDependencyMap(this.dependencies.database, [taskId]).get(taskId) ?? [];
    return dependencies.filter(id => this.dependencies.store.get(id).status !== "delivered");
  }

  private openAttempt(taskId: string): DeliveryProvenanceRecord | null {
    const row = this.dependencies.database.authQuery(db => db.prepare("SELECT * FROM suplex_delivery_provenance WHERE task_id = ? AND kind = 'reconciliation' ORDER BY recorded_at DESC, id DESC LIMIT 1").get(taskId));
    return row ? ProvenanceRowSchema.parse(row) : null;
  }

  private insertProvenance(input: { id?: string; taskId: string; attemptId: string | null; agentId: string; kind: "reconciliation" | "observation" | "merge"; pullRequestNumber: number | null; originalHeadSha: string | null; headSha: string | null; baseSha: string | null; checks: unknown; merge?: unknown }): void {
    this.dependencies.database.authTransaction(db => db.prepare("INSERT INTO suplex_delivery_provenance (id, task_id, attempt_id, agent_id, kind, pull_request_number, original_head_sha, head_sha, base_sha, checks_json, merge_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id ?? `dpv_${randomUUID().replaceAll("-", "")}`, input.taskId, input.attemptId, input.agentId, input.kind, input.pullRequestNumber, input.originalHeadSha, input.headSha, input.baseSha, input.checks === null || input.checks === undefined ? null : JSON.stringify(input.checks), input.merge === undefined ? null : JSON.stringify(input.merge ?? null), new Date().toISOString()));
  }

  private audit(principal: ExternalAgentPrincipal, row: TaskRow | null, action: string, metadata: Record<string, string>): void {
    this.dependencies.database.authTransaction(db => this.dependencies.auth.recordAgentAuditEventInTransaction(db, principal.agentId, action, undefined, row?.company_id ?? principal.companyId, { ...(row ? { taskId: row.id } : {}), ...metadata }));
  }
}

function reconciliationPrompt(baseBranch: string, observed: GithubPullRequestObservation): string {
  return [
    "Suplex received a delivery repair request for this task.",
    `GitHub reports pull request #${observed.number} at head ${observed.headSha ?? "unknown"} with mergeable ${observed.mergeable ?? "unknown"}, merge state ${observed.mergeStateStatus ?? "unknown"}, and ${observed.checks.failing} failing checks.`,
    `Observe GitHub and Git yourself. Integrate the current ${baseBranch} head, resolve every conflict, and repair every failing check.`,
    `The upstream work is already merged into ${baseBranch}. Integrate it. Do not rewrite it and do not reimplement it.`,
    "Preserve the reviewed intent of both sides. Review the new range and continue the delivery workflow.",
  ].join("\n");
}

function resumePrompt(baseBranch: string): string {
  return [
    "Every dependency of this task is delivered.",
    `Suplex merged their work into ${baseBranch}. Integrate that work. Do not rewrite it and do not reimplement it.`,
    "Observe the current task, worktree, and GitHub state, then continue toward the delivery target.",
  ].join("\n");
}
