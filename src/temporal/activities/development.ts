import type { DevelopmentActivities, WorkflowDeveloperExecutionResult, WorkflowDeveloperRepairActivityInput, WorkflowDeveloperRepairResult } from "../contracts/activities/development.js";
import type { ActivityContext } from "./context.js";

export function createDevelopmentActivities(ctx: ActivityContext): DevelopmentActivities {
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, ProjectionIntegrityFailure, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, DeveloperExecutionLeaseRepository, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, artifactSha256, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, ProjectionIntegrityFailure, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, DeveloperExecutionLeaseRepository, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, artifactSha256, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async findActiveDeveloperExecution(input) {
      return database.authQuery((db) => db.prepare("SELECT id AS executionId, session_ref AS sessionRef FROM forge_developer_executions WHERE task_id = ? AND company_id = ? AND workflow_id = ? AND status IN ('starting', 'running', 'cancelling') ORDER BY started_at DESC LIMIT 1").get(input.taskId, input.companyId, input.workflowId) as { executionId: string; sessionRef: string } | undefined) ?? null;
    },
    async reconcileDeveloperDeliveryEvidence(input) {
      const result = await defaultDeveloper.reconcileStoredDelivery(input);
      if (!result) return null;
      const { worktreePath: _worktreePath, ...safeResult } = result;
      return safeResult;
    },
    async runDeveloperExecution(input) {
      const operation = developer.run ? developer.run.bind(developer) : defaultDeveloper.run.bind(defaultDeveloper);
      const result = await invokeAgent(input, () => operation(input));
      if (input.executionId && result.developerExecutionId !== input.executionId) throw new Error("Developer execution identity did not match the durable Workflow operation");
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      const deliveryArtifactSha256 = artifactSha256(input.companyId, safeResult.deliveryArtifactId);
      const evidenceArtifactSha256 = artifactSha256(input.companyId, safeResult.evidenceArtifactId);
      const attention = safeResult.outcome === "blocked" ? await putAttentionEvidence(input, safeResult.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_contradiction", safeResult.failureCode ?? "developer_delivery_blocked", safeResult.deliverySummary) : undefined;
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId, sessionRef: result.developerSessionRef, worktreePath: result.worktreePath }, { ...safeResult, ...(deliveryArtifactSha256 ? { deliveryArtifactSha256 } : {}), ...(evidenceArtifactSha256 ? { evidenceArtifactSha256 } : {}), ...(attention ? { attentionEvidenceArtifactId: attention.artifactId, attentionEvidenceSha256: attention.sha256 } : {}), deliverySummary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.deliverySummary)) });
    },
    async runDeveloperExecutionSupervised(input) {
      return invokeAgent(input, () => runSupervised<WorkflowDeveloperExecutionResult>(input, async (service) => {
        const result = await service.run({ ...input, executionId: input.developerTurnExecutionId });
        activityWorktrees.set(result.developerExecutionId, result.worktreePath);
        activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
        const { worktreePath: _worktreePath, ...safeResult } = result;
        const deliveryArtifactSha256 = artifactSha256(input.companyId, safeResult.deliveryArtifactId);
        const evidenceArtifactSha256 = artifactSha256(input.companyId, safeResult.evidenceArtifactId);
        const attention = safeResult.outcome === "blocked" ? await putAttentionEvidence(input, safeResult.failureCode === "delivery-reconciliation-failed" ? "unsafe_recovery" : "agent_contradiction", safeResult.failureCode ?? "developer_delivery_blocked", safeResult.deliverySummary) : undefined;
        return { ...safeResult, ...(deliveryArtifactSha256 ? { deliveryArtifactSha256 } : {}), ...(evidenceArtifactSha256 ? { evidenceArtifactSha256 } : {}), ...(attention ? { attentionEvidenceArtifactId: attention.artifactId, attentionEvidenceSha256: attention.sha256 } : {}), deliverySummary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.deliverySummary)) };
      }));
    },
    async runDeveloperRepair(input: WorkflowDeveloperRepairActivityInput) {
      const execution = database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath, branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { worktreePath: string; branchName: string; targetBaseSha: string; resultCommit: string | null; resultTree: string | null } | undefined) ?? { worktreePath: latestWorktree(input, input.developerExecutionId), branchName: input.branchName, targetBaseSha: input.targetBaseSha, resultCommit: input.subjectCommit, resultTree: input.subjectTree };
      if (!execution) throw new Error("Developer execution context is unavailable");
      let blockingFindings = input.blockingFindings;
      let repairPlan = input.repairPlan;
      let artifactRepairPlan: string | undefined;
      if (input.repairPlanArtifactId) {
        const reference = await durableArtifactReference(database, artifacts, input.companyId, input.repairPlanArtifactId, "delivery-repair-plan");
        if (!input.repairPlanSha256 || reference.sha256 !== input.repairPlanSha256) throw new Error("Repair plan artifact hash mismatch");
        artifactRepairPlan = (await verifiedArtifactBytes(database, artifacts, input.companyId, { ...reference, sha256: input.repairPlanSha256 }, "delivery-repair-plan")).toString("utf8");
        repairPlan = artifactRepairPlan;
      }
      if (input.reviewArtifact) {
        const review = DeliveryReviewSchema.parse(JSON.parse((await verifiedArtifactBytes(database, artifacts, input.companyId, input.reviewArtifact, "delivery-review")).toString("utf8")));
        if (typeof review.repairPlan !== "string") throw new Error("Delivery review artifact is not repairable");
        blockingFindings = review.findings;
        if (artifactRepairPlan && artifactRepairPlan !== review.repairPlan) throw new Error("Repair plan artifact does not match the authoritative delivery review");
        repairPlan = review.repairPlan;
      }
      if (!blockingFindings || !repairPlan) throw new Error("Delivery review repair evidence is unavailable");
      const serviceInput = { ...input, worktreePath: input.worktreePath ?? execution.worktreePath, branchName: input.branchName || execution.branchName, targetBaseSha: input.targetBaseSha || execution.targetBaseSha, subjectCommit: input.subjectCommit || execution.resultCommit!, subjectTree: input.subjectTree || execution.resultTree!, blockingFindings, repairPlan };
      const result = await invokeAgent(input, async () => normalizeRepairResult(await (developer.runRepair ?? defaultDeveloper.runRepair.bind(defaultDeveloper))(serviceInput), serviceInput));
      activityWorktrees.set(result.developerExecutionId, result.worktreePath);
      activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
      const { worktreePath: _worktreePath, ...safeResult } = result;
      const attention = safeResult.outcome === "blocked" ? await putAttentionEvidence(input, "verification_unrecoverable", "developer_repair_blocked", safeResult.summary) : undefined;
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "developer", executionId: result.developerExecutionId, sessionRef: result.developerSessionRef, worktreePath: result.worktreePath }, { ...safeResult, ...(attention ? { attentionEvidenceArtifactId: attention.artifactId, attentionEvidenceSha256: attention.sha256 } : {}), summary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.summary)) });
    },
    async runDeveloperRepairSupervised(input) {
      return invokeAgent(input, () => runSupervised<WorkflowDeveloperRepairResult>(input, async (service) => {
        const execution = database.authQuery((db) => db.prepare("SELECT worktree_path AS worktreePath, branch_name AS branchName, target_base_sha AS targetBaseSha, result_commit AS resultCommit, result_tree AS resultTree FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { worktreePath: string; branchName: string; targetBaseSha: string; resultCommit: string | null; resultTree: string | null } | undefined) ?? { worktreePath: latestWorktree(input, input.developerExecutionId), branchName: input.branchName, targetBaseSha: input.targetBaseSha, resultCommit: input.subjectCommit, resultTree: input.subjectTree };
        let blockingFindings = input.blockingFindings;
        let repairPlan = input.repairPlan;
        if (input.reviewArtifact) {
          const review = DeliveryReviewSchema.parse(JSON.parse((await verifiedArtifactBytes(database, artifacts, input.companyId, input.reviewArtifact, "delivery-review")).toString("utf8")));
          if (typeof review.repairPlan !== "string") throw new Error("Delivery review artifact is not repairable");
          blockingFindings = review.findings;
          repairPlan = review.repairPlan;
        }
        if (!blockingFindings || !repairPlan) throw new Error("Delivery review repair evidence is unavailable");
        const result = await service.runRepair({ ...input, worktreePath: input.worktreePath ?? execution.worktreePath, branchName: input.branchName || execution.branchName, targetBaseSha: input.targetBaseSha || execution.targetBaseSha, subjectCommit: input.subjectCommit || execution.resultCommit!, subjectTree: input.subjectTree || execution.resultTree!, blockingFindings, repairPlan });
        activityWorktrees.set(result.developerExecutionId, result.worktreePath);
        activityWorktreesByBranch.set(`${input.workflowId}:${result.branchName}`, result.worktreePath);
        const { worktreePath: _worktreePath, ...safeResult } = result;
        const attention = safeResult.outcome === "blocked" ? await putAttentionEvidence(input, "verification_unrecoverable", "developer_repair_blocked", safeResult.summary) : undefined;
        return { ...safeResult, ...(attention ? { attentionEvidenceArtifactId: attention.artifactId, attentionEvidenceSha256: attention.sha256 } : {}), summary: SafeSummarySchema.parse(normalizeSafeSummary(safeResult.summary)) };
      }));
    },
    async cancelDeveloperExecution(input) {
      const result = await cancelDeveloperExecution(database, input.executionId);
      return result;
    },
  };
}
