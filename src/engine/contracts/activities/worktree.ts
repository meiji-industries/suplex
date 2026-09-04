export interface WorktreeActivities {
  inspectTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; expectedCommit?: string; expectedTree?: string; expectedBranch?: string }): Promise<{ present: boolean; owned: boolean; dirtyFileCount: number; branch: string | null; activeExecution: boolean; revision: { proven: boolean; head: string | null; headTree: string | null; branch: string | null; clean: boolean; baseIsAncestor?: boolean; reason?: string } | null; evidenceArtifactId?: string }>;
  cleanupTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; confirmDiscardDirty?: boolean }): Promise<{ outcome: "cleaned" | "dirty_confirmation_required" | "not_owned" | "already_absent"; dirtyFileCount: number; evidenceArtifactId?: string }>;
  recreateTaskWorktree(input: { taskId: string; companyId: string; workflowId: string; branchName: string; targetBaseSha: string }): Promise<{ worktreePath: string }>;
}
