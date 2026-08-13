import { isApiError } from "./api.js";
import { ISSUE_PHASES, type IssuePhase } from "../../issue-phases.js";
import type { AttentionActionResponse, AttentionEvidenceResponse, AttentionItemResponse, CompanyAttentionResponse } from "../../http/contracts/attention.js";
import type { CredentialResponse, InvitationSummaryResponse } from "../../http/contracts/common.js";
import type { ModelResponse, ProfileResponse, ProjectCheckResponse, ProjectResponse } from "../../http/contracts/projects.js";
import type { TaskResponse } from "../../http/contracts/tasks.js";

export type ApiProfile = ProfileResponse;
export type ApiModel = ModelResponse;
export type ApiCheck = ProjectCheckResponse;
export type ApiInvitation = InvitationSummaryResponse;
export type ApiCredential = CredentialResponse;
export type ApiProject = ProjectResponse;
export type ApiAttentionAction = AttentionActionResponse;
export type ApiAttentionItem = AttentionItemResponse;
export type ApiAttentionCompany = CompanyAttentionResponse;
export type ApiAttentionEvidence = AttentionEvidenceResponse;
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

export function relativeTime(timestamp: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (elapsed < 10_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}
