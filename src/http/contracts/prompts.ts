import { z } from "zod";

export const PromptScopeSchema = z.enum(["global", "project"]);
export const PromptTemplateParamsSchema = z.object({ templateId: z.string().min(1) });
export const PromptScopeQuerySchema = z.object({ scope: PromptScopeSchema, projectId: z.string().min(1).optional() }).superRefine((value, context) => {
  if (value.scope === "project" && !value.projectId) context.addIssue({ code: "custom", message: "projectId is required", path: ["projectId"] });
  if (value.scope === "global" && value.projectId) context.addIssue({ code: "custom", message: "projectId is not allowed", path: ["projectId"] });
});
export const PromptOverrideBodySchema = z.object({ mode: z.enum(["inherit", "append", "replace"]), content: z.string(), note: z.string().optional() });
export const PromptPreviewBodySchema = PromptOverrideBodySchema.omit({ note: true });
export const PromptRollbackBodySchema = z.object({ revision: z.number().int().positive() });
export const TaskPromptParamsSchema = z.object({ taskId: z.string().min(1) });

const ProvenanceStepSchema = z.object({ layer: z.enum(["system", "global", "project"]), mode: z.enum(["inherit", "append", "replace"]), revision: z.number().optional(), overrideId: z.string().optional(), sha256: z.string() });
const ResolvedSchema = z.object({ templateId: z.string(), text: z.string(), guidance: z.string(), sha256: z.string(), steps: z.array(ProvenanceStepSchema), staleReplace: z.boolean() });
const OverrideSchema = z.object({ id: z.string(), templateId: z.string(), mode: z.enum(["inherit", "append", "replace"]), content: z.string(), baseTemplateSha256: z.string(), currentRevision: z.number() });
const RevisionSchema = z.object({ id: z.string(), override_id: z.string(), revision: z.number(), mode: z.enum(["inherit", "append", "replace"]), content: z.string(), base_template_sha256: z.string(), actor_user_id: z.string(), note: z.string().nullable(), restored_from_revision: z.number().nullable(), created_at: z.string() });
export const PromptTemplateViewSchema = z.object({ id: z.string(), path: z.string(), category: z.enum(["agent", "shared"]), archetype: z.string(), title: z.string(), editable: z.boolean(), variables: z.array(z.string()), renamedFrom: z.array(z.string()), guidance: z.string(), contract: z.string().nullable(), guidanceSha256: z.string(), override: OverrideSchema.nullable(), resolved: ResolvedSchema, revisions: z.array(RevisionSchema) });
export const PromptTemplateListResponseSchema = z.object({ templates: z.array(PromptTemplateViewSchema) });
export const PromptPreviewResponseSchema = z.object({ resolved: ResolvedSchema, findings: z.array(z.object({ code: z.string(), message: z.string() })) });
export const TaskPromptsResponseSchema = z.object({ version: z.number(), provenance: z.record(z.string(), z.unknown()) });
