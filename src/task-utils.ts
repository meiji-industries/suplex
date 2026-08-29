import { createHash, randomBytes } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { redact } from "./logging.js";
import type { RoleAssignments } from "./projects.js";

export { duplicateTitle } from "./duplicate-title.js";

export interface TaskFinding {
  code: string;
  field: string;
  message: string;
}

export function publicDeveloperSummary(kind: string, stepNumber: number | null, summary: string, exitCode: number | null): string {
  const step = stepNumber ? `Step ${stepNumber}` : "Step";
  const redacted = String(redact(summary)).trim().slice(0, 4_000);
  const detail = /\b(?:hidden|private|internal)\s+(?:reasoning|chain[- ]of[- ]thought)\b/i.test(redacted) ? "" : redacted;
  switch (kind) {
    case "agent_update": {
      try {
        const result = JSON.parse(detail) as { summary?: unknown };
        if (typeof result.summary === "string") return String(redact(result.summary)).slice(0, 2_000);
      } catch { /* Ordinary progress updates are plain text. */ }
      return detail || "Agent posted an update";
    }
    case "tool_call": return detail || "Agent used a tool";
    case "step_started": return `${step} started`;
    case "step_completed": return `${step} completed`;
    case "step_blocked": return `${step} blocked`;
    case "command_started": return detail ? `Running: ${detail}` : "Command started";
    case "command_finished": return detail ? `${exitCode === 0 ? "Ran" : "Command finished"}${exitCode === null ? "" : ` (exit ${exitCode})`}: ${detail}` : `Command finished${exitCode === null ? "" : ` (exit ${exitCode})`}`;
    case "test_result": return detail ? `Test ${exitCode === 0 ? "passed" : "finished"}${exitCode === null ? "" : ` (exit ${exitCode})`}: ${detail}` : `Test finished${exitCode === null ? "" : ` (exit ${exitCode})`}`;
    case "file_change": {
      const path = String(redact(summary)).trim();
      if (path.startsWith("/")) return "File changed: [path]";
      return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) && !path.split("/").includes("..") ? `File changed: ${path}` : "File changed";
    }
    case "git_snapshot": return "Git snapshot recorded";
    case "provider_observation": return "Provider observation recorded";
    case "process_started": return "Developer process started";
    case "process_finished": return "Developer process finished";
    case "reconciliation": return detail || "Developer reconciliation event";
    default: return "Developer activity";
  }
}

export function id(prefix: string): string { return `${prefix}_${randomBytes(12).toString("hex")}`; }
export function json<T>(raw: string, fallback: T): T;
export function json(raw: string, fallback: undefined): unknown;
export function json(raw: string, fallback: unknown): unknown { try { return JSON.parse(raw); } catch { return fallback; } }
export function jsonRequired(raw: string): any {
  const missing = Symbol("json-parse-failed");
  const value = json(raw, missing);
  if (value === missing) throw new SyntaxError("Invalid JSON");
  return value;
}
export function shaAbbrev(value: string | null): string | null { return value === null ? null : value.slice(0, 8); }
export function finding(code: string, field: string, message: string): TaskFinding { return { code, field, message }; }
export function parseImageIds(raw: string): string[] { return json<string[]>(raw, []).filter((value) => typeof value === "string"); }
export function parseRoleAgents(raw: string): RoleAssignments { return json<RoleAssignments>(raw, {}); }
export function parseMetadata(raw: string): Record<string, string | number | boolean> { return json<Record<string, string | number | boolean>>(raw, {}); }
export function normalizeText(value: string): string { return value.trim().replace(/\r\n?/g, "\n"); }
export function creationRequestHash(input: { companyId: string; projectId: string; title: string; description: string; imageHashes: string[]; roleAgents: RoleAssignments; supplementalReview: boolean; autoApprovePlan: boolean; deliveryTarget: "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged"; runProjectTests: boolean; visualEvidence: "off" | "capture" | "required"; projectRevisionId: string; authorityKind?: string; creatorId?: string; source?: { kind: "pull_request"; number: number } | { kind: "branch"; branch: string } }): string {
  const roles = Object.fromEntries(Object.entries(input.roleAgents).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(canonicalJson({ companyId: normalizeText(input.companyId), projectId: normalizeText(input.projectId), title: normalizeText(input.title), description: normalizeText(input.description), imageHashes: input.imageHashes, roleAgents: roles, supplementalReview: input.supplementalReview, autoApprovePlan: input.autoApprovePlan, deliveryTarget: input.deliveryTarget, runProjectTests: input.runProjectTests, visualEvidence: input.visualEvidence, projectRevisionId: normalizeText(input.projectRevisionId), ...(input.authorityKind ? { authorityKind: input.authorityKind } : {}), ...(input.creatorId ? { creatorId: input.creatorId } : {}), ...(input.source ? { source: input.source } : {}) })).digest("hex");
}
