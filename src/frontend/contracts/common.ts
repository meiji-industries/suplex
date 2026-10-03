import { z } from "zod";

export const AuthUserResponseSchema = z.object({ id: z.string(), displayName: z.string(), title: z.string(), username: z.string(), avatarSeed: z.string(), role: z.enum(["admin", "member"]), status: z.enum(["pending", "active", "revoked"]), companyIds: z.array(z.string()) });

// `plan` is a display label from local data, present on the company list only. Null means Suplex has no recent plan.
export const CompanyResponseSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(["active", "paused", "archived"]), issueCode: z.string().nullable(), createdAt: z.string(), plan: z.enum(["free", "pro"]).nullable().optional() });

export const InvitationSummaryResponseSchema = z.object({ id: z.string(), kind: z.enum(["bootstrap", "user", "recovery"]), displayName: z.string(), expiresAt: z.string(), status: z.enum(["active", "expired", "consumed", "replaced"]), createdAt: z.string() });

export const CredentialResponseSchema = z.object({ id: z.string(), userId: z.string(), credentialId: z.string(), label: z.string(), rpId: z.string().nullable(), createdAt: z.string(), revokedAt: z.string().nullable() });

export type AuthUserResponse = z.infer<typeof AuthUserResponseSchema>;

export type CompanyResponse = z.infer<typeof CompanyResponseSchema>;

export type InvitationSummaryResponse = z.infer<typeof InvitationSummaryResponseSchema>;

export type CredentialResponse = z.infer<typeof CredentialResponseSchema>;
