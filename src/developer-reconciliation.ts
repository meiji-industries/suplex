import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { z } from "zod";

import { AuthorizedPlanSubjectSchema, DeveloperDeliverySchema, EvidenceManifestSchema, ExecutionReceiptSchema, type AuthorizedPlanSubject, type DeveloperDelivery, type EvidenceManifest } from "./developer-contracts.js";
import type { VerificationResult } from "./verification.js";

const execFileAsync = promisify(execFile);

const VerificationCommandArtifactSchema = z.object({
  command: z.string().min(1).max(500),
  argv: z.array(z.string().max(500)).max(16),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
  timedOut: z.boolean(),
  stdout: z.string().max(8 * 1024),
  stderr: z.string().max(8 * 1024),
});

export const IndependentVerificationSchema = z.object({
  outcome: z.enum(["passed", "failed"]),
  code: z.enum(["verification_failed", "verification_timed_out", "verification_evidence_too_large"]).optional(),
  summary: z.string().max(4_000),
  commands: z.array(VerificationCommandArtifactSchema).max(8),
});

export type IndependentVerification = z.infer<typeof IndependentVerificationSchema>;

export interface DeveloperGitObservation {
  branch: string;
  head: string;
  tree: string;
  status: string;
  parents: string[];
  commitCount: number;
  isDescendant: boolean;
  changedPaths: string[];
}

export interface DeveloperReconciliationInput {
  executionId: string;
  companyId: string;
  report: unknown;
  independentVerification: VerificationResult | unknown;
  git: DeveloperGitObservation;
  startingSha: string;
  neutralBranch: string;
  providerBeforeSha256: string;
  providerAfterSha256: string | null;
  processExitCode: number | null;
  malformedLines?: number;
  developerSessionId: string | null;
  leadSessionId: string | null;
  authorization: AuthorizedPlanSubject;
  manifest: EvidenceManifest;
}

export interface DeveloperReconciliation {
  kind: "developer-reconciliation";
  policyVersion: 2;
  executionId: string;
  companyId: string;
  outcome: "completed" | "blocked";
  failureCode: string | null;
  mismatches: string[];
  report: DeveloperDelivery | null;
  authorization: AuthorizedPlanSubject;
  manifest: EvidenceManifest;
  independentVerification: IndependentVerification | null;
  git: DeveloperGitObservation;
  provider: { beforeSha256: string; afterSha256: string | null; matching: boolean };
  observations: {
    startingSha: string;
    neutralBranch: string;
    processExitCode: number | null;
    developerSessionId: string | null;
    leadSessionId: string | null;
  };
  sha256: string;
}

const GitObservationSchema = z.object({
  branch: z.string(),
  head: z.string(),
  tree: z.string(),
  status: z.string(),
  parents: z.array(z.string()),
  commitCount: z.number(),
  isDescendant: z.boolean(),
  changedPaths: z.array(z.string()),
});

const ObservationsSchema = z.object({
  startingSha: z.string(),
  neutralBranch: z.string(),
  processExitCode: z.number().nullable(),
  developerSessionId: z.string().nullable(),
  leadSessionId: z.string().nullable(),
  malformedLines: z.number().int().nonnegative().optional(),
  verificationCommands: z.array(z.object({ stepNumber: z.number().int().positive(), commands: z.array(z.string()) })).optional(),
});

