import { z } from "zod";

import { HEALTH_CHECK_IDS, PROVIDER_HARNESS_KINDS } from "./health-checks.js";

const primitive = z.union([z.string(), z.number(), z.boolean()]);

const identifier = z.string().min(1).max(256);

export const HealthCheckSchema = z.object({
  id: z.enum(HEALTH_CHECK_IDS),
  label: identifier,
  status: z.enum(["healthy", "warning", "unhealthy"]),
  summary: z.string(),
  remedy: z.string().optional(),
  remedyKind: z.enum(["command", "link"]).optional(),
  provider: z.enum(PROVIDER_HARNESS_KINDS).optional(),
  details: z.record(z.string(), primitive),
});

export const HealthSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  reachableAddress: z.string().url(),
  version: z.string().optional(),
  ready: z.boolean(),
  checks: z.array(HealthCheckSchema),
  herdr: z.object({ reachable: z.boolean(), socketPath: z.string() }).optional(),
});
