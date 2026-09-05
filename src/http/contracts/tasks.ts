import { z } from "zod";
import { TaskInputSchema, TaskSchema } from "../../task-contracts.js";
import { TaskSessionKindSchema, TaskTurnStatusSchema } from "../../task-control.js";

export { DeliveryTargetSchema, VisualEvidenceSchema } from "../../task-contracts.js";
export { MAX_TASK_REQUEST_BYTES } from "../../task-attachment-limits.js";
export const TaskBodySchema = TaskInputSchema;
export const TaskResponseSchema = TaskSchema.strip();
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export const TaskListResponseSchema = z.object({ tasks: z.array(TaskResponseSchema) });
export type TaskListTask = TaskResponse;
export const TaskDetailsBodySchema = TaskInputSchema.pick({ title: true, description: true }).partial().strict();
export const TaskAnswerBodySchema = z.object({ questionId: z.string().min(1), answer: z.string().trim().min(1), confirmCommandsStopped: z.boolean().optional() }).strict();
export const TaskNoteBodySchema = z.object({ note: z.string().trim().min(1) }).strict();
export const TaskActivityResponseSchema = z.object({
  sessions: z.array(z.object({ id: z.string(), kind: TaskSessionKindSchema, generation: z.number(), nativeSessionId: z.string().nullable(), paneId: z.string().nullable(), current: z.boolean() })),
  turns: z.array(z.object({ id: z.string(), sessionId: z.string(), prompt: z.string(), status: TaskTurnStatusSchema, result: z.string().nullable() })),
});

export const TaskDiffResponseSchema = z.object({ available: z.boolean(), patch: z.string(), truncated: z.boolean() });
export const TaskChecksResponseSchema = z.object({
  available: z.boolean(),
  runs: z.array(z.object({ name: z.string(), status: z.enum(["pending", "failing", "successful"]), url: z.string().nullable() })),
});
