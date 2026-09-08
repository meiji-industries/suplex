import { z } from "zod";

import { DeliveryTargetSchema } from "../../task-contracts.js";

const id = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(120);
const label = z.string().trim().min(1).max(100);
const paths = z.array(z.string().min(1).max(512)).max(100);

export const GithubTriggerCreateSchema = z.object({ projectId: id, name, label, workflowId: id, deliveryTarget: DeliveryTargetSchema, protectedPaths: paths }).strict();
export const GithubTriggerPatchSchema = z.object({ projectId: id.optional(), name: name.optional(), label: label.optional(), workflowId: id.optional(), deliveryTarget: DeliveryTargetSchema.optional(), protectedPaths: paths.optional(), enabled: z.boolean().optional(), archived: z.boolean().optional(), expectedRevision: z.number().int().positive() }).strict();
export const GithubTriggerParamsSchema = z.object({ companyId: id, ruleId: id });
export const GithubTriggerCompanyParamsSchema = z.object({ companyId: id });
export const GithubTriggerActivitySchema = z.object({ at: z.string(), pullRequestNumber: z.number().int().positive().nullable(), url: z.string().url().nullable(), outcome: z.enum(["eligible", "excluded", "error"]), reason: z.string(), matchingPaths: z.array(z.string()), taskId: z.string().nullable().default(null), taskStatus: z.string().nullable().default(null), previouslyProcessed: z.boolean().default(false) });
export const GithubTriggerRuleSchema = z.object({ id, companyId: id, projectId: id, name, label, workflowId: id, deliveryTarget: DeliveryTargetSchema, protectedPaths: paths, repositoryId: z.number().int().positive(), repositoryName: z.string(), authorityUserId: id, enabled: z.boolean(), archivedAt: z.string().nullable(), revision: z.number().int().positive(), lastSuccessfulCheckAt: z.string().nullable(), nextRetryAt: z.string().nullable(), latestError: z.string().nullable(), failureCount: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string() });
export const GithubTriggerListSchema = z.object({ rules: z.array(GithubTriggerRuleSchema) });
export const GithubTriggerActivityResponseSchema = z.object({ activity: z.array(GithubTriggerActivitySchema) });
export type GithubTriggerCreate = z.infer<typeof GithubTriggerCreateSchema>;
export type GithubTriggerPatch = z.infer<typeof GithubTriggerPatchSchema>;
export type GithubTriggerRule = z.infer<typeof GithubTriggerRuleSchema>;
export type GithubTriggerActivity = z.infer<typeof GithubTriggerActivitySchema>;
