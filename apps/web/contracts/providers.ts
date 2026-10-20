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

/** An agent tool row. Its id is the harness that runs its models. */
export const CliProviderSummarySchema = NativeProviderSummarySchema.extend({ kind: z.literal("cli"), harness: HarnessKindSchema, connection: ProviderConnectionSchema });

/** A local or custom OpenAI-compatible endpoint. `harness` runs its model; the API key never leaves the server. */
export const EndpointProviderSummarySchema = NativeProviderSummarySchema.extend({
  id: z.string().startsWith("local-"),
  kind: z.literal("local-endpoint"),
  harness: HarnessKindSchema,
  connection: ProviderConnectionSchema,
  endpoint: z.object({ baseUrl: z.string(), modelId: z.string(), hasApiKey: z.boolean() }),
});

export const ProviderSummarySchema = z.discriminatedUnion("kind", [CliProviderSummarySchema, EndpointProviderSummarySchema]);

export type CliProviderSummary = z.infer<typeof CliProviderSummarySchema>;
export type EndpointProviderSummary = z.infer<typeof EndpointProviderSummarySchema>;
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

/** The fields of a local endpoint, for Test and for Add. */
export const LocalEndpointBodySchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048).url(),
  apiKey: z.string().max(4096).optional(),
  modelId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  label: z.string().trim().max(128).optional(),
}).strict();

export type LocalEndpointBody = z.infer<typeof LocalEndpointBodySchema>;

export const ProviderListResponseSchema = z.object({
  directory: z.string(),
  observedAt: z.string(),
  providers: z.array(ProviderSummarySchema),
});

export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;

export const ProviderInstanceSchema = z.object({ id: z.string(), provider: HarnessKindSchema, label: z.string(), homeDirectory: z.string(), createdAt: z.string(), updatedAt: z.string() });

export const ProviderInstanceReadinessSchema = z.object({ status: z.enum(["healthy", "warning", "unhealthy"]), summary: z.string() });

export const ProviderInstanceListResponseSchema = z.object({ instances: z.array(ProviderInstanceSchema.extend({ readiness: ProviderInstanceReadinessSchema, connection: ProviderConnectionSchema })) });
