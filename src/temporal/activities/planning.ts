import type { PlanningActivities } from "../contracts/activities/planning.js";
import type { RevisedExecutionCoordinates } from "../contracts/primitives.js";
import type { ActivityContext } from "./context.js";
import { readTaskProjectConfiguration } from "../../task-project-configuration.js";

export function createPlanningActivities(ctx: ActivityContext): PlanningActivities {
  const { database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema } = ctx;
  void [database, config, options, createHash, randomBytes, ApplicationFailure, CancelledFailure, Context, z, projectionStateHash, ArtifactStore, redact, AgentFailure, AgentService, DeveloperService, cancelDeveloperExecution, reconcileDeveloperExecutions, cancelAgentExecution, reconcileAgentExecutions, runDeveloperTurn, AcceptanceFailure, AcceptanceService, CiFailure, CiProviderFailure, CiService, createGithubCiProvider, createGithubReleasePort, GithubReleaseFailure, ReleaseService, ForwardMergeFailure, ForwardMergeService, parseAcceptedProjectRevision, runPinnedVerification, createGitCommandGuard, ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, ArtifactReferenceSchema, CreateSuccessorActivityInputSchema, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityInputSchema, DeliveryReviewActivityResultSchema, DeliveryReviewSchema, DeliveryOperationBlockCodeSchema, DeveloperRepairActivityInputSchema, DeveloperRepairActivityResultSchema, DurableArtifactReferenceSchema, IssueProjectionEventSchema, IssueWorkflowStateSchema, PreparePlanRevisionActivityInputSchema, PublishReleaseActivityResultSchema, ReconcileTargetBaseActivityInputSchema, RevisedExecutionCoordinatesSchema, SafeSummarySchema, createInitialIssueWorkflowState, normalizeSafeSummary, PlanGovernanceConflict, PlanGovernanceRepository, StructuredLogger, activityLogContext, CapacityFailure, CapacityManager, CapacityAdmissionResultSchema, CapacityRequestInputSchema, CapacityRequestSnapshotSchema, WorktreeFailure, WorktreeManager, startIssueWorkflow, logger, defaultAgent, githubRelease, defaultDeveloper, artifacts, release, ci, acceptance, legacyForwardMerge, capacity, activityWorktrees, activityWorktreesByBranch, worktrees, agent, developer, putAttentionEvidence, attentionFailure, agentCategory, invokeAgent, bindCapacityExecution, recoverFinalizedDeveloperResult, runSupervised, latestWorktree, cancellationSignal, agentRuntime, pinnedProjectRevision, normalizeReviewResult, normalizeRepairResult, durableArtifactReference, verifiedArtifactBytes, artifactReference, registerArtifact, reconcileBlocker, asNonRetryableCapacityFailure, asNonRetryableApplicationFailure, asRetryableAgentFailure, DeveloperDeliverySchema];
  return {
    async preparePlanRevision(rawInput) {
      const input = PreparePlanRevisionActivityInputSchema.parse(rawInput);
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      const scoped = actor?.status === "active" && database.authQuery((db) => actor.role === "admin"
        ? db.prepare("SELECT t.id FROM forge_tasks t WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_id = ?").get(input.taskId, input.companyId, input.workflowId, input.projectId)
        : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id AND m.user_id = ? AND m.status = 'active' WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_id = ?").get(input.actorUserId, input.taskId, input.companyId, input.workflowId, input.projectId)) as { id: string } | undefined;
      if (!scoped) throw new AgentFailure("revision-scope-unavailable", "Plan revision is unavailable for this issue", { nonRetryable: true });
      const normalizedJson = JSON.stringify(database.authQuery((db) => readTaskProjectConfiguration(db, artifacts, input)));
      const requestId = `revision_${createHash("sha256").update(`${input.workflowId}:${input.requestRevision}`).digest("hex").slice(0, 32)}`;
      const reason = (redact(input.reason.trim()) as string).trim();
      const reasonHash = createHash("sha256").update(reason).digest("hex");
      const reasonArtifactId = `artifact_plan_revision_${createHash("sha256").update(`${input.workflowId}:${input.requestRevision}`).digest("hex").slice(0, 48)}`;
      const existing = database.authQuery((db) => db.prepare("SELECT id, actor_user_id AS actorUserId, reason_artifact_id AS reasonArtifactId, disposition, status, blocker_code AS blockerCode, developer_execution_id AS developerExecutionId, worktree_path AS worktreePath, branch_name AS branchName, base_sha AS baseSha, head_sha AS headSha, tree_sha AS treeSha, dirty_state AS dirtyState, exact_base_sha AS exactBaseSha, authorized_plan_revision AS authorizedPlanRevision FROM forge_plan_revision_requests WHERE workflow_id = ? AND request_revision = ?").get(input.workflowId, input.requestRevision) as { id: string; actorUserId: string; reasonArtifactId: string; disposition: "reuse" | "new"; status: "accepted" | "blocked" | "authorized"; blockerCode: string | null; developerExecutionId: string | null; worktreePath: string | null; branchName: string | null; baseSha: string | null; headSha: string | null; treeSha: string | null; dirtyState: "clean" | "dirty" | null; exactBaseSha: string | null; authorizedPlanRevision: number | null } | undefined);
      if (existing && (existing.actorUserId !== input.actorUserId || existing.reasonArtifactId !== reasonArtifactId || existing.disposition !== input.worktreeDisposition || existing.exactBaseSha !== (input.exactBaseSha ?? null))) throw new AgentFailure("revision-identity-conflict", "The plan revision request identity conflicts with an existing request", { nonRetryable: true });
      const existingArtifact = database.authQuery((db) => db.prepare("SELECT id, company_id AS companyId, kind, sha256, storage_path AS storagePath FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { id: string; companyId: string; kind: string; sha256: string; storagePath: string } | undefined);
      if (existingArtifact && (existingArtifact.companyId !== input.companyId || existingArtifact.kind !== "plan-revision-reason" || existingArtifact.sha256 !== reasonHash)) throw new AgentFailure("revision-identity-conflict", "The plan revision artifact identity conflicts with an existing artifact", { nonRetryable: true });
      if (existing?.status === "blocked") return { status: "blocked", revisionRequestId: existing.id, blockerCode: existing.blockerCode ?? "revision-blocked" };
      if (existing?.status === "accepted" || existing?.status === "authorized") {
        const coordinates = existing.disposition === "reuse"
          ? RevisedExecutionCoordinatesSchema.safeParse({ disposition: "reuse", revisionRequestId: existing.id, developerExecutionId: existing.developerExecutionId, branchName: existing.branchName, baseSha: existing.baseSha, headSha: existing.headSha, treeSha: existing.treeSha, dirtyState: existing.dirtyState })
          : RevisedExecutionCoordinatesSchema.safeParse({ disposition: "new", revisionRequestId: existing.id, exactBaseSha: existing.exactBaseSha });
        if (coordinates.success) return { status: "accepted", revisionRequestId: existing.id, coordinates: coordinates.data };
      }
      const reasonArtifact = existingArtifact ? undefined : await artifacts.putWithId(input.companyId, reasonArtifactId, "plan-revision-reason", { filename: `plan-revision-${input.requestRevision}.md`, mimeType: "text/markdown", bytes: Buffer.from(reason, "utf8") });
      let status: "accepted" | "blocked" = "accepted";
      let blockerCode: string | null = null;
      let coordinates: RevisedExecutionCoordinates;
      if (input.worktreeDisposition === "reuse") {
        const execution = input.developerExecutionId ? database.authQuery((db) => db.prepare("SELECT id, status, worktree_path AS worktreePath, branch_name AS branchName, target_base_sha AS baseSha, result_commit AS headSha, result_tree AS treeSha FROM forge_developer_executions WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").get(input.developerExecutionId, input.taskId, input.companyId, input.workflowId) as { id: string; status: string; worktreePath: string; branchName: string; baseSha: string; headSha: string | null; treeSha: string | null } | undefined) : undefined;
        if (!execution || !["cancelled", "interrupted", "blocked", "completed"].includes(execution.status) || !execution.headSha || !execution.treeSha) { status = "blocked"; blockerCode = "missing-preserved-execution"; }
        else {
          try {
            const pinned = pinnedProjectRevision(normalizedJson);
            const inspected = await worktrees.inspectForPlanRevision({ repositoryPath: pinned.repositoryPath, worktreeRoot: pinned.worktreeRoot, worktreePath: execution.worktreePath, branchName: execution.branchName, baseSha: execution.baseSha, resultCommit: execution.headSha, resultTree: execution.treeSha });
            coordinates = { disposition: "reuse", revisionRequestId: requestId, developerExecutionId: execution.id, branchName: inspected.branchName, baseSha: inspected.baseSha, headSha: inspected.headSha, treeSha: inspected.treeSha, dirtyState: inspected.dirtyState };
          } catch (error) { status = "blocked"; blockerCode = error instanceof WorktreeFailure ? error.code : "worktree-inspection-failed"; }
        }
      } else {
        try { const pinned = pinnedProjectRevision(normalizedJson); await worktrees.validateExactBase({ repositoryPath: pinned.repositoryPath, candidateSha: input.exactBaseSha!, acceptedTargetSha: pinned.targetSha }); coordinates = { disposition: "new", revisionRequestId: requestId, exactBaseSha: input.exactBaseSha! }; }
        catch (error) { status = "blocked"; blockerCode = error instanceof WorktreeFailure ? error.code : "invalid-base-commit"; }
      }
      try {
        const now = new Date().toISOString();
        database.authTransaction((db) => {
          if (reasonArtifact) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reasonArtifact.id, reasonArtifact.companyId, reasonArtifact.kind, reasonArtifact.filename, reasonArtifact.mimeType, reasonArtifact.byteSize, reasonArtifact.sha256, reasonArtifact.storagePath, reasonArtifact.createdAt);
          db.prepare("INSERT INTO forge_plan_revision_requests (id, task_id, company_id, workflow_id, request_revision, actor_user_id, reason_artifact_id, disposition, status, blocker_code, developer_execution_id, worktree_path, branch_name, base_sha, head_sha, tree_sha, dirty_state, exact_base_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(requestId, input.taskId, input.companyId, input.workflowId, input.requestRevision, input.actorUserId, reasonArtifactId, input.worktreeDisposition, status, blockerCode, coordinates?.disposition === "reuse" ? coordinates.developerExecutionId : null, coordinates?.disposition === "reuse" ? database.authQuery((inner) => inner.prepare("SELECT worktree_path FROM forge_developer_executions WHERE id = ?").get(coordinates.developerExecutionId) as { worktree_path: string } | undefined)?.worktree_path ?? null : null, coordinates?.disposition === "reuse" ? coordinates.branchName : null, coordinates?.disposition === "reuse" ? coordinates.baseSha : null, coordinates?.disposition === "reuse" ? coordinates.headSha : null, coordinates?.disposition === "reuse" ? coordinates.treeSha : null, coordinates?.disposition === "reuse" ? "clean" : null, coordinates?.disposition === "new" ? coordinates.exactBaseSha : null, now, now);
        });
      } catch (error) {
        const persisted = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { companyId: string; storagePath: string; sha256: string } | undefined);
        if (reasonArtifact && (!persisted || persisted.companyId !== input.companyId || persisted.sha256 !== reasonArtifact.sha256)) await artifacts.remove(reasonArtifact);
        throw error;
      }
      if (status === "blocked") return { status, revisionRequestId: requestId, blockerCode: blockerCode ?? "revision-blocked" };
      return { status, revisionRequestId: requestId, coordinates: coordinates! };
    },
    async authorizePlanRevision(input) {
      database.authTransaction((db) => {
        const result = db.prepare("UPDATE forge_plan_revision_requests SET status = 'authorized', authorized_plan_revision = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'accepted'").run(input.planRevision, new Date().toISOString(), input.revisionRequestId, input.taskId, input.companyId, input.workflowId);
        if (result.changes !== 1) {
          const row = db.prepare("SELECT status, authorized_plan_revision FROM forge_plan_revision_requests WHERE id = ?").get(input.revisionRequestId) as { status: string; authorized_plan_revision: number | null } | undefined;
          if (!row || !["authorized", "accepted"].includes(row.status) || (row.status === "authorized" && row.authorized_plan_revision !== input.planRevision)) throw new Error("Plan revision authorization identity is unavailable");
        }
      });
    },
    async createSuccessor(rawInput) {
      const input = CreateSuccessorActivityInputSchema.parse(rawInput);
      const allowed = database.authQuery((db) => db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_users u ON u.id = ? AND u.status = 'active' LEFT JOIN forge_memberships m ON m.company_id = t.company_id AND m.user_id = u.id AND m.status = 'active' WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND (u.role = 'admin' OR m.user_id IS NOT NULL)").get(input.actorUserId, input.predecessorTaskId, input.companyId, input.predecessorWorkflowId) as { id: string } | undefined);
      if (!allowed) throw new AgentFailure("successor-scope-unavailable", "Continuation is unavailable for this issue", { nonRetryable: true });
      const existing = database.authQuery((db) => db.prepare("SELECT id, successor_task_id AS successorTaskId, successor_workflow_id AS successorWorkflowId, project_revision_id AS projectRevisionId, accepted_revision AS acceptedRevision, actor_user_id AS actorUserId, reason_artifact_id AS reasonArtifactId, state FROM forge_successor_intents WHERE predecessor_workflow_id = ?").get(input.predecessorWorkflowId) as { id: string; successorTaskId: string; successorWorkflowId: string; projectRevisionId: string; acceptedRevision: number; actorUserId: string; reasonArtifactId: string; state: string } | undefined);
      const reason = (redact(input.reason.trim()) as string).trim();
      const reasonHash = createHash("sha256").update(reason).digest("hex");
      const reasonArtifactId = `artifact_continuation_${input.intentId.replace(/^intent_/, "")}`;
      const storedReason = database.authQuery((db) => db.prepare("SELECT id, company_id AS companyId, kind, sha256, storage_path AS storagePath FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { id: string; companyId: string; kind: string; sha256: string; storagePath: string } | undefined);
      const sameRequest = existing?.actorUserId === input.actorUserId && existing.reasonArtifactId === reasonArtifactId && storedReason?.companyId === input.companyId && storedReason.kind === "continuation-reason" && storedReason.sha256 === reasonHash;
      if (existing?.state === "linked") {
        if (!sameRequest) throw new AgentFailure("successor-identity-conflict", "Continuation identity conflicts with an existing request", { nonRetryable: true });
        return { successorTaskId: existing.successorTaskId, successorWorkflowId: existing.successorWorkflowId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: existing.projectRevisionId, creationRevision: existing.acceptedRevision };
      }
      if (existing && (!sameRequest || existing.id !== input.intentId || existing.successorTaskId !== input.successorTaskId || existing.successorWorkflowId !== input.successorWorkflowId || existing.acceptedRevision !== input.acceptedRevision)) throw new AgentFailure("successor-identity-conflict", "Continuation identity conflicts with an existing request", { nonRetryable: true });
      const current = database.authQuery((db) => db.prepare("SELECT t.title, t.brief_artifact_id AS briefArtifactId, t.image_artifact_ids_json AS imageIdsJson, t.role_agents_json AS roleAgentsJson, t.project_revision_id AS projectRevisionId, r.normalized_json AS normalizedJson, b.sha256 AS briefSha256 FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted' JOIN forge_artifacts b ON b.id = t.brief_artifact_id WHERE t.id = ? AND t.company_id = ? AND t.project_id = ? AND t.workflow_id = ?").get(input.predecessorTaskId, input.companyId, input.projectId, input.predecessorWorkflowId) as { title: string; briefArtifactId: string; imageIdsJson: string; roleAgentsJson: string; projectRevisionId: string; normalizedJson: string; briefSha256: string } | undefined);
      if (!current) throw new AgentFailure("successor-project-unavailable", "The currently accepted project revision is unavailable", { nonRetryable: true });
      if (storedReason && (storedReason.companyId !== input.companyId || storedReason.kind !== "continuation-reason" || storedReason.sha256 !== reasonHash)) throw new AgentFailure("successor-identity-conflict", "Continuation identity conflicts with an existing artifact", { nonRetryable: true });
      const reasonArtifact = storedReason ? undefined : await artifacts.putWithId(input.companyId, reasonArtifactId, "continuation-reason", { filename: `${input.intentId}.md`, mimeType: "text/markdown", bytes: Buffer.from(reason, "utf8") });
      const now = new Date().toISOString();
      const roleAgents = JSON.parse(current.roleAgentsJson) as Record<string, string>;
      const roleProfiles = database.authQuery((db) => {
        const result: Record<string, string> = {};
        for (const role of ["planner", "builder", "reviewer"] as const) {
          const agentId = roleAgents[role];
          const agent = typeof agentId === "string" ? db.prepare("SELECT profile_id FROM forge_agents WHERE id = ? AND role = ?").get(agentId, role) as { profile_id: string } | undefined : undefined;
          if (!agent) throw new AgentFailure("successor-profile-unavailable", "The predecessor task has an unavailable role agent", { nonRetryable: true });
          result[role] = agent.profile_id;
        }
        return result;
      });
      const imageIds = JSON.parse(current.imageIdsJson) as string[];
      const artifactIds = [current.briefArtifactId, ...imageIds, reasonArtifactId];
      const placeholders = artifactIds.map(() => "?").join(",");
      const artifactManifest = database.authQuery((db) => db.prepare(`SELECT id, kind, filename, mime_type AS mimeType, byte_size AS byteSize, sha256, storage_path AS storagePath FROM forge_artifacts WHERE company_id = ? AND id IN (${placeholders})`).all(input.companyId, ...artifactIds) as Array<{ id: string; kind: string; filename: string; mimeType: string; byteSize: number; sha256: string; storagePath: string }>);
      if (reasonArtifact) artifactManifest.push({ id: reasonArtifact.id, kind: reasonArtifact.kind, filename: reasonArtifact.filename, mimeType: reasonArtifact.mimeType, byteSize: reasonArtifact.byteSize, sha256: reasonArtifact.sha256, storagePath: reasonArtifact.storagePath });
      const requestHash = createHash("sha256").update(JSON.stringify({ predecessor: input.predecessorTaskId, successor: input.successorTaskId, reasonArtifactId, projectRevisionId: current.projectRevisionId })).digest("hex");
      try {
        database.authTransaction((db) => {
          if (existing) return;
          if (reasonArtifact) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reasonArtifact.id, reasonArtifact.companyId, reasonArtifact.kind, reasonArtifact.filename, reasonArtifact.mimeType, reasonArtifact.byteSize, reasonArtifact.sha256, reasonArtifact.storagePath, reasonArtifact.createdAt);
          db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, predecessor_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)").run(input.successorTaskId, input.companyId, input.projectId, `Continue: ${current.title}`.slice(0, 160), current.briefArtifactId, JSON.stringify(imageIds), JSON.stringify(roleAgents), input.successorWorkflowId, current.projectRevisionId, `continue_${input.intentId}`, requestHash, input.predecessorTaskId, now, now);
          const initialState = IssueWorkflowStateSchema.parse({ ...createInitialIssueWorkflowState({ workflowId: input.successorWorkflowId, companyId: input.companyId, projectId: input.projectId, issueId: input.successorTaskId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: current.projectRevisionId, briefArtifactId: current.briefArtifactId, briefSha256: current.briefSha256, imageArtifactIds: imageIds, requestHash, roleProfiles, supplementalReview: false, repairCycleLimit: config.deliveryRepairCycleLimit }), predecessorTaskId: input.predecessorTaskId });
          const hash = projectionStateHash(initialState);
          db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, projected_at) VALUES (?, ?, ?, ?, 0, 'backlog', 'human', ?, ?, ?, ?, ?, 0, ?)").run(input.successorTaskId, input.companyId, input.projectId, input.successorWorkflowId, JSON.stringify(initialState.allowedCommands), initialState.pendingAction, now, initialState.lastEventId, hash, now);
          db.prepare("INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, 0, 'task_created', ?, ?, ?)").run(`${input.successorWorkflowId}:0`, input.successorTaskId, input.companyId, input.successorWorkflowId, JSON.stringify({ revision: 0, stateHash: hash }), now, hash);
          db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(input.successorTaskId, input.companyId, input.successorWorkflowId, JSON.stringify(initialState), now);
          db.prepare("INSERT INTO forge_task_creation_intents (id, company_id, project_id, task_id, workflow_id, idempotency_key, request_hash, project_revision_id, artifact_ids_json, artifact_manifest_json, state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'workflow_starting', 1, ?, ?)").run(`creation_${input.intentId}`, input.companyId, input.projectId, input.successorTaskId, input.successorWorkflowId, `continue_${input.intentId}`, requestHash, current.projectRevisionId, JSON.stringify(artifactIds), JSON.stringify(artifactManifest), now, now);
          db.prepare("INSERT INTO forge_successor_intents (id, predecessor_task_id, predecessor_workflow_id, accepted_revision, successor_task_id, successor_workflow_id, company_id, project_id, project_revision_id, actor_user_id, reason_artifact_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'workflow_starting', ?, ?)").run(input.intentId, input.predecessorTaskId, input.predecessorWorkflowId, input.acceptedRevision, input.successorTaskId, input.successorWorkflowId, input.companyId, input.projectId, current.projectRevisionId, input.actorUserId, reasonArtifactId, now, now);
        });
      } catch (error) {
        const persisted = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, sha256 FROM forge_artifacts WHERE id = ?").get(reasonArtifactId) as { companyId: string; sha256: string } | undefined);
        if (reasonArtifact && (!persisted || persisted.companyId !== input.companyId || persisted.sha256 !== reasonArtifact.sha256)) await artifacts.remove(reasonArtifact);
        throw error;
      }
      if (existing && reasonArtifact) {
        const persisted = database.authQuery((db) => db.prepare("SELECT company_id AS companyId, sha256 FROM forge_artifacts WHERE id = ?").get(reasonArtifact.id) as { companyId: string; sha256: string } | undefined);
        if (!persisted) await artifacts.remove(reasonArtifact);
      }
      await startIssueWorkflow(config, { workflowId: input.successorWorkflowId, companyId: input.companyId, projectId: input.projectId, issueId: input.successorTaskId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: current.projectRevisionId, briefArtifactId: current.briefArtifactId, briefSha256: current.briefSha256, imageArtifactIds: imageIds, requestHash, roleProfiles, supplementalReview: false, repairCycleLimit: config.deliveryRepairCycleLimit });
      database.authTransaction((db) => {
        db.prepare("UPDATE forge_successor_intents SET state = 'linked', updated_at = ? WHERE id = ? AND state IN ('prepared', 'workflow_starting', 'started')").run(now, input.intentId);
        db.prepare("UPDATE forge_tasks SET successor_task_id = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(input.successorTaskId, now, input.predecessorTaskId, input.companyId);
        db.prepare("UPDATE forge_task_creation_intents SET state = 'started', updated_at = ? WHERE id = ? AND state = 'workflow_starting'").run(now, `creation_${input.intentId}`);
        db.prepare("INSERT OR IGNORE INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'successor_linked', ?, ?, ?)").run(`audit_successor_link_${input.intentId}`, input.actorUserId, input.companyId, JSON.stringify({ intentId: input.intentId, predecessorTaskId: input.predecessorTaskId, successorTaskId: input.successorTaskId, successorWorkflowId: input.successorWorkflowId }), now);
      });
      return { successorTaskId: input.successorTaskId, successorWorkflowId: input.successorWorkflowId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: current.projectRevisionId, creationRevision: input.acceptedRevision };
    },
    async runLeadPlanning(input) {
      const result = await invokeAgent(input, () => agent?.runLeadPlanning ? agent.runLeadPlanning(input) : defaultAgent.runLeadPlanning(input, agentRuntime()));
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.leadExecutionId, sessionRef: result.leadSessionRef }, { ...result, leadSummary: SafeSummarySchema.parse(normalizeSafeSummary(result.leadSummary)) });
    },
    async runSupplementalReview(input) {
      const result = await invokeAgent(input, () => agent?.runSupplementalReview ? agent.runSupplementalReview(input) : defaultAgent.runSupplementalReview(input, agentRuntime()));
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.executionId, sessionRef: result.sessionRef }, result);
    },
    async consolidateLeadPlan(input) {
      const result = await invokeAgent(input, () => agent?.consolidateLeadPlan ? agent.consolidateLeadPlan(input) : defaultAgent.consolidateLeadPlan(input, agentRuntime()));
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.leadExecutionId, sessionRef: result.leadSessionRef }, { ...result, leadSummary: SafeSummarySchema.parse(normalizeSafeSummary(result.leadSummary)) });
    },
  };
}
