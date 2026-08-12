import { z } from "zod";

import { HEALTH_CHECK_IDS } from "./health-contract.js";

const primitive = z.union([z.string(), z.number(), z.boolean()]);

export const ForgeEnvironmentSchema = z.object({
  FORGE_ACCESS_MODE: z.literal("tailscale").optional(),
  FORGE_TAILSCALE_EXPOSURE: z.enum(["direct", "serve"]).optional(),
  FORGE_TAILSCALE_ADDRESS: z.string().min(1).optional(),
  FORGE_BIND_ADDRESS: z.string().min(1).optional(),
  FORGE_PORT: z.string().regex(/^\d+$/).optional(),
  FORGE_DATA_ROOT: z.string().min(1).optional(),
  FORGE_DATABASE_PATH: z.string().min(1).optional(),
  FORGE_ARTIFACT_ROOT: z.string().min(1).optional(),
  FORGE_RUNTIME_ROOT: z.string().min(1).optional(),
  FORGE_REPOSITORY_ROOT: z.string().min(1).optional(),
  FORGE_WORKTREE_ROOT: z.string().min(1).optional(),
  FORGE_INSTALLATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/).optional(),
  FORGE_TEMPORAL_TARGET: z.enum(["local", "cloud"]).optional(),
  FORGE_TEMPORAL_ADDRESS: z.string().regex(/^[^:\s]+:\d+$/).optional(),
  FORGE_TEMPORAL_NAMESPACE: z.string().regex(/^\S+$/).optional(),
  FORGE_TEMPORAL_API_KEY: z.string().regex(/^\S+$/).optional(),
  FORGE_TASK_QUEUE: z.string().min(1).optional(),
  FORGE_DELIVERY_REPAIR_LIMIT: z.string().regex(/^\d+$/).optional(),
  FORGE_CODEX_CAPACITY: z.string().regex(/^\d+$/).optional(),
  FORGE_DEVELOPMENT_AUTO_LOGIN: z.literal("1").optional(),
}).passthrough();

export const ForgeConfigSchema = z.object({
  accessMode: z.literal("tailscale"),
  tailscaleExposure: z.enum(["direct", "serve"]),
  bindAddress: z.string().min(1),
  reachableAddress: z.string().url(),
  port: z.number().int().min(1).max(65535),
  dataRoot: z.string().min(1),
  databasePath: z.string().min(1),
  artifactRoot: z.string().min(1),
  runtimeRoot: z.string().min(1),
  repositoryRoot: z.string().min(1),
  worktreeRoot: z.string().min(1),
  temporalTarget: z.enum(["local", "cloud"]),
  temporalAddress: z.string().regex(/^[^:\s]+:\d+$/),
  temporalNamespace: z.string().min(1),
  temporalApiKey: z.string().min(1).optional(),
  taskQueue: z.string().min(1),
  deliveryRepairCycleLimit: z.number().int().min(0).max(5),
  externalTurnCapacity: z.number().int().min(1).max(64),
  installationId: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/),
  developmentAutoLogin: z.boolean(),
}).superRefine((config, context) => {
  if (config.temporalTarget === "cloud" && !config.temporalApiKey) {
    context.addIssue({ code: "custom", path: ["temporalApiKey"], message: "Temporal Cloud requires an API key" });
  }
  if (config.temporalTarget === "local" && config.temporalApiKey) {
    context.addIssue({ code: "custom", path: ["temporalApiKey"], message: "Local Temporal must not use a Cloud API key" });
  }
  if (config.developmentAutoLogin && !["127.0.0.1", "::1"].includes(config.bindAddress)) {
    context.addIssue({ code: "custom", path: ["developmentAutoLogin"], message: "Development auto-login requires a loopback bind address" });
  }
});

export const OwnedProcessSchema = z.object({
  name: z.string().min(1),
  pid: z.number().int().positive(),
  command: z.string().min(1),
  startedAt: z.string().min(1),
  processGroup: z.number().int().positive().optional(),
  startTime: z.string().min(1).optional(),
  startId: z.string().min(1).optional(),
  executable: z.string().min(1).optional(),
  argv: z.array(z.string()).optional(),
  ready: z.boolean().optional(),
});

export const TailscaleServeSchema = z.object({
  port: z.number().int().min(1).max(65535),
  backend: z.string().url(),
});

export const ProcessRegistrySchema = z.object({
  version: z.literal(1),
  processes: z.array(OwnedProcessSchema),
  tailscaleServe: TailscaleServeSchema.optional(),
});

export const TailscaleStatusSchema = z.object({
  Self: z.object({ DNSName: z.string().optional() }).optional(),
});

export const TailscaleServeStatusSchema = z.object({
  Web: z.record(
    z.string(),
    z.object({
      Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional(),
    }),
  ).optional(),
});

export const GhAuthStatusSchema = z.object({
  hosts: z.record(z.string(), z.array(z.object({
    state: z.string(),
    active: z.boolean(),
  }))),
});

const identifier = z.string().min(1).max(256);
const durableIdentifier = identifier.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const CompanyIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/);

export const ProbeWorkflowInputSchema = z.object({
  workflowId: durableIdentifier,
  probeId: durableIdentifier,
  companyId: durableIdentifier,
});

export const ProbeWorkflowStateSchema = ProbeWorkflowInputSchema.extend({
  status: z.enum(["starting", "running"]),
});

export const HealthCheckSchema = z.object({
  id: z.enum(HEALTH_CHECK_IDS),
  label: identifier,
  status: z.enum(["healthy", "unhealthy"]),
  summary: z.string(),
  details: z.record(z.string(), primitive),
});

export const HealthSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  reachableAddress: z.string().url(),
  ready: z.boolean(),
  checks: z.array(HealthCheckSchema),
});
