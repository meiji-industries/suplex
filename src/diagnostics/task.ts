import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { defaultPayloadConverter } from "@temporalio/common";

import type { ForgeConfig } from "../config.js";
import type { ForgeDatabase } from "../database.js";
import { connectTemporal } from "../temporal/service.js";
import { issueStateQuery } from "../temporal/workflows.js";
import { IssueWorkflowStateSchema } from "../temporal/issue-contracts.js";
import { jsonRequired } from "../task-utils.js";

const execFileAsync = promisify(execFile);

type RecordValue = Record<string, unknown>;
export type TaskDiagnostic = RecordValue;

function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function text(value: unknown): string | null { return typeof value === "string" ? value : value == null ? null : String(value); }
function json(value: unknown): unknown { try { return jsonRequired(String(value)); } catch { return value; } }
function iso(value: unknown): string | null {
  const seconds = record(value).seconds;
  if (seconds === undefined) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}
function failure(value: unknown): string | null {
  const item = record(value);
  return text(item.message) ?? (Object.keys(item).length ? JSON.stringify(item).slice(0, 500) : null);
}
function decodePayload(value: unknown): unknown {
  try { return defaultPayloadConverter.fromPayload(value as never); } catch { return undefined; }
}
function eventSummary(event: unknown): RecordValue {
  const item = record(event);
  const eventType = Object.keys(item).find((key) => key.endsWith("EventAttributes"));
  const attributes = eventType ? record(item[eventType]) : {};
  const activity = record(attributes.activityType).name;
  const payloads = record(attributes.result).payloads;
  const result = decodePayload(Array.isArray(payloads) ? payloads[0] : undefined);
  return {
    id: Number(item.eventId ?? 0),
    at: iso(item.eventTime),
    type: eventType?.replace(/EventAttributes$/, "") ?? "unknown",
    ...(typeof activity === "string" ? { activityType: activity } : {}),
    ...(result !== undefined ? { result: result && typeof result === "object" ? { outcome: record(result).outcome, summary: record(result).summary } : result } : {}),
    ...(failure(attributes.failure) ? { failure: failure(attributes.failure) } : {}),
  };
}

