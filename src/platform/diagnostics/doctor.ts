import type { ForgeConfig } from "../config.js";
import type { ForgeDatabase } from "../database.js";
import { createHostHealthDependencies } from "../host-health.js";
import { TaskControlStore } from "../../coordination/root-session-store.js";
import { z } from "zod";

export type DoctorCheck = { status: "PASS" | "WARN" | "FAIL"; name: string; detail: string };

export async function runDoctor(config: ForgeConfig, database: ForgeDatabase): Promise<DoctorCheck[]> {
  const schema = database.schemaStatus();
  const checks: DoctorCheck[] = [{
    status: schema.state === "current" ? "PASS" : "FAIL",
    name: "database schema",
    detail: `${schema.state} (${schema.applied.length}/${schema.expected.length} migrations)`,
  }];
  if (schema.state !== "current") return checks;
  const foreignKeys = database.authQuery(db => z.array(z.unknown()).parse(db.pragma("foreign_key_check")));
  checks.push({ status: foreignKeys.length ? "FAIL" : "PASS", name: "database references", detail: `${foreignKeys.length} invalid references` });
  const dependencies = createHostHealthDependencies(config, database);
  for (const read of Object.values(dependencies)) {
    const health = await read();
    checks.push({ status: health.status === "healthy" ? "PASS" : health.id === "herdr-readiness" ? "WARN" : "FAIL", name: health.label, detail: health.summary });
  }
  const store = new TaskControlStore(database);
  const taskIds = database.authQuery(db => z.array(z.object({ id: z.string() })).parse(db.prepare("SELECT id FROM forge_tasks WHERE archived_at IS NULL").all()));
  for (const { id } of taskIds) {
    try {
      const task = store.get(id);
      if (task.status === "waiting_human") checks.push({ status: "WARN", name: id, detail: task.humanQuestion ?? "Answer the task question" });
    } catch (error) {
      checks.push({ status: "FAIL", name: id, detail: error instanceof Error ? error.message : "Task control is not available" });
    }
  }
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map(check => `${check.status.padEnd(4)} ${check.name}: ${check.detail}\n`).join("");
}
