import { TaskInputSchema } from "../../contracts/tasks.js";
import type { z } from "zod";

// Workflow and Advisor selections are never remembered: every ordinary fresh task opens as Standard.
const SettingsSchema = TaskInputSchema.pick({ projectId: true, rootProfileId: true, workerProfileId: true, startImmediately: true, deliveryTarget: true, runProjectTests: true, visualEvidence: true }).partial({ projectId: true });
export type NewTaskMemory = z.input<typeof SettingsSchema>;
const storageKey = "suplex.newTask.lastSettings";

export function readNewTaskMemory(): NewTaskMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    // Memory written by another build with a repair workflow carries forced target/tests; drop them together.
    if (raw.workflow === "refine_pull_request") { delete raw.workflow; delete raw.advisorProfileIds; delete raw.deliveryTarget; delete raw.runProjectTests; }
    return SettingsSchema.parse(raw);
  }
  catch { return SettingsSchema.parse({}); }
}

export function writeNewTaskMemory(value: NewTaskMemory): void {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); }
  catch { /* Task creation also works when browser storage is disabled. */ }
}
