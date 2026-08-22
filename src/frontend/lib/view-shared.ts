import { isApiError } from "./api.js";
import { ISSUE_PHASES, type IssuePhase } from "../../issue-phases.js";
import type { AttentionActionResponse, AttentionItemResponse, CompanyAttentionResponse } from "../../http/contracts/attention.js";
import type { CredentialResponse, InvitationSummaryResponse } from "../../http/contracts/common.js";
import type { AgentResponse, ModelResponse, ProfileResponse, ProjectCheckResponse, ProjectResponse } from "../../http/contracts/projects.js";
import type { HermesAdminAgent } from "../../http/contracts/hermes.js";
import type { TaskResponse } from "../../http/contracts/tasks.js";

export type ApiProfile = ProfileResponse;
export type ApiAgent = AgentResponse;
export type ApiHermesAgent = HermesAdminAgent;
export type ApiModel = ModelResponse;
export type ApiCheck = ProjectCheckResponse;
export type ApiInvitation = InvitationSummaryResponse;
export type ApiCredential = CredentialResponse;
export type ApiProject = ProjectResponse;
export type ApiAttentionAction = AttentionActionResponse;
export type ApiAttentionItem = AttentionItemResponse;
export type ApiAttentionCompany = CompanyAttentionResponse;
export type ApiTask = TaskResponse;
export type TaskPhase = IssuePhase;
export type ApiCi = NonNullable<ApiTask["ci"]>;
export type ApiRelease = NonNullable<ApiTask["release"]>;

export const taskPhases = ISSUE_PHASES;

export function taskActionPayload(expectedRevision: number, note?: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return "expectedWorkflowRevision" in payload ? payload : { expectedRevision, ...(note ? { note } : {}), ...payload };
}

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
