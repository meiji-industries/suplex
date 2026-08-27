import { access } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { connectTemporal, durableCommand, executeIssueCommand } from "./temporal/service.js";
import { issueUpdates } from "./temporal/issue-updates.js";

export interface WorktreeReconciliationResult {
  inspected: number;
  removedExternally: number;
  reported: number;
  outcomes: Array<{ taskId: string; phase: string; status: "present" | "removed_externally_terminal" | "removed_externally_active" | "already_recorded" }>;
}

type Candidate = { taskId: string; companyId: string; workflowId: string; worktreePath: string; phase: string; revision: number };

async function reportWorktreeMissing(config: ForgeConfig, workflowId: string, input: { expectedRevision: number; actorUserId: string; commandId: string; worktreePath: string }): Promise<void> {
  const temporal = await connectTemporal(config);
  try {
    const handle = temporal.client.workflow.getHandle(workflowId);
    await handle.executeUpdate(issueUpdates.report_worktree_missing, { args: [input], updateId: input.commandId });
  } finally {
    await temporal.connection.close();
  }
}

export async function reconcileWorktrees(database: ForgeDatabase, config: ForgeConfig, options: { taskId?: string; exists?: (path: string) => Promise<boolean>; execute?: typeof executeIssueCommand } = {}): Promise<WorktreeReconciliationResult> {
  const rows = database.authQuery((db) => db.prepare(`SELECT w.task_id AS taskId, w.company_id AS companyId, w.workflow_id AS workflowId, w.worktree_path AS worktreePath, p.phase, p.revision
    FROM forge_issue_worktrees w JOIN forge_issue_projections p ON p.task_id = w.task_id AND p.company_id = w.company_id
    WHERE w.status <> 'released' AND w.cleaned_at IS NULL AND (? IS NULL OR w.task_id = ?) ORDER BY w.task_id`).all(options.taskId ?? null, options.taskId ?? null) as Candidate[]);
  const exists = options.exists ?? (async (path: string) => access(path).then(() => true).catch(() => false));
  const execute = options.execute ?? executeIssueCommand;
  const outcomes: WorktreeReconciliationResult["outcomes"] = [];
  let removedExternally = 0;
  let reported = 0;
  for (const row of rows) {
    if (await exists(row.worktreePath)) { outcomes.push({ taskId: row.taskId, phase: row.phase, status: "present" }); continue; }
    const marked = database.authTransaction((db) => db.prepare("UPDATE forge_issue_worktrees SET removed_externally_at = ? WHERE task_id = ? AND status <> 'released' AND cleaned_at IS NULL AND removed_externally_at IS NULL").run(new Date().toISOString(), row.taskId));
    if (!marked.changes) { outcomes.push({ taskId: row.taskId, phase: row.phase, status: "already_recorded" }); continue; }
    removedExternally += 1;
    if (["done", "cancelled"].includes(row.phase)) {
      const metadataJson = JSON.stringify({ path: row.worktreePath });
      const eventHash = createHash("sha256").update(metadataJson).digest("hex");
      database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, 'workflow', 'worktree_removed_externally', ?, ?, ?)").run(row.workflowId + ":worktree_removed_externally", row.taskId, row.companyId, row.workflowId, row.revision, metadataJson, new Date().toISOString(), eventHash));
      outcomes.push({ taskId: row.taskId, phase: row.phase, status: "removed_externally_terminal" });
      continue;
    }
    const input = durableCommand(row.workflowId, "report-worktree-missing", { expectedRevision: row.revision, actorUserId: "worktree-reconciler", commandId: undefined, worktreePath: row.worktreePath });
    if (options.execute) await execute(config, row.workflowId, "report_worktree_missing" as never, input as never);
    else await reportWorktreeMissing(config, row.workflowId, input);
    reported += 1;
    outcomes.push({ taskId: row.taskId, phase: row.phase, status: "removed_externally_active" });
  }
  return { inspected: rows.length, removedExternally, reported, outcomes };
}
