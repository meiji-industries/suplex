import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ArtifactStore } from "../../artifacts.js";
import { runCommand } from "../../command-runner.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import type { ActivityContext } from "./context.js";

export function createWorktreeActivities(ctx: ActivityContext) {
  const { database, config, worktrees, createHash } = ctx;
  const owned = (input: { taskId: string; companyId: string; workflowId: string }) => database.authQuery((db) => db.prepare("SELECT repository_path AS repositoryPath, worktree_path AS worktreePath, worktree_root AS worktreeRoot, branch_name AS branchName, starting_sha AS targetBaseSha FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND status <> 'released'").get(input.taskId, input.companyId, input.workflowId) as { repositoryPath: string; worktreePath: string; worktreeRoot: string; branchName: string; targetBaseSha: string } | undefined);
  const resolved = (input: { taskId: string; companyId: string; workflowId: string }) => {
    const lease = owned(input);
    if (lease) return { ...lease, leased: true };
    return database.authQuery((db) => {
      const execution = db.prepare("SELECT worktree_path AS worktreePath, branch_name AS branchName FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY started_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId) as { worktreePath: string; branchName: string } | undefined;
      if (!execution) return undefined;
      try {
        const pinned = loadTaskConfiguration(db, new ArtifactStore(config.artifactRoot, database), input);
        return { repositoryPath: pinned.repositoryPath, worktreePath: execution.worktreePath, worktreeRoot: pinned.worktreeRoot, branchName: execution.branchName, leased: false };
      } catch {
        return undefined;
      }
    });
  };
  const safe = (row: { worktreePath: string; worktreeRoot: string }) => {
    const path = resolve(row.worktreePath);
    return path.startsWith(`${resolve(config.worktreeRoot)}/`) && path.startsWith(`${resolve(row.worktreeRoot)}/`);
  };
  const active = (input: { taskId: string }) => database.authQuery((db) => db.prepare("SELECT 1 FROM forge_herdr_turns WHERE task_id = ? AND ledger = 'developer' AND status IN ('dispatching', 'waiting', 'validating') LIMIT 1").get(input.taskId)) !== undefined;
  const revision = (input: { taskId: string; companyId: string }) => database.authQuery((db) => (db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = ? AND company_id = ?").get(input.taskId, input.companyId) as { revision: number } | undefined)?.revision ?? 0);
  const recordTimeline = (input: { taskId: string; companyId: string; workflowId: string }, eventType: "worktree_cleaned" | "worktree_recreated", metadata: Record<string, unknown>) => {
    const currentRevision = revision(input);
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(metadata);
    const eventHash = createHash("sha256").update(metadataJson).digest("hex");
    database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, 'workflow', ?, ?, ?, ?)").run(input.workflowId + ":" + eventType + ":" + currentRevision, input.taskId, input.companyId, input.workflowId, currentRevision, eventType, metadataJson, now, eventHash));
  };
  const dirtyFiles = async (path: string): Promise<string[]> => {
    const { stdout, exitCode } = await runCommand({ taskId: null, stepId: null, command: "git", args: ["status", "--porcelain=v1", "--untracked-files=all"], cwd: path, timeout: 30_000 });
    if (exitCode !== 0) throw new Error("Git could not inspect worktree changes");
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).slice(0, 20);
  };
  return {
    async inspectTaskWorktree(input: { taskId: string; companyId: string; workflowId: string }) {
      const row = resolved(input);
      const isSafe = !!row && safe(row);
      const present = !!row && existsSync(row.worktreePath);
      let dirtyFileCount = 0;
      if (isSafe && present) dirtyFileCount = (await worktrees.inspectDelivery(row.worktreePath, row.branchName)).dirtyState === "dirty" ? 1 : 0;
      const artifact = !present && row
        ? await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "attention-evidence", { taskId: input.taskId, filename: input.workflowId + "-worktree-missing.txt", mimeType: "text/plain", bytes: Buffer.from("Local worktree is missing: " + row.worktreePath, "utf8") })
        : undefined;
      return { present, owned: isSafe, dirtyFileCount, branch: row?.branchName ?? null, activeExecution: active(input), ...(artifact ? { evidenceArtifactId: artifact.id } : {}) };
    },
    async cleanupTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; confirmDiscardDirty?: boolean }) {
      const row = resolved(input);
      if (!row || !safe(row) || active(input)) return { outcome: "not_owned" as const, dirtyFileCount: 0 };
      if (!existsSync(row.worktreePath)) return { outcome: "already_absent" as const, dirtyFileCount: 0 };
      const files = await dirtyFiles(row.worktreePath);
      const dirty = files.length;
      if (dirty && !input.confirmDiscardDirty) {
        const artifact = await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "attention-evidence", { taskId: input.taskId, filename: input.workflowId + "-worktree-dirty.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ path: row.worktreePath, dirtyFileCount: dirty, files }), "utf8") });
        return { outcome: "dirty_confirmation_required" as const, dirtyFileCount: dirty, evidenceArtifactId: artifact.id };
      }
      await worktrees.remove(row.repositoryPath, row.worktreePath);
      if (row.leased) database.authTransaction((db) => db.prepare("UPDATE forge_issue_worktrees SET status = 'released', cleaned_at = ? WHERE task_id = ?").run(new Date().toISOString(), input.taskId));
      recordTimeline(input, "worktree_cleaned", { path: row.worktreePath, dirtyFileCount: dirty, confirmed: !!input.confirmDiscardDirty });
      return { outcome: "cleaned" as const, dirtyFileCount: dirty };
    },
    async recreateTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; branchName: string; targetBaseSha: string }) {
      const row = owned(input);
      if (!row) throw new Error("Recorded worktree is unavailable");
      const result = await worktrees.create({ repositoryPath: row.repositoryPath, worktreeRoot: row.worktreeRoot, taskId: input.taskId, branchName: input.branchName, targetBaseSha: input.targetBaseSha });
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_worktrees SET worktree_path = ?, status = 'active', removed_externally_at = NULL, cleaned_at = NULL WHERE task_id = ?").run(result.worktreePath, input.taskId));
      recordTimeline(input, "worktree_recreated", { path: result.worktreePath, branchName: input.branchName, targetBaseSha: input.targetBaseSha });
      return { worktreePath: result.worktreePath };
    },
  };
}
