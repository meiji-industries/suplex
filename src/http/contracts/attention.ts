import { z } from "zod";
import { IssueCommandSchema } from "../../temporal/issue-contracts.js";

const AttentionActionSchema = z.object({ command: IssueCommandSchema, label: z.string(), expectedRevision: z.number().int().nonnegative(), requiresNote: z.boolean(), destructive: z.boolean() });
const AttentionItemSchema = z.object({ companyId: z.string(), taskId: z.string(), issueKey: z.string().nullable(), taskTitle: z.string(), summary: z.string().nullable(), sourceRevision: z.number().int().nonnegative(), activatedAt: z.string(), actions: z.array(AttentionActionSchema) });
const CompanyAttentionSchema = z.object({ companyId: z.string(), companyName: z.string(), companyStatus: z.string(), attentionCount: z.number().int().nonnegative(), attention: z.array(AttentionItemSchema) });

export const AttentionListResponseSchema = z.object({ companies: z.array(CompanyAttentionSchema) });
export type CompanyAttentionResponse = z.infer<typeof CompanyAttentionSchema>;
export type AttentionItemResponse = z.infer<typeof AttentionItemSchema>;
export type AttentionActionResponse = z.infer<typeof AttentionActionSchema>;
