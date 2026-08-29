import { z } from "zod";
import { AGENT_PROVIDER_KINDS } from "../../agent-providers/provider.js";
export const ProviderSummarySchema = z.object({ id: z.enum(AGENT_PROVIDER_KINDS), label: z.string(), harness: z.string(), harnessLabel: z.string(), healthCheckId: z.string(), credential: z.object({ required: z.boolean(), configured: z.boolean(), maskedKey: z.string().nullable(), lastTestedAt: z.string().nullable(), lastTestStatus: z.enum(["healthy", "unhealthy"]).nullable(), lastTestSummary: z.string().nullable() }) });
export const ProviderListResponseSchema = z.object({ providers: z.array(ProviderSummarySchema) });
export const ProviderCredentialBodySchema = z.object({ apiKey: z.string().min(1).max(512) });
export const ProviderTestResponseSchema = z.object({ ok: z.boolean(), summary: z.string(), check: z.object({ id: z.string(), label: z.string(), status: z.string(), summary: z.string(), details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }) });
