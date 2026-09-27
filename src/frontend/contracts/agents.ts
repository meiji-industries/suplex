import { z } from "zod";

export const AgentApiAdminAgentSchema = z.object({
  id: z.string(),
  kind: z.literal("external"),
  name: z.string(),
  avatarSeed: z.string(),
  companyId: z.string(),
  clientProfileId: z.string().nullable(),
  status: z.enum(["pending", "paired", "revoked"]),
  projectIds: z.array(z.string()),
  pairingExpiresAt: z.string().nullable(),
  pairedAt: z.string().nullable(),
  credentialCreatedAt: z.string().nullable(),
  connectionKind: z.enum(["oauth", "credential"]),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AgentApiAdminAgent = z.infer<typeof AgentApiAdminAgentSchema>;
