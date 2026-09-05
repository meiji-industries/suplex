import { z } from "zod";

export const ProviderSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  modelCount: z.number().int().nonnegative(),
  status: z.literal("configured"),
});
export const ProviderListResponseSchema = z.object({
  harness: z.literal("opencode"),
  directory: z.string(),
  observedAt: z.string(),
  providers: z.array(ProviderSummarySchema),
});
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;
