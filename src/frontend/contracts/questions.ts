import { z } from "zod";

export const HumanQuestionOptionSchema = z.object({
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  recommended: z.boolean(),
}).strict();

export const HumanQuestionOptionsSchema = z.array(HumanQuestionOptionSchema).max(4);
