import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { ArtifactStore, StoredArtifact } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { GithubReleaseFailure, type GithubAcceptancePort, type GithubPullRequest } from "./github-release.js";

const durableId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const AcceptanceDecisionSchema = z.enum(["accept", "request_changes", "cancel"]);
export type AcceptanceDecision = z.infer<typeof AcceptanceDecisionSchema>;

export const AcceptanceEvidenceSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectRevisionId: durableId,
  releaseId: durableId,
  deliveryReviewId: durableId,
  finalReviewId: durableId,
  ciRunId: durableId,
  pullRequestNumber: z.number().int().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().min(1).max(256),
  baseSha: sha,
  headSha: sha,
  headTree: sha,
  leadSessionRef: durableId,
  actorUserId: durableId,
  decision: AcceptanceDecisionSchema,
});
export type AcceptanceEvidence = z.infer<typeof AcceptanceEvidenceSchema>;

const RawAcceptanceInputSchema = z.object({
  taskId: durableId,
  companyId: durableId,
  workflowId: durableId,
  projectRevisionId: durableId,
  releaseId: durableId,
  deliveryReviewId: durableId.optional(),
  reviewId: durableId.optional(),
  finalReviewId: durableId,
  ciRunId: durableId,
  pullRequestNumber: z.number().int().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().min(1).max(256),
  baseSha: sha,
  headSha: sha,
  headTree: sha,
  leadSessionRef: durableId,
  actorUserId: durableId,
  decision: AcceptanceDecisionSchema.default("accept"),
  reason: z.string().max(4_000).optional(),
}).strict().superRefine((value, context) => {
  if (!value.deliveryReviewId && !value.reviewId) context.addIssue({ code: "custom", path: ["deliveryReviewId"], message: "An exact delivery review is required" });
  if (value.deliveryReviewId && value.reviewId && value.deliveryReviewId !== value.reviewId) context.addIssue({ code: "custom", path: ["deliveryReviewId"], message: "Delivery review references conflict" });
});

export const AcceptanceInputSchema = RawAcceptanceInputSchema.transform((value) => ({
  ...value,
  deliveryReviewId: value.deliveryReviewId ?? value.reviewId!,
}));
export type AcceptanceInput = z.input<typeof RawAcceptanceInputSchema>;

export const ReadyReconciliationOutcomeSchema = z.enum(["pending_ready", "ready", "changed", "closed", "merged_early", "provider_unavailable"]);
export type ReadyReconciliationOutcome = z.infer<typeof ReadyReconciliationOutcomeSchema>;

export const MergeReconciliationOutcomeSchema = z.enum(["open", "merged", "closed_without_merge", "changed_head", "changed_base", "provider_unavailable"]);
export type MergeReconciliationOutcome = z.infer<typeof MergeReconciliationOutcomeSchema>;

export const AcceptanceBlockerSchema = z.object({
  code: z.string().min(1).max(80).regex(/^[a-z0-9_:-]+$/),
  owner: z.enum(["human", "lead", "provider"]),
  summary: z.string().min(1).max(500),
  retryAt: z.string().datetime().nullable(),
  evidenceArtifactId: durableId.nullable(),
});
export type AcceptanceBlocker = z.infer<typeof AcceptanceBlockerSchema>;

export class AcceptanceFailure extends Error {
  constructor(readonly code: "malformed" | "not-ready" | "stale" | "scope" | "provider" | "identity-conflict") {
    super(`Acceptance ${code}`);
    this.name = "AcceptanceFailure";
  }
}

export interface AcceptanceResult {
  acceptanceId: string | null;
  status: "pending_ready" | "accepted" | "requested_changes" | "cancelled" | "blocked";
  outcome?: ReadyReconciliationOutcome;
  retryAt?: string | null;
  readyAt?: string | null;
  acceptedAt?: string | null;
  blocker?: AcceptanceBlocker;
  pullRequest: GithubPullRequest | null;
  reasonArtifactId?: string | null;
}

export interface ReadyReconciliationResult {
  acceptanceId: string;
  status: "pending_ready" | "accepted" | "blocked";
  outcome: ReadyReconciliationOutcome;
  retryAt: string | null;
  blocker?: AcceptanceBlocker;
  pullRequest: GithubPullRequest | null;
  readyAt: string | null;
  acceptedAt: string;
}

export interface MergeReconciliationResult {
  outcome: MergeReconciliationOutcome;
  pullRequest: GithubPullRequest | null;
  observationId: string | null;
  completionReceiptId: string | null;
  observedAt: string;
  mergedAt: string | null;
  retryAt?: string | null;
  blocker?: AcceptanceBlocker;
}

interface AcceptanceServiceOptions {
  artifacts?: ArtifactStore;
  now?: () => Date;
}

interface EvidenceRow extends AcceptanceEvidence {
  deliveryReviewOutcome: string;
  deliveryPlanRevision: number;
  deliveryBaseSha: string;
  deliveryHeadSha: string;
  deliveryHeadTree: string;
  deliverySessionRef: string;
  finalReviewOutcome: string;
  finalPlanRevision: number;
  finalBaseSha: string;
  finalHeadSha: string;
  finalHeadTree: string;
  finalCiRunId: string;
  finalDeliveryReviewId: string;
  finalReviewSessionRef: string;
  finalReviewOpinionArtifactId: string;
  finalReviewEvidenceArtifactId: string;
  developerExecutionId: string;
  developerSessionRef: string;
  releaseStatus: string;
  releasePrUrl: string;
  releaseHeadBranch: string;
  ciStatus: string;
  ciExpectedHeadSha: string;
  developerTargetBaseSha: string;
  developerHeadSha: string | null;
  developerHeadTree: string | null;
  authoritativeLeadSessionRef: string;
}

