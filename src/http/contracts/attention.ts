import { z } from "zod";

const AttentionItemSchema = z.object({ id: z.string(), companyId: z.string(), taskId: z.string(), taskTitle: z.string(), category: z.string(), summary: z.string(), action: z.string(), evidenceRef: z.string().optional(), updatedAt: z.string() });
const RecentOutcomeSchema = z.object({ taskId: z.string(), taskTitle: z.string(), phase: z.string(), updatedAt: z.string() });
const CompanyAttentionSchema = z.object({ companyId: z.string(), companyName: z.string(), companyStatus: z.string(), activeIssueCount: z.number(), phases: z.record(z.string(), z.number()), attentionCount: z.number(), attention: z.array(AttentionItemSchema), recentOutcomes: z.array(RecentOutcomeSchema) });

export const AttentionListResponseSchema = z.object({ companies: z.array(CompanyAttentionSchema) });
export const AttentionDetailResponseSchema = z.object({ items: z.array(AttentionItemSchema) });
