import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { ArtifactStore } from "./artifacts.js";
import { runCommand } from "./command-runner.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { acquireWorktreeMutation, beginOperation, claimOperation, fenceOperation, fenceWorktreeMutation, operationKey, readOperationEffect, recordOperationEffect, recoverOperation, releaseOperation, releaseWorktreeMutation, settleOperation, type OperationOwnership } from "./operation-claims.js";
import { withWorktreeMiseTrust } from "./worktrees.js";

export type RemoteIntegration =
  | { kind: "skipped_active_turn" }
  | { kind: "up_to_date"; head: string }
  | { kind: "fast_forwarded"; from: string; to: string }
  | { kind: "merged"; mergeCommit: string; remoteHead: string }
  | { kind: "conflict"; remoteHead: string; forwardMergeId: string; conflictArtifactId: string; conflictFileCount: number }
  | { kind: "dirty_worktree"; dirtyFileCount: number }
  | { kind: "missing_worktree" }
  | { kind: "not_owned" };

type Git = (args: string[], cwd: string, taskId: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const shaPattern = /^[a-f0-9]{40,64}$/i;
function inside(root: string, candidate: string): boolean { const path = relative(root, candidate); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".."); }
function active(database: ForgeDatabase, taskId: string): boolean {
  return database.authQuery((db) => db.prepare(`SELECT 1 FROM forge_developer_executions WHERE task_id = ? AND status IN ('starting', 'running', 'cancelling')
    UNION ALL SELECT 1 FROM forge_herdr_turns WHERE task_id = ? AND ledger = 'developer' AND status IN ('dispatching', 'waiting', 'validating') LIMIT 1`).get(taskId, taskId)) !== undefined;
}
function stored(value: unknown): RemoteIntegration | undefined {
  return value && typeof value === "object" && "kind" in value ? value as RemoteIntegration : undefined;
}

function terminalIntegration(claim: { status: "settled" | "failed"; result: unknown | null }): RemoteIntegration {
  if (claim.status === "settled") {
    const prior = stored(claim.result);
    if (prior) return prior;
    throw new Error("Remote branch integration settled without a reusable result");
  }
  throw new Error("Remote branch integration previously failed");
}

class ExactObservationFailure extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function exactRemoteCommit(result: Awaited<ReturnType<Git>>, remoteRef: string): string | null {
  if (!result.ok) throw new ExactObservationFailure("Could not observe the exact remote task branch", true);
  const rows = result.stdout.split(/\r?\n/).filter(Boolean);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new ExactObservationFailure("Remote task branch observation was ambiguous", false);
  const [commit, ref, ...extra] = rows[0]!.trim().split(/\s+/);
  if (extra.length || ref !== remoteRef || !commit || !shaPattern.test(commit)) throw new ExactObservationFailure("Remote task branch observation was ambiguous", false);
  return commit.toLowerCase();
}

