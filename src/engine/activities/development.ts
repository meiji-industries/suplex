import type { DevelopmentActivities, WorkflowDeveloperExecutionResult, WorkflowDeveloperRepairActivityInput, WorkflowDeveloperRepairResult } from "../contracts/activities/development.js";
import type { ActivityContext } from "./context.js";

export function createDevelopmentActivities(ctx: ActivityContext): DevelopmentActivities {
  const { database, cancelDeveloperExecution, SafeSummarySchema, normalizeSafeSummary, defaultDeveloper, activityWorktrees, activityWorktreesByBranch, developer, invokeAgent, bindCapacityExecution, runSupervised, latestWorktree, normalizeRepairResult } = ctx;
  const workflowExecutionResult = (raw: unknown): WorkflowDeveloperExecutionResult => {
    const result = raw as WorkflowDeveloperExecutionResult & { worktreePath: string };
    const { worktreePath: _worktreePath, ...safeResult } = result;
    void _worktreePath;
    return { ...safeResult, deliverySummary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.deliverySummary)) };
  };
  const workflowRepairResult = (raw: unknown): WorkflowDeveloperRepairResult => {
    const result = raw as WorkflowDeveloperRepairResult & { worktreePath: string };
    const { worktreePath: _worktreePath, ...safeResult } = result;
    void _worktreePath;
    return { ...safeResult, summary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.summary)) };
  };
  return {
    async findActiveDeveloperExecution(input) {
      return database.authQuery((db) => db.prepare(`SELECT execution.id AS executionId, session.id AS sessionRef
        FROM forge_developer_executions execution
        JOIN forge_herdr_turns turn ON turn.ledger = 'developer' AND turn.execution_id = execution.id AND turn.task_id = execution.task_id
        JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.task_id = execution.task_id AND session.is_current = 1
        WHERE execution.task_id = ? AND execution.company_id = ? AND execution.workflow_id = ?
          AND turn.turn_id = (SELECT latest.turn_id FROM forge_herdr_turns latest WHERE latest.role_session_id = turn.role_session_id ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1)
          AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating')
        ORDER BY turn.updated_at DESC, turn.created_at DESC LIMIT 1`).get(input.taskId, input.companyId, input.workflowId) as { executionId: string; sessionRef: string } | undefined) ?? null;
    },
    async findRecoverableDeveloperExecution(input) {
      const rows = database.authQuery((db) => db.transaction(() => {
        const executions = db.prepare(`SELECT execution.id AS executionId, execution.plan_revision AS planRevision, execution.attempt, session.id AS sessionRef, execution.worktree_path AS worktreePath, execution.branch_name AS branchName, execution.target_base_sha AS targetBaseSha, execution.supersedes_execution_id AS supersedesExecutionId
          FROM forge_developer_executions execution
          JOIN forge_herdr_turns turn ON turn.ledger = 'developer' AND turn.execution_id = execution.id AND turn.task_id = execution.task_id
          JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.task_id = execution.task_id
          WHERE execution.task_id = ? AND execution.company_id = ? AND execution.workflow_id = ?
            AND session.session_role IN ('builder', 'integrator') AND session.is_current = 1
            AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating', 'completed')
          ORDER BY execution.started_at DESC LIMIT 2`).all(input.taskId, input.companyId, input.workflowId) as Array<{ executionId: string; planRevision: number; attempt: number; sessionRef: string; worktreePath: string; branchName: string; targetBaseSha: string; supersedesExecutionId: string | null }>;
        if (executions.length !== 1) return [];
        const candidate = executions[0]!;
        return [candidate];
      })());
      return rows[0] ?? null;
    },
    async runDeveloperExecution(input) {
      const operation = developer.run ? developer.run.bind(developer) : defaultDeveloper.run.bind(defaultDeveloper);
      const result = await invokeAgent(input, () => operation(input), "builder");
      if (input.executionId && result.developerExecutionId !== input.executionId) throw new Error("The build identity did not match the durable Workflow operation");
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      void _worktreePath;
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId, sessionRef: result.developerSessionRef, worktreePath: result.worktreePath }, { ...safeResult, deliverySummary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.deliverySummary)) });
    },
    async runDeveloperExecutionSupervised(input) {
      return invokeAgent(input, () => runSupervised<WorkflowDeveloperExecutionResult>(input, "implementation", async (service) => {
        const result = await service.run({ ...input, executionId: input.developerTurnExecutionId });
        activityWorktrees.set(result.developerExecutionId, result.worktreePath);
        activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
        return workflowExecutionResult(result);
      }), "builder");
    },
    async runDeveloperRepair(input: WorkflowDeveloperRepairActivityInput) {
      const execution = database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath, branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { worktreePath: string; branchName: string; targetBaseSha: string; resultCommit: string | null; resultTree: string | null } | undefined) ?? { worktreePath: latestWorktree(input, input.developerExecutionId), branchName: input.branchName, targetBaseSha: input.targetBaseSha, resultCommit: input.subjectCommit, resultTree: input.subjectTree };
      if (!execution) throw new Error("The build context is unavailable");
      const serviceInput = { ...input, blockingFindings: input.blockingFindings ?? [], worktreePath: input.worktreePath ?? execution.worktreePath, branchName: input.branchName || execution.branchName, targetBaseSha: input.targetBaseSha || execution.targetBaseSha, subjectCommit: input.subjectCommit || execution.resultCommit!, subjectTree: input.subjectTree || execution.resultTree! };
      const runRepair = developer.runRepair ? developer.runRepair.bind(developer) : defaultDeveloper.runRepair.bind(defaultDeveloper);
      const result = await invokeAgent(input, async () => normalizeRepairResult(await runRepair(serviceInput), serviceInput), "builder");
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      void _worktreePath;
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId, sessionRef: result.developerSessionRef, worktreePath: result.worktreePath }, { ...safeResult, summary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.summary)) });
    },
    async runDeveloperRepairSupervised(input) {
      return invokeAgent(input, () => runSupervised<WorkflowDeveloperRepairResult>(input, "delivery-repair", async (service, operation) => {
        const execution = database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath, branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { worktreePath: string; branchName: string; targetBaseSha: string; resultCommit: string | null; resultTree: string | null } | undefined) ?? { worktreePath: latestWorktree(input, input.developerExecutionId), branchName: input.branchName, targetBaseSha: input.targetBaseSha, resultCommit: input.subjectCommit, resultTree: input.subjectTree };
        const result = await service.runRepair({ ...input, blockingFindings: input.blockingFindings ?? [], worktreePath: input.worktreePath ?? execution.worktreePath, branchName: input.branchName || execution.branchName, targetBaseSha: input.targetBaseSha || execution.targetBaseSha, subjectCommit: input.subjectCommit || execution.resultCommit!, subjectTree: input.subjectTree || execution.resultTree!, signal: operation.signal });
        activityWorktrees.set(result.developerExecutionId, result.worktreePath);
        activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
        return workflowRepairResult(result);
      }), "builder");
    },
    async cancelDeveloperExecution(input) {
      const result = await cancelDeveloperExecution(database, input.executionId, input.taskId);
      return result;
    },
  };
}
