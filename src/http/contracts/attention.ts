import { z } from "zod";

import { AttentionCategorySchema, IssueCommandSchema } from "../../temporal/issue-contracts.js";

const AttentionActionSchema = z.object({ command: IssueCommandSchema, label: z.string(), expectedRevision: z.number().int().nonnegative(), requiresNote: z.boolean(), destructive: z.boolean() });
const AttentionEvidenceSchema = z.object({ artifactId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.string(), mimeType: z.string(), byteSize: z.number().int().nonnegative(), href: z.string() });
const AttentionItemSchema = z.object({ id: z.string(), companyId: z.string(), taskId: z.string(), taskTitle: z.string(), category: AttentionCategorySchema, summary: z.string(), sourceRevision: z.number().int().nonnegative(), activatedAt: z.string(), actions: z.array(AttentionActionSchema), evidence: AttentionEvidenceSchema });
const RecentOutcomeSchema = z.object({ taskId: z.string(), taskTitle: z.string(), phase: z.string(), updatedAt: z.string(), sourceRevision: z.number().int().nonnegative().optional() });
const ProjectionHealthSchema = z.object({ projectedRevision: z.number().int().nonnegative(), sourceRevision: z.number().int().nonnegative(), projectedAt: z.string(), stateChangedAt: z.string().nullable(), reconciledAt: z.string().nullable(), status: z.enum(["current", "stale", "unknown"]), lagMs: z.number().nonnegative() });
const CompanyAttentionSchema = z.object({ companyId: z.string(), companyName: z.string(), companyStatus: z.string(), activeIssueCount: z.number(), phases: z.record(z.string(), z.number()), attentionCount: z.number(), attention: z.array(AttentionItemSchema), recentOutcomes: z.array(RecentOutcomeSchema), projectionHealth: ProjectionHealthSchema });

export const AttentionListResponseSchema = z.object({ companies: z.array(CompanyAttentionSchema) });
export const AttentionDetailResponseSchema = z.object({ items: z.array(AttentionItemSchema) });
export const AttentionEvidenceResponseSchema = z.object({ artifactId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.string(), content: z.string(), truncated: z.boolean() });
