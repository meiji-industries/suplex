import { readdir, statfs } from "node:fs/promises";

import { Worker } from "@temporalio/worker";

import type { ForgeConfig } from "../config.js";
import type { ForgeDatabase } from "../database.js";
import { buildProductionWorkflowBundle, temporalDataConverter, workflowBundleBuildId } from "../temporal/workflow-bundle.js";
import { connectTemporal } from "../temporal/service.js";
import { inspectTask } from "./task.js";
import { loadDefaultPrompts, PROMPT_PATHS } from "../prompts.js";

export type DoctorCheck = { status: "PASS" | "WARN" | "FAIL"; name: string; detail: string };

export async function runDoctor(config: ForgeConfig, database: ForgeDatabase, options: { fix?: boolean } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const schema = database.schemaStatus();
  if (options.fix && schema.state === "behind") {
    throw new Error("forge doctor --fix refused: database is behind this build — restart the stack to migrate");
  }
  const unknownApplied = schema.applied.filter((migration) => !schema.expected.some((expected) => expected.hash === migration.hash));
  const unknownNames = unknownApplied.map((migration) => `migration-${migration.createdAt} (${migration.hash})`);
  checks.push({
    status: schema.state === "current" ? "PASS" : schema.state === "ahead" ? "WARN" : "FAIL",
    name: "database schema",
    detail: schema.state === "ahead"
      ? `ahead (${schema.applied.length}/${schema.expected.length} migrations); build lacks ${unknownNames.join(", ") || "an applied migration"}`
      : `${schema.state} (${schema.applied.length}/${schema.expected.length} migrations)`,
  });
  const journal = database.authQuery((db) => String(db.pragma("journal_mode", { simple: true })));
  checks.push({ status: journal.toLowerCase() === "wal" ? "PASS" : "WARN", name: "sqlite WAL", detail: journal });
  const stalled = database.authQuery((db) => db.prepare("SELECT task_id AS taskId, projection_status_message AS message FROM forge_issue_projections WHERE projection_status = 'stalled' ORDER BY task_id").all() as Array<{ taskId: string; message: string | null }>);
  checks.push({ status: stalled.length ? "FAIL" : "PASS", name: "stalled workflows", detail: stalled.length ? stalled.map((task) => `${task.taskId}: ${task.message ?? "unknown failure"}`).join("; ") : "none" });
  const disk = await statfs(config.databasePath);
  const free = Number(disk.bavail) * Number(disk.bsize);
  checks.push({ status: free > 1024 ** 3 ? "PASS" : "WARN", name: "disk headroom", detail: `${Math.floor(free / 1024 / 1024)} MiB free` });
  try {
    loadDefaultPrompts();
    const projects = database.authQuery((db) => db.prepare("SELECT name, repository_path AS repositoryPath FROM forge_projects ORDER BY name").all() as Array<{ name: string; repositoryPath: string }>);
    const unknownOverrides: string[] = [];
    for (const project of projects) {
      try {
        const files = await readdir(`${project.repositoryPath}/.forge/prompts`, { recursive: true });
        for (const file of files) {
          if (typeof file !== "string" || !file.endsWith(".md")) continue;
          if (!PROMPT_PATHS.includes(file as typeof PROMPT_PATHS[number])) unknownOverrides.push(`${project.name}: ${file}`);
        }
      } catch (error) {
        if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
    checks.push({ status: unknownOverrides.length ? "WARN" : "PASS", name: "project prompts", detail: unknownOverrides.length ? `unknown overrides: ${unknownOverrides.join(", ")}` : "all overrides match defaults" });
  } catch (error) {
    checks.push({ status: "FAIL", name: "project prompts", detail: `default prompts invalid: ${error instanceof Error ? error.message : "unknown error"}` });
  }
  const open = database.authQuery((db) => db.prepare("SELECT id FROM forge_tasks WHERE id IN (SELECT task_id FROM forge_issue_projections WHERE phase NOT IN ('done', 'cancelled'))").all() as Array<{ id: string }>);
  try {
    const temporal = await connectTemporal(config);
    try {
      const pollers = await temporal.connection.workflowService.describeTaskQueue({ namespace: config.temporalNamespace, taskQueue: { name: config.taskQueue }, taskQueueType: 1, includeTaskQueueStatus: true } as never);
      const bundle = await buildProductionWorkflowBundle();
      const buildId = workflowBundleBuildId(config.installationId, bundle);
      checks.push({ status: (pollers.pollers?.length ?? 0) > 0 ? "PASS" : "WARN", name: "API + worker pollers", detail: `${pollers.pollers?.length ?? 0} poller(s), current build ${buildId}` });
      const replayFailures: string[] = [];
      for (const task of open) {
        try {
          const report = await inspectTask(config, database, task.id);
          const workflowId = String((report.projection as Record<string, unknown>).workflowId);
          const history = await temporal.client.workflow.getHandle(workflowId).fetchHistory();
          await Worker.runReplayHistory({ workflowBundle: bundle, dataConverter: temporalDataConverter }, history, workflowId);
          const differences = (report.live as Record<string, unknown>).differences;
          if (options.fix && Array.isArray(differences) && differences.length > 0) {
            // Projection repair is intentionally delegated to the existing Rescue service/UI: never reset on a failed replay.
            checks.push({ status: "WARN", name: `projection ${task.id}`, detail: "disagrees with live state; use Rescue to resync" });
          }
        } catch (error) { replayFailures.push(`${task.id}: ${error instanceof Error ? error.message : "unknown replay failure"}`); }
      }
      checks.push({ status: replayFailures.length ? "FAIL" : "PASS", name: "replay open workflows", detail: replayFailures.length ? replayFailures.join("; ") : `${open.length} workflow(s) compatible` });
    } finally { await temporal.connection.close(); }
  } catch (error) { checks.push({ status: "FAIL", name: "Temporal API", detail: error instanceof Error ? error.message : "unavailable" }); }
  const orphanCount = database.authQuery((db) => Number((db.prepare("SELECT count(*) AS count FROM forge_developer_executions WHERE status IN ('completed', 'failed', 'cancelled') AND process_pid IS NOT NULL").get() as { count: number }).count));
  checks.push({ status: orphanCount ? "WARN" : "PASS", name: "terminal execution processes", detail: orphanCount ? `${orphanCount} terminal row(s) still retain a pid` : "none" });
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string { return `${checks.map((check) => `${check.status.padEnd(4)} ${check.name}: ${check.detail}`).join("\n")}\n`; }
