import type { CapacityActivities } from "../contracts/activities/capacity.js";
import type { CapacityRequestInput } from "../../capacity-contracts.js";
import type { ActivityContext } from "./context.js";

export function createCapacityActivities(ctx: ActivityContext): CapacityActivities {
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, ProjectionIntegrityFailure, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, DeveloperExecutionLeaseRepository, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, artifactSha256, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, ProjectionIntegrityFailure, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, DeveloperExecutionLeaseRepository, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, artifactSha256, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async requestCapacity(rawInput: CapacityRequestInput) {
      const input = CapacityRequestInputSchema.parse(rawInput);
      try {
        return CapacityRequestSnapshotSchema.parse(capacity.request(input));
      } catch (error) {
        const failure = asNonRetryableCapacityFailure(error);
        if (failure) throw failure;
        throw error;
      }
    },
    async tryAcquireCapacity(input) {
      try {
        const result = capacity.tryAcquire(input.requestId, input.expectedWorkflowRevision);
        return CapacityAdmissionResultSchema.parse({ status: result.status, publicState: result.publicState });
      } catch (error) {
        const failure = asNonRetryableCapacityFailure(error);
        if (failure) throw failure;
        throw error;
      }
    },
    async inspectCapacity(input) {
      return CapacityRequestSnapshotSchema.parse(capacity.inspect(input.requestId));
    },
    async requeueCapacity(input) {
      return CapacityRequestSnapshotSchema.parse(capacity.requeueRateLimited(input.requestId, input.now));
    },
    async cancelCapacity(input) {
      return CapacityRequestSnapshotSchema.parse(capacity.cancelQueued(input.requestId, input.reason));
    },
    async finalizeCapacity(input) {
      try {
        return CapacityRequestSnapshotSchema.parse(capacity.finalize(input.requestId, input.expectedExecutionId, input.terminalReason));
      } catch (error) {
        const failure = asNonRetryableCapacityFailure(error);
        if (failure) throw failure;
        throw error;
      }
    },
    async rateLimitCapacity(input) {
      return CapacityRequestSnapshotSchema.parse(capacity.recordRateLimit(input.requestId, input.executionId, input.retryAt));
    },
    async reconcileCapacityOwnership(input) {
      await reconcileAgentExecutions(database);
      await reconcileDeveloperExecutions(database);
      capacity.reconcileFromLedgers(input?.now);
      return database.authQuery((db) => (db.prepare("SELECT id AS requestId, status, COALESCE(terminal_reason, 'reconciled') AS reason FROM forge_capacity_requests WHERE status = 'ownership_ambiguous'").all() as Array<{ requestId: string; status: string; reason: string }>).map((entry) => ({ requestId: entry.requestId, status: entry.status as "ownership_ambiguous", reason: entry.reason })));
    },
    async cancelCapacityExecution(input) {
      const request = capacity.inspect(input.requestId);
      if (request.status === "queued" || request.status === "rate_limited") {
        capacity.cancelQueued(input.requestId, "workflow cancellation");
        return { status: "cancelled" as const };
      }
      if (request.status === "ownership_ambiguous") {
        capacity.markOwnershipAmbiguous(input.requestId, "legacy ownership ambiguity reconciled during cancellation");
        return { status: "cancelled" as const, ...(request.executionId ? { executionId: request.executionId } : {}), reason: "legacy-ownership-ambiguity" };
      }
      if (request.status !== "active" || !request.executionKind || !request.executionId) {
        capacity.markOwnershipAmbiguous(input.requestId, "Active capacity has no provable external execution owner");
        return { status: "cancelled" as const, reason: "ownership-missing" };
      }
      if (request.executionKind === "agent") {
        const result = await cancelAgentExecution(database, request.executionId);
        if (result.status === "ownership_ambiguous") capacity.markOwnershipAmbiguous(input.requestId, result.reason ?? "agent cancellation ownership ambiguity");
        return { status: "cancelled" as const, executionId: request.executionId, ...(result.reason ? { reason: result.reason } : {}) };
      }
      await cancelDeveloperExecution(database, request.executionId);
      // The Developer cancellation activity owns pid inspection and escalation.
      // A capacity slot must never become a human-verification gate afterward.
      return { status: "cancelled" as const, executionId: request.executionId };
    },
  };
}
