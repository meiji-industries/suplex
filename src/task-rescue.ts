import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { TERMINAL_PHASES } from "./issue-phases.js";
import type { IssueCommand } from "./commands/registry.js";
import { connectTemporal } from "./temporal/service.js";
import { issueStateQuery } from "./temporal/workflows.js";
import { IssueWorkflowStateSchema } from "./temporal/issue-contracts.js";
import { routeWorkflowToCurrentDeployment } from "./developer-reconciliation-recovery.js";
import type { ForgeTask, TaskService } from "./tasks.js";

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

  private task(actorUserId: string, taskId: string): ForgeTask { return this.tasks.getTask(actorUserId, taskId); }

  private record(task: ForgeTask, name: string, outcome: RescueStep["outcome"], detail: string): RescueStep {
    const step = { name, outcome, detail };
    this.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, NULL, 'task_rescue', ?, ?, ?)").run(`audit_rescue_${randomUUID()}`, task.companyId, JSON.stringify({ taskId: task.id, actionLabel: `Rescue: ${name}`, outcome, detail, revision: task.revision }), new Date().toISOString()));
    return step;
  }

  async diagnostics(actorUserId: string, taskId: string): Promise<TaskDiagnostics> {
    const task = this.task(actorUserId, taskId);
    const local = this.database.authQuery((db) => ({
      executions: db.prepare(`SELECT id, 'developer' AS kind, status, process_pid AS pid FROM forge_developer_executions WHERE task_id = ? UNION ALL SELECT id, 'agent' AS kind, status, process_pid AS pid FROM forge_agent_executions WHERE task_id = ? ORDER BY id`).all(task.id, task.id) as Array<{ id: string; kind: "agent" | "developer"; status: string; pid: number | null }>,
      capacityRequests: db.prepare("SELECT id, status, execution_id AS executionId FROM forge_capacity_requests WHERE task_id = ? ORDER BY requested_at DESC").all(task.id) as Array<{ id: string; status: string; executionId: string | null }>,
      leases: db.prepare("SELECT execution_id AS executionId, status FROM forge_developer_execution_leases WHERE task_id = ? ORDER BY created_at DESC").all(task.id) as Array<{ executionId: string; status: string }>,
    }));
    let workflow: TaskDiagnostics["workflow"] = { status: "unavailable", lastWorkflowTaskFailure: null, pendingWorkflowTaskAgeSeconds: null, buildId: null, currentBuildId: null };
    try {
      const temporal = await connectTemporal(this.config);
      try {
        const response = await temporal.connection.workflowService.describeWorkflowExecution({ namespace: this.config.temporalNamespace, execution: { workflowId: task.workflowId } });
        const info = response.workflowExecutionInfo as unknown as Record<string, unknown>;
        const pending = response.pendingWorkflowTask as unknown as Record<string, unknown> | undefined;
        const scheduledAt = pending?.scheduledTime as { seconds?: number | string } | undefined;
        const seconds = scheduledAt?.seconds === undefined ? null : Number(scheduledAt.seconds) * 1000;
        workflow = { status: String(info.status ?? "running"), lastWorkflowTaskFailure: typeof pending?.failure === "object" ? JSON.stringify(pending.failure).slice(0, 500) : null, pendingWorkflowTaskAgeSeconds: seconds === null ? null : Math.max(0, Math.floor((Date.now() - seconds) / 1000)), buildId: typeof info.workerVersionStamp === "object" ? JSON.stringify(info.workerVersionStamp) : null, currentBuildId: null };
      } finally { temporal.connection.close(); }
    } catch { /* diagnostics must remain useful when Temporal is unavailable */ }
    return { workflow, executions: local.executions.map((entry) => ({ ...entry, terminal: terminalExecution.has(entry.status) })), capacityRequests: local.capacityRequests, leases: local.leases };
  }

  async rescue(actorUserId: string, taskId: string): Promise<{ steps: RescueStep[] }> {
    let task = this.task(actorUserId, taskId);
    const steps: RescueStep[] = [];
    try {
      const temporal = await connectTemporal(this.config);
      try {
        const handle = temporal.client.workflow.getHandle(task.workflowId);
        const [rawState, description] = await Promise.all([handle.query(issueStateQuery), handle.describe()]);
        const state = IssueWorkflowStateSchema.parse(rawState);
        const runId = description.rootExecution?.runId ?? description.runId;
        this.database.projectIssueState({ taskId: state.issueId, companyId: state.companyId, projectId: state.projectId, workflowId: state.workflowId, ...(runId ? { runId } : {}), revision: state.revision, phase: state.phase, owner: state.owner, allowedCommands: state.allowedCommands, pendingAction: state.pendingAction, lastEventId: state.lastEventId, state });
        steps.push(this.record(task, "Resync projection", "completed", `Projected workflow revision ${state.revision}.`));
      } finally { temporal.connection.close(); }
    } catch (error) {
      steps.push(this.record(task, "Resync projection", "failed", error instanceof Error ? error.message.slice(0, 300) : "Could not query the live workflow state."));
    }
    task = this.task(actorUserId, taskId);
    if (TERMINAL_PHASES.has(task.phase)) return { steps: [...steps, this.record(task, "Rescue", "skipped", "Task is already terminal.")] };
    const diagnostics = await this.diagnostics(actorUserId, taskId);
    const needsReset = diagnostics.workflow.lastWorkflowTaskFailure !== null || (diagnostics.workflow.pendingWorkflowTaskAgeSeconds ?? 0) > 60;
    if (needsReset) {
      try {
        const temporal = await connectTemporal(this.config);
        try {
          const description = await temporal.connection.workflowService.describeWorkflowExecution({ namespace: this.config.temporalNamespace, execution: { workflowId: task.workflowId } });
          const runId = description.workflowExecutionInfo?.execution?.runId;
          const finishEventId = Number((description.pendingWorkflowTask as unknown as { scheduledEventId?: number | string } | undefined)?.scheduledEventId ?? 0);
          await temporal.connection.workflowService.resetWorkflowExecution({ namespace: this.config.temporalNamespace, workflowExecution: { workflowId: task.workflowId, ...(runId ? { runId } : {}) }, reason: "Forge task rescue", requestId: randomUUID(), workflowTaskFinishEventId: finishEventId, resetReapplyType: 1 } as never);
          await routeWorkflowToCurrentDeployment(temporal.connection as never, this.config, task.workflowId, "forge-task-rescue");
          steps.push(this.record(task, "Re-dispatch workflow", "completed", "Reset to the last workflow task and cleared the versioning override."));
        } finally { temporal.connection.close(); }
      } catch (error) { steps.push(this.record(task, "Re-dispatch workflow", "failed", error instanceof Error ? error.message.slice(0, 300) : "Temporal reset failed.")); }
    } else steps.push(this.record(task, "Re-dispatch workflow", "skipped", "Workflow has no stale or failed workflow task."));
    const released = this.database.authTransaction((db) => {
      const now = new Date().toISOString();
      const capacity = db.prepare(`UPDATE forge_capacity_requests SET status = 'released', released_at = ?, terminal_reason = 'process_failed', wait_reason = NULL, updated_at = ? WHERE task_id = ? AND status = 'active' AND ((execution_kind = 'developer' AND EXISTS (SELECT 1 FROM forge_developer_executions d WHERE d.id = execution_id AND d.status IN ('completed','blocked','interrupted','cancelled','failed'))) OR (execution_kind = 'agent' AND EXISTS (SELECT 1 FROM forge_agent_executions a WHERE a.id = execution_id AND a.status IN ('completed','blocked','interrupted','cancelled','failed'))))`).run(now, now, task.id).changes;
      const leases = db.prepare(`UPDATE forge_developer_execution_leases SET status = 'terminated', updated_at = ? WHERE task_id = ? AND status IN ('reserved','supervisor_starting','running','result_ready','cancel_requested','cancelling') AND EXISTS (SELECT 1 FROM forge_developer_executions d WHERE d.id = execution_id AND d.status IN ('completed','blocked','interrupted','cancelled','failed'))`).run(now, task.id).changes;
      const running = db.prepare(`UPDATE forge_developer_executions SET status = 'interrupted', finished_at = COALESCE(finished_at, ?), failure_code = 'rescue-process-missing', failure_summary = 'Forge rescue released a stale execution without a process.', heartbeat_at = ? WHERE task_id = ? AND status = 'running' AND process_pid IS NULL`).run(now, now, task.id).changes;
      return capacity + leases + running;
    });
    steps.push(this.record(task, "Release stale bookkeeping", released ? "completed" : "skipped", released ? `Released ${released} stale capacity, lease, or execution record${released === 1 ? "" : "s"}.` : "No terminal or pid-less bookkeeping was found."));
    task = this.task(actorUserId, taskId);
    const command = retryCommands.find((candidate) => task.allowedCommands.includes(candidate));
    if (command && (task.phase === "delivery_blocked" || task.phase === "blocked" || task.phase === "failed" || task.phase === "ci_repair_required" || task.phase === "repair_required" || task.allowedCommands.includes("retry_development"))) {
      try { await this.tasks.executeCommand(actorUserId, task.id, command, { expectedRevision: task.revision, commandId: randomUUID() }); steps.push(this.record(task, "Retry current step", "completed", `Issued ${command}.`)); }
      catch (error) { steps.push(this.record(task, "Retry current step", "failed", error instanceof Error ? error.message.slice(0, 300) : `Could not issue ${command}.`)); }
    } else steps.push(this.record(task, "Retry current step", "skipped", "No retry command is available for the current phase."));
    return { steps };
  }
}
