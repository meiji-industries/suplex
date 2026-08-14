import { z } from "zod";

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const commitSha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const repositoryIdentity = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

const relativeRepositoryPath = z.string().min(1).max(1_000).refine((value) => {
  if (value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Repository paths must be normalized repository-relative paths");

const uniqueStrings = <T extends z.ZodType<string>>(schema: T, max: number) => z.array(schema).max(max).refine((values) => new Set(values).size === values.length, "Values must be unique");
const uniqueNumbers = (max: number) => z.array(z.number().int().positive()).max(max).refine((values) => new Set(values).size === values.length, "Values must be unique");

export const AcceptedProjectRevisionSchema = z.object({
  projectRevisionId: id,
  projectId: id,
  companyId: id,
  repositoryIdentity,
  repositoryPath: z.string().min(1).max(2_000),
  worktreeRoot: z.string().min(1).max(2_000),
  baseBranch: z.string().min(1).max(256),
  targetBranch: z.string().min(1).max(256),
  baseSha: commitSha,
  targetSha: commitSha,
  setupVerificationPolicySha256: sha256,
}).superRefine((value, context) => {
  if (value.repositoryPath.includes("\0") || value.worktreeRoot.includes("\0")) {
    context.addIssue({ code: "custom", path: ["repositoryPath"], message: "Repository paths cannot contain NUL bytes" });
  }
});

export type AcceptedProjectRevision = z.infer<typeof AcceptedProjectRevisionSchema>;

export const AuthorizedPlanSubjectSchema = z.object({
  authorizationId: id,
  taskId: id,
  companyId: id,
  projectId: id,
  workflowId: id,
  planRevision: z.number().int().positive(),
  planArtifactId: id,
  planSha256: sha256,
  authorizationKind: z.enum(["routine_auto", "human_approval"]),
  approvalDecisionId: id.nullable(),
  authorizedAt: z.string().datetime(),
}).superRefine((value, context) => {
  if (value.authorizationKind === "human_approval" && !value.approvalDecisionId) {
    context.addIssue({ code: "custom", path: ["approvalDecisionId"], message: "Human approval requires a decision identity" });
  }
  if (value.authorizationKind === "routine_auto" && value.approvalDecisionId !== null) {
    context.addIssue({ code: "custom", path: ["approvalDecisionId"], message: "Routine authorization cannot carry an approval decision" });
  }
});

export type AuthorizedPlanSubject = z.infer<typeof AuthorizedPlanSubjectSchema>;

export const DeveloperContextSchema = z.object({
  includeTaskBrief: z.boolean(),
  evidenceArtifactIds: uniqueStrings(id, 32),
  imageArtifactIds: uniqueStrings(id, 32),
  repositoryInstructionPaths: uniqueStrings(relativeRepositoryPath, 64),
  artifactStepNumbers: z.record(relativeRepositoryPath, uniqueNumbers(64)).default({}),
});

export type DeveloperContext = z.infer<typeof DeveloperContextSchema>;

export const PlanStepVerificationSchema = z.object({
  stepNumber: z.number().int().positive(),
  commands: z.array(z.string().min(1).max(500)).max(32),
});

export const EvidenceManifestEntrySchema = z.object({
  kind: z.enum(["final_plan", "task_brief", "evidence", "image", "repository_instruction"]),
  artifactId: id.nullable(),
  repositoryPath: relativeRepositoryPath.nullable(),
  sha256,
  byteSize: z.number().int().nonnegative().max(8 * 1024 * 1024),
  stagedFilename: z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/),
  planStepNumbers: z.array(z.number().int().positive()).max(64),
}).superRefine((value, context) => {
  if ((value.artifactId === null) === (value.repositoryPath === null)) {
    context.addIssue({ code: "custom", path: ["artifactId"], message: "Exactly one artifact or repository path is required" });
  }
});

export const EvidenceManifestSchema = z.object({
  version: z.literal(1),
  authorizedPlan: AuthorizedPlanSubjectSchema,
  projectRevision: AcceptedProjectRevisionSchema,
  entries: z.array(EvidenceManifestEntrySchema).min(1).max(128),
  contradictionRule: z.literal("stop_before_unrelated_edits"),
  verificationCommands: z.array(PlanStepVerificationSchema).max(64),
  createdAt: z.string().datetime(),
}).superRefine((value, context) => {
  const keys = value.entries.map((entry) => `${entry.kind}:${entry.artifactId ?? entry.repositoryPath}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["entries"], message: "Evidence entries must be unique" });
});

export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export const OwnedWorktreeSchema = z.object({
  leaseId: id,
  leaseTokenHash: sha256,
  taskId: id,
  companyId: id,
  projectId: id,
  workflowId: id,
  repositoryRoot: z.string().min(1).max(2_000),
  worktreeRoot: z.string().min(1).max(2_000),
  worktreePath: z.string().min(1).max(2_000),
  branchName: z.string().min(1).max(256),
  startingSha: commitSha,
  legacy: z.boolean(),
  status: z.enum(["reserved", "active", "ambiguous", "released"]),
}).superRefine((value, context) => {
  if (!value.legacy && !value.branchName.startsWith("work/")) {
    context.addIssue({ code: "custom", path: ["branchName"], message: "New issue worktrees require the neutral work namespace" });
  }
});

export type OwnedWorktree = z.infer<typeof OwnedWorktreeSchema>;

export const ExecutionReceiptSchema = z.object({
  eventId: id,
  executionId: id,
  attempt: z.number().int().positive(),
  sequence: z.number().int().positive(),
  kind: z.enum(["step_started", "step_completed", "step_blocked", "agent_update", "tool_call", "command_started", "command_finished", "file_change", "test_result", "git_snapshot", "provider_observation", "process_started", "process_finished", "reconciliation"]),
  stepNumber: z.number().int().positive().nullable(),
  sourceItemId: z.string().max(256).nullable(),
  occurredAt: z.string().datetime(),
  summary: z.string().max(4_000),
  exitCode: z.number().int().nullable(),
  artifactId: id.nullable(),
  artifactSha256: sha256.nullable(),
  idempotencyKey: z.string().min(1).max(512),
});

export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

export const OwnedExternalProcessIdentitySchema = z.object({
  executionId: id,
  attempt: z.number().int().positive(),
  leaseTokenHash: sha256,
  supervisorId: id,
  supervisorExecutable: z.string().min(1).max(2_000),
  supervisorPid: z.number().int().positive(),
  supervisorProcessGroupId: z.number().int().positive(),
  supervisorStartIdentity: z.string().min(1).max(512),
  childExecutable: z.string().min(1).max(2_000),
  childPid: z.number().int().positive(),
  childProcessGroupId: z.number().int().positive(),
  childStartIdentity: z.string().min(1).max(512),
  worktreePath: z.string().min(1).max(2_000),
  ownerUid: z.number().int().nonnegative().nullable(),
  controlRoot: z.string().min(1).max(2_000),
  eventsPath: z.string().min(1).max(2_000),
  resultPath: z.string().min(1).max(2_000),
});

export type OwnedExternalProcessIdentity = z.infer<typeof OwnedExternalProcessIdentitySchema>;

export const DeveloperDeliverySchema = z.object({
  kind: z.literal("delivery"),
  summary: z.string().min(1).max(2_000),
  steps: z.array(z.object({
    number: z.number().int().positive(),
    status: z.enum(["completed", "not_completed", "blocked"]),
    filesChanged: z.array(z.string().max(500)).max(128),
    notes: z.string().max(4_000),
  })).min(1).max(64),
  authorizedStepsNotCompleted: z.array(z.number().int().positive()).max(64),
  resultCommit: commitSha,
  resultTree: commitSha,
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().max(4_000).nullable(),
});

export type DeveloperDelivery = z.infer<typeof DeveloperDeliverySchema>;

export function normalizeRepositoryInstructionPath(value: string): string {
  return relativeRepositoryPath.parse(value);
}
