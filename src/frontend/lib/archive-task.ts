import { readJson, withCompany } from "./api.js";

export type TaskArchiveOutcome =
  | { status: "archived"; redirectPath: string }
  | { status: "confirmation_required"; dirtyFileCount: number };

export async function requestTaskArchive(
  input: { taskId: string; companyId: string; expectedRevision: number; confirmDiscardDirty: boolean; returnTo: "tasks" | "board" },
  options: { request?: <T>(url: string, init?: RequestInit) => Promise<T> } = {},
): Promise<TaskArchiveOutcome> {
  const request = options.request ?? readJson;
  const result = await request<{ status: "archived" } | { status: "confirmation_required"; dirtyFileCount: number }>(
    `/api/tasks/${encodeURIComponent(input.taskId)}/archive`,
    { method: "POST", body: JSON.stringify({ expectedRevision: input.expectedRevision, confirmDiscardDirty: input.confirmDiscardDirty }) },
  );
  if (result.status === "confirmation_required") return result;
  return { status: "archived", redirectPath: withCompany(`/${input.returnTo}`, input.companyId) };
}
