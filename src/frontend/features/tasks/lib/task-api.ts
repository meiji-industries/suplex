import { readJsonUnchecked } from "../../../lib/api.js";
import type { Task, TaskInput } from "../../../contracts/tasks.js";
import type { TaskAgentSelectionRequest } from "../../../contracts/agent-selection.js";
import type { IssueAssociation } from "../../../contracts/issues.js";
import { TaskActivityResponseSchema, TaskDiffResponseSchema, TaskDiffSummaryResponseSchema, WorktreeAppsResponseSchema } from "../../../contracts/task-responses.js";
import { TaskExecutionResponseSchema } from "../../../contracts/task-execution.js";
import { TaskTimelineResponseSchema } from "../../../contracts/timeline.js";
import type { TaskActivityResponse } from "../../../contracts/generated/TaskActivityResponse.js";
import type { TaskExecutionResponse } from "../../../contracts/generated/TaskExecutionResponse.js";
import type { TaskDiffResponse } from "../../../contracts/generated/TaskDiffResponse.js";
import type { TaskDiffSummaryResponse } from "../../../contracts/generated/TaskDiffSummaryResponse.js";
import type { WorktreeApp } from "../../../contracts/generated/WorktreeApp.js";
import type { WorktreeAppsResponse } from "../../../contracts/generated/WorktreeAppsResponse.js";
import type { TimelineResponse } from "../../../contracts/generated/TimelineResponse.js";
import type { ArchiveConfirmation } from "../../../contracts/generated/ArchiveConfirmation.js";
import type { ProfileResponse } from "../../../contracts/projects.js";
import type { TaskSourceSummary } from "../task-source-picker.js";

export type TaskAction = "refresh" | "cancel" | "unarchive" | "disarm" | "start" | "force-start" | "answer";

const taskPath = (taskId: string, suffix = ""): string =>
  `/api/tasks/${encodeURIComponent(taskId)}${suffix}`;

export function getTask(taskId: string): Promise<Task> {
  return readJsonUnchecked<Task>(taskPath(taskId));
}

export async function listTaskProfiles(signal?: AbortSignal): Promise<ProfileResponse[]> {
  const result = await readJsonUnchecked<{ profiles: ProfileResponse[] }>("/api/profiles", signal ? { signal } : undefined);
  return result.profiles;
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

export type PullRequestSource = Extract<TaskSourceSummary, { kind: "pull_request" }>;

/** Open pull requests in the project's repository. `available` is false when the repository cannot be read. */
export function listPullRequestSources(projectId: string): Promise<{ available: boolean; sources: PullRequestSource[] }> {
  return readJsonUnchecked<{ available: boolean; sources: PullRequestSource[] }>(`/api/projects/${encodeURIComponent(projectId)}/task-sources?kind=pull_request`);
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

export async function readTaskActivity(taskId: string, signal: AbortSignal): Promise<TaskActivityResponse> {
  const result = await readJsonUnchecked<TaskActivityResponse>(taskPath(taskId, "/activity"), { signal });
  TaskActivityResponseSchema.parse(result);
  return result;
}

export async function readTaskExecution(taskId: string, signal: AbortSignal): Promise<TaskExecutionResponse> {
  const result = await readJsonUnchecked<TaskExecutionResponse>(taskPath(taskId, "/execution"), { signal });
  TaskExecutionResponseSchema.parse(result);
  return result;
}

export async function readTaskTimeline(taskId: string, signal: AbortSignal): Promise<TimelineResponse> {
  const result = await readJsonUnchecked<TimelineResponse>(taskPath(taskId, "/timeline"), { signal });
  TaskTimelineResponseSchema.parse(result);
  return result;
}

export async function listWorktreeApps(taskId: string): Promise<WorktreeAppsResponse> {
  const result = await readJsonUnchecked<WorktreeAppsResponse>(taskPath(taskId, "/worktree/apps"));
  WorktreeAppsResponseSchema.parse(result);
  return result;
}

export function openWorktree(taskId: string, app: WorktreeApp): Promise<{ ok: boolean; error?: string }> {
  return readJsonUnchecked<{ ok: boolean; error?: string }>(taskPath(taskId, "/worktree/open"), { method: "POST", body: JSON.stringify({ app }) });
}

export async function readTaskDiffSummary(taskId: string, signal: AbortSignal): Promise<TaskDiffSummaryResponse> {
  const result = await readJsonUnchecked<TaskDiffSummaryResponse>(taskPath(taskId, "/diff/summary"), { signal });
  TaskDiffSummaryResponseSchema.parse(result);
  return result;
}

export async function readTaskDiff(taskId: string, signal: AbortSignal): Promise<TaskDiffResponse> {
  const result = await readJsonUnchecked<TaskDiffResponse>(taskPath(taskId, "/diff"), { signal });
  TaskDiffResponseSchema.parse(result);
  return result;
}
