import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { ArtifactStore } from "./artifacts.js";
import { runCommand } from "./command-runner.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
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
  return database.authQuery((db) => db.prepare(`SELECT 1 FROM forge_herdr_turns turn
    JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.is_current = 1
    WHERE turn.task_id = ? AND turn.ledger = 'developer'
      AND turn.turn_id = (SELECT latest.turn_id FROM forge_herdr_turns latest WHERE latest.role_session_id = turn.role_session_id ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1)
      AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating') LIMIT 1`).get(taskId)) !== undefined;
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
  if (!worktreePath || !inside(resolve(config.worktreeRoot), worktreePath)) return { kind: "not_owned" };
  try { await access(worktreePath); } catch { return { kind: "missing_worktree" }; }
  if (!shaPattern.test(input.remoteHead)) throw new Error("Remote task branch identity is invalid");
  const intendedRemoteHead = input.remoteHead.toLowerCase();
  {
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
    let priorHead = initial.head;
    let priorDirtyFileCount = initial.status.split(/\r?\n/).filter(Boolean).length;
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
      persistOutcome(outcome);
      return outcome;
    };
    if (priorDirtyFileCount > 0) return settleOutcome({ kind: "dirty_worktree", dirtyFileCount: priorDirtyFileCount });
    if (priorHead === intendedRemoteHead) return settleOutcome({ kind: "up_to_date", head: priorHead });
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
          const aborted = await run(["merge", "--abort"]);
          const files = conflicts.stdout.split("\0").filter(Boolean);
          if (!files.length || !tree.ok || !aborted.ok) throw new Error("Remote merge failed without complete conflict evidence and abort");
          const payload = JSON.stringify({ version: 1, checkpoint: "pre_release", expectedBaseSha: input.targetBaseSha ?? priorHead, observedBaseSha: intendedRemoteHead, priorHead, priorTree: tree.stdout, conflictFiles: files, combinedDiff: combined.stdout, priorCommitSummary: priorHead, baseCommitSummary: intendedRemoteHead, commandEvidence: { command: "git diff --cc --no-ext-diff", complete: true } }, null, 2);
          const artifact = await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "forward-merge-conflict", { taskId: input.taskId, filename: `${input.taskId}.json`, mimeType: "application/json", bytes: Buffer.from(payload) });
          const forwardMergeId = `merge_${createHash("sha256").update(`${input.workflowId}:remote:${intendedRemoteHead}`).digest("hex").slice(0, 32)}`;
          const now = (deps.now ?? (() => new Date().toISOString()))();
          database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, checkpoint, operation_key, prior_tree, conflict_artifact_id, conflict_artifact_sha256, conflict_file_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'conflict', ?, ?, ?, 'pre_release', NULL, ?, ?, ?, ?, ?)").run(forwardMergeId, input.taskId, input.companyId, input.targetBaseSha ?? priorHead, intendedRemoteHead, priorHead, JSON.stringify(files), now, input.workflowId, tree.stdout, artifact.id, artifact.sha256, files.length, now));
          outcome = { kind: "conflict", remoteHead: intendedRemoteHead, forwardMergeId, conflictArtifactId: artifact.id, conflictFileCount: files.length };
        }
      }
    } catch (error) { throw error; }
    return settleOutcome(outcome);
  }
}
