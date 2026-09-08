import { isApiError } from "../lib/api.js";
import type { CredentialResponse, InvitationSummaryResponse } from "../../http/contracts/common.js";
import type { ModelResponse, ProfileResponse, ProjectResponse } from "../../http/contracts/projects.js";
import type { HermesAdminAgent } from "../../http/contracts/hermes.js";
import type { TaskListTask, TaskResponse } from "../../http/contracts/tasks.js";
import type { TaskTemplateResponse } from "../../http/contracts/task-templates.js";
import type { WorkflowRecord } from "../../http/contracts/workflows.js";

export type ApiProfile = ProfileResponse;
export type ApiWorkflow = WorkflowRecord;
export type ApiHermesAgent = HermesAdminAgent;
export type ApiModel = ModelResponse;
export type ApiInvitation = InvitationSummaryResponse;
export type ApiCredential = CredentialResponse;
export type ApiProject = ProjectResponse;
export type ApiTask = TaskResponse;
export type ApiTaskSummary = TaskListTask;
export type ApiTaskTemplate = TaskTemplateResponse;

export async function reconcileScopedNotFound(reason: unknown, reloadCompanies: () => Promise<void>): Promise<boolean> {
  if (!isApiError(reason, 404)) return false;
  await reloadCompanies();
  return true;
}
export function adminDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

export function relativeTime(timestamp: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}${minutes % 60 ? ` ${minutes % 60}m` : ""} ago`;
}
