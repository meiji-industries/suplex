import { z } from "zod";

export const ProviderSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  modelCount: z.number().int().nonnegative(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  status: z.enum(["configured", "missing"]),
});
export const ProviderListResponseSchema = z.object({
  directory: z.string(),
  observedAt: z.string(),
  providers: z.array(ProviderSummarySchema),
});
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;
export const ProviderInstanceSchema = z.object({ id: z.string(), provider: z.string(), label: z.string(), homeDirectory: z.string(), createdAt: z.string(), updatedAt: z.string() });
export type ProviderInstance = z.infer<typeof ProviderInstanceSchema>;
export const ProviderInstanceReadinessSchema = z.object({ status: z.enum(["healthy", "warning", "unhealthy"]), summary: z.string() });
export const ProviderInstanceListResponseSchema = z.object({ instances: z.array(ProviderInstanceSchema.extend({ readiness: ProviderInstanceReadinessSchema })) });
export const ProviderInstanceCreateBodySchema = z.object({ provider: z.string().min(1), label: z.string().trim().min(1).max(128) });
