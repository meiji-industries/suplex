import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { DeveloperDeliverySchema, ExecutionReceiptSchema, type AuthorizedPlanSubject, type DeveloperDelivery, type EvidenceManifest, type ExecutionReceipt } from "./developer-contracts.js";

const execFileAsync = promisify(execFile);

function canonicalCommand(value: string): string {
  const firstLine = value.split("\n", 1)[0]?.trim() ?? "";
  const shell = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])(.*)\1$/.exec(firstLine);
  return (shell?.[2]?.trim() ?? firstLine).replace(/(['"])([A-Za-z0-9_./{}^:@%+=,-]+)\1/g, "$2").replace(/''|""/g, "");
}

function isAllowlistedBootstrapReceipt(receipt: ExecutionReceipt, firstStepSequence: number): boolean {
  if (receipt.sequence >= firstStepSequence || !["command_started", "command_finished"].includes(receipt.kind)) return false;
  const command = canonicalCommand(receipt.summary);
  if (!command || /&&|\|\||[;<>`]|\$\(/.test(command)) return false;
  if (/^pwd$/.test(command) || /^git (?:status|rev-parse)(?:\s|$)/.test(command)) return true;
  return /^(?:cat|head|tail|sed|ls|find)\s+/.test(command) && /(?:^|\s)\.forge-context(?:\/|\s|$)/.test(command);
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
  sha256: string;
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
      if (["command_started", "command_finished", "file_change", "test_result"].includes(receipt.kind) && receipt.stepNumber === null && !isAllowlistedBootstrapReceipt(receipt, firstStepSequence)) mismatches.push("receipt-outside-step");
      if (receipt.kind === "file_change" && !changedByGit.has(receipt.summary)) mismatches.push("file-change-not-in-final-tree");
    }
    for (const step of reportedSteps) if (!startedByStep.has(step) || !terminalByStep.has(step)) mismatches.push(`missing-step-receipt:${step}`);
    const receiptSteps = [...new Set(input.receipts.map((receipt) => receipt.stepNumber).filter((step): step is number => step !== null))].sort((a, b) => a - b);
    if (JSON.stringify(expectedSteps) !== JSON.stringify(receiptSteps)) mismatches.push("receipt-step-set-mismatch");
    for (const verification of input.verificationCommands) {
      const stepReceipts = input.receipts.filter((receipt) => receipt.stepNumber === verification.stepNumber && receipt.kind === "command_finished");
      for (const command of verification.commands) {
        const matching = stepReceipts.filter((receipt) => canonicalCommand(receipt.summary) === canonicalCommand(command));
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
  const result: Omit<DeveloperReconciliation, "sha256"> = { kind: "developer-reconciliation", executionId: input.executionId, companyId: input.companyId, outcome: mismatches.length ? "blocked" : "completed", failureCode: mismatches.length ? (mismatches.includes("provider-state-changed") ? "provider-state-changed" : "delivery-reconciliation-failed") : null, mismatches, report, authorization: input.authorization, manifest: input.manifest, receipts: input.receipts, git: input.git, provider: { beforeSha256: input.providerBeforeSha256, afterSha256: input.providerAfterSha256, matching: input.providerBeforeSha256 === input.providerAfterSha256 }, receiptCount: input.receipts.length };
  return { ...result, sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex") };
}