interface AcceptanceRow {
  id: string;
  task_id: string;
  company_id: string;
  workflow_id: string;
  project_revision_id: string | null;
  release_id: string;
  review_id: string;
  final_review_id: string | null;
  ci_run_id: string;
  pr_number: number | null;
  repository: string;
  base_branch: string;
  base_sha: string | null;
  head_sha: string;
  head_tree: string;
  lead_session_ref: string | null;
  actor_user_id: string;
  decision: AcceptanceDecision;
  status: AcceptanceResult["status"];
  ready_at: string | null;
  failure_code: string | null;
  retry_at: string | null;
  reason_artifact_id: string | null;
  created_at: string;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function operationKey(input: AcceptanceEvidence): string {
  return `${input.taskId}:acceptance:${input.releaseId}:${input.finalReviewId}:${input.ciRunId}:${input.headSha}:${input.decision}`;
}

function retryAt(now: string, attempt: number): string {
  return new Date(Date.parse(now) + Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempt, 7))).toISOString();
}

function safeSummary(summary: string): string {
  return summary.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export class AcceptanceService {
  private readonly artifacts: ArtifactStore | undefined;
  private readonly now: () => Date;

  constructor(private readonly database: ForgeDatabase, private readonly github: GithubAcceptancePort, options: AcceptanceServiceOptions = {}) {
    this.artifacts = options.artifacts;
    this.now = options.now ?? (() => new Date());
  }

  async accept(rawInput: AcceptanceInput): Promise<AcceptanceResult> {
    const input = AcceptanceInputSchema.parse(rawInput);
    const decision = input.decision ?? "accept";
    const evidenceInput = AcceptanceEvidenceSchema.parse({ ...input, deliveryReviewId: input.deliveryReviewId, decision });
    const evidence = this.loadEvidence(evidenceInput);
    if (!evidence) throw new AcceptanceFailure("not-ready");
    if (evidence.releaseId !== input.releaseId || evidence.repository !== input.repository || evidence.pullRequestNumber !== input.pullRequestNumber || evidence.deliveryPlanRevision !== evidence.finalPlanRevision || evidence.finalCiRunId !== input.ciRunId || evidence.finalDeliveryReviewId !== input.deliveryReviewId || evidence.deliverySessionRef !== evidence.finalReviewSessionRef || evidence.finalReviewSessionRef !== input.leadSessionRef || evidence.authoritativeLeadSessionRef !== input.leadSessionRef || evidence.deliveryReviewOutcome !== "approved" || evidence.ciStatus !== "passed" || (decision === "accept" && evidence.finalReviewOutcome !== "approved") || (decision === "request_changes" && !["approved", "blocking"].includes(evidence.finalReviewOutcome)) || (decision === "cancel" && !["approved", "blocking"].includes(evidence.finalReviewOutcome))) throw new AcceptanceFailure("not-ready");

    const identity = { ...evidenceInput, decision };
    let current: GithubPullRequest | null = null;
    if (decision === "accept") {
      try {
        current = await this.observeExactPullRequest(input);
      } catch (error) {
        if (error instanceof AcceptanceFailure && error.code === "provider") {
          const next = retryAt(this.now().toISOString(), 1);
          return { acceptanceId: null, status: "blocked", outcome: "provider_unavailable", retryAt: next, pullRequest: current, blocker: { code: "provider_unavailable", owner: "provider", summary: "GitHub acceptance evidence is temporarily unavailable", retryAt: next, evidenceArtifactId: null } };
        }
        throw error;
      }
    }
    if (decision === "request_changes" && !input.reason?.trim()) throw new AcceptanceFailure("malformed");

    const reasonArtifact = input.reason?.trim() ? await this.putArtifact(input.companyId, "delivery-decision", `acceptance-${input.finalReviewId}.md`, input.reason.trim()) : undefined;
    const accepted = this.insertOrGetAcceptance(identity, reasonArtifact);
    if (accepted.conflict) throw new AcceptanceFailure("identity-conflict");
    if (accepted.row.status !== "pending_ready" || decision !== "accept") {
      return { acceptanceId: accepted.row.id, status: accepted.row.status, pullRequest: current, acceptedAt: accepted.row.created_at, reasonArtifactId: accepted.row.reason_artifact_id };
    }
    return this.reconcileReady({ ...input, decision });
  }

  async enableAutoMerge(input: { repository: string; pullRequestNumber: number; baseBranch: string; baseSha: string; headSha: string }): Promise<void> {
    const current = await this.github.getPullRequest({ repository: input.repository, number: input.pullRequestNumber });
    if (current.repository.toLowerCase() !== input.repository.toLowerCase() || current.number !== input.pullRequestNumber || current.state !== "open" || current.isDraft) throw new AcceptanceFailure("stale");
    if (!this.github.enableAutoMerge) throw new AcceptanceFailure("provider");
    await this.github.enableAutoMerge({ repository: input.repository, number: input.pullRequestNumber, headSha: current.headSha });
  }

  async reconcileReady(rawInput: AcceptanceInput | { acceptanceId: string; taskId: string; companyId: string }): Promise<ReadyReconciliationResult> {
    const input = "acceptanceId" in rawInput ? this.inputForAcceptance(rawInput.acceptanceId, rawInput.taskId, rawInput.companyId) : AcceptanceInputSchema.parse(rawInput);
    const acceptanceId = "acceptanceId" in rawInput ? rawInput.acceptanceId : this.findAcceptanceId(input);
    if (!acceptanceId) throw new AcceptanceFailure("scope");
    const row = this.database.authQuery((db) => db.prepare("SELECT id, task_id, company_id, workflow_id, project_revision_id, release_id, review_id, final_review_id, ci_run_id, pr_number, repository, base_branch, base_sha, head_sha, head_tree, lead_session_ref, actor_user_id, decision, status, ready_at, failure_code, retry_at, reason_artifact_id, created_at FROM forge_acceptances WHERE id = ? AND task_id = ? AND company_id = ?").get(acceptanceId, input.taskId, input.companyId) as AcceptanceRow | undefined);
    if (!row || row.decision !== "accept" || !row.final_review_id || row.pr_number === null || row.project_revision_id === null || row.workflow_id === null || row.base_sha === null || row.lead_session_ref === null) throw new AcceptanceFailure("scope");
    if (row.status === "accepted") return { acceptanceId, status: "accepted", outcome: "ready", retryAt: null, pullRequest: null, readyAt: row.ready_at, acceptedAt: row.created_at };
    if (row.status === "blocked") return { acceptanceId, status: "blocked", outcome: "changed", retryAt: row.retry_at, pullRequest: null, blocker: this.rowBlocker(row), readyAt: row.ready_at, acceptedAt: row.created_at };

    let current: GithubPullRequest;
    try {
      current = await this.currentPr(row.repository, row.pr_number);
    } catch {
      const next = retryAt(this.now().toISOString(), this.nextAttempt(row.id));
      const artifactId = await this.recordAttempt(row, "observe", "provider_unavailable", null, null, "provider_unavailable", next);
      this.updateAcceptance(row.id, "pending_ready", "provider_unavailable", next);
      return { acceptanceId, status: "pending_ready", outcome: "provider_unavailable", retryAt: next, pullRequest: null, readyAt: null, acceptedAt: row.created_at, blocker: { code: "provider_unavailable", owner: "lead", summary: "GitHub ready state is temporarily unavailable", retryAt: next, evidenceArtifactId: artifactId } };
    }
    if (current.state === "merged") return this.readyBlocked(row, "merged_early", "merged_before_ready_confirmation", "The pull request merged before Forge confirmed ready-for-review", current);
    if (current.state === "closed") return this.readyBlocked(row, "closed", "closed_before_ready_confirmation", "The pull request closed before Forge confirmed ready-for-review", current);
    if (!current.isDraft) {
      const observedAt = this.now().toISOString();
      await this.recordAttempt(row, "observe", "ready", current.state, false, undefined, null, { pullRequest: current });
      this.updateAcceptance(row.id, "accepted", null, null, observedAt);
      this.database.authTransaction((db) => db.prepare("UPDATE forge_releases SET status = 'ready', updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(observedAt, row.release_id, row.task_id, row.company_id));
      return { acceptanceId: row.id, status: "accepted", outcome: "ready", retryAt: null, pullRequest: current, readyAt: observedAt, acceptedAt: row.created_at };
    }

    const attempts = this.database.authQuery((db) => db.prepare("SELECT attempt, action, outcome FROM forge_acceptance_attempts WHERE acceptance_id = ? ORDER BY attempt DESC").all(row.id) as Array<{ attempt: number; action: string; outcome: string }>);
    const last = attempts[0];
    if (last?.action === "mark_ready" && last.outcome === "draft") {
      const next = retryAt(this.now().toISOString(), last.attempt);
      const evidenceArtifactId = await this.recordAttempt(row, "observe", "draft", current.state, true, "ready_not_observed", next, { pullRequest: current });
      this.updateAcceptance(row.id, "pending_ready", "ready_not_observed", next);
      return { acceptanceId: row.id, status: "pending_ready", outcome: "pending_ready", retryAt: next, pullRequest: current, readyAt: null, acceptedAt: row.created_at, blocker: { code: "ready_not_observed", owner: "lead", summary: "Forge has not yet observed the pull request as ready-for-review", retryAt: next, evidenceArtifactId } };
    }

    const attempt = this.nextAttempt(row.id);
    const now = this.now().toISOString();
    if (!this.claimAttempt(row, attempt, "mark_ready", "draft", current.state, true)) {
      return this.reconcileReady({ acceptanceId: row.id, taskId: row.task_id, companyId: row.company_id });
    }
    await this.attachAttemptEvidence(row, attempt, "mark_ready", "draft", current.state, true, undefined, null, { pullRequest: current });
    try {
      if (!this.github.markReadyForReview) throw new GithubReleaseFailure("provider-unavailable");
      await this.github.markReadyForReview({ repository: row.repository, number: row.pr_number });
    } catch (error) {
      const providerCode = error instanceof GithubReleaseFailure ? error.code : "provider-unavailable";
      const observed = await this.observeAfterReadyFailure(row);
      if (observed.current && !observed.current.isDraft) {
        const readyAt = this.now().toISOString();
        await this.recordAttempt(row, "observe", "mutation_timeout_reconciled", observed.current.state, false, "mutation_timeout_reconciled", null, { pullRequest: observed.current });
        this.updateAcceptance(row.id, "accepted", null, null, readyAt);
        this.database.authTransaction((db) => db.prepare("UPDATE forge_releases SET status = 'ready', updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(readyAt, row.release_id, row.task_id, row.company_id));
        return { acceptanceId: row.id, status: "accepted", outcome: "ready", retryAt: null, pullRequest: observed.current, readyAt, acceptedAt: row.created_at };
      }
      const next = retryAt(now, attempt);
      const evidenceArtifactId = await this.recordAttempt(row, "observe", "provider_unavailable", observed.current?.state ?? null, observed.current?.isDraft ?? null, providerCode, next, { pullRequest: observed.current ?? null });
      this.updateAcceptance(row.id, "pending_ready", providerCode, next);
      return { acceptanceId: row.id, status: "pending_ready", outcome: "provider_unavailable", retryAt: next, pullRequest: observed.current, readyAt: null, acceptedAt: row.created_at, blocker: { code: "provider_unavailable", owner: "lead", summary: "GitHub did not confirm ready-for-review", retryAt: next, evidenceArtifactId } };
    }
    const confirmed = await this.observeAfterReadyFailure(row);
    if (confirmed.current && !confirmed.current.isDraft) {
      const readyAt = this.now().toISOString();
      await this.recordAttempt(row, "observe", "ready", confirmed.current.state, false, undefined, null, { pullRequest: confirmed.current });
      this.updateAcceptance(row.id, "accepted", null, null, readyAt);
      this.database.authTransaction((db) => db.prepare("UPDATE forge_releases SET status = 'ready', updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(readyAt, row.release_id, row.task_id, row.company_id));
      return { acceptanceId: row.id, status: "accepted", outcome: "ready", retryAt: null, pullRequest: confirmed.current, readyAt, acceptedAt: row.created_at };
    }
    const next = retryAt(now, attempt);
    const evidenceArtifactId = await this.recordAttempt(row, "observe", "draft", confirmed.current?.state ?? null, true, "ready_not_observed", next, { pullRequest: confirmed.current ?? null });
    this.updateAcceptance(row.id, "pending_ready", "ready_not_observed", next);
    return { acceptanceId: row.id, status: "pending_ready", outcome: "pending_ready", retryAt: next, pullRequest: confirmed.current, readyAt: null, acceptedAt: row.created_at, blocker: { code: "ready_not_observed", owner: "lead", summary: "The ready-for-review mutation needs another provider observation", retryAt: next, evidenceArtifactId } };
  }

  async reconcileMerge(input: { taskId: string; companyId: string; workflowId: string; acceptanceId: string }): Promise<MergeReconciliationResult> {
    const context = this.database.authQuery((db) => db.prepare(`SELECT a.id AS acceptanceId, a.release_id AS releaseId, a.task_id AS taskId, a.company_id AS companyId, a.workflow_id AS workflowId, a.project_revision_id AS projectRevisionId, a.review_id AS deliveryReviewId, a.final_review_id AS finalReviewId, a.ci_run_id AS ciRunId, a.pr_number AS prNumber, a.repository, a.base_branch AS baseBranch, a.base_sha AS baseSha, a.head_sha AS headSha, a.head_tree AS headTree, a.actor_user_id AS actorUserId, a.created_at AS acceptedAt, r.pr_url AS prUrl
      FROM forge_acceptances a JOIN forge_releases r ON r.id = a.release_id AND r.task_id = a.task_id AND r.company_id = a.company_id
      WHERE a.id = ? AND a.task_id = ? AND a.company_id = ? AND a.workflow_id = ? AND a.status = 'accepted'`).get(input.acceptanceId, input.taskId, input.companyId, input.workflowId) as { acceptanceId: string; releaseId: string; taskId: string; companyId: string; workflowId: string; projectRevisionId: string; deliveryReviewId: string; finalReviewId: string; ciRunId: string; prNumber: number; repository: string; baseBranch: string; baseSha: string; headSha: string; headTree: string; actorUserId: string; acceptedAt: string; prUrl: string } | undefined);
    if (!context) throw new AcceptanceFailure("scope");
    const observedAt = this.now().toISOString();
    let current: GithubPullRequest | null = null;
    try { current = await this.currentPr(context.repository, context.prNumber); } catch {
      const next = retryAt(observedAt, this.nextObservationAttempt(context.acceptanceId));
      const observation = await this.recordMergeObservation(context, "provider_unavailable", "provider_unavailable", null, observedAt, next);
      return { outcome: "provider_unavailable", pullRequest: null, observationId: observation.id, completionReceiptId: null, observedAt, mergedAt: null, retryAt: next, blocker: { code: "provider_unavailable", owner: "human", summary: "GitHub merge state is temporarily unavailable", retryAt: next, evidenceArtifactId: observation.evidenceArtifactId } };
    }
    if (current.state === "merged" && !current.mergedAt) {
      const observation = await this.recordMergeObservation(context, "provider_invalid", "provider_unavailable", current, observedAt, null);
      return { outcome: "provider_unavailable", pullRequest: current, observationId: observation.id, completionReceiptId: null, observedAt, mergedAt: null, blocker: { code: "provider_invalid", owner: "human", summary: "GitHub reported merged without an authoritative merge time", retryAt: null, evidenceArtifactId: observation.evidenceArtifactId } };
    }
    const outcome: MergeReconciliationOutcome = current.state === "merged" ? "merged" : current.state === "closed" ? "closed_without_merge" : "open";
    const next = outcome === "open" ? retryAt(observedAt, this.nextObservationAttempt(context.acceptanceId)) : null;
    const observation = await this.recordMergeObservation(context, current.state, outcome, current, observedAt, next);
    if (outcome !== "merged") {
      const blocker = outcome === "open" ? undefined : { code: outcome === "closed_without_merge" ? "closed_without_merge" : outcome, owner: "human" as const, summary: outcome === "closed_without_merge" ? "The pull request closed without merging" : "The pull request no longer matches the accepted identity", retryAt: null, evidenceArtifactId: observation.evidenceArtifactId };
      return { outcome, pullRequest: current, observationId: observation.id, completionReceiptId: null, observedAt, mergedAt: null, retryAt: next, ...(blocker ? { blocker } : {}) };
    }
    const receipt = await this.recordCompletionReceipt(context, observation.id, current, observedAt);
    return { outcome: "merged", pullRequest: current, observationId: observation.id, completionReceiptId: receipt, observedAt, mergedAt: current.mergedAt, retryAt: null };
  }

  async reconcile(input: { taskId: string; companyId: string; releaseId: string; repository: string; number: number; expectedHeadSha: string; expectedBaseBranch: string }): Promise<{ outcome: "open" | "merged" | "closed_without_merge" | "changed" | "provider_unavailable"; pullRequest: GithubPullRequest | null }> {
    const acceptance = this.database.authQuery((db) => db.prepare("SELECT id, workflow_id FROM forge_acceptances WHERE task_id = ? AND company_id = ? AND release_id = ? AND head_sha = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.companyId, input.releaseId, input.expectedHeadSha) as { id: string; workflow_id: string } | undefined);
    if (!acceptance?.workflow_id) throw new AcceptanceFailure("scope");
    const result = await this.reconcileMerge({ taskId: input.taskId, companyId: input.companyId, workflowId: acceptance.workflow_id, acceptanceId: acceptance.id });
    return { outcome: result.outcome === "changed_head" || result.outcome === "changed_base" ? "changed" : result.outcome, pullRequest: result.pullRequest };
  }

  private loadEvidence(input: AcceptanceEvidence): EvidenceRow | undefined {
    const evidence = this.database.authQuery((db) => db.prepare(`SELECT r.id AS releaseId, r.repository, r.base_branch AS baseBranch, r.base_sha AS baseSha, r.head_sha AS headSha, r.head_tree AS headTree, r.pr_number AS pullRequestNumber, r.status AS releaseStatus, r.pr_url AS releasePrUrl, r.head_branch AS releaseHeadBranch,
      dr.id AS deliveryReviewId, dr.outcome AS deliveryReviewOutcome, dr.plan_revision AS deliveryPlanRevision, dr.base_sha AS deliveryBaseSha, dr.subject_commit AS deliveryHeadSha, dr.subject_tree AS deliveryHeadTree, dr.session_ref AS deliverySessionRef,
      fr.id AS finalReviewId, fr.outcome AS finalReviewOutcome, fr.plan_revision AS finalPlanRevision, fr.base_sha AS finalBaseSha, fr.subject_commit AS finalHeadSha, fr.subject_tree AS finalHeadTree, fr.ci_run_id AS finalCiRunId, fr.delivery_review_id AS finalDeliveryReviewId, fr.session_ref AS finalReviewSessionRef, fr.opinion_artifact_id AS finalReviewOpinionArtifactId, fr.evidence_artifact_id AS finalReviewEvidenceArtifactId, fr.developer_execution_id AS developerExecutionId,
      de.session_ref AS developerSessionRef, de.target_base_sha AS developerTargetBaseSha, de.result_commit AS developerHeadSha, de.result_tree AS developerHeadTree, c.status AS ciStatus, c.expected_head_sha AS ciExpectedHeadSha, io.session_ref AS authoritativeLeadSessionRef
      FROM forge_tasks t
      JOIN forge_project_revisions pr ON pr.id = t.project_revision_id
      JOIN forge_releases r ON r.id = ? AND r.task_id = t.id AND r.company_id = t.company_id AND r.workflow_id = ? AND r.superseded_at IS NULL AND r.status IN ('draft', 'ready')
      JOIN forge_delivery_reviews dr ON dr.id = ? AND dr.task_id = t.id AND dr.company_id = t.company_id AND dr.workflow_id = t.workflow_id
      JOIN forge_final_reviews fr ON fr.id = ? AND fr.task_id = t.id AND fr.company_id = t.company_id AND fr.workflow_id = t.workflow_id AND fr.release_id = r.id AND fr.delivery_review_id = dr.id
      JOIN forge_developer_executions de ON de.id = fr.developer_execution_id AND de.task_id = t.id AND de.company_id = t.company_id AND de.workflow_id = t.workflow_id
      JOIN forge_ci_runs c ON c.id = ? AND c.task_id = t.id AND c.company_id = t.company_id AND c.release_id = r.id
      JOIN forge_issue_outputs io ON io.task_id = t.id AND io.company_id = t.company_id AND io.workflow_id = t.workflow_id AND io.revision = fr.plan_revision AND io.kind = 'plan' AND io.session_ref = fr.session_ref AND io.session_ref <> de.session_ref
      JOIN forge_users u ON u.id = ? AND u.status = 'active' AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM forge_memberships m WHERE m.user_id = u.id AND m.company_id = t.company_id))
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.project_revision_id = ? AND pr.id = ?`).get(
      input.releaseId, input.workflowId, input.deliveryReviewId, input.finalReviewId, input.ciRunId, input.actorUserId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId, input.projectRevisionId,
    ) as EvidenceRow | undefined);
    return evidence;
  }

  private async observeExactPullRequest(input: AcceptanceInput): Promise<GithubPullRequest> {
    return this.currentPr(input.repository, input.pullRequestNumber);
  }

  private async currentPr(repository: string, number: number): Promise<GithubPullRequest> {
    if (!this.github.getPullRequest) throw new AcceptanceFailure("provider");
    try { return await this.github.getPullRequest({ repository, number }); } catch { throw new AcceptanceFailure("provider"); }
  }

  private insertOrGetAcceptance(input: AcceptanceEvidence, reasonArtifact?: StoredArtifact): { row: AcceptanceRow; conflict: boolean } {
    const key = operationKey(input);
    return this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT id, task_id, company_id, workflow_id, project_revision_id, release_id, review_id, final_review_id, ci_run_id, pr_number, repository, base_branch, base_sha, head_sha, head_tree, lead_session_ref, actor_user_id, decision, status, ready_at, failure_code, retry_at, reason_artifact_id, created_at FROM forge_acceptances WHERE operation_key = ?").get(key) as AcceptanceRow | undefined;
      if (existing) {
        const same = existing.task_id === input.taskId && existing.company_id === input.companyId && existing.workflow_id === input.workflowId && existing.project_revision_id === input.projectRevisionId && existing.release_id === input.releaseId && existing.review_id === input.deliveryReviewId && existing.final_review_id === input.finalReviewId && existing.ci_run_id === input.ciRunId && existing.pr_number === input.pullRequestNumber && existing.repository === input.repository && existing.base_branch === input.baseBranch && lower(existing.base_sha ?? "") === lower(input.baseSha) && lower(existing.head_sha) === lower(input.headSha) && lower(existing.head_tree) === lower(input.headTree) && existing.lead_session_ref === input.leadSessionRef && existing.actor_user_id === input.actorUserId && existing.decision === input.decision;
        return { row: existing, conflict: !same };
      }
      const acceptanceId = id("acceptance");
      const now = this.now().toISOString();
      if (reasonArtifact) db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(reasonArtifact.id, reasonArtifact.companyId, reasonArtifact.kind, reasonArtifact.filename, reasonArtifact.mimeType, reasonArtifact.byteSize, reasonArtifact.sha256, reasonArtifact.storagePath, reasonArtifact.createdAt);
      db.prepare(`INSERT INTO forge_acceptances (id, task_id, company_id, workflow_id, operation_key, project_revision_id, release_id, review_id, final_review_id, ci_run_id, pr_number, repository, base_branch, base_sha, head_sha, head_tree, lead_session_ref, actor_user_id, decision, status, reason_artifact_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(acceptanceId, input.taskId, input.companyId, input.workflowId, key, input.projectRevisionId, input.releaseId, input.deliveryReviewId, input.finalReviewId, input.ciRunId, input.pullRequestNumber, input.repository, input.baseBranch, input.baseSha, input.headSha, input.headTree, input.leadSessionRef, input.actorUserId, input.decision, input.decision === "accept" ? "pending_ready" : input.decision === "request_changes" ? "requested_changes" : "cancelled", reasonArtifact?.id ?? null, now, now);
      db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, kind, status, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'acceptance', ?, ?, ?, ?)").run(id("provider"), key, input.taskId, input.companyId, input.decision === "accept" ? "pending_ready" : input.decision, JSON.stringify({ acceptanceId, decision: input.decision, headSha: input.headSha }), now, now);
      return { row: db.prepare("SELECT id, task_id, company_id, workflow_id, project_revision_id, release_id, review_id, final_review_id, ci_run_id, pr_number, repository, base_branch, base_sha, head_sha, head_tree, lead_session_ref, actor_user_id, decision, status, ready_at, failure_code, retry_at, reason_artifact_id, created_at FROM forge_acceptances WHERE id = ?").get(acceptanceId) as AcceptanceRow, conflict: false };
    });
  }

  private async readyBlocked(row: AcceptanceRow, outcome: ReadyReconciliationOutcome, code: string, summary: string, current: GithubPullRequest): Promise<ReadyReconciliationResult> {
    const artifactId = await this.recordAttempt(row, "observe", outcome === "closed" ? "closed" : outcome === "merged_early" ? "merged" : "changed", current.state, current.isDraft, code, null, { pullRequest: current });
    this.updateAcceptance(row.id, "blocked", code, null);
    return { acceptanceId: row.id, status: "blocked", outcome, retryAt: null, pullRequest: current, readyAt: null, acceptedAt: row.created_at, blocker: { code, owner: "human", summary: safeSummary(summary), retryAt: null, evidenceArtifactId: artifactId } };
  }

  private async observeAfterReadyFailure(row: AcceptanceRow): Promise<{ current: GithubPullRequest | null }> {
    try { return { current: await this.currentPr(row.repository, row.pr_number!) }; } catch { return { current: null }; }
  }

  private updateAcceptance(idValue: string, status: AcceptanceResult["status"], failureCode: string | null, retryAtValue: string | null, readyAtValue?: string): void {
    this.database.authTransaction((db) => db.prepare("UPDATE forge_acceptances SET status = ?, ready_at = COALESCE(?, ready_at), failure_code = ?, retry_at = ?, updated_at = ? WHERE id = ?").run(status, readyAtValue ?? null, failureCode, retryAtValue, this.now().toISOString(), idValue));
  }

  private nextAttempt(acceptanceId: string): number {
    return Number((this.database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_acceptance_attempts WHERE acceptance_id = ?").get(acceptanceId) as { attempt: number })).attempt) + 1;
  }

  private claimAttempt(row: AcceptanceRow, attempt: number, action: "observe" | "mark_ready", outcome: string, observedState: string | null, isDraft: boolean | null): boolean {
    const now = this.now().toISOString();
    return this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_acceptance_attempts (id, acceptance_id, task_id, company_id, attempt, action, outcome, observed_state, observed_is_draft, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id("acceptance_attempt"), row.id, row.task_id, row.company_id, attempt, action, outcome, observedState, isDraft === null ? null : isDraft ? 1 : 0, now, now).changes === 1);
  }

  private async attachAttemptEvidence(row: AcceptanceRow, attempt: number, action: "observe" | "mark_ready", outcome: string, observedState: string | null, isDraft: boolean | null, errorCode?: string, retryAtValue?: string | null, extra?: Record<string, unknown>): Promise<string | null> {
    const artifact = await this.putArtifact(row.company_id, "agent-evidence", `acceptance-${row.id}-${attempt}.json`, JSON.stringify({ acceptanceId: row.id, attempt, action, outcome, observedState, observedIsDraft: isDraft, errorCode: errorCode ?? null, retryAt: retryAtValue ?? null, ...(extra ?? {}) }));
    if (!artifact) return null;
    return this.database.authTransaction((db) => {
      db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("UPDATE forge_acceptance_attempts SET evidence_artifact_id = ? WHERE acceptance_id = ? AND attempt = ? AND action = ?").run(artifact.id, row.id, attempt, action);
      return artifact.id;
    });
  }

  private async recordAttempt(row: AcceptanceRow, action: "observe" | "mark_ready", outcome: string, observedState: string | null, isDraft: boolean | null, errorCode?: string, retryAtValue?: string | null, extra?: Record<string, unknown>): Promise<string | null> {
    const attempt = (extra?.attempt as number | undefined) ?? this.nextAttempt(row.id);
    const now = this.now().toISOString();
    const artifact = await this.putArtifact(row.company_id, "agent-evidence", `acceptance-${row.id}-${attempt}.json`, JSON.stringify({ acceptanceId: row.id, attempt, action, outcome, observedState, observedIsDraft: isDraft, errorCode: errorCode ?? null, retryAt: retryAtValue ?? null, ...(extra ?? {}) }));
    return this.database.authTransaction((db) => {
      if (artifact) db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT OR IGNORE INTO forge_acceptance_attempts (id, acceptance_id, task_id, company_id, attempt, action, outcome, observed_state, observed_is_draft, error_code, retry_at, evidence_artifact_id, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id("acceptance_attempt"), row.id, row.task_id, row.company_id, attempt, action, outcome, observedState, isDraft === null ? null : isDraft ? 1 : 0, errorCode ?? null, retryAtValue ?? null, artifact?.id ?? null, now, now);
      return (db.prepare("SELECT evidence_artifact_id AS evidenceArtifactId FROM forge_acceptance_attempts WHERE acceptance_id = ? AND attempt = ?").get(row.id, attempt) as { evidenceArtifactId: string | null } | undefined)?.evidenceArtifactId ?? null;
    });
  }

  private inputForAcceptance(acceptanceId: string, taskId: string, companyId: string): AcceptanceInput {
    const row = this.database.authQuery((db) => db.prepare("SELECT workflow_id AS workflowId, project_revision_id AS projectRevisionId, release_id AS releaseId, review_id AS deliveryReviewId, final_review_id AS finalReviewId, ci_run_id AS ciRunId, pr_number AS pullRequestNumber, repository, base_branch AS baseBranch, base_sha AS baseSha, head_sha AS headSha, head_tree AS headTree, lead_session_ref AS leadSessionRef, actor_user_id AS actorUserId, decision FROM forge_acceptances WHERE id = ? AND task_id = ? AND company_id = ?").get(acceptanceId, taskId, companyId) as Omit<AcceptanceInput, "taskId" | "companyId"> | undefined);
    if (!row || row.finalReviewId === null || row.projectRevisionId === null || row.workflowId === null || row.pullRequestNumber === null || row.baseSha === null || row.leadSessionRef === null) throw new AcceptanceFailure("scope");
    return { taskId, companyId, ...row, decision: "accept" } as AcceptanceInput;
  }

  private findAcceptanceId(input: AcceptanceInput): string | undefined {
    const row = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_acceptances WHERE task_id = ? AND company_id = ? AND operation_key = ?").get(input.taskId, input.companyId, operationKey({ ...input, deliveryReviewId: input.deliveryReviewId!, decision: input.decision ?? "accept" })) as { id: string } | undefined);
    return row?.id;
  }

  private rowBlocker(row: AcceptanceRow): AcceptanceBlocker {
    return { code: row.failure_code ?? "acceptance_blocked", owner: "human", summary: "Acceptance reconciliation is blocked", retryAt: row.retry_at, evidenceArtifactId: null };
  }

  private nextObservationAttempt(acceptanceId: string): number {
    return Number((this.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS attempt FROM forge_merge_observations WHERE acceptance_id = ?").get(acceptanceId) as { attempt: number })).attempt) + 1;
  }

  private async recordMergeObservation(context: { acceptanceId: string; taskId: string; companyId: string; workflowId: string; releaseId: string; repository: string; prNumber: number; baseBranch: string; headSha: string }, providerState: string, outcome: string, current: GithubPullRequest | null, observedAt: string, retryAtValue: string | null): Promise<{ id: string; evidenceArtifactId: string | null }> {
    const key = createHash("sha256").update(JSON.stringify([context.acceptanceId, providerState, outcome, current?.headSha?.toLowerCase() ?? null, current?.baseBranch ?? null, current?.baseSha?.toLowerCase() ?? null, current?.mergedAt ?? null])).digest("hex");
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, evidence_artifact_id AS evidenceArtifactId FROM forge_merge_observations WHERE observation_key = ?").get(key) as { id: string; evidenceArtifactId: string | null } | undefined);
    if (existing) return existing;
    const artifact = await this.putArtifact(context.companyId, "agent-evidence", `merge-observation-${key.slice(0, 16)}.json`, JSON.stringify({ acceptanceId: context.acceptanceId, providerState, outcome, observedBaseBranch: current?.baseBranch ?? null, observedBaseSha: current?.baseSha ?? null, observedHeadSha: current?.headSha ?? null, mergedAt: current?.mergedAt ?? null, retryAt: retryAtValue }));
    const observationId = id("merge_observation");
    this.database.authTransaction((db) => {
      if (artifact) db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT OR IGNORE INTO forge_merge_observations (id, observation_key, task_id, company_id, workflow_id, release_id, acceptance_id, repository, pr_number, expected_base_branch, expected_head_sha, observed_base_branch, observed_base_sha, observed_head_sha, provider_state, outcome, provider_merged_at, evidence_artifact_id, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(observationId, key, context.taskId, context.companyId, context.workflowId, context.releaseId, context.acceptanceId, context.repository, context.prNumber, context.baseBranch, context.headSha, current?.baseBranch ?? null, current?.baseSha ?? null, current?.headSha ?? null, providerState, outcome, current?.mergedAt ?? null, artifact?.id ?? null, observedAt, observedAt);
    });
    const persisted = this.database.authQuery((db) => db.prepare("SELECT id, evidence_artifact_id AS evidenceArtifactId FROM forge_merge_observations WHERE observation_key = ?").get(key) as { id: string; evidenceArtifactId: string | null } | undefined);
    if (!persisted) throw new AcceptanceFailure("provider");
    return persisted;
  }

  private async recordCompletionReceipt(context: { acceptanceId: string; taskId: string; companyId: string; workflowId: string; projectRevisionId: string; releaseId: string; deliveryReviewId: string; finalReviewId: string; ciRunId: string; repository: string; prNumber: number; baseBranch: string; baseSha: string; headSha: string; headTree: string; actorUserId: string; acceptedAt: string }, observationId: string, current: GithubPullRequest, observedAt: string): Promise<string> {
    const existing = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_completion_receipts WHERE acceptance_id = ?").get(context.acceptanceId) as { id: string } | undefined);
    if (existing) return existing.id;
    const receiptId = id("receipt");
    const artifact = await this.putArtifact(context.companyId, "agent-evidence", `completion-receipt-${context.acceptanceId}.json`, JSON.stringify({ ...context, observationId, receiptId, providerMergedAt: current.mergedAt, observedAt, deploymentStatus: "unknown" }));
    if (!artifact) throw new AcceptanceFailure("provider");
    this.database.authTransaction((db) => {
      db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT OR IGNORE INTO forge_completion_receipts (id, task_id, company_id, workflow_id, project_revision_id, release_id, acceptance_id, merge_observation_id, delivery_review_id, final_review_id, ci_run_id, repository, pr_number, base_branch, accepted_base_sha, head_sha, head_tree, actor_user_id, accepted_at, observed_at, provider_merged_at, deployment_status, receipt_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)").run(receiptId, context.taskId, context.companyId, context.workflowId, context.projectRevisionId, context.releaseId, context.acceptanceId, observationId, context.deliveryReviewId, context.finalReviewId, context.ciRunId, context.repository, context.prNumber, context.baseBranch, context.baseSha, context.headSha, context.headTree, context.actorUserId, context.acceptedAt, observedAt, current.mergedAt, artifact.id, observedAt);
    });
    return (this.database.authQuery((db) => db.prepare("SELECT id FROM forge_completion_receipts WHERE acceptance_id = ?").get(context.acceptanceId) as { id: string }).id);
  }

  private async putArtifact(companyId: string, kind: StoredArtifact["kind"], filename: string, contents: string): Promise<StoredArtifact | undefined> {
    if (!this.artifacts) return undefined;
    return this.artifacts.putArtifact(companyId, kind, { filename, mimeType: "application/json", bytes: Buffer.from(contents, "utf8") });
  }
}
