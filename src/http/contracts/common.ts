import { z } from "zod";

export const IdSchema = z.string().min(1).max(256);
export const CompanyIdParamsSchema = z.object({ companyId: IdSchema });
export const ProjectIdParamsSchema = z.object({ projectId: IdSchema });
export const TaskIdParamsSchema = z.object({ taskId: IdSchema });
export const UserIdParamsSchema = z.object({ userId: IdSchema });
export const CredentialIdParamsSchema = z.object({ credentialId: IdSchema });
export const TaskArtifactParamsSchema = z.object({ taskId: IdSchema, artifactId: IdSchema });
export const TaskExecutionParamsSchema = z.object({ taskId: IdSchema, executionId: IdSchema });
export const AttentionIdParamsSchema = z.object({ attentionId: IdSchema });
export const CompanyStatusParamsSchema = z.object({ companyId: IdSchema, status: z.enum(["active", "paused", "archived"]) });

export const ExpectedRevisionBodySchema = z.object({
  expectedRevision: z.coerce.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER),
  commandId: z.string().min(1).max(256).optional(), // bound: durable command identifier
  idempotencyKey: z.string().min(1).max(256).optional(),
  automatic: z.boolean().optional(),
});
export const ExpectedRevisionNoteBodySchema = ExpectedRevisionBodySchema.extend({ note: z.string().optional() });
export const RequiredRevisionNoteBodySchema = ExpectedRevisionBodySchema.extend({ note: z.string().trim().min(1) });
export const HttpPlanDecisionBodySchema = z.object({ note: z.string().trim().min(1), idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }); // bound: idempotency identifier
export const HttpSupplementalReviewBodySchema = z.object({ expectedRevision: z.coerce.number().int().min(0), idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) });
export const HttpPlanBlockerResponseBodySchema = z.object({ expectedWorkflowRevision: z.number().int().nonnegative(), answer: z.string().trim().min(1), idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }); // bound: idempotency identifier
export const ResolveDecisionBlockerBodySchema = ExpectedRevisionBodySchema.extend({ answer: z.string().min(1) });
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
  checks: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["healthy", "warning", "unhealthy"]), summary: z.string(), details: z.record(z.string(), z.unknown()) })),
  herdr: z.object({ reachable: z.boolean(), socketPath: z.string() }).optional(),
});

export const AuthUserResponseSchema = z.object({ id: z.string(), displayName: z.string(), username: z.string(), avatarSeed: z.string(), role: z.enum(["admin", "member"]), status: z.enum(["pending", "active", "revoked"]), companyIds: z.array(z.string()) });
export const CompanyResponseSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(["active", "paused", "archived"]), issueCode: z.string().nullable(), createdAt: z.string() });
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
export type AuthUserResponse = z.infer<typeof AuthUserResponseSchema>;
export type CompanyResponse = z.infer<typeof CompanyResponseSchema>;
export type InvitationSummaryResponse = z.infer<typeof InvitationSummaryResponseSchema>;
export type CredentialResponse = z.infer<typeof CredentialResponseSchema>;

export const AuthEnvelopeSchema = z.object({ user: AuthUserResponseSchema });
export const AuthStatusResponseSchema = z.object({ required: z.boolean(), authenticated: z.boolean() });
export const AuthOptionsResponseSchema = z.object({ challengeId: z.string(), options: z.unknown() });
export const SignOutResponseSchema = z.object({ signedOut: z.literal(true) });

export const NotFoundResponseSchema = z.object({ error: z.literal("Not found") });
