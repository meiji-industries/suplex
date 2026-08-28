import { z } from "zod";

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const commitSha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const repositoryIdentity = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

const relativeRepositoryPath = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Repository paths must be normalized repository-relative paths");

const uniqueStrings = <T extends z.ZodType<string>>(schema: T) => z.array(schema).refine((values) => new Set(values).size === values.length, "Values must be unique");
const uniqueNumbers = () => z.array(z.number().int().positive()).refine((values) => new Set(values).size === values.length, "Values must be unique");

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
  // Historical authorization data; the plan artifact ID is the live reference.
  planSha256: sha256.optional(),
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
  evidenceArtifactIds: uniqueStrings(id),
  imageArtifactIds: uniqueStrings(id),
  repositoryInstructionPaths: uniqueStrings(relativeRepositoryPath),
  artifactStepNumbers: z.record(relativeRepositoryPath, uniqueNumbers()).default({}),
});

export type DeveloperContext = z.infer<typeof DeveloperContextSchema>;

export const PlanStepVerificationSchema = z.object({
  stepNumber: z.number().int().positive(),
  commands: z.array(z.string().min(1)),
});

export const EvidenceManifestEntrySchema = z.object({
  kind: z.enum(["final_plan", "task_brief", "evidence", "image", "repository_instruction"]),
  artifactId: id.nullable(),
  repositoryPath: relativeRepositoryPath.nullable(),
  sha256: sha256.optional(),
  byteSize: z.number().int().nonnegative().max(8 * 1024 * 1024),
  stagedFilename: z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/),
  planStepNumbers: z.array(z.number().int().positive()),
}).superRefine((value, context) => {
  if ((value.artifactId === null) === (value.repositoryPath === null)) {
    context.addIssue({ code: "custom", path: ["artifactId"], message: "Exactly one artifact or repository path is required" });
  }
});

export const EvidenceManifestSchema = z.object({
  version: z.literal(1),
  authorizedPlan: AuthorizedPlanSubjectSchema,
  projectRevision: AcceptedProjectRevisionSchema,
  entries: z.array(EvidenceManifestEntrySchema).min(1),
  contradictionRule: z.literal("stop_before_unrelated_edits"),
  verificationCommands: z.array(PlanStepVerificationSchema),
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
  summary: z.string(),
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
  summary: z.string().min(1),
  steps: z.array(z.object({
    number: z.number().int().positive(),
    status: z.enum(["completed", "incomplete", "not_completed", "blocked", "not_applicable_locally"]),
    filesChanged: z.array(z.string()),
    notes: z.string(),
  })).min(1),
  authorizedStepsNotCompleted: z.array(z.number().int().positive()),
  resultCommit: commitSha,
  resultTree: commitSha,
  dirtyState: z.enum(["clean", "dirty"]),
  blocker: z.string().nullable(),
});

export type DeveloperDelivery = z.infer<typeof DeveloperDeliverySchema>;

export type DeliveryDisposition = "complete" | "incomplete" | "blocked";

/** Classifies structured delivery state without trusting an agent's free-text blocker. */
export function classifyDelivery(
  delivery: { steps: Array<{ number: number; status: string }>; authorizedStepsNotCompleted: number[]; dirtyState: string; resultCommit: string | null; blocker: string | null },
  priorCommit: string | null,
): DeliveryDisposition {
  const authorized = new Set(delivery.authorizedStepsNotCompleted);
  const allAuthorizedComplete = delivery.steps
    .filter((step) => !authorized.has(step.number))
    .every((step) => step.status === "completed" || step.status === "not_applicable_locally")
    && delivery.authorizedStepsNotCompleted.length === 0;
  if (allAuthorizedComplete) return "complete";
  if (delivery.dirtyState === "clean" && delivery.resultCommit !== null && delivery.resultCommit !== priorCommit && !delivery.steps.some((step) => step.status === "blocked")) return "incomplete";
  return "blocked";
}

export function normalizeRepositoryInstructionPath(value: string): string {
  return relativeRepositoryPath.parse(value);
}
