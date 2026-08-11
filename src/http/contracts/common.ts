import { z } from "zod";

export const IdSchema = z.string().min(1).max(256);
export const CompanyIdParamsSchema = z.object({ companyId: IdSchema });
export const ProjectIdParamsSchema = z.object({ projectId: IdSchema });
export const TaskIdParamsSchema = z.object({ taskId: IdSchema });
export const UserIdParamsSchema = z.object({ userId: IdSchema });
export const CredentialIdParamsSchema = z.object({ credentialId: IdSchema });
export const TaskArtifactParamsSchema = z.object({ taskId: IdSchema, artifactId: IdSchema });
export const CompanyStatusParamsSchema = z.object({ companyId: IdSchema, status: z.enum(["active", "paused", "archived"]) });

export const ExpectedRevisionBodySchema = z.object({
  expectedRevision: z.coerce.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const ExpectedRevisionNoteBodySchema = ExpectedRevisionBodySchema.extend({ note: z.string().optional() });
export const EmptyBodySchema = z.object({}).passthrough();
export const TokenBodySchema = z.object({ token: z.string().default("") });
export const RegistrationVerificationBodySchema = z.object({ token: z.string().default(""), challengeId: z.string().default(""), response: z.unknown() });
export const AuthenticationVerificationBodySchema = z.object({ challengeId: z.string().default(""), response: z.unknown() });

export const FindingSchema = z.object({ code: z.string(), field: z.string(), message: z.string() });
export const ErrorResponseSchema = z.object({ error: z.string(), code: z.string().optional(), findings: z.array(FindingSchema).optional() });

export const HealthSnapshotResponseSchema = z.object({
  generatedAt: z.string(),
  reachableAddress: z.string(),
  ready: z.boolean(),
  checks: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["healthy", "unhealthy"]), summary: z.string(), details: z.record(z.string(), z.unknown()) })),
});

export const AuthUserResponseSchema = z.object({ id: z.string(), displayName: z.string(), username: z.string(), role: z.enum(["admin", "member"]), status: z.enum(["pending", "active", "revoked"]), companyIds: z.array(z.string()) });
export const CompanyResponseSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(["active", "paused", "archived"]), createdAt: z.string() });
export const CompanyListResponseSchema = z.object({ companies: z.array(CompanyResponseSchema) });
export const UserResponseSchema = AuthUserResponseSchema;
export const UserListResponseSchema = z.object({ users: z.array(UserResponseSchema) });
export const InvitationResponseSchema = z.object({ token: z.string(), kind: z.enum(["bootstrap", "user", "recovery"]), expiresAt: z.string(), user: AuthUserResponseSchema.optional() });
export const InvitationSummaryResponseSchema = z.object({ id: z.string(), kind: z.enum(["bootstrap", "user", "recovery"]), displayName: z.string(), expiresAt: z.string(), status: z.enum(["active", "expired", "consumed", "replaced"]), createdAt: z.string() });
export const InvitationSummaryListResponseSchema = z.object({ invitations: z.array(InvitationSummaryResponseSchema) });
export const CredentialResponseSchema = z.object({ id: z.string(), userId: z.string(), credentialId: z.string(), createdAt: z.string(), revokedAt: z.string().optional() });
export const CredentialListResponseSchema = z.object({ credentials: z.array(CredentialResponseSchema) });
export const AuditEventResponseSchema = z.object({ id: z.string(), actorUserId: z.string().optional(), action: z.string(), targetUserId: z.string().optional(), companyId: z.string().optional(), metadata: z.record(z.string(), z.string()), createdAt: z.string() });
export const AuditEventListResponseSchema = z.object({ events: z.array(AuditEventResponseSchema) });

export const AuthEnvelopeSchema = z.object({ user: AuthUserResponseSchema });
export const AuthStatusResponseSchema = z.object({ required: z.boolean(), authenticated: z.boolean() });
export const AuthOptionsResponseSchema = z.object({ challengeId: z.string(), options: z.unknown() });
export const SignOutResponseSchema = z.object({ signedOut: z.literal(true) });

export const NotFoundResponseSchema = z.object({ error: z.literal("Not found") });