/** Reads both receipt-era and receipt-free reconciliation artifacts. */
export const DeveloperReconciliationArtifactSchema = z.object({
  kind: z.literal("developer-reconciliation"),
  policyVersion: z.literal(2).optional(),
  executionId: z.string().min(1),
  companyId: z.string().min(1),
  outcome: z.enum(["completed", "blocked"]),
  failureCode: z.string().nullable(),
  mismatches: z.array(z.string()),
  report: z.unknown().nullable(),
  authorization: AuthorizedPlanSubjectSchema,
  manifest: EvidenceManifestSchema,
  independentVerification: IndependentVerificationSchema.nullable().optional(),
  receipts: z.array(ExecutionReceiptSchema).optional(),
  receiptCount: z.number().int().nonnegative().optional(),
  git: GitObservationSchema,
  provider: z.object({ beforeSha256: z.string(), afterSha256: z.string().nullable(), matching: z.boolean() }),
  observations: ObservationsSchema.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).passthrough();

const LegacyReceiptMismatch = /^(malformed-jsonl-output|developer-receipt-invalid|receipt-outside-step|duplicate-step-start:\d+|missing-step-start:\d+|duplicate-step-terminal:\d+|step-terminal-order:\d+|missing-step-receipt:\d+|receipt-step-set-mismatch|missing-verification-command:\d+|verification-command-failed:\d+|file-change-not-in-final-tree|missing-command-terminal:.+|command-terminal-without-start:.+)$/;

/** True only for a receipt-era failure that can safely be rechecked. */
export function isLegacyReceiptOnlyRecovery(raw: unknown): boolean {
  const parsed = DeveloperReconciliationArtifactSchema.safeParse(raw);
  if (!parsed.success) return false;
  const reconciliation = parsed.data;
  return reconciliation.policyVersion === undefined
    && reconciliation.independentVerification === undefined
    && reconciliation.outcome === "blocked"
    && reconciliation.failureCode === "delivery-reconciliation-failed"
    && Boolean(reconciliation.receipts?.length)
    && reconciliation.mismatches.length > 0
    && reconciliation.mismatches.every((mismatch) => LegacyReceiptMismatch.test(mismatch));
}

export function independentVerificationResults(raw: unknown): string[] {
  try {
    const reconciliation = DeveloperReconciliationArtifactSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (reconciliation.policyVersion !== 2 || !reconciliation.independentVerification) return [];
    const verification = reconciliation.independentVerification;
    if (verification.outcome !== "passed") return [`Verification failed: ${verification.summary}`];
    return verification.commands.map((command) => `${command.command}: ${command.timedOut ? "timed out" : command.exitCode === 0 ? "passed" : `exit ${command.exitCode ?? "unknown"}`}`);
  } catch { return []; }
}

function normalizeVerification(raw: VerificationResult | unknown): IndependentVerification | null {
  const parsed = IndependentVerificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function collectDeveloperGitObservation(repositoryPath: string, startingSha: string): Promise<DeveloperGitObservation> {
  const run = async (args: string[]) => (await execFileAsync("git", args, { cwd: repositoryPath, timeout: 30_000, maxBuffer: 256 * 1024 })).stdout.trim();
  const [branch, head, tree, status, parentLine, count, changed] = await Promise.all([
    run(["symbolic-ref", "--short", "HEAD"]),
    run(["rev-parse", "HEAD"]),
    run(["rev-parse", "HEAD^{tree}"]),
    run(["status", "--porcelain=v1", "--untracked-files=all"]),
    run(["rev-list", "--parents", "-n", "1", "HEAD"]),
    run(["rev-list", "--count", `${startingSha}..HEAD`]),
    run(["diff", "--name-only", "--diff-filter=ACDMRT", `${startingSha}..HEAD`]),
  ]);
  let isDescendant = true;
  try { await run(["merge-base", "--is-ancestor", startingSha, "HEAD"]); } catch { isDescendant = false; }
  const parents = parentLine.split(/\s+/).slice(1).filter(Boolean);
  return { branch, head, tree, status, parents, commitCount: Number(count), isDescendant, changedPaths: changed ? changed.split(/\r?\n/) : [] };
}

export function reconcileDeveloperDelivery(rawInput: DeveloperReconciliationInput): DeveloperReconciliation {
  const independentVerification = normalizeVerification(rawInput.independentVerification);
  const parsed = DeveloperDeliverySchema.safeParse(rawInput.report);
  const mismatches: string[] = [];
  if (!parsed.success) mismatches.push("raw-report-schema-invalid");
  const report = parsed.success ? parsed.data : null;
  if (rawInput.git.branch !== rawInput.neutralBranch) mismatches.push("branch-mismatch");
  if (rawInput.git.status) mismatches.push("dirty-final-tree");
  if (!rawInput.git.isDescendant) mismatches.push("starting-commit-not-ancestor");
  if (rawInput.git.head.toLowerCase() === rawInput.startingSha.toLowerCase()) mismatches.push("no-new-commit");
  if (rawInput.git.parents.length !== 1 || rawInput.git.parents[0]?.toLowerCase() !== rawInput.startingSha.toLowerCase()) mismatches.push("commit-parent-mismatch");
  if (rawInput.git.commitCount !== 1) mismatches.push("commit-count-mismatch");
  if (rawInput.providerAfterSha256 === null) mismatches.push("provider-observation-unavailable");
  if (rawInput.processExitCode !== 0) mismatches.push(rawInput.processExitCode === null ? "process-exit-unknown" : "process-exit-nonzero");
  if (!rawInput.developerSessionId) mismatches.push("missing-session");
  if (!rawInput.leadSessionId) mismatches.push("missing-lead-session");
  else if (rawInput.developerSessionId === rawInput.leadSessionId) mismatches.push("session-identity-conflict");
  if (!independentVerification || independentVerification.outcome !== "passed") mismatches.push("independent-verification-failed");

  if (report) {
    const expectedSteps = rawInput.manifest.verificationCommands.map((step) => step.stepNumber).sort((a, b) => a - b);
    const reportedSteps = report.steps.map((step) => step.number).sort((a, b) => a - b);
    if (new Set(expectedSteps).size !== expectedSteps.length) mismatches.push("duplicate-authorized-step");
    if (new Set(reportedSteps).size !== reportedSteps.length) mismatches.push("duplicate-plan-step");
    if (JSON.stringify(expectedSteps) !== JSON.stringify(reportedSteps)) mismatches.push("plan-step-set-mismatch");
    const changedByReport = new Set(report.steps.flatMap((step) => step.filesChanged));
    const changedByGit = new Set(rawInput.git.changedPaths);
    if (changedByReport.size !== changedByGit.size || [...changedByReport].some((path) => !changedByGit.has(path))) mismatches.push("reported-files-mismatch");
    const incomplete = report.steps.filter((step) => step.status !== "completed").map((step) => step.number).sort((a, b) => a - b);
    if (JSON.stringify(incomplete) !== JSON.stringify([...report.authorizedStepsNotCompleted].sort((a, b) => a - b))) mismatches.push("incomplete-step-mismatch");
    if (incomplete.length || report.blocker !== null) mismatches.push("non-completed-step");
    if (report.resultCommit.toLowerCase() !== rawInput.git.head.toLowerCase() || report.resultTree.toLowerCase() !== rawInput.git.tree.toLowerCase() || report.dirtyState !== "clean") mismatches.push("reported-git-state-mismatch");
  }

  const uniqueMismatches = [...new Set(mismatches)];
  // Audit observations remain durable diagnostics; only required local checks and
  // unsafe worktree state decide whether delivery can continue.
  const requiredTestsFailed = !independentVerification || independentVerification.outcome !== "passed";
  const blockingMismatch = ["dirty-final-tree", "branch-mismatch"].find((code) => uniqueMismatches.includes(code));
  const result: Omit<DeveloperReconciliation, "sha256"> = {
    kind: "developer-reconciliation",
    policyVersion: 2,
    executionId: rawInput.executionId,
    companyId: rawInput.companyId,
    outcome: requiredTestsFailed || blockingMismatch ? "blocked" : "completed",
    failureCode: requiredTestsFailed ? "required-local-tests-failed" : blockingMismatch ?? null,
    mismatches: uniqueMismatches,
    report,
    authorization: rawInput.authorization,
    manifest: rawInput.manifest,
    independentVerification,
    git: rawInput.git,
    provider: { beforeSha256: rawInput.providerBeforeSha256, afterSha256: rawInput.providerAfterSha256, matching: rawInput.providerAfterSha256 !== null && rawInput.providerBeforeSha256 === rawInput.providerAfterSha256 },
    observations: { startingSha: rawInput.startingSha, neutralBranch: rawInput.neutralBranch, processExitCode: rawInput.processExitCode, developerSessionId: rawInput.developerSessionId, leadSessionId: rawInput.leadSessionId },
  };
  return { ...result, sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
