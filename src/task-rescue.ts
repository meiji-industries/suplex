import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { TERMINAL_PHASES } from "./issue-phases.js";
import type { IssueCommand } from "./commands/registry.js";
import { connectEngine, reconcileIssueDeveloperDelivery } from "./engine/service.js";
import { issueStateQuery } from "./engine/workflows.js";
import { IssueWorkflowStateSchema } from "./engine/issue-contracts.js";
import { TaskFailure, type ForgeTask, type TaskService } from "./tasks.js";

export type RescueStep = { name: string; outcome: "completed" | "skipped" | "failed"; detail: string };
export type TaskDiagnostics = {
  workflow: { status: string; lastWorkflowTaskFailure: string | null; pendingWorkflowTaskAgeSeconds: number | null; buildId: string | null; currentBuildId: string | null };
  executions: Array<{ id: string; kind: "agent" | "developer"; status: string; pid: number | null; terminal: boolean }>;
  capacityRequests: Array<{ id: string; status: string; executionId: string | null }>;
  leases: Array<{ executionId: string; status: string }>;
};

const terminalExecution = new Set(["completed", "blocked", "interrupted", "cancelled", "failed"]);
const retryCommands: IssueCommand[] = ["retry_development", "repair_ci", "review_delivery", "reconcile_ci", "repair_delivery", "reconcile_merge", "retry_capacity", "retry_target_base_reconciliation", "retry_forward_merge_verification", "publish_draft", "resolve_merge_conflict", "reconcile_acceptance"];

export class TaskRescueService {
  constructor(private readonly tasks: TaskService, private readonly database: ForgeDatabase, private readonly config: ForgeConfig) {}

  private task(actorUserId: string, taskId: string): ForgeTask {
    const admin = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_users WHERE id = ? AND role = 'admin' AND status = 'active'").get(actorUserId) as { id: string } | undefined);
    if (!admin) throw new TaskFailure("Not found", [], 404);
    return this.tasks.getTask(actorUserId, taskId);
  }

