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
