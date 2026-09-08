import { z } from "zod";
import type { HumanQuestionOptions } from "./human-question.js";
import type { AdvisorRole, WorkflowId, WorkflowInput, WorkflowState } from "./workflows.js";


export const TaskControlStatusSchema = z.enum(["backlog", "active", "waiting_human", "cancelled", "delivered"]);
export const TaskSessionKindSchema = z.enum(["root", "worker"]);
export const TaskSessionLifecycleSchema = z.enum(["reserved", "live", "stopped", "unknown", "cancelled"]);
export const TaskTurnStatusSchema = z.enum(["pending_prompt", "prompted", "unknown", "completed", "cancelled"]);
export const PromptDispatchAttemptSchema = z.object({ serverGeneration: z.string().uuid(), claimedAt: z.string().datetime() }).strict();
export type PromptDispatchAttempt = z.infer<typeof PromptDispatchAttemptSchema>;
export const TaskProfileSchema = z.object({ profileId: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]), serviceTier: z.enum(["default", "priority"]) }).strict();

export const WorktreeReferenceSchema = z.object({
  path: z.string().min(1), branch: z.string().min(1), baseSha: z.string().min(1), headSha: z.string().min(1), dirty: z.boolean(),
}).strict();
export const PullRequestReferenceSchema = z.object({
  repository: z.string().min(1), number: z.number().int().positive(), url: z.string().url(), headSha: z.string().min(1), state: z.string().min(1), mergedAt: z.string().datetime().nullable(),
}).strict();
export const DeliveryIntentSchema = z.object({
  repository: z.string().min(1),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  baselineSha: z.string().min(1),
  pullRequestNumber: z.number().int().positive().nullable(),
}).strict();

export type WorktreeReference = z.infer<typeof WorktreeReferenceSchema>;
export type PullRequestReference = z.infer<typeof PullRequestReferenceSchema>;
export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;
export type TaskControlStatus = z.infer<typeof TaskControlStatusSchema>;
export type TaskSessionKind = z.infer<typeof TaskSessionKindSchema>;
export type TaskSessionLifecycle = z.infer<typeof TaskSessionLifecycleSchema>;
export type TaskTurnStatus = z.infer<typeof TaskTurnStatusSchema>;
export type TaskProfile = z.infer<typeof TaskProfileSchema>;

export interface TaskControl {
  taskId: string;
  objective: string;
  deliveryTarget: string;
  deliveryIntent: DeliveryIntent;
  status: TaskControlStatus;
  wakeAt: string | null;
  humanQuestion: string | null;
  humanQuestionOptions?: HumanQuestionOptions;
  humanQuestionId: string | null;
  recoveryTurnId: string | null;
  worktree: WorktreeReference | null;
  pullRequest: PullRequestReference | null;
  rootSessionId: string | null;
  workerSessionId: string | null;
  rootProfile: TaskProfile;
  workerProfile: TaskProfile;
  workflow: WorkflowId;
  advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>>;
  workflowState: WorkflowState;
}

export interface TaskSession {
  id: string;
  taskId: string;
  kind: TaskSessionKind;
  generation: number;
  current: boolean;
  paneId: string | null;
  nativeSessionId: string | null;
  lifecycle: TaskSessionLifecycle;
  assignmentHash: string | null;
  launchOwner: string | null;
  launchOwnerPid: number | null;
  launchOwnerStartTime: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  advisorRole: AdvisorRole | null;
  delegateSlot?: string | null;
  workflowInput: WorkflowInput | null;
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
  nativeTurnId: string | null;
  dispatchAttempt: PromptDispatchAttempt | null;
  workflowInput: WorkflowInput | null;
}