export async function integrateRemoteBranch(database: ForgeDatabase, config: ForgeConfig, input: { taskId: string; companyId: string; workflowId: string; repository: string; branchName: string; remoteHead: string; worktreePath: string | null; targetBaseSha: string | null }, deps: { git?: Git; now?: () => string } = {}): Promise<RemoteIntegration> {
  const worktreePath = input.worktreePath ? resolve(input.worktreePath) : null;
  const owned = worktreePath && database.authQuery((db) => db.prepare("SELECT worktree_root AS worktreeRoot, branch_name AS branchName FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND worktree_path = ? AND status <> 'released'").get(input.taskId, input.companyId, input.workflowId, worktreePath) as { worktreeRoot: string; branchName: string } | undefined);
  if (!worktreePath || !owned || owned.branchName !== input.branchName || !inside(resolve(config.worktreeRoot), worktreePath) || !inside(resolve(owned.worktreeRoot), worktreePath)) return { kind: "not_owned" };
  try { await access(worktreePath); } catch { return { kind: "missing_worktree" }; }
  if (!shaPattern.test(input.remoteHead)) throw new Error("Remote task branch identity is invalid");
  const intendedRemoteHead = input.remoteHead.toLowerCase();
  const key = operationKey(["remote-integration", input.taskId, intendedRemoteHead]);
  const mutationLease = acquireWorktreeMutation(database, worktreePath, key);
  if (!mutationLease) throw new Error("Remote branch integration is already in progress");
  try {
    if (active(database, input.taskId)) return { kind: "skipped_active_turn" };
    const remoteRef = `refs/heads/${input.branchName}`;
    const git: Git = deps.git ?? (async (args, cwd, taskId) => {
      const result = await runCommand({ taskId, stepId: `remote-integration:${input.remoteHead}`, command: "git", args, cwd, env: withWorktreeMiseTrust(process.env, cwd), timeout: 30_000 });
      return { ok: result.exitCode === 0 && !result.timedOut, stdout: result.stdout.trim(), stderr: result.stderr };
    });
    const run = async (args: string[]) => git(args, worktreePath, input.taskId);
    const observe = async () => {
      const [remoteUrl, remoteObservation, status, head, tree] = await Promise.all([
        run(["remote", "get-url", "origin"]),
        run(["ls-remote", "origin", remoteRef]),
        run(["status", "--porcelain=v1", "--untracked-files=all"]),
        run(["rev-parse", "HEAD"]),
        run(["rev-parse", "HEAD^{tree}"]),
      ]);
      if (!remoteUrl.ok || !status.ok || !head.ok || !tree.ok || !shaPattern.test(head.stdout) || !shaPattern.test(tree.stdout)) throw new ExactObservationFailure("Exact remote integration authority is unavailable", true);
      return {
        remoteUrl: remoteUrl.stdout,
        remoteHead: exactRemoteCommit(remoteObservation, remoteRef),
        status: status.stdout,
        head: head.stdout.toLowerCase(),
        tree: tree.stdout.toLowerCase(),
      };
    };
    const initial = await observe();
    const remoteUrlSha256 = createHash("sha256").update(initial.remoteUrl).digest("hex");
    const coordinates = {
      identity: { companyId: input.companyId, workflowId: input.workflowId, repository: input.repository, provider: "git-origin", remoteUrlSha256, remoteRef, intendedRemoteHead, targetBaseSha: input.targetBaseSha },
      authority: { priorHead: initial.head, priorTree: initial.tree, priorStatusSha256: createHash("sha256").update(initial.status).digest("hex"), priorDirtyFileCount: initial.status.split(/\r?\n/).filter(Boolean).length },
    };
    const claim = claimOperation(database, { key, taskId: input.taskId, kind: "merge", coordinates, allowLegacyRecovery: true, allowLegacyTerminal: true });
    if (claim.status === "in_progress") throw new Error("Remote branch integration is already in progress");
    const parseReceipt = (): { outcome: RemoteIntegration; head: string; tree: string; statusSha256: string } | undefined => {
      const raw = readOperationEffect(database, key);
      if (!raw || typeof raw !== "object" || !("kind" in raw) || raw.kind !== "remote-integration" || !("outcome" in raw) || !("head" in raw) || typeof raw.head !== "string" || !("tree" in raw) || typeof raw.tree !== "string" || !("statusSha256" in raw) || typeof raw.statusSha256 !== "string") return undefined;
      const outcome = stored(raw.outcome);
      return outcome ? { outcome, head: raw.head, tree: raw.tree, statusSha256: raw.statusSha256 } : undefined;
    };
    const exactReceiptOutcome = async (observation: Awaited<ReturnType<typeof observe>>): Promise<RemoteIntegration | undefined> => {
      const receipt = parseReceipt();
      if (!receipt || observation.head !== receipt.head || observation.tree !== receipt.tree || createHash("sha256").update(observation.status).digest("hex") !== receipt.statusSha256) return undefined;
      if (receipt.outcome.kind !== "dirty_worktree" && observation.status) return undefined;
      if (receipt.outcome.kind === "conflict") {
        const conflict = receipt.outcome;
        const mergeHead = await run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
        const exactConflict = database.authQuery((db) => db.prepare(`SELECT 1 FROM forge_forward_merges f JOIN forge_artifacts a ON a.id = f.conflict_artifact_id AND a.sha256 = f.conflict_artifact_sha256 WHERE f.id = ? AND f.operation_key = ? AND f.status = 'conflict' AND lower(f.current_base_sha) = lower(?) AND f.conflict_artifact_id = ? AND f.conflict_file_count = ?`).get(conflict.forwardMergeId, key, intendedRemoteHead, conflict.conflictArtifactId, conflict.conflictFileCount)) !== undefined;
        if (mergeHead.ok || !exactConflict) return undefined;
      }
      return receipt.outcome;
    };
    if ("result" in claim) {
      if (claim.status === "failed") return terminalIntegration(claim);
      const prior = stored(claim.result);
      const exact = await exactReceiptOutcome(initial);
      if (prior && exact && JSON.stringify(prior) === JSON.stringify(exact) && initial.remoteHead === intendedRemoteHead) return prior;
      if (prior?.kind === "up_to_date" && !initial.status && initial.head === prior.head.toLowerCase() && initial.remoteHead === intendedRemoteHead) return prior;
      if (prior?.kind === "fast_forwarded" && !initial.status && initial.head === prior.to.toLowerCase() && initial.remoteHead === intendedRemoteHead) {
        const ancestor = await run(["merge-base", "--is-ancestor", prior.from, prior.to]);
        if (ancestor.ok) return prior;
      }
      throw new Error("Remote branch integration completed outcome no longer matches exact authority");
    }
    let ownership: OperationOwnership;
    let phase = claim.phase;
    let priorHead = initial.head;
    let priorTree = initial.tree;
    let priorStatusSha256 = createHash("sha256").update(initial.status).digest("hex");
    let priorDirtyFileCount = initial.status.split(/\r?\n/).filter(Boolean).length;
    if (claim.status === "recoverable") {
      const authority = claim.coordinates.authority;
      if (typeof authority.priorHead !== "string" || typeof authority.priorTree !== "string" || typeof authority.priorStatusSha256 !== "string" || typeof authority.priorDirtyFileCount !== "number") throw new Error("Remote branch integration recovery coordinates are unavailable");
      priorHead = authority.priorHead.toLowerCase();
      priorTree = authority.priorTree.toLowerCase();
      priorStatusSha256 = authority.priorStatusSha256;
      priorDirtyFileCount = authority.priorDirtyFileCount;
      const recovered = recoverOperation(database, key, claim.previousOwnership, undefined, coordinates);
      if (!recovered) throw new Error("Remote branch integration recovery is already in progress");
      ownership = recovered;
      phase = claim.phase;
      const exact = await exactReceiptOutcome(initial);
      if (exact) {
        if (!beginOperation(database, key, ownership)) throw new Error("Remote branch integration recovery lost ownership");
        const settlement = settleOperation(database, key, ownership, "settled", exact);
        if (settlement.applied) return exact;
        if (settlement.status === "in_progress") throw new Error("Remote branch integration recovery settlement is pending");
        return terminalIntegration(settlement);
      }
      if (phase === "executing") {
        releaseOperation(database, key, ownership, "executing");
        throw new Error("Remote branch integration outcome requires exact recovery");
      }
    } else {
      ownership = claim.ownership;
    }
    const preDispatch = await observe();
    const preDispatchStatusHash = createHash("sha256").update(preDispatch.status).digest("hex");
    const preDispatchRemoteIdentity = createHash("sha256").update(preDispatch.remoteUrl).digest("hex");
    if (preDispatchRemoteIdentity !== remoteUrlSha256 || preDispatch.remoteHead !== intendedRemoteHead) {
      if (beginOperation(database, key, ownership)) settleOperation(database, key, ownership, "failed", { reasonCode: "operation-recovery-ambiguous", summary: "Remote integration exact identity is ambiguous" });
      throw new Error("Remote integration exact identity is ambiguous");
    }
    if (preDispatch.head !== priorHead || preDispatch.tree !== priorTree || preDispatchStatusHash !== priorStatusSha256) {
      releaseOperation(database, key, ownership, "executing");
      throw new Error("Remote branch integration authority changed before execution");
    }
    if (!beginOperation(database, key, ownership) || !fenceOperation(database, key, ownership) || !fenceWorktreeMutation(database, mutationLease)) throw new Error("Remote branch integration was cancelled before mutation");
    const persistOutcome = (outcome: RemoteIntegration): void => {
      if (!["fast_forwarded", "merged", "conflict"].includes(outcome.kind)) return;
      const metadata = JSON.stringify(outcome);
      const eventType = outcome.kind === "conflict" ? "remote_branch_conflict" : "remote_branch_integrated";
      const revision = (database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = ?").get(input.taskId) as { revision: number } | undefined)?.revision ?? 0);
      const now = (deps.now ?? (() => new Date().toISOString()))();
      database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, 'workflow', ?, ?, ?, ?)").run(`${input.workflowId}:remote_integration:${input.remoteHead}`, input.taskId, input.companyId, input.workflowId, revision, eventType, metadata, now, createHash("sha256").update(metadata).digest("hex")));
    };
    const settleOutcome = async (outcome: RemoteIntegration): Promise<RemoteIntegration> => {
      const observed = await observe();
      if (outcome.kind !== "dirty_worktree" && observed.status) throw new Error("Remote integration did not leave a clean worktree");
      if (outcome.kind === "conflict") {
        const mergeHead = await run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
        if (mergeHead.ok) throw new Error("Remote integration conflict abort is incomplete");
      }
      const receipt = { kind: "remote-integration", outcome, head: observed.head, tree: observed.tree, statusSha256: createHash("sha256").update(observed.status).digest("hex") };
      if (!recordOperationEffect(database, key, ownership, receipt)) throw new Error("Remote integration effect receipt could not be persisted");
      persistOutcome(outcome);
      const settlement = settleOperation(database, key, ownership, "settled", outcome);
      if (settlement.applied) return outcome;
      if (settlement.status === "in_progress") throw new Error("Remote branch integration settlement lost ownership");
      return terminalIntegration(settlement);
    };
    if (priorDirtyFileCount > 0) return settleOutcome({ kind: "dirty_worktree", dirtyFileCount: priorDirtyFileCount });
    if (priorHead === intendedRemoteHead) return settleOutcome({ kind: "up_to_date", head: priorHead });
    let outcome: RemoteIntegration;
    try {
      if (!fenceOperation(database, key, ownership) || !fenceWorktreeMutation(database, mutationLease)) throw new Error("Remote branch integration mutation ownership changed");
      const fetched = await run(["fetch", "--no-tags", "origin", `+${remoteRef}:refs/remotes/origin/${input.branchName}`]);
      if (!fetched.ok) throw new Error("Could not fetch remote task branch");
      const ancestor = await run(["merge-base", "--is-ancestor", "HEAD", intendedRemoteHead]);
      if (ancestor.ok) {
        if (!fenceOperation(database, key, ownership) || !fenceWorktreeMutation(database, mutationLease)) throw new Error("Remote branch integration mutation ownership changed");
        const merged = await run(["merge", "--ff-only", intendedRemoteHead]);
        if (!merged.ok) throw new Error("Could not fast-forward task branch");
        outcome = { kind: "fast_forwarded", from: priorHead, to: intendedRemoteHead };
      } else {
        if (!fenceOperation(database, key, ownership) || !fenceWorktreeMutation(database, mutationLease)) throw new Error("Remote branch integration mutation ownership changed");
        const merged = await run(["merge", "--no-edit", intendedRemoteHead]);
        if (merged.ok) {
          const mergeCommit = await run(["rev-parse", "HEAD"]);
          if (!mergeCommit.ok || !shaPattern.test(mergeCommit.stdout)) throw new Error("Merged task branch HEAD is invalid");
          outcome = { kind: "merged", mergeCommit: mergeCommit.stdout.toLowerCase(), remoteHead: intendedRemoteHead };
        } else {
          const conflicts = await run(["diff", "--name-only", "--diff-filter=U", "-z"]);
          const combined = await run(["diff", "--cc", "--no-ext-diff"]);
          const tree = await run(["rev-parse", "HEAD^{tree}"]);
          const aborted = await run(["merge", "--abort"]);
          const files = conflicts.stdout.split("\0").filter(Boolean);
          if (!files.length || !tree.ok || !aborted.ok) throw new Error("Remote merge failed without complete conflict evidence and abort");
          const payload = JSON.stringify({ version: 1, checkpoint: "pre_release", expectedBaseSha: input.targetBaseSha ?? priorHead, observedBaseSha: intendedRemoteHead, priorHead, priorTree: tree.stdout, conflictFiles: files, combinedDiff: combined.stdout, priorCommitSummary: priorHead, baseCommitSummary: intendedRemoteHead, commandEvidence: { command: "git diff --cc --no-ext-diff", complete: true } }, null, 2);
          const artifact = await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "forward-merge-conflict", { taskId: input.taskId, filename: `${input.taskId}.json`, mimeType: "application/json", bytes: Buffer.from(payload) });
          const forwardMergeId = `merge_${createHash("sha256").update(`${input.workflowId}:remote:${intendedRemoteHead}`).digest("hex").slice(0, 32)}`;
          const now = (deps.now ?? (() => new Date().toISOString()))();
          database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, checkpoint, operation_key, prior_tree, conflict_artifact_id, conflict_artifact_sha256, conflict_file_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'conflict', ?, ?, ?, 'pre_release', ?, ?, ?, ?, ?, ?)").run(forwardMergeId, input.taskId, input.companyId, input.targetBaseSha ?? priorHead, intendedRemoteHead, priorHead, JSON.stringify(files), now, input.workflowId, key, tree.stdout, artifact.id, artifact.sha256, files.length, now));
          outcome = { kind: "conflict", remoteHead: intendedRemoteHead, forwardMergeId, conflictArtifactId: artifact.id, conflictFileCount: files.length };
        }
      }
    } catch (error) {
      try {
        const observed = await observe();
        const exact = await exactReceiptOutcome(observed);
        if (exact) return settleOutcome(exact);
        const unchanged = observed.head === priorHead && observed.tree === priorTree && createHash("sha256").update(observed.status).digest("hex") === priorStatusSha256;
        releaseOperation(database, key, ownership, unchanged ? "prepared" : "executing");
      } catch {
        releaseOperation(database, key, ownership, "executing");
      }
      throw error;
    }
    return settleOutcome(outcome);
  } finally {
    releaseWorktreeMutation(database, mutationLease);
  }
}
