import { z } from "zod";
import { IssueCommandSchema } from "../../commands/registry.js";

const AttentionActionSchema = z.object({ command: IssueCommandSchema, label: z.string(), expectedRevision: z.number().int().nonnegative(), requiresNote: z.boolean(), destructive: z.boolean(), idempotency: z.enum(["required", "none"]) });
const AttentionCardActionSchema = z.object({ command: z.string(), label: z.string(), destructive: z.boolean().optional(), requiresNote: z.boolean().optional() });
const AttentionChoiceSchema = z.object({ id: z.string(), label: z.string(), description: z.string() });
export const AttentionCardSchema = z.object({ kind: z.enum(["github_credential", "worktree_missing", "missing_turn_outcome", "product_decision", "dirty_worktree_cleanup", "no_progress", "generic"]), title: z.string().min(1), explanation: z.string().min(1), evidence: z.array(z.object({ kind: z.enum(["artifact", "url", "text"]), ref: z.string(), label: z.string().optional() })).min(1), primaryAction: AttentionCardActionSchema, secondaryAction: AttentionCardActionSchema.optional(), decision: z.object({ choices: z.array(AttentionChoiceSchema).min(2), recommendedChoiceId: z.string(), freeTextPrompt: z.string() }).optional() });
const AttentionItemSchema = z.object({ companyId: z.string(), taskId: z.string(), issueKey: z.string().nullable(), taskTitle: z.string(), summary: z.string().nullable(), sourceRevision: z.number().int().nonnegative(), activatedAt: z.string(), actions: z.array(AttentionActionSchema), card: AttentionCardSchema });
const CompanyAttentionSchema = z.object({ companyId: z.string(), companyName: z.string(), companyStatus: z.string(), attentionCount: z.number().int().nonnegative(), attention: z.array(AttentionItemSchema) });

export const AttentionListResponseSchema = z.object({ companies: z.array(CompanyAttentionSchema) });
export type CompanyAttentionResponse = z.infer<typeof CompanyAttentionSchema>;
export type AttentionItemResponse = z.infer<typeof AttentionItemSchema>;
export type AttentionActionResponse = z.infer<typeof AttentionActionSchema>;
