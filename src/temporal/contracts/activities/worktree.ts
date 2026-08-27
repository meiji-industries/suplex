export interface WorktreeActivities {
  inspectTaskWorktree(input: { taskId: string; companyId: string; workflowId: string }): Promise<{ present: boolean; owned: boolean; dirtyFileCount: number; branch: string | null; activeExecution: boolean }>;
  cleanupTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; confirmDiscardDirty?: boolean }): Promise<{ outcome: "cleaned" | "dirty_confirmation_required" | "not_owned" | "already_absent"; dirtyFileCount: number }>;
  recreateTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; branchName: string; targetBaseSha: string }): Promise<{ worktreePath: string }>;
}
