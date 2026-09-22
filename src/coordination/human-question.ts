import { z } from "zod";

export const HumanQuestionOptionSchema = z.object({
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  recommended: z.boolean(),
}).strict();
export const HumanQuestionOptionsSchema = z.array(HumanQuestionOptionSchema).max(4);
export type HumanQuestionOptions = z.infer<typeof HumanQuestionOptionsSchema>;
export const RecommendedQuestionOptionsSchema = HumanQuestionOptionsSchema.min(2).refine(options => options.filter(option => option.recommended).length === 1, "Provide exactly one recommended option").refine(options => new Set(options.map(option => option.label.toLowerCase())).size === options.length && options.every(option => option.label.toLowerCase() !== "other"), "Use unique labels; Suplex adds Other");
