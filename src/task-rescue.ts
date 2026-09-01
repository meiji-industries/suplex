import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { TERMINAL_PHASES } from "./issue-phases.js";
import type { IssueCommand } from "./commands/registry.js";
import { getIssueEngine } from "./engine/index.js";
import { createRunFromLatestSnapshot } from "./engine/runs.js";
import { TaskFailure, type ForgeTask, type TaskService } from "./tasks.js";

export type RescueStep = { name: string; outcome: "completed" | "skipped" | "failed"; detail: string };
export type TaskDiagnostics = {
  workflow: { status: "running" | "errored" | "not_loaded"; lastError: string | null };
  executions: Array<{ id: string; kind: "agent" | "developer"; status: string; pid: number | null; terminal: boolean }>;
};

const terminalExecution = new Set(["completed", "blocked", "interrupted", "cancelled", "failed"]);
const retryCommands: IssueCommand[] = ["retry_target_base_reconciliation", "retry_forward_merge_verification", "repair_ci", "reconcile_ci", "repair_delivery", "reconcile_merge", "retry_capacity", "review_delivery", "publish_draft", "resolve_merge_conflict", "reconcile_acceptance", "retry_development"];

export class TaskRescueService {
  constructor(private readonly tasks: TaskService, private readonly database: ForgeDatabase, private readonly config: ForgeConfig) {}

  private task(actorUserId: string, taskId: string): ForgeTask {
    const admin = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_users WHERE id = ? AND role = 'admin' AND status = 'active'").get(actorUserId) as { id: string } | undefined);
    if (!admin) throw new TaskFailure("Not found", [], 404);
    return this.tasks.getTask(actorUserId, taskId);
  }

  private record(actorUserId: string, task: ForgeTask, name: string, outcome: RescueStep["outcome"], detail: string): RescueStep {
    const step = { name, outcome, detail };
    this.database.authQuery((db) => db.prepare("INSERT INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'task_rescue', ?, ?, ?)").run(`audit_rescue_${randomUUID()}`, actorUserId, task.companyId, JSON.stringify({ taskId: task.id, actionLabel: `Retry workflow: ${name}`, outcome, detail, revision: task.revision }), new Date().toISOString()));
    return step;
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

  async rescue(actorUserId: string, taskId: string): Promise<{ steps: RescueStep[] }> {
    const task = this.task(actorUserId, taskId);
    const steps: RescueStep[] = [];
    if (TERMINAL_PHASES.has(task.phase)) return { steps: [...steps, this.record(actorUserId, task, "Retry workflow", "skipped", "Task is already terminal.")] };
    try {
      const run = await createRunFromLatestSnapshot(getIssueEngine(this.config), task.workflowId);
      const command = retryCommands.find((candidate) => run.state.allowedCommands.includes(candidate));
      if (command) {
        await this.tasks.executeCommand(actorUserId, task.id, command, { expectedRevision: run.state.revision, commandId: randomUUID() });
        steps.push(this.record(actorUserId, task, "Retry current step", "completed", `Issued ${command}.`));
      } else steps.push(this.record(actorUserId, task, "Retry current step", "skipped", "No retry command is available for the current phase."));
    } catch (error) { steps.push(this.record(actorUserId, task, "Retry current step", "failed", error instanceof Error ? error.message.slice(0, 300) : "Could not restart workflow.")); }
    return { steps };
  }
}
