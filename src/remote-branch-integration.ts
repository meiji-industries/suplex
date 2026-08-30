import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { ArtifactStore } from "./artifacts.js";
import { runCommand } from "./command-runner.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { operationKey, claimOperation, recoverOperation, releaseOperation, settleOperation, type OperationOwnership } from "./operation-claims.js";
import { json } from "./task-utils.js";
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
  if (active(database, input.taskId)) return { kind: "skipped_active_turn" };
  if (!shaPattern.test(input.remoteHead)) throw new Error("Remote task branch identity is invalid");
  const intendedRemoteHead = input.remoteHead.toLowerCase();
  const remoteRef = `refs/heads/${input.branchName}`;
  const git: Git = deps.git ?? (async (args, cwd, taskId) => {
    const result = await runCommand({ taskId, stepId: `remote-integration:${input.remoteHead}`, command: "git", args, cwd, env: withWorktreeMiseTrust(process.env, cwd), timeout: 30_000 });
    return { ok: result.exitCode === 0 && !result.timedOut, stdout: result.stdout.trim(), stderr: result.stderr };
  });
  const run = async (args: string[]) => git(args, worktreePath, input.taskId);
  const [remoteUrl, remoteObservation, initialStatus, initialHead] = await Promise.all([
    run(["remote", "get-url", "origin"]),
    run(["ls-remote", "origin", remoteRef]),
    run(["status", "--porcelain=v1", "--untracked-files=all"]),
    run(["rev-parse", "HEAD"]),
  ]);
  if (!remoteUrl.ok || !initialStatus.ok || !initialHead.ok || !shaPattern.test(initialHead.stdout)) throw new Error("Could not inspect exact remote integration coordinates");
  const observedRemoteHead = exactRemoteCommit(remoteObservation, remoteRef);
  const remoteUrlSha256 = createHash("sha256").update(remoteUrl.stdout).digest("hex");
  const key = operationKey(["remote-integration", input.taskId, intendedRemoteHead]);
  const initialStatusSha256 = createHash("sha256").update(initialStatus.stdout).digest("hex");
  const coordinates = {
    identity: { companyId: input.companyId, workflowId: input.workflowId, repository: input.repository, provider: "git-origin", remoteUrlSha256, remoteRef, intendedRemoteHead, targetBaseSha: input.targetBaseSha },
    authority: { priorHead: initialHead.stdout.toLowerCase(), priorStatusSha256: initialStatusSha256, priorDirtyFileCount: initialStatus.stdout.split(/\r?\n/).filter(Boolean).length },
  };
  const claim = claimOperation(database, { key, taskId: input.taskId, kind: "merge", coordinates });
  if (claim.status === "in_progress") throw new Error("Remote branch integration is already in progress");
  if ("result" in claim) {
    if (observedRemoteHead !== intendedRemoteHead) throw new Error("Remote integration provider identity changed");
    if (claim.status === "failed") return terminalIntegration(claim);
    const prior = stored(claim.result);
    const currentHead = initialHead.stdout.toLowerCase();
    const storedCoordinateRow = database.authQuery((db) => db.prepare("SELECT coordinates_json AS coordinatesJson FROM forge_operation_claims WHERE operation_key = ?").get(key)) as { coordinatesJson: string | null } | undefined;
    const parsedCoordinates: unknown = storedCoordinateRow?.coordinatesJson ? json(storedCoordinateRow.coordinatesJson, null) : null;
    let terminalPriorHead: string | undefined;
    let terminalStatusSha256: string | undefined;
    if (parsedCoordinates && typeof parsedCoordinates === "object" && "authority" in parsedCoordinates) {
      const authority = parsedCoordinates.authority;
      if (authority && typeof authority === "object") {
        if ("priorHead" in authority && typeof authority.priorHead === "string") terminalPriorHead = authority.priorHead;
        if ("priorStatusSha256" in authority && typeof authority.priorStatusSha256 === "string") terminalStatusSha256 = authority.priorStatusSha256;
      }
    }
    const clean = initialStatus.stdout === "";
    let exact = false;
    if (prior?.kind === "up_to_date") exact = clean && prior.head.toLowerCase() === currentHead;
    else if (prior?.kind === "fast_forwarded") exact = clean && prior.to.toLowerCase() === currentHead;
    else if (prior?.kind === "merged") exact = clean && prior.mergeCommit.toLowerCase() === currentHead && prior.remoteHead.toLowerCase() === intendedRemoteHead;
    else if (prior?.kind === "dirty_worktree") exact = currentHead === terminalPriorHead && createHash("sha256").update(initialStatus.stdout).digest("hex") === terminalStatusSha256;
    else if (prior?.kind === "conflict") exact = clean && database.authQuery((db) => db.prepare("SELECT 1 FROM forge_forward_merges WHERE id = ? AND operation_key = ? AND status = 'conflict' AND current_base_sha = ?").get(prior.forwardMergeId, key, intendedRemoteHead)) !== undefined;
    if (exact && prior) return prior;
    throw new Error("Remote branch integration completed outcome no longer matches exact authority");
  }
  let ownership: OperationOwnership;
  let priorHead = initialHead.stdout.toLowerCase();
  let priorStatusSha256 = initialStatusSha256;
  let priorDirtyFileCount = coordinates.authority.priorDirtyFileCount;
  if (claim.status === "recoverable") {
    const authority = claim.coordinates.authority;
    if (typeof authority.priorHead !== "string" || !shaPattern.test(authority.priorHead) || typeof authority.priorStatusSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(authority.priorStatusSha256) || typeof authority.priorDirtyFileCount !== "number") throw new Error("Remote branch integration recovery coordinates are unavailable");
    priorHead = authority.priorHead.toLowerCase();
    priorStatusSha256 = authority.priorStatusSha256.toLowerCase();
    priorDirtyFileCount = authority.priorDirtyFileCount;
    const recovered = recoverOperation(database, key, claim.previousOwnership);
    if (!recovered) throw new Error("Remote branch integration recovery is already in progress");
    ownership = recovered;
  } else {
    ownership = claim.ownership;
  }
  const persistOutcome = (outcome: RemoteIntegration): void => {
    if (!["fast_forwarded", "merged", "conflict"].includes(outcome.kind)) return;
    const metadata = JSON.stringify(outcome);
    const eventType = outcome.kind === "conflict" ? "remote_branch_conflict" : "remote_branch_integrated";
    const revision = (database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = ?").get(input.taskId) as { revision: number } | undefined)?.revision ?? 0);
    const now = (deps.now ?? (() => new Date().toISOString()))();
    database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, 'workflow', ?, ?, ?, ?)").run(`${input.workflowId}:remote_integration:${input.remoteHead}`, input.taskId, input.companyId, input.workflowId, revision, eventType, metadata, now, createHash("sha256").update(metadata).digest("hex")));
  };
  const inspectAuthority = async (): Promise<{ outcome?: RemoteIntegration; absent: boolean }> => {
    const [currentRemoteUrl, currentRemote, status, head] = await Promise.all([
      run(["remote", "get-url", "origin"]),
      run(["ls-remote", "origin", remoteRef]),
      run(["status", "--porcelain=v1", "--untracked-files=all"]),
      run(["rev-parse", "HEAD"]),
    ]);
    if (!currentRemoteUrl.ok || !status.ok || !head.ok) throw new ExactObservationFailure("Exact remote integration authority is unavailable", true);
    if (!shaPattern.test(head.stdout)) throw new ExactObservationFailure("Exact remote integration authority is invalid", false);
    if (createHash("sha256").update(currentRemoteUrl.stdout).digest("hex") !== remoteUrlSha256 || exactRemoteCommit(currentRemote, remoteRef) !== intendedRemoteHead) throw new ExactObservationFailure("Remote integration provider identity changed", false);
    const currentHead = head.stdout.toLowerCase();
    const statusSha256 = createHash("sha256").update(status.stdout).digest("hex");
    const forwardMerge = database.authQuery((db) => db.prepare("SELECT id, current_base_sha AS currentBaseSha, prior_head AS priorHead, status, conflict_artifact_id AS conflictArtifactId, conflict_file_count AS conflictFileCount FROM forge_forward_merges WHERE operation_key = ?").get(key) as { id: string; currentBaseSha: string; priorHead: string; status: string; conflictArtifactId: string | null; conflictFileCount: number | null } | undefined);
    if (forwardMerge?.status === "conflict" && forwardMerge.currentBaseSha.toLowerCase() === intendedRemoteHead && forwardMerge.priorHead.toLowerCase() === priorHead && forwardMerge.conflictArtifactId && forwardMerge.conflictFileCount !== null) {
      return { outcome: { kind: "conflict", remoteHead: intendedRemoteHead, forwardMergeId: forwardMerge.id, conflictArtifactId: forwardMerge.conflictArtifactId, conflictFileCount: forwardMerge.conflictFileCount }, absent: false };
    }
    if (forwardMerge) return { absent: false };
    if (currentHead === priorHead && statusSha256 === priorStatusSha256 && priorDirtyFileCount > 0) return { outcome: { kind: "dirty_worktree", dirtyFileCount: priorDirtyFileCount }, absent: false };
    if (currentHead === intendedRemoteHead) {
      if (priorHead === intendedRemoteHead) return { outcome: { kind: "up_to_date", head: currentHead }, absent: false };
      const ancestor = await run(["merge-base", "--is-ancestor", priorHead, intendedRemoteHead]);
      if (ancestor.ok) return { outcome: { kind: "fast_forwarded", from: priorHead, to: intendedRemoteHead }, absent: false };
      return { absent: false };
    }
    if (currentHead !== priorHead) {
      const parents = await run(["rev-list", "--parents", "-n", "1", currentHead]);
      const values = parents.ok ? parents.stdout.toLowerCase().split(/\s+/) : [];
      return values.length === 3 && values[0] === currentHead && values[1] === priorHead && values[2] === intendedRemoteHead
        ? { outcome: { kind: "merged", mergeCommit: currentHead, remoteHead: intendedRemoteHead }, absent: false }
        : { absent: false };
    }
    if (statusSha256 !== priorStatusSha256) return { absent: false };
    if (priorDirtyFileCount > 0) return { outcome: { kind: "dirty_worktree", dirtyFileCount: priorDirtyFileCount }, absent: false };
    return { absent: true };
  };
  const settleOutcome = (outcome: RemoteIntegration): RemoteIntegration => {
    try {
      persistOutcome(outcome);
      const settlement = settleOperation(database, key, ownership, "settled", outcome);
      if (settlement.applied) return outcome;
      if (settlement.status === "in_progress") throw new Error("Remote branch integration settlement lost claim ownership");
      return terminalIntegration(settlement);
    } catch (error) {
      if (database.authQuery((db) => (db.prepare("SELECT status FROM forge_operation_claims WHERE operation_key = ?").get(key) as { status: string } | undefined)?.status) === "claimed") releaseOperation(database, key, ownership);
      throw error;
    }
  };
  let inspection: Awaited<ReturnType<typeof inspectAuthority>>;
  try {
    inspection = await inspectAuthority();
  } catch (error) {
    if (error instanceof ExactObservationFailure && error.retryable) {
      releaseOperation(database, key, ownership);
      throw error;
    }
    const failure = { reasonCode: "operation-recovery-ambiguous", summary: "Remote branch integration exact identity is ambiguous" };
    settleOperation(database, key, ownership, "failed", failure);
    throw new Error(failure.summary);
  }
  if (inspection.outcome) return settleOutcome(inspection.outcome);
  if (!inspection.absent) {
    const failure = { reasonCode: "operation-recovery-ambiguous", summary: "Remote branch integration recovery found identity drift" };
    settleOperation(database, key, ownership, "failed", failure);
    throw new Error(failure.summary);
  }
  let outcome: RemoteIntegration;
  try {
    const fetched = await run(["fetch", "--no-tags", "origin", `+${remoteRef}:refs/remotes/origin/${input.branchName}`]);
    if (!fetched.ok) throw new Error("Could not fetch remote task branch");
    const ancestor = await run(["merge-base", "--is-ancestor", "HEAD", intendedRemoteHead]);
    if (ancestor.ok) {
      const merged = await run(["merge", "--ff-only", intendedRemoteHead]);
      if (!merged.ok) throw new Error("Could not fast-forward task branch");
      outcome = { kind: "fast_forwarded", from: priorHead, to: intendedRemoteHead };
    } else {
      const merged = await run(["merge", "--no-edit", intendedRemoteHead]);
      if (merged.ok) {
        const mergeCommit = await run(["rev-parse", "HEAD"]);
        if (!mergeCommit.ok || !shaPattern.test(mergeCommit.stdout)) throw new Error("Merged task branch HEAD is invalid");
        outcome = { kind: "merged", mergeCommit: mergeCommit.stdout.toLowerCase(), remoteHead: intendedRemoteHead };
      } else {
        const conflicts = await run(["diff", "--name-only", "--diff-filter=U", "-z"]);
        const combined = await run(["diff", "--cc", "--no-ext-diff"]);
        const tree = await run(["rev-parse", "HEAD^{tree}"]);
        await run(["merge", "--abort"]);
        const files = conflicts.stdout.split("\0").filter(Boolean);
        if (!files.length || !tree.ok) throw new Error("Remote merge failed without conflict evidence");
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
      inspection = await inspectAuthority();
    } catch (observationError) {
      if (observationError instanceof ExactObservationFailure && !observationError.retryable) {
        const failure = { reasonCode: "operation-recovery-ambiguous", summary: "Remote branch integration exact identity is ambiguous" };
        settleOperation(database, key, ownership, "failed", failure);
        throw new Error(failure.summary);
      }
      releaseOperation(database, key, ownership);
      throw error;
    }
    if (inspection.outcome) outcome = inspection.outcome;
    else if (inspection.absent) {
      releaseOperation(database, key, ownership);
      throw error;
    } else {
      const failure = { reasonCode: "operation-recovery-ambiguous", summary: "Remote branch integration recovery found identity drift" };
      settleOperation(database, key, ownership, "failed", failure);
      throw new Error(failure.summary);
    }
  }
  return settleOutcome(outcome);
}
