import { createHash } from "node:crypto";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const TaskControlStatusSchema = z.enum(["active", "waiting_human", "cancelled", "delivered"]);
export const TaskSessionKindSchema = z.enum(["root", "worker"]);
export const TaskSessionLifecycleSchema = z.enum(["reserved", "live", "stopped", "unknown", "cancelled"]);
export const TaskTurnStatusSchema = z.enum(["pending_prompt", "prompted", "unknown", "completed", "cancelled"]);
export const TaskProfileSchema = z.object({ profileId: z.string().min(1), provider: z.enum(["codex", "claude"]), model: z.string().min(1), reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]), serviceTier: z.enum(["default", "priority", "fast"]) }).strict();

export const WorktreeReferenceSchema = z.object({
  path: z.string().min(1), branch: z.string().min(1), baseSha: z.string().min(1), headSha: z.string().min(1), dirty: z.boolean(),
}).strict();
export const PullRequestReferenceSchema = z.object({
  repository: z.string().min(1), number: z.number().int().positive(), url: z.string().url(), headSha: z.string().min(1), state: z.string().min(1), mergedAt: z.string().datetime().nullable(),
}).strict();

export type WorktreeReference = z.infer<typeof WorktreeReferenceSchema>;
export type PullRequestReference = z.infer<typeof PullRequestReferenceSchema>;
export type TaskControlStatus = z.infer<typeof TaskControlStatusSchema>;
export type TaskSessionKind = z.infer<typeof TaskSessionKindSchema>;
export type TaskSessionLifecycle = z.infer<typeof TaskSessionLifecycleSchema>;
export type TaskTurnStatus = z.infer<typeof TaskTurnStatusSchema>;
export type TaskProfile = z.infer<typeof TaskProfileSchema>;

export interface TaskControl {
  taskId: string;
  objective: string;
  deliveryTarget: string;
  status: TaskControlStatus;
  wakeAt: string | null;
  humanQuestion: string | null;
  worktree: WorktreeReference | null;
  pullRequest: PullRequestReference | null;
  rootSessionId: string | null;
  workerSessionId: string | null;
  rootProfile: TaskProfile;
  workerProfile: TaskProfile;
}

export interface TaskSession {
  id: string;
  taskId: string;
  kind: TaskSessionKind;
  generation: number;
  current: boolean;
  paneId: string | null;
  agentName: string | null;
  nativeSessionId: string | null;
  lifecycle: TaskSessionLifecycle;
  assignmentHash: string | null;
  promptHash: string | null;
  resultReceiptId: string | null;
}

export interface TaskTurn {
  id: string;
  taskId: string;
  sessionId: string;
  generation: number;
  assignmentHash: string | null;
  promptHash: string;
  promptText: string;
  status: TaskTurnStatus;
  resultReceiptId: string | null;
  terminalObservation: string | null;
}

export function taskPromptHash(value: string): string {
  return sha256.parse(createHash("sha256").update(value).digest("hex"));
}
