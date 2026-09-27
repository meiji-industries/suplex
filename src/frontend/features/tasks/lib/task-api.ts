import { readJsonUnchecked } from "../../../lib/api.js";
import type { Task, TaskInput } from "../../../contracts/tasks.js";
import type { TaskAgentSelectionRequest } from "../../../contracts/agent-selection.js";
import type { IssueAssociation } from "../../../contracts/issues.js";
import type { ArchiveConfirmation } from "../../../contracts/generated/ArchiveConfirmation.js";

export type TaskAction = "refresh" | "cancel" | "unarchive" | "disarm" | "start" | "answer";

const taskPath = (taskId: string, suffix = ""): string =>
  `/api/tasks/${encodeURIComponent(taskId)}${suffix}`;

export function getTask(taskId: string): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId));
}

export async function listTasks(
  companyId: string,
  options: { archived?: boolean; signal?: AbortSignal } = {},
): Promise<Task[]> {
  const query = options.archived === undefined ? "" : `?archived=${options.archived}`;
  const result = await readJsonUnchecked<{ tasks: Task[] }>(
    `/api/companies/${encodeURIComponent(companyId)}/tasks${query}`,
    options.signal ? { signal: options.signal } : undefined,
  );
  return result.tasks;
}

export function createTask(companyId: string, body: TaskInput): Promise<Task> {
  return readJsonUnchecked<Task>(`/api/companies/${encodeURIComponent(companyId)}/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type TaskUpdate = Partial<
  Pick<
    TaskInput,
    | "title"
    | "description"
    | "deliveryTarget"
    | "runProjectTests"
    | "visualEvidence"
    | "workflow"
    | "advisorProfileIds"
    | "rootProfileId"
    | "workerProfileId"
  >
>;

export function updateTask(taskId: string, body: TaskUpdate): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId), { method: "PATCH", body: JSON.stringify(body) });
}

export function runTaskAction(taskId: string, action: TaskAction, body?: unknown): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId, `/${action}`), {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function renameTask(taskId: string, title: string): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId, "/rename"), { method: "POST", body: JSON.stringify({ title }) });
}

export function setTaskIssue(taskId: string, issue: IssueAssociation | null): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId, "/issue"), { method: "PATCH", body: JSON.stringify({ issue }) });
}

export function setTaskDependencies(taskId: string, dependsOn: string[], pullRequestNumbers: number[]): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId, "/dependencies"), {
    method: "PUT",
    body: JSON.stringify({ dependsOn, blockedByPullRequests: pullRequestNumbers.map(number => ({ number })) }),
  });
}

export function addTaskNote(taskId: string, note: string): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId, "/note"), { method: "POST", body: JSON.stringify({ note }) });
}

export function selectTaskAgent(taskId: string, body: TaskAgentSelectionRequest): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId, "/select-agent"), { method: "POST", body: JSON.stringify(body) });
}

export function continueTaskDelivery(taskId: string, deliveryTarget: Task["deliveryTarget"]): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId, "/continue-delivery"), {
    method: "POST",
    body: JSON.stringify({ deliveryTarget }),
  });
}

export async function archiveTask(taskId: string, confirmDiscardDirty: boolean): Promise<Task | ArchiveConfirmation> {
  return readJsonUnchecked<Task | ArchiveConfirmation>(taskPath(taskId, "/archive"), {
    method: "POST",
    body: JSON.stringify({ confirmDiscardDirty }),
  });
}

export function isArchiveConfirmation(result: Task | ArchiveConfirmation): result is ArchiveConfirmation {
  return "dirtyFilePaths" in result;
}
