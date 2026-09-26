import { z } from "zod";

import { HarnessKindSchema } from "./harness-kind.js";

export const ProviderConnectionSchema = z.object({
  status: z.enum(["connected", "not-connected", "unknown"]),
  summary: z.string(),
  account: z.string().optional(),
});

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

export const NativeProviderSummarySchema = z.object({
  id: HarnessKindSchema,
  label: z.string(),
  modelCount: z.number().int().nonnegative(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  status: z.enum(["configured", "missing"]),
});

export const ProviderSummarySchema = NativeProviderSummarySchema.extend({ connection: ProviderConnectionSchema });

export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

export const ProviderListResponseSchema = z.object({
  directory: z.string(),
  observedAt: z.string(),
  providers: z.array(ProviderSummarySchema),
});

export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;

export const ProviderInstanceSchema = z.object({ id: z.string(), provider: HarnessKindSchema, label: z.string(), homeDirectory: z.string(), createdAt: z.string(), updatedAt: z.string() });

export const ProviderInstanceReadinessSchema = z.object({ status: z.enum(["healthy", "warning", "unhealthy"]), summary: z.string() });

export const ProviderInstanceListResponseSchema = z.object({ instances: z.array(ProviderInstanceSchema.extend({ readiness: ProviderInstanceReadinessSchema, connection: ProviderConnectionSchema })) });
