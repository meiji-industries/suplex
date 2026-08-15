import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { z } from "zod";

import { AuthorizedPlanSubjectSchema, DeveloperDeliverySchema, EvidenceManifestSchema, ExecutionReceiptSchema, type AuthorizedPlanSubject, type DeveloperDelivery, type EvidenceManifest, type ExecutionReceipt } from "./developer-contracts.js";

const execFileAsync = promisify(execFile);

function canonicalCommand(value: string): string {
  const firstLine = value.split("\n", 1)[0]?.trim() ?? "";
  const shell = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(.+)$/.exec(firstLine)?.[1]?.trim() ?? firstLine;
  const command = (shell.startsWith("'") || shell.startsWith('"')) && shell.at(-1) === shell[0] ? shell.slice(1, -1) : shell;
  return command.replace(/\\(["'])/g, "$1").replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

// Strictly read-only git subcommands the Developer may run outside an active
// step (pre-step inspection and post-final-step verification). Mutating or
// ambiguous subcommands (remote, worktree, mutating branch forms, ...) stay excluded.
const readOnlyGit = "(?:status|rev-parse|log|show|diff|diff-tree|merge-base|rev-list|ls-files|cat-file|describe|branch\\s+--show-current)";
const forbiddenBootstrapCommand = new RegExp(`\\b(?:rm|mv|cp|touch|mkdir|rmdir|chmod|chown|curl|wget)\\b|\\bgit\\s+(?!${readOnlyGit}\\b)`);
const allowedBootstrapCommand = new RegExp(`^(?:for\\b|pwd|git ${readOnlyGit}\\b|(?:cat|head|tail|sed|ls|find|file|printf|sha256sum|xxd|nl|wc|rg)\\s+)`);
const allowedFinalGitCommand = new RegExp(`^git ${readOnlyGit}\\b`);

function isAllowlistedBootstrapReceipt(receipt: ExecutionReceipt, firstStepSequence: number): boolean {
  if (receipt.sequence >= firstStepSequence || !["command_started", "command_finished"].includes(receipt.kind)) return false;
  const command = canonicalCommand(receipt.summary);
  if (!command || /[<>`]|\$\(/.test(command) || forbiddenBootstrapCommand.test(command)) return false;
  return allowedBootstrapCommand.test(command);
}

function isAllowlistedFinalGitReceipt(receipt: ExecutionReceipt, finalStepSequence: number | undefined): boolean {
  if (finalStepSequence === undefined || receipt.sequence <= finalStepSequence || !["command_started", "command_finished"].includes(receipt.kind) || (receipt.kind === "command_finished" && receipt.exitCode !== 0)) return false;
  const command = canonicalCommand(receipt.summary);
  if (!command || /[<>`|;]|\$\(|\|\|/.test(command)) return false;
  const parts = command.split(/\s*&&\s*/);
  if (parts.length === 2 && /^git add\s+\S/.test(parts[0]!) && /^git commit\s+/.test(parts[1]!)) return true;
  return parts.every((part) => allowedFinalGitCommand.test(part) || (allowedBootstrapCommand.test(part) && !forbiddenBootstrapCommand.test(part)));
}

function matchesVerificationCommand(receipt: ExecutionReceipt, command: string): boolean {
  const actual = canonicalCommand(receipt.summary);
  const expected = canonicalCommand(command);
  return actual === expected || actual.split(/\s*(?:&&|;)\s*/).includes(expected);
}

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
  receipts: unknown[];
  git: DeveloperGitObservation;
  startingSha: string;
  neutralBranch: string;
  providerBeforeSha256: string;
  providerAfterSha256: string | null;
  processExitCode: number | null;
  malformedLines: number;
  developerSessionId: string | null;
  leadSessionId: string | null;
  authorization: AuthorizedPlanSubject;
  manifest: EvidenceManifest;
  verificationCommands: Array<{ stepNumber: number; commands: string[] }>;
}

export interface DeveloperReconciliation {
  kind: "developer-reconciliation";
  executionId: string;
  companyId: string;
  outcome: "completed" | "blocked";
  failureCode: string | null;
  mismatches: string[];
  report: DeveloperDelivery | null;
  authorization: AuthorizedPlanSubject;
  manifest: EvidenceManifest;
  receipts: ExecutionReceipt[];
  git: DeveloperGitObservation;
  provider: { beforeSha256: string; afterSha256: string | null; matching: boolean };
  receiptCount: number;
  observations?: {
    startingSha: string;
    neutralBranch: string;
    processExitCode: number | null;
    malformedLines: number;
    developerSessionId: string | null;
    leadSessionId: string | null;
    verificationCommands: Array<{ stepNumber: number; commands: string[] }>;
  };
  sha256: string;
}

const StoredReconciliationSchema = z.object({
  kind: z.literal("developer-reconciliation"),
  executionId: z.string().min(1),
  companyId: z.string().min(1),
  outcome: z.enum(["completed", "blocked"]),
  failureCode: z.string().nullable(),
  mismatches: z.array(z.string()),
  report: z.unknown().nullable(),
  authorization: AuthorizedPlanSubjectSchema,
  manifest: EvidenceManifestSchema,
  receipts: z.array(ExecutionReceiptSchema),
  git: z.object({ branch: z.string(), head: z.string(), tree: z.string(), status: z.string(), parents: z.array(z.string()), commitCount: z.number(), isDescendant: z.boolean(), changedPaths: z.array(z.string()) }),
  provider: z.object({ beforeSha256: z.string(), afterSha256: z.string().nullable(), matching: z.boolean() }),
  observations: z.object({ startingSha: z.string(), neutralBranch: z.string(), processExitCode: z.number().nullable(), malformedLines: z.number().int().nonnegative(), developerSessionId: z.string().nullable(), leadSessionId: z.string().nullable(), verificationCommands: z.array(z.object({ stepNumber: z.number().int().positive(), commands: z.array(z.string()) })) }).optional(),
}).passthrough();

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
  const input = { ...rawInput, receipts: rawInput.receipts.map((receipt) => ExecutionReceiptSchema.parse(receipt)) };
  const parsed = DeveloperDeliverySchema.safeParse(input.report);
  const mismatches: string[] = [];
  if (!parsed.success) mismatches.push("raw-report-schema-invalid");
  const report = parsed.success ? parsed.data : null;
  if (input.git.branch !== input.neutralBranch) mismatches.push("branch-mismatch");
  if (input.git.status) mismatches.push("dirty-final-tree");
  if (!input.git.isDescendant) mismatches.push("starting-commit-not-ancestor");
  if (input.git.head.toLowerCase() === input.startingSha.toLowerCase()) mismatches.push("no-new-commit");
  if (input.git.parents.length !== 1 || input.git.parents[0]?.toLowerCase() !== input.startingSha.toLowerCase()) mismatches.push("commit-parent-mismatch");
  if (input.git.commitCount !== 1) mismatches.push("commit-count-mismatch");
  if (input.providerAfterSha256 === null) mismatches.push("provider-observation-unavailable");
  else if (input.providerBeforeSha256 !== input.providerAfterSha256) mismatches.push("provider-state-changed");
  if (input.processExitCode !== 0) mismatches.push(input.processExitCode === null ? "process-exit-unknown" : "process-exit-nonzero");
  if (input.malformedLines > 0) mismatches.push("malformed-jsonl-output");
  if (!input.developerSessionId) mismatches.push("missing-session");
  if (!input.leadSessionId) mismatches.push("missing-lead-session");
  else if (input.developerSessionId === input.leadSessionId) mismatches.push("session-identity-conflict");
  if (report) {
    const expectedSteps = input.verificationCommands.map((step) => step.stepNumber).sort((a, b) => a - b);
    const reportedSteps = report.steps.map((step) => step.number).sort((a, b) => a - b);
    if (new Set(expectedSteps).size !== expectedSteps.length) mismatches.push("duplicate-authorized-step");
    if (new Set(reportedSteps).size !== reportedSteps.length) mismatches.push("duplicate-plan-step");
    if (JSON.stringify(expectedSteps) !== JSON.stringify(reportedSteps)) mismatches.push("plan-step-set-mismatch");
    const changedByReport = new Set(report.steps.flatMap((step) => step.filesChanged));
    const changedByGit = new Set(input.git.changedPaths);
    if (changedByReport.size !== changedByGit.size || [...changedByReport].some((path) => !changedByGit.has(path))) mismatches.push("reported-files-mismatch");
    const incomplete = report.steps.filter((step) => step.status !== "completed").map((step) => step.number).sort((a, b) => a - b);
    if (JSON.stringify(incomplete) !== JSON.stringify([...report.authorizedStepsNotCompleted].sort((a, b) => a - b))) mismatches.push("incomplete-step-mismatch");
    if (incomplete.length || report.blocker !== null) mismatches.push("non-completed-step");
    const startedByStep = new Map<number, number>();
    const terminalByStep = new Map<number, number>();
    const firstStepSequence = Math.min(Number.MAX_SAFE_INTEGER, ...input.receipts.filter((receipt) => receipt.kind === "step_started").map((receipt) => receipt.sequence));
    const finalStepSequence = input.receipts.filter((receipt) => receipt.kind === "step_completed" && receipt.stepNumber === reportedSteps.at(-1)).at(-1)?.sequence;
    for (const receipt of input.receipts) {
      if (receipt.kind === "reconciliation" && /Invalid forge-step marker|escaped the owned worktree/i.test(receipt.summary)) mismatches.push("developer-receipt-invalid");
      if (receipt.kind === "step_started") {
        if (startedByStep.has(receipt.stepNumber!)) mismatches.push(`duplicate-step-start:${receipt.stepNumber}`);
        startedByStep.set(receipt.stepNumber!, receipt.sequence);
      }
      if (receipt.kind === "step_completed" || receipt.kind === "step_blocked") {
        if (!startedByStep.has(receipt.stepNumber!)) mismatches.push(`missing-step-start:${receipt.stepNumber}`);
        if (terminalByStep.has(receipt.stepNumber!)) mismatches.push(`duplicate-step-terminal:${receipt.stepNumber}`);
        if ((startedByStep.get(receipt.stepNumber!) ?? Number.MAX_SAFE_INTEGER) >= receipt.sequence) mismatches.push(`step-terminal-order:${receipt.stepNumber}`);
        terminalByStep.set(receipt.stepNumber!, receipt.sequence);
      }
      if (["command_started", "command_finished", "file_change", "test_result"].includes(receipt.kind) && receipt.stepNumber === null && !isAllowlistedBootstrapReceipt(receipt, firstStepSequence) && !isAllowlistedFinalGitReceipt(receipt, finalStepSequence)) mismatches.push("receipt-outside-step");
      if (receipt.kind === "file_change" && !changedByGit.has(receipt.summary)) mismatches.push("file-change-not-in-final-tree");
    }
    for (const step of reportedSteps) if (!startedByStep.has(step) || !terminalByStep.has(step)) mismatches.push(`missing-step-receipt:${step}`);
    const receiptSteps = [...new Set(input.receipts.map((receipt) => receipt.stepNumber).filter((step): step is number => step !== null))].sort((a, b) => a - b);
    if (JSON.stringify(expectedSteps) !== JSON.stringify(receiptSteps)) mismatches.push("receipt-step-set-mismatch");
    for (const verification of input.verificationCommands) {
      const stepReceipts = input.receipts.filter((receipt) => receipt.stepNumber !== null && receipt.stepNumber >= verification.stepNumber && receipt.kind === "command_finished");
      for (const command of verification.commands) {
        const matching = stepReceipts.filter((receipt) => matchesVerificationCommand(receipt, command));
        if (!matching.length) mismatches.push(`missing-verification-command:${verification.stepNumber}`);
        else if (!matching.some((receipt) => receipt.exitCode === 0)) mismatches.push(`verification-command-failed:${verification.stepNumber}`);
      }
    }
    const commandStarted = new Set(input.receipts.filter((receipt) => receipt.kind === "command_started" && receipt.sourceItemId).map((receipt) => receipt.sourceItemId!));
    const commandFinished = new Set(input.receipts.filter((receipt) => receipt.kind === "command_finished" && receipt.sourceItemId).map((receipt) => receipt.sourceItemId!));
    for (const itemId of commandStarted) if (!commandFinished.has(itemId)) mismatches.push(`missing-command-terminal:${itemId}`);
    for (const itemId of commandFinished) if (!commandStarted.has(itemId)) mismatches.push(`command-terminal-without-start:${itemId}`);
    if (report.resultCommit.toLowerCase() !== input.git.head.toLowerCase() || report.resultTree.toLowerCase() !== input.git.tree.toLowerCase() || report.dirtyState !== "clean") mismatches.push("reported-git-state-mismatch");
  }
  const uniqueMismatches = [...new Set(mismatches)];
  const result: Omit<DeveloperReconciliation, "sha256"> = { kind: "developer-reconciliation", executionId: input.executionId, companyId: input.companyId, outcome: uniqueMismatches.length ? "blocked" : "completed", failureCode: uniqueMismatches.length ? (uniqueMismatches.includes("provider-state-changed") ? "provider-state-changed" : "delivery-reconciliation-failed") : null, mismatches: uniqueMismatches, report, authorization: input.authorization, manifest: input.manifest, receipts: input.receipts, git: input.git, provider: { beforeSha256: input.providerBeforeSha256, afterSha256: input.providerAfterSha256, matching: input.providerBeforeSha256 === input.providerAfterSha256 }, receiptCount: input.receipts.length, observations: { startingSha: input.startingSha, neutralBranch: input.neutralBranch, processExitCode: input.processExitCode, malformedLines: input.malformedLines, developerSessionId: input.developerSessionId, leadSessionId: input.leadSessionId, verificationCommands: input.verificationCommands } };
  return { ...result, sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}

/** Re-run only the pure acceptance policy against immutable stored evidence. */
export function rereconcileDeveloperDelivery(raw: unknown): DeveloperReconciliation | null {
  const parsed = StoredReconciliationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.outcome !== "blocked" || parsed.data.failureCode !== "delivery-reconciliation-failed") return null;
  const prior = parsed.data;
  const observations = prior.observations ?? (prior.mismatches.length > 0 && prior.mismatches.every((code) => code === "receipt-outside-step")
    ? { startingSha: prior.git.parents[0] ?? "", neutralBranch: prior.git.branch, processExitCode: 0, malformedLines: 0, developerSessionId: "legacy-developer-session", leadSessionId: "legacy-lead-session", verificationCommands: prior.manifest.verificationCommands }
    : null);
  if (!observations) return null;
  return reconcileDeveloperDelivery({ executionId: prior.executionId, companyId: prior.companyId, report: prior.report, receipts: prior.receipts, git: prior.git, startingSha: observations.startingSha, neutralBranch: observations.neutralBranch, providerBeforeSha256: prior.provider.beforeSha256, providerAfterSha256: prior.provider.afterSha256, processExitCode: observations.processExitCode, malformedLines: observations.malformedLines, developerSessionId: observations.developerSessionId, leadSessionId: observations.leadSessionId, authorization: prior.authorization, manifest: prior.manifest, verificationCommands: observations.verificationCommands });
}
