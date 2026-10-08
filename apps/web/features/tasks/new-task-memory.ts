import { TaskInputSchema } from "../../contracts/tasks.js";
import type { ApiWorkflow } from "../../shell/view-shared.js";
import { z } from "zod";

const { shape } = TaskInputSchema;
// The selected workflow is remembered by its record id and restored only while that record is live.
// Advisor, start mode, and delivery target are never remembered: they follow the restored workflow's defaults,
// else Run and open a PR. Older stored values for them, and the older engine-only workflow key, are dropped on read.
// Memory holds only stored choices; the API defaults must not stand in for the dialog's own fallbacks.
const SettingsSchema = z.object({
  projectId: shape.projectId.optional(),
  rootProfileId: shape.rootProfileId,
  workerProfileId: shape.workerProfileId,
  runProjectTests: shape.runProjectTests.removeDefault().optional(),
  visualEvidence: shape.visualEvidence.removeDefault().optional(),
  workflowId: z.string().min(1).optional(),
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

/** The remembered workflow record while it is live and the project's repository admits it; else none, so the dialog opens as Standard. */
export function rememberedWorkflow(records: ApiWorkflow[], id: string | undefined, repositoryKind: string | undefined): ApiWorkflow | undefined {
  if (!id) return undefined;
  return records.find(record => record.id === id && !record.archivedAt && (repositoryKind !== "bitbucket" || record.engine !== "refine_pull_request"));
}
