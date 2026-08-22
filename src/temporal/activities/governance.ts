import type { GovernanceActivities, PlanBlockerResponseActivityInput } from "../contracts/activities/governance.js";
import type { ActivityContext } from "./context.js";

export function createGovernanceActivities(ctx: ActivityContext): GovernanceActivities {
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async recordPlanDecision(input) {
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new Error("Plan decision actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin" ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ? AND m.status = 'active'").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new Error("Plan decision scope is unavailable");
      const store = new ArtifactStore(config.artifactRoot);
      const staging = input.noteStagingRef ? { companyId: input.companyId, storagePath: `${input.companyId}/staging/${input.noteStagingRef}.bin` } : undefined;
      const repository = new PlanGovernanceRepository(database);
      if (input.idempotencyKey) {
        const existing = repository.findDecisionByIdempotency(input.workflowId, input.idempotencyKey);
        if (existing) {
          if (staging) await store.discardStaged(staging);
          return { decisionId: existing.decisionId, duplicate: true, noteArtifactId: existing.noteArtifactId };
        }
      }
      const bytes = input.noteStagingRef
        ? await store.readStaged(input.companyId, input.noteStagingRef)
        : Buffer.from((redact(input.note?.trim() ?? "") as string) || `${input.decision} plan`, "utf8");
      const noteArtifact = await store.put(input.companyId, "plan-decision", { filename: `${input.idempotencyKey ?? `decision_${input.planRevision}`}.md`, mimeType: "text/markdown", bytes });
      let result;
      try {
        database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(noteArtifact.id, noteArtifact.companyId, noteArtifact.kind, noteArtifact.filename, noteArtifact.mimeType, noteArtifact.byteSize, noteArtifact.sha256, noteArtifact.storagePath, noteArtifact.createdAt));
        result = repository.recordDecisionIdempotently({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, actorUserId: input.actorUserId, decision: input.decision, planRevision: input.planRevision, ...(input.subject ? { subject: input.subject } : {}), noteArtifactId: noteArtifact.id, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
      } catch (error) {
        database.authTransaction((db) => db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(noteArtifact.id, input.companyId));
        await store.remove(noteArtifact);
        throw asNonRetryableApplicationFailure(error) ?? error;
      }
      if (staging) await store.discardStaged(staging);
      return { decisionId: result.decisionId, duplicate: result.duplicate, noteArtifactId: result.noteArtifactId };
    },
    async recordDecisionBlockerResolution(input) {
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new AgentFailure("scope_configuration", "Decision blocker actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin"
        ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId)
        : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ? AND m.status = 'active'").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new AgentFailure("scope_configuration", "Decision blocker scope is unavailable");
      const existing = database.authQuery((db) => db.prepare("SELECT id, answer_artifact_id FROM forge_decision_blocker_resolutions WHERE workflow_id = ? AND blocker_output_artifact_id = ?").get(input.workflowId, input.blockerOutputArtifactId) as { id: string; answer_artifact_id: string } | undefined);
      if (existing) {
        return { resolutionId: existing.id };
      }
      const resolutionId = `blocker_resolution_${randomBytes(12).toString("hex")}`;
      const createdAt = new Date().toISOString();
      try {
        database.authTransaction((db) => db.prepare("INSERT INTO forge_decision_blocker_resolutions (id, task_id, company_id, workflow_id, blocker_output_artifact_id, blocker_output_sha256, answer_artifact_id, answer_sha256, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)").run(resolutionId, input.taskId, input.companyId, input.workflowId, input.blockerOutputArtifactId, input.answerArtifactId, input.actorUserId, createdAt));
      } catch (error) {
        const retry = database.authQuery((db) => db.prepare("SELECT id FROM forge_decision_blocker_resolutions WHERE workflow_id = ? AND blocker_output_artifact_id = ?").get(input.workflowId, input.blockerOutputArtifactId) as { id: string } | undefined);
        if (retry) return { resolutionId: retry.id };
        throw error;
      }
      return { resolutionId };
    },
    async recordPlanBlockerResponse(input: PlanBlockerResponseActivityInput) {
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new Error("Plan blocker response actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin"
        ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId)
        : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ? AND m.status = 'active'").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new Error("Plan blocker response scope is unavailable");
      const store = new ArtifactStore(config.artifactRoot);
      const staging = { companyId: input.companyId, storagePath: `${input.companyId}/staging/${input.answerStagingRef}.bin` };
      const repository = new PlanGovernanceRepository(database);
      const existing = repository.findBlockerResponseByIdempotency(input.workflowId, input.idempotencyKey);
      if (existing) {
        await store.discardStaged(staging);
        return { responseId: existing.responseId, duplicate: true, answerArtifactId: existing.answerArtifactId };
      }
      const answer = await store.readStaged(input.companyId, input.answerStagingRef);
      const answerArtifact = await store.put(input.companyId, "plan-blocker-response", { filename: `${input.idempotencyKey}.md`, mimeType: "text/markdown", bytes: answer });
      let result;
      try {
        database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(answerArtifact.id, answerArtifact.companyId, answerArtifact.kind, answerArtifact.filename, answerArtifact.mimeType, answerArtifact.byteSize, answerArtifact.sha256, answerArtifact.storagePath, answerArtifact.createdAt));
        result = repository.recordBlockerResponseIdempotently({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, blockerArtifactId: input.blockerArtifactId, answerArtifactId: answerArtifact.id, actorUserId: input.actorUserId, expectedWorkflowRevision: input.expectedWorkflowRevision, idempotencyKey: input.idempotencyKey });
      } catch (error) {
        database.authTransaction((db) => db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(answerArtifact.id, input.companyId));
        await store.remove(answerArtifact);
        throw asNonRetryableApplicationFailure(error) ?? error;
      }
      await store.discardStaged(staging);
      return { responseId: result.responseId, duplicate: result.duplicate, answerArtifactId: result.answerArtifactId };
    },
  };
}
