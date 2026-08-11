import { z } from "zod";

import { HEALTH_CHECK_IDS } from "./health-contract.js";

const primitive = z.union([z.string(), z.number(), z.boolean()]);
export const ImmutableTemporalImageSchema = z.string()
  .regex(/^[^:@\s]+\/[^:@\s]+:[^:@\s]+@sha256:[a-f0-9]{64}$/)
  .refine((image) => !image.includes(":latest@"), { message: "Temporal image tags must be explicit releases, not latest" });

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
  FORGE_LEGACY_RUNTIME: z.literal("1").optional(),
  FORGE_TEMPORAL_MODE: z.enum(["managed", "external"]).optional(),
  FORGE_TEMPORAL_ADDRESS: z.string().regex(/^[^:\s]+:\d+$/).optional(),
  FORGE_TEMPORAL_NAMESPACE: z.string().min(1).optional(),
  FORGE_TEMPORAL_IMAGE: ImmutableTemporalImageSchema.optional(),
  FORGE_TASK_QUEUE: z.string().min(1).optional(),
  FORGE_DELIVERY_REPAIR_LIMIT: z.string().regex(/^\d+$/).optional(),
  FORGE_CODEX_CAPACITY: z.string().regex(/^\d+$/).optional(),
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
  temporalAddress: z.string().regex(/^[^:\s]+:\d+$/),
  temporalMode: z.enum(["managed", "external"]),
  temporalNamespace: z.string().min(1),
  temporalImage: ImmutableTemporalImageSchema,
  taskQueue: z.string().min(1),
  deliveryRepairCycleLimit: z.number().int().min(0).max(5),
  externalTurnCapacity: z.number().int().min(1).max(64),
  installationId: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/),
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

export const TemporalContainerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  owner: z.string().min(1).optional(),
  legacy: z.boolean().optional(),
  address: z.string().regex(/^[^:\s]+:\d+$/).optional(),
  image: z.string().min(1).optional(),
});

export const TailscaleServeSchema = z.object({
  port: z.number().int().min(1).max(65535),
  backend: z.string().url(),
});

export const ProcessRegistrySchema = z.object({
  version: z.literal(1),
  processes: z.array(OwnedProcessSchema),
  temporalContainer: TemporalContainerSchema.optional(),
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

export const DockerContainerInspectionSchema = z.object({
  Id: z.string().min(1),
  Image: z.string().min(1).optional(),
  Config: z.object({
    Image: z.string().min(1).optional(),
    Cmd: z.array(z.string()).optional(),
    Labels: z.record(z.string(), z.string()).optional(),
  }).optional(),
  State: z.object({ Status: z.string().min(1) }),
  Mounts: z.array(z.object({ Name: z.string().optional() })).optional(),
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
