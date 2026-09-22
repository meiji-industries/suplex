import { z } from "zod";

export const CoordinatorReplacementRequestSchema = z.discriminatedUnion("resume", [
  z.object({ sessionId: z.string().min(1), rootProfileId: z.string().min(1), handoff: z.string().trim().max(20_000).optional(), resume: z.literal(false) }).strict(),
  z.object({ sessionId: z.string().min(1), rootProfileId: z.string().min(1), handoff: z.string().trim().max(20_000).optional(), resume: z.literal(true), questionId: z.string().min(1) }).strict(),
]);
export type CoordinatorReplacementRequest = z.infer<typeof CoordinatorReplacementRequestSchema>;
