import { TaskInputSchema } from "../../contracts/tasks.js";
import { z } from "zod";

const { shape } = TaskInputSchema;
// Workflow, Advisor, start mode, and delivery target are never remembered: every ordinary fresh task
// opens as Standard with Run and open a PR. Older stored values for them are dropped on read.
// Memory holds only stored choices; the API defaults must not stand in for the dialog's own fallbacks.
const SettingsSchema = z.object({
  projectId: shape.projectId.optional(),
  rootProfileId: shape.rootProfileId,
  workerProfileId: shape.workerProfileId,
  runProjectTests: shape.runProjectTests.removeDefault().optional(),
  visualEvidence: shape.visualEvidence.removeDefault().optional(),
});
export type NewTaskMemory = z.input<typeof SettingsSchema>;
const storageKey = "suplex.newTask.lastSettings";

export function readNewTaskMemory(): NewTaskMemory {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    // Memory written by another build with a repair workflow carries forced target/tests; drop them together.
    if (raw.workflow === "refine_pull_request") { delete raw.workflow; delete raw.advisorProfileIds; delete raw.runProjectTests; }
    return SettingsSchema.parse(raw);
  }
  catch { return {}; }
}

export function writeNewTaskMemory(value: NewTaskMemory): void {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); }
  catch { /* Task creation also works when browser storage is disabled. */ }
}
