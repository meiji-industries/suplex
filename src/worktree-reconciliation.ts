import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { runCommand } from "./command-runner.js";

export interface WorktreeReconciliationResult {
  inspected: number;
  removedExternally: number;
  reported: number;
  outcomes: Array<{ taskId: string; phase: string; status: "present" | "removed_externally_terminal" | "removed_externally_active" | "already_recorded" }>;
}

type Candidate = { taskId: string; companyId: string; workflowId: string; repositoryPath: string; worktreePath: string; branchName: string; phase: string; revision: number };

export async function reconcileWorktrees(database: ForgeDatabase, _config: ForgeConfig, options: { taskId?: string; exists?: (path: string) => Promise<boolean>; listed?: (row: Pick<Candidate, "repositoryPath" | "worktreePath" | "branchName">) => Promise<boolean> } = {}): Promise<WorktreeReconciliationResult> {
  const rows = database.authQuery((db) => db.prepare(`SELECT w.task_id AS taskId, w.company_id AS companyId, w.workflow_id AS workflowId, w.repository_path AS repositoryPath, w.worktree_path AS worktreePath, w.branch_name AS branchName, p.phase, p.revision
    FROM forge_issue_worktrees w JOIN forge_issue_projections p ON p.task_id = w.task_id AND p.company_id = w.company_id
    JOIN forge_tasks t ON t.id = w.task_id AND t.company_id = w.company_id AND t.archived_at IS NULL
  WHERE p.phase NOT IN ('done', 'cancelled', 'failed') AND (? IS NULL OR w.task_id = ?) ORDER BY w.task_id`).all(options.taskId ?? null, options.taskId ?? null) as Candidate[]);
  const exists = options.exists ?? (async (path: string) => access(path).then(() => true).catch(() => false));
  const listed = options.listed ?? (async (row: Pick<Candidate, "repositoryPath" | "worktreePath" | "branchName">) => {
    const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["worktree", "list", "--porcelain"], cwd: row.repositoryPath, timeout: 30_000 });
    if (result.exitCode !== 0) throw new Error("Git could not list task worktrees");
    const worktreePath = resolve(row.worktreePath);
    return result.stdout.split(/\r?\n\r?\n/).some((entry) => entry.split(/\r?\n/).some((line) => line === `worktree ${worktreePath}`));
  });
  const outcomes: WorktreeReconciliationResult["outcomes"] = [];
  let removedExternally = 0;
  let reported = 0;
  for (const row of rows) {
    if (await exists(row.worktreePath) && await listed(row)) { outcomes.push({ taskId: row.taskId, phase: row.phase, status: "present" }); continue; }
    removedExternally += 1;
    const metadataJson = JSON.stringify({ path: row.worktreePath, branch: row.branchName });
    const eventHash = createHash("sha256").update(metadataJson).digest("hex");
    database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, 'workflow', 'worktree_observed_missing', ?, ?, ?)").run(row.workflowId + ":worktree_observed_missing:" + row.revision, row.taskId, row.companyId, row.workflowId, row.revision, metadataJson, new Date().toISOString(), eventHash));
    outcomes.push({ taskId: row.taskId, phase: row.phase, status: "removed_externally_active" });
  }
  return { inspected: rows.length, removedExternally, reported, outcomes };
}
