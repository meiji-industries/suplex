import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { ArtifactStore } from "../../artifacts.js";
import { runCommand } from "../../command-runner.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { json } from "../../task-utils.js";
import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import { readEnvironmentSettings } from "../../environment-settings.js";
import { invalidateBranchSync, WorktreeManager } from "../../worktrees.js";
import { DeveloperDeliveryReportSchema } from "../../codex-developer.js";
import type { ActivityContext } from "./context.js";

export function createWorktreeActivities(ctx: Pick<ActivityContext, "database" | "config" | "worktrees" | "createHash">) {
  const { database, config, worktrees, createHash } = ctx;
  const owned = (input: { taskId: string; companyId: string; workflowId: string }) => database.authQuery((db) => db.prepare("SELECT repository_path AS repositoryPath, worktree_path AS worktreePath, worktree_root AS worktreeRoot, branch_name AS branchName, starting_sha AS targetBaseSha FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY reserved_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId) as { repositoryPath: string; worktreePath: string; worktreeRoot: string; branchName: string; targetBaseSha: string } | undefined);
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
  const active = async (input: { taskId: string }) => {
    const turn = database.authQuery((db) => db.prepare(`SELECT turn.result_relative_path AS resultRelativePath FROM forge_herdr_turns turn
    WHERE turn.task_id = ? AND turn.ledger = 'developer'
      AND turn.turn_id = (SELECT latest.turn_id FROM forge_herdr_turns latest WHERE latest.role_session_id = turn.role_session_id ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1)
      AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating') LIMIT 1`).get(input.taskId) as { resultRelativePath: string } | undefined);
    if (!turn) return false;
    const resultPath = resolve(config.runtimeRoot, turn.resultRelativePath);
    if (!resultPath.startsWith(`${resolve(config.runtimeRoot)}/`)) return true;
    try { return !DeveloperDeliveryReportSchema.safeParse(json(await readFile(resultPath, "utf8"), null)).success; } catch { return true; }
  };
  const listed = async (row: { repositoryPath: string; worktreePath: string; branchName: string }) => {
    const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["worktree", "list", "--porcelain"], cwd: row.repositoryPath, timeout: 30_000 });
    if (result.exitCode !== 0) throw new Error("Git could not list task worktrees");
    const worktreePath = realpathSync(row.worktreePath);
    return result.stdout.split(/\r?\n\r?\n/).some((entry) => entry.split(/\r?\n/).includes(`worktree ${worktreePath}`));
  };
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
      const present = !!row && existsSync(row.worktreePath) && await listed(row);
      let dirtyFileCount = 0;
      if (isSafe && present) dirtyFileCount = (await worktrees.inspectDelivery(row.worktreePath, row.branchName)).dirtyState === "dirty" ? 1 : 0;
      const artifact = !present && row
        ? await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "attention-evidence", { taskId: input.taskId, filename: input.workflowId + "-worktree-missing.txt", mimeType: "text/plain", bytes: Buffer.from("The local worktree is missing: " + row.worktreePath, "utf8") })
        : undefined;
      return { present, owned: isSafe, dirtyFileCount, branch: row?.branchName ?? null, activeExecution: await active(input), ...(artifact ? { evidenceArtifactId: artifact.id } : {}) };
    },
    async cleanupTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; confirmDiscardDirty?: boolean }) {
      const row = resolved(input);
      if (!row || !safe(row) || await active(input)) return { outcome: "not_owned" as const, dirtyFileCount: 0 };
      if (!existsSync(row.worktreePath) || !await listed(row)) return { outcome: "already_absent" as const, dirtyFileCount: 0 };
      const files = await dirtyFiles(row.worktreePath);
      const dirty = files.length;
      if (dirty && !input.confirmDiscardDirty) {
        const artifact = await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "attention-evidence", { taskId: input.taskId, filename: input.workflowId + "-worktree-dirty.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ path: row.worktreePath, dirtyFileCount: dirty, files }), "utf8") });
        return { outcome: "dirty_confirmation_required" as const, dirtyFileCount: dirty, evidenceArtifactId: artifact.id };
      }
      await worktrees.remove(row.repositoryPath, row.worktreePath);
      recordTimeline(input, "worktree_cleaned", { path: row.worktreePath, dirtyFileCount: dirty, confirmed: !!input.confirmDiscardDirty });
      return { outcome: "cleaned" as const, dirtyFileCount: dirty };
    },
    async recreateTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; branchName: string; targetBaseSha: string }) {
      const row = owned(input);
      if (!row) throw new Error("Recorded worktree is unavailable");
      const result = await worktrees.create({ repositoryPath: row.repositoryPath, worktreeRoot: row.worktreeRoot, taskId: input.taskId, branchName: input.branchName, targetBaseSha: input.targetBaseSha });
      await invalidateBranchSync(result.worktreePath, input.branchName);
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_worktrees SET worktree_path = ?, activated_at = ? WHERE task_id = ? AND company_id = ? AND workflow_id = ?").run(result.worktreePath, new Date().toISOString(), input.taskId, input.companyId, input.workflowId));
      recordTimeline(input, "worktree_recreated", { path: result.worktreePath, branchName: input.branchName, targetBaseSha: input.targetBaseSha });
      return { worktreePath: result.worktreePath };
    },
  };
}

/**
 * Builds the worktree cleanup activity outside the engine host so the archive
 * path can clean a worktree locally when the durable workflow has already ended.
 */
export function createLocalWorktreeCleanup(database: ForgeDatabase, config: ForgeConfig, git?: ConstructorParameters<typeof WorktreeManager>[0]) {
  return createWorktreeActivities({
    database,
    config,
    worktrees: new WorktreeManager(git, () => readEnvironmentSettings(database).minFreeDiskGb),
    createHash,
  }).cleanupTaskWorktree;
}
