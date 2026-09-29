import { z } from "zod";

import { TaskToolSchema } from "./task-execution.js";

export const NativeHistoryTextPartSchema = z.object({
  id: z.string().min(1),
  type: z.literal("text"),
  text: z.string(),
});

export const NativeHistoryReasoningPartSchema = NativeHistoryTextPartSchema.extend({ type: z.literal("reasoning") });

export const NativeHistoryToolPartSchema = TaskToolSchema.extend({ type: z.literal("tool") });

export const NativeHistoryPartSchema = z.discriminatedUnion("type", [
  NativeHistoryTextPartSchema,
  NativeHistoryReasoningPartSchema,
  NativeHistoryToolPartSchema,
]);

export const NativeHistoryMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  createdAt: z.number().int().nonnegative().nullable(),
  content: z.array(NativeHistoryPartSchema),
});

export const SessionHistoryPageSchema = z.object({
  messages: z.array(NativeHistoryMessageSchema),
  olderCursor: z.string().min(1).nullable(),
});

export const SessionHistoryLiveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    page: SessionHistoryPageSchema,
    order: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal("update"),
    messages: z.array(NativeHistoryMessageSchema),
    removedIds: z.array(z.string().min(1)),
    order: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string().min(1),
  }),
]);

export type NativeHistoryMessage = z.infer<typeof NativeHistoryMessageSchema>;

export type SessionHistoryPage = z.infer<typeof SessionHistoryPageSchema>;

export type SessionHistoryLiveEvent = z.infer<typeof SessionHistoryLiveEventSchema>;
