import {
  RecoverRevalidatedDeliveryReviewInputSchema,
  ReviewArbitrationActivityInputSchema,
  type DeliveryReviewActivities,
  type WorkflowDeliveryReviewActivityInput,
} from "../contracts/activities/delivery-review.js";
import type { ActivityContext } from "./context.js";
import { recoverReviewedDelivery } from "./reviewed-delivery-recovery.js";

export function createDeliveryReviewActivities(ctx: ActivityContext): DeliveryReviewActivities {
  const { database, config, randomBytes, ArtifactStore, redact, DeliveryDecisionActivityInputSchema, DeliveryReviewActivityResultSchema, CompletedDeliveryReviewLookupInputSchema, ReviewArbitrationActivityResultSchema, SafeSummarySchema, normalizeSafeSummary, defaultAgent, githubRelease, artifacts, agent, invokeAgent, bindCapacityExecution, latestWorktree, agentRuntime, normalizeReviewResult, durableArtifactReference } = ctx;
  return {
    async arbitrateReview(rawInput) {
      const input = ReviewArbitrationActivityInputSchema.parse(rawInput);
      const runner = agent as (typeof agent & { arbitrateReview?: (value: typeof input) => Promise<unknown> });
      const service = defaultAgent as unknown as { arbitrateReview: (value: typeof input, runtime: { signal?: AbortSignal }) => Promise<unknown> };
      const result = ReviewArbitrationActivityResultSchema.parse(await invokeAgent(input, () => runner?.arbitrateReview ? runner.arbitrateReview(input) : service.arbitrateReview(input, agentRuntime())));
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.leadExecutionId, sessionRef: result.leadSessionRef, worktreePath: input.worktreePath }, result);
    },
    async recoverRevalidatedDeliveryReview(rawInput) {
      return recoverReviewedDelivery(database, artifacts, githubRelease, config, RecoverRevalidatedDeliveryReviewInputSchema.parse(rawInput));
    },
    async reviewDelivery(input: WorkflowDeliveryReviewActivityInput) {
      const worktreePath = input.worktreePath ?? latestWorktree(input, input.subject.developerExecutionId);
      const serviceInput = { ...input, worktreePath };
      const result = await invokeAgent(input, async () => normalizeReviewResult(await (agent?.reviewDelivery ? agent.reviewDelivery(serviceInput) : defaultAgent.reviewDelivery(serviceInput, agentRuntime())), serviceInput), "reviewer");
      if (result.outcome === "blocked") return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.executionId, sessionRef: result.sessionRef, worktreePath }, result);
      const reviewArtifact = await durableArtifactReference(database, artifacts, input.companyId, result.review.opinionArtifactId, "delivery-review");
      const completed = DeliveryReviewActivityResultSchema.parse({ ...result, review: { ...result.review, summary: SafeSummarySchema.parse(normalizeSafeSummary(result.review.summary)), reviewArtifact } });
      if (completed.outcome !== "completed") throw new Error("Completed delivery review normalization produced a blocked result");
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: completed.review.leadExecutionId, sessionRef: completed.review.leadSessionRef, worktreePath }, completed);
    },
    async findCompletedDeliveryReview(rawInput) {
      const input = CompletedDeliveryReviewLookupInputSchema.parse(rawInput);
      const attempt = database.authQuery((db) => db.prepare(`
        SELECT a.id AS attemptId, a.correction_attempts AS correctionAttempts, a.plan_revision AS planRevision,
          a.base_sha AS targetBaseSha, a.developer_execution_id AS developerExecutionId,
          a.delivery_artifact_id AS deliveryArtifactId, a.developer_evidence_artifact_id AS developerEvidenceArtifactId, a.lead_session_ref AS leadSessionRef,
          a.developer_session_ref AS developerSessionRef, r.id AS reviewId,
          r.lead_execution_id AS leadExecutionId, r.session_ref AS reviewSessionRef,
          r.opinion_artifact_id AS opinionArtifactId, r.evidence_artifact_id AS evidenceArtifactId,
          r.outcome, r.summary, r.supersedes_review_id AS supersedesReviewId
        FROM forge_delivery_review_attempts a
        JOIN forge_delivery_reviews r ON r.id = a.completed_review_id
        WHERE a.task_id = ? AND a.company_id = ? AND a.workflow_id = ?
          AND a.status = 'completed' AND lower(a.subject_commit) = lower(?) AND lower(a.subject_tree) = lower(?)
          AND lower(r.subject_commit) = lower(?) AND lower(r.subject_tree) = lower(?)
        ORDER BY a.finished_at DESC, a.id DESC LIMIT 1
      `).get(input.taskId, input.companyId, input.workflowId, input.subjectCommit, input.subjectTree, input.subjectCommit, input.subjectTree) as {
        attemptId: string; correctionAttempts: number; planRevision: number; targetBaseSha: string; developerExecutionId: string; deliveryArtifactId: string; developerEvidenceArtifactId: string; leadSessionRef: string; developerSessionRef: string | null;
        reviewId: string; leadExecutionId: string; reviewSessionRef: string; opinionArtifactId: string; evidenceArtifactId: string;
        outcome: "approved" | "blocking"; summary: string; supersedesReviewId: string | null;
      } | undefined);
      if (!attempt) return null;
      const findings = database.authQuery((db) => db.prepare("SELECT id AS findingId, severity, rationale, evidence_ref AS evidenceRef, disposition, repair_instruction AS repairInstruction FROM forge_delivery_findings WHERE review_id = ? AND task_id = ? AND company_id = ? ORDER BY id").all(attempt.reviewId, input.taskId, input.companyId));
      return DeliveryReviewActivityResultSchema.parse({
        outcome: "completed", attemptId: attempt.attemptId, correctionAttempts: attempt.correctionAttempts,
        subject: { planRevision: attempt.planRevision, targetBaseSha: attempt.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree, developerExecutionId: attempt.developerExecutionId, deliveryArtifactId: attempt.deliveryArtifactId, developerEvidenceArtifactId: attempt.developerEvidenceArtifactId, leadSessionRef: attempt.leadSessionRef, developerSessionRef: attempt.developerSessionRef ?? "developer_session_recovered" },
        review: { reviewId: attempt.reviewId, leadExecutionId: attempt.leadExecutionId, leadSessionRef: attempt.reviewSessionRef, opinionArtifactId: attempt.opinionArtifactId, evidenceArtifactId: attempt.evidenceArtifactId, opinion: attempt.outcome, summary: attempt.summary, findings, supersedesReviewId: attempt.supersedesReviewId },
      });
    },
    async planDeliveryRepair(input) {
      const result = await invokeAgent(input, () => (agent?.planDeliveryRepair ?? defaultAgent.planDeliveryRepair.bind(defaultAgent))(input), "reviewer");
      return bindCapacityExecution(input.capacityRequestId, { executionKind: "agent", executionId: result.leadExecutionId, sessionRef: result.leadSessionRef, worktreePath: input.worktreePath }, result);
    },
    async recordDeliveryDecision(rawInput) {
      const input = DeliveryDecisionActivityInputSchema.parse(rawInput);
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new Error("Delivery decision actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin"
        ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId)
        : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ? AND m.status = 'active'").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new Error("Delivery decision scope is unavailable");
      const note = (redact(input.note.trim()) as string) || "Member decision recorded for blocked delivery";
      const artifact = await new ArtifactStore(config.artifactRoot, database).putArtifact(input.companyId, "delivery-decision", { filename: "delivery-decision.md", mimeType: "text/markdown", bytes: Buffer.from(note, "utf8") });
      const decisionId = `delivery_decision_${randomBytes(12).toString("hex")}`;
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_delivery_decisions (id, task_id, company_id, workflow_id, actor_user_id, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(decisionId, input.taskId, input.companyId, input.workflowId, input.actorUserId, artifact.id, artifact.createdAt);
      });
      return { artifactId: artifact.id };
    },
  };
}
