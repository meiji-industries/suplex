import { z } from "zod";
import { TaskToolSchema } from "../execution/contracts.js";

export const NativeHistoryTextPartSchema = z.object({
  id: z.string().min(1),
  type: z.literal("text"),
  text: z.string(),
});

export const NativeHistoryToolPartSchema = TaskToolSchema.extend({ type: z.literal("tool") });

export const NativeHistoryPartSchema = z.discriminatedUnion("type", [
  NativeHistoryTextPartSchema,
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

export type NativeHistoryMessage = z.infer<typeof NativeHistoryMessageSchema>;
export type SessionHistoryPage = z.infer<typeof SessionHistoryPageSchema>;
