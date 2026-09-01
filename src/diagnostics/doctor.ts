import { readdir, statfs } from "node:fs/promises";

import type { ForgeConfig } from "../config.js";
import type { ForgeDatabase } from "../database.js";
import { getIssueEngine } from "../engine/index.js";
import { IssueWorkflowStateSchema } from "../engine/issue-contracts.js";
import { loadPromptCatalog, type PromptTemplate } from "../prompts.js";
import { json } from "../task-utils.js";

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
  const failed = database.authQuery((db) => db.prepare("SELECT snapshot.task_id AS taskId, json_extract(snapshot.state_json, '$.lastHandlerError.reason') AS message FROM forge_workflow_snapshots snapshot JOIN (SELECT task_id, max(revision) AS revision FROM forge_workflow_snapshots GROUP BY task_id) latest ON latest.task_id = snapshot.task_id AND latest.revision = snapshot.revision WHERE json_extract(snapshot.state_json, '$.lastHandlerError') IS NOT NULL ORDER BY snapshot.task_id").all() as Array<{ taskId: string; message: string | null }>);
  checks.push({ status: failed.length ? "FAIL" : "PASS", name: "workflow errors", detail: failed.length ? failed.map((task) => `${task.taskId}: ${task.message ?? "unknown failure"}`).join("; ") : "none" });
  const disk = await statfs(config.databasePath);
  const free = Number(disk.bavail) * Number(disk.bsize);
  checks.push({ status: free > 1024 ** 3 ? "PASS" : "WARN", name: "disk headroom", detail: `${Math.floor(free / 1024 / 1024)} MiB free` });
  let catalog: ReadonlyMap<string, PromptTemplate> | undefined;
  try {
    catalog = loadPromptCatalog();
  } catch (error) {
    checks.push({ status: "FAIL", name: "project prompts", detail: `prompt catalog invalid: ${error instanceof Error ? error.message : "unknown error"}` });
  }
  if (catalog) {
    try {
      const projects = database.authQuery((db) => db.prepare("SELECT name, repository_path AS repositoryPath FROM forge_projects ORDER BY name").all() as Array<{ name: string; repositoryPath: string }>);
      const retiredDirectories: string[] = [];
      for (const project of projects) {
        try {
          await readdir(`${project.repositoryPath}/.forge/prompts`, { recursive: true });
          retiredDirectories.push(project.name);
        } catch (error) {
          if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
        }
      }
      const orphaned = database.authQuery((db) => db.prepare("SELECT scope_key AS scopeKey, template_id AS templateId FROM forge_prompt_overrides ORDER BY scope_key, template_id").all() as Array<{ scopeKey: string; templateId: string }>).filter((override) => !catalog.has(override.templateId));
      const warnings = [
        retiredDirectories.length ? `.forge/prompts/ no longer read — move to Project Settings: ${retiredDirectories.join(", ")}` : "",
        orphaned.length ? `orphaned DB overrides: ${orphaned.map(({ scopeKey, templateId }) => `${scopeKey}/${templateId}`).join(", ")}` : "",
      ].filter(Boolean);
      checks.push({ status: warnings.length ? "WARN" : "PASS", name: "project prompts", detail: warnings.length ? warnings.join("; ") : "no retired repository overrides or orphaned DB overrides" });
    } catch (error) {
      checks.push({ status: "FAIL", name: "project prompts", detail: error instanceof Error ? error.message : "diagnostic unavailable" });
    }
  }
  const snapshots = database.authQuery((db) => db.prepare("SELECT task_id taskId, workflow_id workflowId, state_json stateJson FROM forge_workflow_snapshots WHERE (task_id, revision) IN (SELECT task_id, max(revision) FROM forge_workflow_snapshots GROUP BY task_id)").all() as Array<{ taskId: string; workflowId: string; stateJson: string }>);
  const invalid = snapshots.filter((row) => !IssueWorkflowStateSchema.safeParse(json(row.stateJson, undefined)).success);
  checks.push({ status: invalid.length ? "FAIL" : "PASS", name: "engine snapshots", detail: invalid.length ? invalid.map((row) => row.taskId).join(", ") : `${snapshots.length} latest snapshot(s) parse` });
  const engine = getIssueEngine(config);
  const open = snapshots.filter((row) => !["done", "cancelled", "failed"].includes(String(json<Record<string, unknown>>(row.stateJson, {}).phase)));
  const missing = open.filter((row) => !engine.runs.has(row.workflowId));
  checks.push({ status: missing.length ? "WARN" : "PASS", name: "engine runs", detail: missing.length ? `${missing.length} open run(s) are not loaded` : `${engine.runs.size} run(s) loaded` });
  const inFlight = database.authQuery((db) => (db.prepare("SELECT count(*) count FROM forge_engine_activities").get() as { count: number }).count);
  checks.push({ status: "PASS", name: "in-flight activities", detail: `${inFlight}` });
  const orphanCount = database.authQuery((db) => Number((db.prepare("SELECT count(*) AS count FROM forge_developer_executions WHERE status IN ('completed', 'failed', 'cancelled') AND process_pid IS NOT NULL").get() as { count: number }).count));
  checks.push({ status: orphanCount ? "WARN" : "PASS", name: "terminal execution processes", detail: orphanCount ? `${orphanCount} terminal row(s) still retain a pid` : "none" });
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string { return `${checks.map((check) => `${check.status.padEnd(4)} ${check.name}: ${check.detail}`).join("\n")}\n`; }
