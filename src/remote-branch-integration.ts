import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { ArtifactStore } from "./artifacts.js";
import { runCommand } from "./command-runner.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { operationKey, claimOperation, settleOperation } from "./operation-claims.js";
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
  const failure = claim.result as { message?: unknown; summary?: unknown } | null;
  const detail = typeof failure?.message === "string" ? failure.message : typeof failure?.summary === "string" ? failure.summary : "";
  throw new Error(`Remote branch integration previously failed${detail ? `: ${detail}` : ""}`);
}

export async function integrateRemoteBranch(database: ForgeDatabase, config: ForgeConfig, input: { taskId: string; companyId: string; workflowId: string; repository: string; branchName: string; remoteHead: string; worktreePath: string | null; targetBaseSha: string | null }, deps: { git?: Git; now?: () => string } = {}): Promise<RemoteIntegration> {
  const worktreePath = input.worktreePath ? resolve(input.worktreePath) : null;
  const owned = worktreePath && database.authQuery((db) => db.prepare("SELECT worktree_root AS worktreeRoot, branch_name AS branchName FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND worktree_path = ? AND status <> 'released'").get(input.taskId, input.companyId, input.workflowId, worktreePath) as { worktreeRoot: string; branchName: string } | undefined);
  if (!worktreePath || !owned || owned.branchName !== input.branchName || !inside(resolve(config.worktreeRoot), worktreePath) || !inside(resolve(owned.worktreeRoot), worktreePath)) return { kind: "not_owned" };
  try { await access(worktreePath); } catch { return { kind: "missing_worktree" }; }
  if (active(database, input.taskId)) return { kind: "skipped_active_turn" };
  const key = operationKey(["remote-integration", input.taskId, input.remoteHead]);
  const claim = claimOperation(database, { key, taskId: input.taskId, kind: "merge" });
  if (claim.status === "in_progress") throw new Error("Remote branch integration is already in progress");
  if (claim.status !== "acquired") return terminalIntegration(claim);
  const git: Git = deps.git ?? (async (args, cwd, taskId) => {
    const result = await runCommand({ taskId, stepId: `remote-integration:${input.remoteHead}`, command: "git", args, cwd, env: withWorktreeMiseTrust(process.env, cwd), timeout: 30_000 });
    return { ok: result.exitCode === 0 && !result.timedOut, stdout: result.stdout.trim(), stderr: result.stderr };
  });
  const run = async (args: string[]) => git(args, worktreePath, input.taskId);
  let outcome: RemoteIntegration;
  try {
    const status = await run(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!status.ok) throw new Error("Could not inspect task worktree");
    if (status.stdout) outcome = { kind: "dirty_worktree", dirtyFileCount: status.stdout.split(/\r?\n/).filter(Boolean).length };
    else {
      const fetched = await run(["fetch", "--no-tags", "origin", `+refs/heads/${input.branchName}:refs/remotes/origin/${input.branchName}`]);
      if (!fetched.ok) throw new Error("Could not fetch remote task branch");
      const head = await run(["rev-parse", "HEAD"]);
      if (!head.ok || !shaPattern.test(head.stdout)) throw new Error("Task branch HEAD is invalid");
      if (head.stdout.toLowerCase() === input.remoteHead.toLowerCase()) outcome = { kind: "up_to_date", head: head.stdout };
      else {
        const ancestor = await run(["merge-base", "--is-ancestor", "HEAD", input.remoteHead]);
        if (ancestor.ok) {
          const merged = await run(["merge", "--ff-only", input.remoteHead]);
          if (!merged.ok) throw new Error("Could not fast-forward task branch");
          outcome = { kind: "fast_forwarded", from: head.stdout, to: input.remoteHead };
        } else {
          const merged = await run(["merge", "--no-edit", input.remoteHead]);
          if (merged.ok) {
            const mergeCommit = await run(["rev-parse", "HEAD"]);
            if (!mergeCommit.ok || !shaPattern.test(mergeCommit.stdout)) throw new Error("Merged task branch HEAD is invalid");
            outcome = { kind: "merged", mergeCommit: mergeCommit.stdout, remoteHead: input.remoteHead };
          } else {
            const conflicts = await run(["diff", "--name-only", "--diff-filter=U", "-z"]);
            const combined = await run(["diff", "--cc", "--no-ext-diff"]);
            const tree = await run(["rev-parse", "HEAD^{tree}"]);
            await run(["merge", "--abort"]);
            const files = conflicts.stdout.split("\0").filter(Boolean);
            if (!files.length || !tree.ok) throw new Error("Remote merge failed without conflict evidence");
            const payload = JSON.stringify({ version: 1, checkpoint: "pre_release", expectedBaseSha: input.targetBaseSha ?? head.stdout, observedBaseSha: input.remoteHead, priorHead: head.stdout, priorTree: tree.stdout, conflictFiles: files, combinedDiff: combined.stdout, priorCommitSummary: head.stdout, baseCommitSummary: input.remoteHead, commandEvidence: { command: "git diff --cc --no-ext-diff", complete: true } }, null, 2);
            const artifact = await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "forward-merge-conflict", { taskId: input.taskId, filename: `${input.taskId}.json`, mimeType: "application/json", bytes: Buffer.from(payload) });
            const forwardMergeId = `merge_${createHash("sha256").update(`${input.workflowId}:remote:${input.remoteHead}`).digest("hex").slice(0, 32)}`;
            const now = (deps.now ?? (() => new Date().toISOString()))();
            database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, checkpoint, operation_key, prior_tree, conflict_artifact_id, conflict_artifact_sha256, conflict_file_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'conflict', ?, ?, ?, 'pre_release', ?, ?, ?, ?, ?, ?)").run(forwardMergeId, input.taskId, input.companyId, input.targetBaseSha ?? head.stdout, input.remoteHead, head.stdout, JSON.stringify(files), now, input.workflowId, key, tree.stdout, artifact.id, artifact.sha256, files.length, now));
            outcome = { kind: "conflict", remoteHead: input.remoteHead, forwardMergeId, conflictArtifactId: artifact.id, conflictFileCount: files.length };
          }
        }
      }
    }
    if (["fast_forwarded", "merged", "conflict"].includes(outcome.kind)) {
      const metadata = JSON.stringify(outcome);
      const eventType = outcome.kind === "conflict" ? "remote_branch_conflict" : "remote_branch_integrated";
      const revision = (database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = ?").get(input.taskId) as { revision: number } | undefined)?.revision ?? 0);
      const now = (deps.now ?? (() => new Date().toISOString()))();
      database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, 'workflow', ?, ?, ?, ?)").run(`${input.workflowId}:remote_integration:${input.remoteHead}`, input.taskId, input.companyId, input.workflowId, revision, eventType, metadata, now, createHash("sha256").update(metadata).digest("hex")));
    }
    const settlement = settleOperation(database, key, "settled", outcome);
    return settlement.applied ? outcome : terminalIntegration(settlement);
  } catch (error) {
    const settlement = settleOperation(database, key, "failed", { message: error instanceof Error ? error.message : String(error) });
    if (!settlement.applied) return terminalIntegration(settlement);
    throw error;
  }
}
