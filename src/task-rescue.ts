import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { TERMINAL_PHASES } from "./issue-phases.js";
import type { IssueCommand } from "./commands/registry.js";
import { getIssueEngine } from "./engine/index.js";
import { TaskFailure, type ForgeTask, type TaskService } from "./tasks.js";

export type TaskRetryReport = {
  status: "reconciled" | "command_issued" | "waiting" | "cannot_proceed";
  detail: string;
  revision: number;
  command?: IssueCommand;
};
export type TaskDiagnostics = {
  workflow: { status: "running" | "errored" | "not_loaded"; lastError: string | null };
  executions: Array<{ id: string; kind: "agent" | "developer"; status: string; pid: number | null; terminal: boolean }>;
};

const terminalExecution = new Set(["completed", "blocked", "interrupted", "cancelled", "failed"]);
const continuationCommands = new Set<IssueCommand>(["start_planning", "start_development", "repair_ci", "repair_delivery", "review_delivery", "publish_draft", "resolve_merge_conflict"]);

function selectRetryCommand(commands: IssueCommand[]): IssueCommand | undefined {
  return commands.find((command) => command.startsWith("retry_"))
    ?? commands.find((command) => command.startsWith("reconcile_"))
    ?? commands.find((command) => continuationCommands.has(command));
}

export class TaskRescueService {
  private readonly retries = new Map<string, Promise<TaskRetryReport>>();

  constructor(private readonly tasks: TaskService, private readonly database: ForgeDatabase, private readonly config: ForgeConfig) {}

  private task(actorUserId: string, taskId: string): ForgeTask {
    const admin = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_users WHERE id = ? AND role = 'admin' AND status = 'active'").get(actorUserId) as { id: string } | undefined);
    if (!admin) throw new TaskFailure("Not found", [], 404);
    return this.tasks.getTask(actorUserId, taskId);
  }

  private record(actorUserId: string, task: ForgeTask, report: TaskRetryReport): TaskRetryReport {
    this.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'task_retry', ?, ?, ?)").run(`audit_retry_${randomUUID()}`, actorUserId, task.companyId, JSON.stringify({ taskId: task.id, ...report }), new Date().toISOString()));
    return report;
  }

  async diagnostics(actorUserId: string, taskId: string): Promise<TaskDiagnostics> {
    const task = this.task(actorUserId, taskId);
    const local = this.database.authQuery((db) => ({
      executions: db.prepare(`SELECT id, 'developer' AS kind, status, process_pid AS pid FROM forge_developer_executions WHERE task_id = ? UNION ALL SELECT id, 'agent' AS kind, status, process_pid AS pid FROM forge_agent_executions WHERE task_id = ? ORDER BY id`).all(task.id, task.id) as Array<{ id: string; kind: "agent" | "developer"; status: string; pid: number | null }>,
    }));
    const run = getIssueEngine(this.config).runs.get(task.workflowId);
    const failure = run?.error;
    const workflow: TaskDiagnostics["workflow"] = !run ? { status: "not_loaded", lastError: null } : failure ? { status: "errored", lastError: failure instanceof Error ? failure.message : String(failure) } : { status: "running", lastError: null };
    return { workflow, executions: local.executions.map((entry) => ({ ...entry, terminal: terminalExecution.has(entry.status) })) };
  }

  async rescue(actorUserId: string, taskId: string): Promise<TaskRetryReport> {
    const task = this.task(actorUserId, taskId);
    if (TERMINAL_PHASES.has(task.phase)) return this.record(actorUserId, task, { status: "cannot_proceed", detail: "Task is already terminal.", revision: task.revision });
    const active = this.retries.get(task.workflowId);
    if (active) return active;
    const retry = this.retry(actorUserId, task);
    this.retries.set(task.workflowId, retry);
    try {
      return await retry;
    } finally { this.retries.delete(task.workflowId); }
  }

  private async retry(actorUserId: string, task: ForgeTask): Promise<TaskRetryReport> {
    try {
      const run = getIssueEngine(this.config).run(task.workflowId);
      const reconciliation = await run.reconcileOwnerRead();
      const current = this.tasks.getTask(actorUserId, task.id);
      if (TERMINAL_PHASES.has(current.phase)) return this.record(actorUserId, current, { status: "reconciled", detail: "Forge reconciled the task to a terminal state.", revision: current.revision });
      const operationRunning = run.state.activeOperation !== null && run.state.activeOperation !== undefined;
      if (reconciliation === "waiting" && operationRunning) return this.record(actorUserId, current, { status: "waiting", detail: "Forge is checking the current workflow state.", revision: current.revision });
      const command = selectRetryCommand(current.allowedCommands);
      if (!command) {
        const status = operationRunning ? "waiting" : "cannot_proceed";
        return this.record(actorUserId, current, { status, detail: status === "waiting" ? "Forge is waiting for the current workflow action." : "No retry action is available for the current task state.", revision: current.revision });
      }
      const updated = await this.tasks.executeCommand(actorUserId, current.id, command, { expectedRevision: current.revision, commandId: `${current.workflowId}:task-retry:${current.revision}:${command}` });
      return this.record(actorUserId, updated, { status: "command_issued", command, detail: `Forge issued ${command}.`, revision: updated.revision });
    } catch (error) {
      const current = this.tasks.getTask(actorUserId, task.id);
      return this.record(actorUserId, current, { status: "cannot_proceed", detail: error instanceof Error ? error.message.slice(0, 300) : "Forge could not retry the task.", revision: current.revision });
    }
  }
}