function processAlive(pid: number | null): boolean | null {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function projection(database: ForgeDatabase, taskId: string): RecordValue {
  const row = database.authQuery((db) => db.prepare(`SELECT t.id, t.title, t.workflow_id AS workflowId, p.revision, p.phase, p.owner, p.pending_action AS pendingAction, p.allowed_commands_json AS allowedCommands, p.last_run_id AS runId
    FROM forge_tasks t LEFT JOIN forge_issue_projections p ON p.task_id = t.id WHERE t.id = ?`).get(taskId)) as RecordValue | undefined;
  if (!row) throw new Error(`Task not found: ${taskId}`);
  return { ...row, allowedCommands: json(row.allowedCommands), allowedCommands_json: undefined };
}

function localRows(database: ForgeDatabase, taskId: string): Pick<TaskDiagnostic, "executions" | "capacity" | "commands"> {
  return database.authQuery((db) => {
    const executions = db.prepare(`SELECT id, 'developer' AS kind, status, attempt, process_pid AS pid, branch_name AS branch, result_commit AS resultCommit, failure_summary AS failure, worktree_path AS runtimeDir FROM forge_developer_executions WHERE task_id = ?
      UNION ALL SELECT id, 'agent' AS kind, status, 1 AS attempt, process_pid AS pid, NULL AS branch, NULL AS resultCommit, failure_summary AS failure, NULL AS runtimeDir FROM forge_agent_executions WHERE task_id = ? ORDER BY id DESC`).all(taskId, taskId) as RecordValue[];
    let capacity: RecordValue[] = [];
    try { capacity = db.prepare("SELECT id, status, execution_id AS executionId, lane_key AS laneKey, requested_capacity AS requestedCapacity, wait_reason AS waitReason FROM forge_capacity_requests WHERE task_id = ? ORDER BY updated_at DESC").all(taskId) as RecordValue[]; } catch { /* database predates durable capacity lanes */ }
    let commands: RecordValue[] = [];
    try { commands = db.prepare("SELECT command, step_id AS stepId, exit_code AS exitCode, duration_ms AS durationMs, finished_at AS finishedAt FROM forge_task_command_activity WHERE task_id = ? ORDER BY finished_at DESC LIMIT 20").all(taskId) as RecordValue[]; } catch { /* pre-command-runner database */ }
    return { executions: executions.map((entry) => ({ ...entry, alive: processAlive(Number(entry.pid) || null) })), capacity, commands };
  });
}

export async function inspectTask(config: ForgeConfig, database: ForgeDatabase, taskId: string, includeAllHistory = false): Promise<TaskDiagnostic> {
  const projected = projection(database, taskId);
  const result: TaskDiagnostic = { taskId, projection: projected, live: { available: false }, workflow: { status: "unavailable" }, history: [], ...localRows(database, taskId) };
  try {
    const temporal = await connectTemporal(config);
    try {
      const handle = temporal.client.workflow.getHandle(String(projected.workflowId), text(projected.runId) ?? undefined);
      const [rawState, description, history] = await Promise.all([handle.query(issueStateQuery), handle.describe(), handle.fetchHistory()]);
      const live = IssueWorkflowStateSchema.parse(rawState);
      const described = record(description);
      const pendingWorkflowTask = record(described.pendingWorkflowTask);
      const pendingActivities = (described.pendingActivities as unknown[] ?? []).map((activity) => {
        const item = record(activity);
        return { activityType: record(item.activityType).name ?? "unknown", attempt: Number(item.attempt ?? 0), lastFailure: failure(item.lastFailure) };
      });
      const events = (record(history).events as unknown[] ?? []).map(eventSummary);
      const differences = ["revision", "phase", "allowedCommands"].flatMap((key) => JSON.stringify(projected[key]) === JSON.stringify(live[key as keyof typeof live]) ? [] : [{ field: key, projection: projected[key], live: live[key as keyof typeof live] }]);
      result.live = { available: true, revision: live.revision, phase: live.phase, allowedCommands: live.allowedCommands, differences };
      const status = record(described.status).name ?? described.status ?? "unknown";
      result.workflow = { status, runId: described.runId, buildId: record(described.workerVersionStamp).buildId ?? null, pendingWorkflowTaskAgeSeconds: iso(pendingWorkflowTask.scheduledTime) ? Math.max(0, Math.floor((Date.now() - Date.parse(iso(pendingWorkflowTask.scheduledTime)!)) / 1000)) : null, lastFailure: failure(pendingWorkflowTask.failure), pendingActivities };
      result.history = includeAllHistory ? events : events.slice(-30);
    } finally { await temporal.connection.close(); }
  } catch (error) { result.live = { available: false, error: error instanceof Error ? error.message : "Temporal unavailable" }; }
  return result;
}

export function formatTaskDiagnostic(value: TaskDiagnostic): string {
  const projection = record(value.projection);
  const live = record(value.live);
  const workflow = record(value.workflow);
  const lines = [
    `TASK ${value.taskId}: ${projection.title ?? "untitled"}`,
    `projection  phase=${projection.phase ?? "?"} revision=${projection.revision ?? "?"} owner=${projection.owner ?? "?"} pending=${projection.pendingAction ?? "—"}`,
    `allowed     ${JSON.stringify(projection.allowedCommands ?? [])}`,
    `live        phase=${live.phase ?? "unavailable"} revision=${live.revision ?? "—"} allowed=${JSON.stringify(live.allowedCommands ?? [])}`,
    ...(Array.isArray(live.differences) && live.differences.length ? [`DIFF        ${JSON.stringify(live.differences)}`] : []),
    `workflow    status=${workflow.status ?? "unavailable"} build=${workflow.buildId ?? "—"} pending-age=${workflow.pendingWorkflowTaskAgeSeconds ?? "—"}s failure=${workflow.lastFailure ?? "—"}`,
    `executions  ${(value.executions as RecordValue[]).map((item) => `${item.id} ${item.status} pid=${item.pid ?? "—"}/${item.alive === null ? "—" : item.alive ? "alive" : "dead"} branch=${item.branch ?? "—"} commit=${item.resultCommit ?? "—"}`).join(" | ") || "none"}`,
    `capacity    ${(value.capacity as RecordValue[]).map((item) => `${item.id}:${item.status}`).join(" | ") || "none"}`,
    `commands    ${(value.commands as RecordValue[]).map((item) => `${item.exitCode ?? "?"} ${item.command}`).join(" | ") || "none"}`,
    `history     ${(value.history as RecordValue[]).map((item) => `#${item.id} ${item.type}${item.activityType ? `(${item.activityType})` : ""}`).join(" | ") || "none"}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function writeTaskBundle(config: ForgeConfig, database: ForgeDatabase, taskId: string): Promise<string> {
  const diagnostic = await inspectTask(config, database, taskId, true);
  const destination = resolve(".forge/bundles");
  const staging = await mkdtemp(join(tmpdir(), "forge-task-bundle-"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = join(destination, `${taskId}-${timestamp}.tar.gz`);
  try {
    await writeFile(join(staging, "projection.json"), `${JSON.stringify(diagnostic.projection, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(staging, "history.json"), `${JSON.stringify(diagnostic.history, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(staging, "activity.json"), `${JSON.stringify({ workflow: diagnostic.workflow, executions: diagnostic.executions, capacity: diagnostic.capacity }, null, 2)}\n`, { mode: 0o600 });
    for (const entry of diagnostic.executions as RecordValue[]) {
      const runtimeDir = text(entry.runtimeDir);
      if (!runtimeDir) continue;
      const source = resolve(runtimeDir);
      try { await access(source); await cp(source, join(staging, "executions", basename(source)), { recursive: true, filter: (path) => !/(secret|token|credential|\.env)/i.test(path) }); } catch { /* stale worktree paths are useful diagnostics, not bundle failures */ }
    }
    await (await import("node:fs/promises")).mkdir(destination, { recursive: true });
    await execFileAsync("tar", ["-C", staging, "-czf", archive, "."]);
    return relative(process.cwd(), archive);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
