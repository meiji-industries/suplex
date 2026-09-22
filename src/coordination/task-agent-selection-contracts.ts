import { z } from "zod";

const role = z.enum(["root", "worker", "reviewer", "planner_a", "planner_b", "rater"]);
const fields = { role, expectedProfileId: z.string().min(1), expectedSessionId: z.string().min(1).nullable(), profileId: z.string().min(1), direction: z.string().trim() };
export const TaskAgentSelectionRequestSchema = z.discriminatedUnion("resume", [
  z.object({ ...fields, resume: z.literal(false) }).strict(),
  z.object({ ...fields, resume: z.literal(true), questionId: z.string().min(1) }).strict(),
]);
export type TaskAgentSelectionRequest = z.infer<typeof TaskAgentSelectionRequestSchema>;
