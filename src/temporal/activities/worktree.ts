import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ActivityContext } from "./context.js";

export function createWorktreeActivities(ctx: ActivityContext) {
  const { database, config, worktrees } = ctx;
  const owned = (input: { taskId: string; companyId: string; workflowId: string }) => database.authQuery((db) => db.prepare("SELECT repository_path AS repositoryPath, worktree_path AS worktreePath, worktree_root AS worktreeRoot, branch_name AS branchName, starting_sha AS targetBaseSha FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND status <> 'released'").get(input.taskId, input.companyId, input.workflowId) as { repositoryPath: string; worktreePath: string; worktreeRoot: string; branchName: string; targetBaseSha: string } | undefined);
  const active = (input: { taskId: string }) => database.authQuery((db) => db.prepare("SELECT 1 FROM forge_developer_executions WHERE task_id = ? AND status IN ('starting', 'running', 'cancelling') UNION ALL SELECT 1 FROM forge_agent_executions WHERE task_id = ? AND status IN ('starting', 'running', 'cancelling') LIMIT 1").get(input.taskId, input.taskId)) !== undefined;
  return {
    async inspectTaskWorktree(input: { taskId: string; companyId: string; workflowId: string }) {
      const row = owned(input);
      const safe = !!row && resolve(row.worktreePath).startsWith(`${resolve(config.worktreeRoot)}/`);
      const present = !!row && existsSync(row.worktreePath);
      let dirtyFileCount = 0;
      if (safe && present) dirtyFileCount = (await worktrees.inspectDelivery(row.worktreePath, row.branchName)).dirtyState === "dirty" ? 1 : 0;
      return { present, owned: safe, dirtyFileCount, branch: row?.branchName ?? null, activeExecution: active(input) };
    },
    async cleanupTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; confirmDiscardDirty?: boolean }) {
      const row = owned(input);
      if (!row || !resolve(row.worktreePath).startsWith(`${resolve(config.worktreeRoot)}/`) || active(input)) return { outcome: "not_owned" as const, dirtyFileCount: 0 };
      if (!existsSync(row.worktreePath)) return { outcome: "already_absent" as const, dirtyFileCount: 0 };
      const dirty = (await worktrees.inspectDelivery(row.worktreePath, row.branchName)).dirtyState === "dirty" ? 1 : 0;
      if (dirty && !input.confirmDiscardDirty) return { outcome: "dirty_confirmation_required" as const, dirtyFileCount: dirty };
      await worktrees.remove(row.repositoryPath, row.worktreePath);
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_worktrees SET status = 'released', cleaned_at = ? WHERE task_id = ?").run(new Date().toISOString(), input.taskId));
      return { outcome: "cleaned" as const, dirtyFileCount: dirty };
    },
    async recreateTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; branchName: string; targetBaseSha: string }) {
      const row = owned(input);
      if (!row) throw new Error("Recorded worktree is unavailable");
      const result = await worktrees.create({ repositoryPath: row.repositoryPath, worktreeRoot: row.worktreeRoot, taskId: input.taskId, branchName: input.branchName, targetBaseSha: input.targetBaseSha });
      database.authTransaction((db) => db.prepare("UPDATE forge_issue_worktrees SET worktree_path = ?, status = 'active', removed_externally_at = NULL, cleaned_at = NULL WHERE task_id = ?").run(result.worktreePath, input.taskId));
      return { worktreePath: result.worktreePath };
    },
  };
}