  private record(actorUserId: string, task: ForgeTask, name: string, outcome: RescueStep["outcome"], detail: string): RescueStep {
    const step = { name, outcome, detail };
    this.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'task_rescue', ?, ?, ?)").run(`audit_rescue_${randomUUID()}`, actorUserId, task.companyId, JSON.stringify({ taskId: task.id, actionLabel: `Rescue: ${name}`, outcome, detail, revision: task.revision }), new Date().toISOString()));
    return step;
  }

  async diagnostics(actorUserId: string, taskId: string): Promise<TaskDiagnostics> {
    const task = this.task(actorUserId, taskId);
    const local = this.database.authQuery((db) => ({
      executions: db.prepare(`SELECT id, 'developer' AS kind, status, process_pid AS pid FROM forge_developer_executions WHERE task_id = ? UNION ALL SELECT id, 'agent' AS kind, status, process_pid AS pid FROM forge_agent_executions WHERE task_id = ? ORDER BY id`).all(task.id, task.id) as Array<{ id: string; kind: "agent" | "developer"; status: string; pid: number | null }>,
      capacityRequests: [],
    }));
    let workflow: TaskDiagnostics["workflow"] = { status: "unavailable", lastWorkflowTaskFailure: null, pendingWorkflowTaskAgeSeconds: null, buildId: null, currentBuildId: null };
    try {
      const engine = await connectEngine(this.config);
      try {
        const response = await engine.connection.workflowService.describeWorkflowExecution({ execution: { workflowId: task.workflowId } });
        const info = response.workflowExecutionInfo as unknown as Record<string, unknown>;
        const pending = response.pendingWorkflowTask as unknown as Record<string, unknown> | undefined;
        const scheduledAt = pending?.scheduledTime as { seconds?: number | string } | undefined;
        const seconds = scheduledAt?.seconds === undefined ? null : Number(scheduledAt.seconds) * 1000;
        workflow = { status: String(info.status ?? "running"), lastWorkflowTaskFailure: typeof pending?.failure === "object" ? JSON.stringify(pending.failure).slice(0, 500) : null, pendingWorkflowTaskAgeSeconds: seconds === null ? null : Math.max(0, Math.floor((Date.now() - seconds) / 1000)), buildId: typeof info.workerVersionStamp === "object" ? JSON.stringify(info.workerVersionStamp) : null, currentBuildId: null };
      } finally { await engine.connection.close(); }
    } catch { /* diagnostics must remain useful when Engine is unavailable */ }
    return { workflow, executions: local.executions.map((entry) => ({ ...entry, terminal: terminalExecution.has(entry.status) })), capacityRequests: local.capacityRequests, leases: [] };
  }

  async rescue(actorUserId: string, taskId: string): Promise<{ steps: RescueStep[] }> {
    let task = this.task(actorUserId, taskId);
    const steps: RescueStep[] = [];
    try {
      const engine = await connectEngine(this.config);
      try {
        const handle = engine.client.workflow.getHandle(task.workflowId);
        const [rawState, description] = await Promise.all([handle.query(issueStateQuery), handle.describe()]);
        const state = IssueWorkflowStateSchema.parse(rawState);
        const runId = description.rootExecution?.runId ?? description.runId;
        this.database.projectIssueState({ taskId: state.issueId, companyId: state.companyId, projectId: state.projectId, workflowId: state.workflowId, ...(runId ? { runId } : {}), revision: state.revision, phase: state.phase, owner: state.owner, allowedCommands: state.allowedCommands, pendingAction: state.pendingAction, lastEventId: state.lastEventId, state });
        steps.push(this.record(actorUserId, task, "Resync projection", "completed", `Projected workflow revision ${state.revision}.`));
      } finally { await engine.connection.close(); }
    } catch (error) {
      steps.push(this.record(actorUserId, task, "Resync projection", "failed", error instanceof Error ? error.message.slice(0, 300) : "Could not query the live workflow state."));
    }
    task = this.task(actorUserId, taskId);
    if (TERMINAL_PHASES.has(task.phase)) return { steps: [...steps, this.record(actorUserId, task, "Rescue", "skipped", "Task is already terminal.")] };
    if (task.phase === "development" || task.phase === "delivery_blocked") {
      try {
        const state = await reconcileIssueDeveloperDelivery(this.config, task.workflowId, { expectedRevision: task.revision, actorUserId, commandId: `rescue-reconcile-${randomUUID()}`, reconcileOnly: true });
        steps.push(this.record(actorUserId, task, "Reconcile Developer delivery", state.phase === "delivery_ready" ? "completed" : "skipped", state.phase === "delivery_ready" ? "Recovered the existing Developer delivery." : "No recoverable Developer execution exists."));
        if (state.phase === "delivery_ready") return { steps };
      } catch (error) {
        steps.push(this.record(actorUserId, task, "Reconcile Developer delivery", "failed", error instanceof Error ? error.message.slice(0, 300) : "Could not reconcile the Developer execution."));
      }
    } else steps.push(this.record(actorUserId, task, "Reconcile Developer delivery", "skipped", "Task is not in a Developer recovery phase."));
    steps.push(this.record(actorUserId, task, "Re-dispatch workflow", "skipped", "In-process workflow re-dispatch is disabled because run liveness cannot be proven."));
    steps.push(this.record(actorUserId, task, "Release stale bookkeeping", "skipped", "Process PID rescue is unavailable for Herdr executions."));
    task = this.task(actorUserId, taskId);
    const command = retryCommands.find((candidate) => task.allowedCommands.includes(candidate));
    if (command && (task.phase === "delivery_blocked" || task.phase === "blocked" || task.phase === "failed" || task.phase === "ci_repair_required" || task.phase === "repair_required" || task.allowedCommands.includes("retry_development"))) {
      try { await this.tasks.executeCommand(actorUserId, task.id, command, { expectedRevision: task.revision, commandId: randomUUID() }); steps.push(this.record(actorUserId, task, "Retry current step", "completed", `Issued ${command}.`)); }
      catch (error) { steps.push(this.record(actorUserId, task, "Retry current step", "failed", error instanceof Error ? error.message.slice(0, 300) : `Could not issue ${command}.`)); }
    } else steps.push(this.record(actorUserId, task, "Retry current step", "skipped", "No retry command is available for the current phase."));
    return { steps };
  }
}
