import { readJson } from "./api.js";
import type { Task } from "../../task-contracts.js";

export async function readTaskList(companyId: string, archived = false): Promise<Task[]> {
  return (await readJson<{ tasks: Task[] }>(`/api/companies/${encodeURIComponent(companyId)}/tasks?archived=${archived}`)).tasks;
}
