import { z } from "zod";
import type { TaskListItem } from "./generated/TaskListItem.js";

import { TaskSchema } from "./tasks.js";

import { TaskSessionKindSchema, TaskTurnStatusSchema } from "./task-control.js";

import { AdvisorRoleSchema } from "./advisor-reports.js";

import { HarnessKindSchema } from "./harness-kind.js";

import { WorkerReplacementSchema } from "./worker-replacement.js";

export const TaskResponseSchema = TaskSchema.strip();

export type { TaskResponse } from "./generated/TaskResponse.js";

export type TaskListTask = TaskListItem;


export const TaskHarnessKindSchema = HarnessKindSchema;

export const TaskSetupSchema = z.object({ state: z.enum(["none", "running", "succeeded", "failed"]), exitStatus: z.string().nullable() });

export const TaskActivityResponseSchema = z.object({
  setup: TaskSetupSchema,
  sessions: z.array(z.object({ id: z.string(), kind: TaskSessionKindSchema, advisorRole: AdvisorRoleSchema.nullable(), label: z.string(), profileId: z.string(), harness: TaskHarnessKindSchema.optional(), generation: z.number(), nativeSessionId: z.string().nullable(), paneId: z.string().nullable(), current: z.boolean(), replacement: WorkerReplacementSchema.nullable().optional() })),
  turns: z.array(z.object({ id: z.string(), sessionId: z.string(), prompt: z.string(), status: TaskTurnStatusSchema, promptedAt: z.string().datetime().nullable(), completedAt: z.string().datetime().nullable(), result: z.string().nullable(), assignment: z.object({ mode: z.enum(["planned", "direct"]), purpose: z.enum(["implementation", "verification"]), plan: z.string().nullable(), acceptanceCriteria: z.array(z.string()), instruction: z.string() }).nullable() })),
  shellPaneId: z.string().nullable(),
});

export const TaskDiffResponseSchema = z.object({ available: z.boolean(), patch: z.string(), truncated: z.boolean() });

export const TaskDiffSummaryResponseSchema = z.object({ available: z.boolean(), files: z.number().int().nonnegative() });

export const TaskAgentStatusSchema = z.enum(["queued", "working", "retrying", "idle", "waiting_human", "stopped", "unknown"]);

export const TaskAgentsResponseSchema = z.object({ setup: TaskSetupSchema, agents: z.array(z.object({ id: z.string(), role: TaskSessionKindSchema, advisorRole: AdvisorRoleSchema.nullable().optional(), label: z.string().optional(), paneId: z.string().nullable(), status: TaskAgentStatusSchema, statusChangedAt: z.string().datetime().nullable() })) });

export const TaskAgentsBatchResponseSchema = z.object({ tasks: z.array(z.object({ taskId: z.string(), setup: TaskSetupSchema, agents: TaskAgentsResponseSchema.shape.agents })) });

export const TaskChecksResponseSchema = z.object({
  available: z.boolean(),
  pullRequestState: z.enum(["draft", "ready", "closed", "merged"]).nullable().optional(),
  runs: z.array(z.object({ name: z.string(), status: z.enum(["pending", "failing", "successful"]), url: z.string().nullable(), conclusion: z.string().optional(), workflow: z.string().nullable().optional(), startedAt: z.string().datetime().nullable().optional(), completedAt: z.string().datetime().nullable().optional() })),
});

export const WorktreeAppSchema = z.enum(["finder", "cursor", "vscode", "devin", "xcode", "ghostty", "iterm", "terminal", "antigravity", "conductor"]);

export const WorktreeAppsResponseSchema = z.object({ apps: z.array(z.object({ id: WorktreeAppSchema, label: z.string(), icon: z.string().startsWith("data:image/png;base64,").nullable() })) });
