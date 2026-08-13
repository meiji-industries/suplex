import type { GovernanceActivities, PlanBlockerResponseActivityInput } from "../contracts/activities/governance.js";
import type { ActivityContext } from "./context.js";

export function createGovernanceActivities(ctx: ActivityContext): GovernanceActivities {
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, ProjectionIntegrityFailure, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, DeveloperExecutionLeaseRepository, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, hashPlanBlockerSubject, hashPlanDecisionSubject, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, artifactSha256, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, ProjectionIntegrityFailure, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, DeveloperExecutionLeaseRepository, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, hashPlanBlockerSubject, hashPlanDecisionSubject, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, artifactSha256, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async authorizeFinalPlan(input) {
      const plan = database.authQuery((db) => db.prepare(`SELECT a.id, a.sha256, a.storage_path
        FROM forge_issue_outputs io
        JOIN forge_artifacts a ON a.id = io.output_artifact_id AND a.company_id = io.company_id
        JOIN forge_tasks t ON t.id = io.task_id AND t.company_id = io.company_id AND t.project_id = ? AND t.project_revision_id = ? AND t.workflow_id = io.workflow_id
        JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.project_id = t.project_id AND r.state = 'accepted'
        JOIN forge_issue_governance g ON g.task_id = t.id AND g.company_id = t.company_id AND g.plan_revision = io.revision
        WHERE io.task_id = ? AND io.company_id = ? AND io.workflow_id = ? AND io.revision = ? AND io.output_artifact_id = ? AND io.kind = 'plan'
          AND ((? = 'routine_auto' AND g.plan_material = 0) OR (? = 'human_approval' AND g.plan_material = 1))`).get(input.projectId, input.projectRevisionId, input.taskId, input.companyId, input.workflowId, input.planRevision, input.planArtifactId, input.authorizationKind, input.authorizationKind) as { id: string; sha256: string; storage_path: string } | undefined);
      if (!plan) throw ApplicationFailure.nonRetryable("The exact final plan artifact is unavailable", "plan-authorization-mismatch");
      const bytes = await new ArtifactStore(config.artifactRoot).read({ companyId: input.companyId, storagePath: plan.storage_path, sha256: plan.sha256 });
      if (createHash("sha256").update(bytes).digest("hex") !== plan.sha256) throw new Error("The final plan artifact failed hash verification");
      if (input.authorizationKind === "routine_auto" && input.approvalDecisionId) throw new Error("Routine plan authorization cannot include an approval decision");
      if (input.authorizationKind === "human_approval" && !input.approvalDecisionId) throw new Error("Human plan authorization requires an approval decision");
      if (input.approvalDecisionId) {
        const decision = database.authQuery((db) => db.prepare("SELECT id FROM forge_plan_decisions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND decision = 'approve' AND legacy_unverified = 0").get(input.approvalDecisionId, input.taskId, input.companyId, input.workflowId) as { id: string } | undefined);
        if (!decision) throw new Error("The exact plan approval decision is unavailable");
      }
      const existing = database.authQuery((db) => db.prepare("SELECT id, plan_artifact_id AS planArtifactId, plan_sha256 AS planSha256, authorization_kind AS authorizationKind, approval_decision_id AS approvalDecisionId, authorized_at AS authorizedAt FROM forge_plan_authorizations WHERE task_id = ? AND company_id = ? AND project_id = ? AND workflow_id = ? AND plan_revision = ?").get(input.taskId, input.companyId, input.projectId, input.workflowId, input.planRevision) as { id: string; planArtifactId: string; planSha256: string; authorizationKind: "routine_auto" | "human_approval"; approvalDecisionId: string | null; authorizedAt: string } | undefined);
      if (existing) {
        if (existing.planArtifactId !== plan.id || existing.planSha256 !== plan.sha256 || existing.authorizationKind !== input.authorizationKind || existing.approvalDecisionId !== (input.approvalDecisionId ?? null)) throw new Error("The plan authorization identity conflicts with an existing authorization");
        return { authorizationId: existing.id, planRevision: input.planRevision, planArtifactId: plan.id, planArtifactSha256: plan.sha256, authorizationKind: existing.authorizationKind, approvalDecisionId: existing.approvalDecisionId, authorizedAt: existing.authorizedAt };
      }
      const authorizationId = `plan_auth_${randomBytes(12).toString("hex")}`;
      const authorizedAt = new Date().toISOString();
      database.authTransaction((db) => db.prepare("INSERT INTO forge_plan_authorizations (id, task_id, company_id, project_id, workflow_id, plan_revision, plan_artifact_id, plan_sha256, authorization_kind, approval_decision_id, authorized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(authorizationId, input.taskId, input.companyId, input.projectId, input.workflowId, input.planRevision, plan.id, plan.sha256, input.authorizationKind, input.approvalDecisionId ?? null, authorizedAt));
      return { authorizationId, planRevision: input.planRevision, planArtifactId: plan.id, planArtifactSha256: plan.sha256, authorizationKind: input.authorizationKind, approvalDecisionId: input.approvalDecisionId ?? null, authorizedAt };
    },
    async recordPlanDecision(input) {
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new Error("Plan decision actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin" ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ? AND m.status = 'active'").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new Error("Plan decision scope is unavailable");
      if (input.subject && input.idempotencyKey && input.noteStagingRef && input.noteSha256) {
        const repository = new PlanGovernanceRepository(database);
        const existing = repository.findDecisionByIdempotency(input.workflowId, input.idempotencyKey);
        if (existing) {
          const expectedDecision = input.decision === "approve" ? "approve" : "request_revision";
          if (existing.decision !== expectedDecision || existing.subjectHash !== hashPlanDecisionSubject(input.subject) || existing.noteArtifactSha256 !== input.noteSha256) throw new PlanGovernanceConflict("The idempotency key was reused with a different decision");
          await new ArtifactStore(config.artifactRoot).discardStaged({ companyId: input.companyId, storagePath: `${input.companyId}/staging/${input.noteStagingRef}.bin` });
          return { decisionId: existing.decisionId, subjectHash: existing.subjectHash, duplicate: true, noteArtifactId: existing.noteArtifactId, noteArtifactSha256: existing.noteArtifactSha256 };
        }
        const note = await new ArtifactStore(config.artifactRoot).readStaged(input.companyId, input.noteStagingRef, input.noteSha256);
        const noteArtifact = await new ArtifactStore(config.artifactRoot).put(input.companyId, "plan-decision", { filename: `${input.idempotencyKey}.md`, mimeType: "text/markdown", bytes: note });
        let result;
        try {
          database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(noteArtifact.id, noteArtifact.companyId, noteArtifact.kind, noteArtifact.filename, noteArtifact.mimeType, noteArtifact.byteSize, noteArtifact.sha256, noteArtifact.storagePath, noteArtifact.createdAt));
          result = repository.recordDecisionIdempotently({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, actorUserId: input.actorUserId, decision: input.decision === "approve" ? "approve" : "request_revision", subject: input.subject, noteArtifactId: noteArtifact.id, noteArtifactSha256: noteArtifact.sha256, idempotencyKey: input.idempotencyKey });
        } catch (error) {
          database.authTransaction((db) => db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(noteArtifact.id, input.companyId));
          await new ArtifactStore(config.artifactRoot).remove(noteArtifact);
          throw error;
        }
        await new ArtifactStore(config.artifactRoot).discardStaged({ companyId: input.companyId, storagePath: `${input.companyId}/staging/${input.noteStagingRef}.bin` });
        return { decisionId: result.decisionId, subjectHash: result.subjectHash, duplicate: result.duplicate, noteArtifactId: result.noteArtifactId, noteArtifactSha256: result.noteArtifactSha256 };
      }
      const note = (redact(input.note?.trim() ?? "") as string) || `${input.decision} plan`;
      const artifact = await new ArtifactStore(config.artifactRoot).put(input.companyId, "plan-decision", { filename: `decision_${input.planRevision}.md`, mimeType: "text/markdown", bytes: Buffer.from(note, "utf8") });
      const decisionId = `decision_${randomBytes(12).toString("hex")}`;
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
        db.prepare("INSERT INTO forge_plan_decisions (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(decisionId, input.taskId, input.companyId, input.workflowId, input.planRevision, input.decision, input.actorUserId, artifact.id, artifact.createdAt);
      });
      return { decisionId, noteArtifactId: artifact.id, noteSha256: artifact.sha256 };
    },
    async recordDecisionBlockerResolution(input) {
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new AgentFailure("scope_configuration", "Decision blocker actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin"
        ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId)
        : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ? AND m.status = 'active'").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new AgentFailure("scope_configuration", "Decision blocker scope is unavailable");
      const existing = database.authQuery((db) => db.prepare("SELECT id, answer_artifact_id, answer_sha256 FROM forge_decision_blocker_resolutions WHERE workflow_id = ? AND blocker_output_artifact_id = ?").get(input.workflowId, input.blockerOutputArtifactId) as { id: string; answer_artifact_id: string; answer_sha256: string } | undefined);
      if (existing) {
        if (existing.answer_artifact_id !== input.answerArtifactId || existing.answer_sha256 !== input.answerSha256) throw new AgentFailure("evidence_contradiction", "A different answer is already recorded for this decision blocker");
        return { resolutionId: existing.id };
      }
      const resolutionId = `blocker_resolution_${randomBytes(12).toString("hex")}`;
      const createdAt = new Date().toISOString();
      try {
        database.authTransaction((db) => db.prepare("INSERT INTO forge_decision_blocker_resolutions (id, task_id, company_id, workflow_id, blocker_output_artifact_id, blocker_output_sha256, answer_artifact_id, answer_sha256, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(resolutionId, input.taskId, input.companyId, input.workflowId, input.blockerOutputArtifactId, input.blockerOutputSha256, input.answerArtifactId, input.answerSha256, input.actorUserId, createdAt));
      } catch (error) {
        const retry = database.authQuery((db) => db.prepare("SELECT id, answer_artifact_id, answer_sha256 FROM forge_decision_blocker_resolutions WHERE workflow_id = ? AND blocker_output_artifact_id = ?").get(input.workflowId, input.blockerOutputArtifactId) as { id: string; answer_artifact_id: string; answer_sha256: string } | undefined);
        if (retry && retry.answer_artifact_id === input.answerArtifactId && retry.answer_sha256 === input.answerSha256) return { resolutionId: retry.id };
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
      const repository = new PlanGovernanceRepository(database);
      const expectedSubjectHash = hashPlanBlockerSubject(input.blockerSubject);
      const existing = repository.findBlockerResponseByIdempotency(input.workflowId, input.idempotencyKey);
      if (existing) {
        if (existing.subjectHash !== expectedSubjectHash || existing.answerArtifactSha256 !== input.answerSha256) throw new PlanGovernanceConflict("The idempotency key was reused with a different blocker answer");
        await new ArtifactStore(config.artifactRoot).discardStaged({ companyId: input.companyId, storagePath: `${input.companyId}/staging/${input.answerStagingRef}.bin` });
        return { responseId: existing.responseId, duplicate: true, subjectHash: existing.subjectHash, answerArtifactId: existing.answerArtifactId, answerArtifactSha256: existing.answerArtifactSha256 };
      }
      const answer = await new ArtifactStore(config.artifactRoot).readStaged(input.companyId, input.answerStagingRef, input.answerSha256);
      const answerArtifact = await new ArtifactStore(config.artifactRoot).put(input.companyId, "plan-blocker-response", { filename: `${input.idempotencyKey}.md`, mimeType: "text/markdown", bytes: answer });
      let result;
      try {
        database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(answerArtifact.id, answerArtifact.companyId, answerArtifact.kind, answerArtifact.filename, answerArtifact.mimeType, answerArtifact.byteSize, answerArtifact.sha256, answerArtifact.storagePath, answerArtifact.createdAt));
        result = repository.recordBlockerResponseIdempotently({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, blockerArtifactId: input.blockerSubject.artifactId, blockerArtifactSha256: input.blockerSubject.artifactSha256, answerArtifactId: answerArtifact.id, answerArtifactSha256: answerArtifact.sha256, actorUserId: input.actorUserId, expectedWorkflowRevision: input.expectedWorkflowRevision, idempotencyKey: input.idempotencyKey, subjectHash: expectedSubjectHash });
      } catch (error) {
        database.authTransaction((db) => db.prepare("DELETE FROM forge_artifacts WHERE id = ? AND company_id = ?").run(answerArtifact.id, input.companyId));
        await new ArtifactStore(config.artifactRoot).remove(answerArtifact);
        throw error;
      }
      await new ArtifactStore(config.artifactRoot).discardStaged({ companyId: input.companyId, storagePath: `${input.companyId}/staging/${input.answerStagingRef}.bin` });
      return { responseId: result.responseId, subjectHash: result.subjectHash, duplicate: result.duplicate, answerArtifactId: result.answerArtifactId, answerArtifactSha256: result.answerArtifactSha256 };
    },
  };
}
