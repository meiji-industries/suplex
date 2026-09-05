import { TaskInputSchema } from "../../../task-contracts.js";
import type { z } from "zod";

const SettingsSchema = TaskInputSchema.pick({ projectId: true, rootProfileId: true, workerProfileId: true, startImmediately: true, deliveryTarget: true, runProjectTests: true, visualEvidence: true }).partial({ projectId: true });
export type NewTaskMemory = z.input<typeof SettingsSchema>;
const storageKey = "forge.newTask.lastSettings";

export function readNewTaskMemory(): NewTaskMemory {
  try { return SettingsSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); }
  catch { return SettingsSchema.parse({}); }
}

export function writeNewTaskMemory(value: NewTaskMemory): void {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); }
  catch { /* Task creation also works when browser storage is disabled. */ }
}
