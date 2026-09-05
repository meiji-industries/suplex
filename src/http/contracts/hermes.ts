import { z } from "zod";

export const HermesAdminAgentSchema = z.object({
  id: z.string(),
  kind: z.literal("hermes"),
  name: z.string(),
  avatarSeed: z.string(),
  companyId: z.string(),
  hermesProfileId: z.string().nullable(),
  status: z.enum(["pending", "paired", "revoked"]),
  projectIds: z.array(z.string()),
  pairingExpiresAt: z.string().nullable(),
  pairedAt: z.string().nullable(),
  credentialCreatedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type HermesAdminAgent = z.infer<typeof HermesAdminAgentSchema>;

export const HermesAgentListResponseSchema = z.object({
  agents: z.array(HermesAdminAgentSchema),
});

export const HermesAdminListQuerySchema = z.object({
  companyId: z.string().optional(),
});

export const HermesAdminCreateBodySchema = z.object({
  name: z.string().trim().min(1),
  companyId: z.string().min(1).max(128),
  projectIds: z.array(z.string().min(1).max(128)).min(1),
  avatarSeed: z.string().max(128).optional(),
});

export const HermesAdminCreateResponseSchema = z.object({
  agent: HermesAdminAgentSchema,
  pairingCode: z.string(),
  expiresAt: z.string(),
});

export const HermesAdminAgentParamsSchema = z.object({
  agentId: z.string().min(1).max(128),
});

export const HermesAdminProjectsBodySchema = z.object({
  projectIds: z.array(z.string().min(1).max(128)),
});

export const HermesAdminProjectsResponseSchema = z.object({
  agent: HermesAdminAgentSchema,
});

export const HermesAdminPairingCodeResponseSchema = z.object({
  pairingCode: z.string(),
  expiresAt: z.string(),
});

export const HermesPublicAgentSchema = z.object({
  id: z.string(),
  kind: z.literal("hermes"),
  name: z.string(),
  avatarSeed: z.string(),
  companyId: z.string(),
  profileId: z.string().nullable(),
  status: z.enum(["pending", "paired", "revoked"]),
  projectIds: z.array(z.string()),
  pairedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type HermesPublicAgent = z.infer<typeof HermesPublicAgentSchema>;

export const HermesPairingExchangeBodySchema = z.object({
  pairingCode: z.string(),
  profileId: z.string().trim().min(1).max(128),
});

export const HermesPairingExchangeResponseSchema = z.object({
  agent: HermesPublicAgentSchema,
  credential: z.string(),
});

export const HermesTaskCreateBodySchema = z.object({
  projectId: z.string().min(1).max(128),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(128),
});

export const HermesTaskIdParamsSchema = z.object({
  taskId: z.string().min(1).max(128),
});

export const HermesSafeTaskProjectionSchema = z.object({
  id: z.string(),
  issueKey: z.string().nullable(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(["backlog", "active", "waiting_human", "cancelled", "delivered"]),
  humanQuestion: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type HermesSafeTaskProjection = z.infer<typeof HermesSafeTaskProjectionSchema>;
