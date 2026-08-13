import { isApiError } from "./api.js";
import { ISSUE_PHASES, type IssuePhase } from "../../issue-phases.js";
import type { TaskResponse } from "../../http/contracts/tasks.js";

export type ApiProfile = { id: string; name: string; model: string; reasoningLevel: string; servicePriority: string; capacity: number | null; effectiveCapacity: number };
export type ApiModel = { id: string; displayName: string; description: string; status: "active" | "retired"; sortOrder: number };
export type ApiCheck = { name: string; status: string; conclusion?: string };
export type ApiInvitation = { id: string; kind: "bootstrap" | "user" | "recovery"; displayName: string; expiresAt: string; status: "active" | "expired" | "consumed" | "replaced"; createdAt: string };
export type ApiCredential = { id: string; userId: string; credentialId: string; createdAt: string; revokedAt?: string };
export type ApiProject = { id: string; companyId: string; name: string; repositoryPath: string; worktreeRoot: string; repository?: string; baseBranch: string; targetBranch: string; setupCommand: string; verificationCommand: string; requiredChecks: string[]; allowedProfileIds: string[]; roleDefaults: Record<string, string>; status: "draft" | "active" | "paused" | "needs-reactivation" | "archived"; configurationRevision: number; configurationIdentity?: string; baseSha?: string; targetSha?: string };
export type ApiAttentionAction = { command: string; label: string; expectedRevision: number; requiresNote: boolean; destructive: boolean };
export type ApiAttentionItem = { id: string; companyId: string; taskId: string; taskTitle: string; category: string; summary: string; sourceRevision: number; activatedAt: string; actions: ApiAttentionAction[]; evidence: { artifactId: string; sha256: string; kind: string; mimeType: string; byteSize: number; href: string } };
export type ApiAttentionCompany = { companyId: string; companyName: string; companyStatus: string; activeIssueCount: number; phases: Record<string, number>; attentionCount: number; attention: ApiAttentionItem[]; recentOutcomes: Array<{ taskId: string; taskTitle: string; phase: string; updatedAt: string }>; projectionHealth: { projectedRevision: number; sourceRevision: number; projectedAt: string; stateChangedAt: string | null; reconciledAt: string | null; status: "current" | "stale" | "unknown"; lagMs: number } };
export type ApiAttentionEvidence = { artifactId: string; sha256: string; kind: string; content: string; truncated: boolean };
export type ApiTask = TaskResponse;
export type TaskPhase = IssuePhase;
export type ApiCi = NonNullable<ApiTask["ci"]>;
export type ApiRelease = NonNullable<ApiTask["release"]>;

export const taskPhases = ISSUE_PHASES;

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
