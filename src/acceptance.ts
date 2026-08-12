import { randomBytes } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import type { GithubAcceptancePort, GithubPullRequest } from "./github-release.js";

export type AcceptanceDecision = "accept" | "request_changes" | "cancel";
export type ReconciliationOutcome = "open" | "merged" | "closed_without_merge" | "changed" | "provider_unavailable";

export class AcceptanceFailure extends Error {
  constructor(readonly code: "not-ready" | "stale" | "scope" | "provider") {
    super(`Acceptance ${code}`);
    this.name = "AcceptanceFailure";
  }
}

function id(): string { return `acceptance_${randomBytes(12).toString("hex")}`; }

export interface AcceptanceInput {
  taskId: string;
  companyId: string;
  releaseId: string;
  reviewId: string;
  ciRunId: string;
  repository: string;
  baseBranch: string;
  headSha: string;
  headTree: string;
  actorUserId: string;
  decision?: AcceptanceDecision;
  finalReviewId: string;
}

export interface AcceptanceResult {
  acceptanceId: string;
  status: "accepted" | "requested_changes" | "cancelled";
  pullRequest: GithubPullRequest;
}

export class AcceptanceService {
  constructor(private readonly database: ForgeDatabase, private readonly github: GithubAcceptancePort) {}

  async accept(input: AcceptanceInput): Promise<AcceptanceResult> {
    const release = this.database.authQuery((db) => db.prepare(`SELECT r.id, r.repository, r.head_branch, r.base_branch, r.base_sha, r.head_sha, r.head_tree, r.pr_number, r.pr_url, r.superseded_at
      FROM forge_releases r
      WHERE r.id = ? AND r.task_id = ? AND r.company_id = ? AND r.superseded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM forge_releases newer WHERE newer.task_id = r.task_id AND newer.company_id = r.company_id AND newer.superseded_at IS NULL AND newer.created_at > r.created_at)`).get(input.releaseId, input.taskId, input.companyId) as { id: string; repository: string; head_branch: string; base_branch: string; base_sha: string; head_sha: string; head_tree: string; pr_number: number | null; pr_url: string | null; superseded_at: string | null } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT id, outcome, subject_commit, subject_tree, base_sha FROM forge_delivery_reviews WHERE id = ? AND task_id = ? AND company_id = ?").get(input.reviewId, input.taskId, input.companyId) as { id: string; outcome: string; subject_commit: string; subject_tree: string; base_sha: string } | undefined);
    const finalReview = this.database.authQuery((db) => db.prepare("SELECT id, outcome, subject_commit, subject_tree, base_sha FROM forge_final_reviews WHERE id = ? AND task_id = ? AND company_id = ? AND release_id = ? AND ci_run_id = ?").get(input.finalReviewId, input.taskId, input.companyId, input.releaseId, input.ciRunId) as { id: string; outcome: string; subject_commit: string; subject_tree: string; base_sha: string } | undefined);
    const ci = this.database.authQuery((db) => db.prepare("SELECT status, expected_head_sha AS expectedHeadSha, expected_head_tree AS expectedHeadTree, superseded_at AS supersededAt FROM forge_ci_runs WHERE id = ? AND task_id = ? AND company_id = ? AND release_id = ? AND superseded_at IS NULL AND policy_hash IS NOT NULL AND project_revision_id = (SELECT project_revision_id FROM forge_tasks WHERE id = ? AND company_id = ?)").get(input.ciRunId, input.taskId, input.companyId, input.releaseId, input.taskId, input.companyId) as { status: string; expectedHeadSha: string; expectedHeadTree: string | null; supersededAt: string | null } | undefined);
    const latestAttempt = ci ? this.database.authQuery((db) => db.prepare("SELECT outcome, observed_repository AS observedRepository, observed_pr_number AS observedPrNumber, observed_base_branch AS observedBaseBranch, observed_base_sha AS observedBaseSha, observed_head_branch AS observedHeadBranch, observed_head_sha AS observedHeadSha FROM forge_ci_attempts WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 1").get(input.ciRunId) as { outcome: string; observedRepository: string | null; observedPrNumber: number | null; observedBaseBranch: string | null; observedBaseSha: string | null; observedHeadBranch: string | null; observedHeadSha: string | null } | undefined) : undefined;
    if (!release || !review || review.outcome !== "approved" || review.subject_commit.toLowerCase() !== input.headSha.toLowerCase() || review.subject_tree.toLowerCase() !== input.headTree.toLowerCase() || !finalReview || finalReview.outcome !== "approved" || finalReview.subject_commit.toLowerCase() !== input.headSha.toLowerCase() || finalReview.subject_tree.toLowerCase() !== input.headTree.toLowerCase() || finalReview.base_sha.toLowerCase() !== release.base_sha.toLowerCase() || !ci || !latestAttempt || latestAttempt.outcome !== "passed" || latestAttempt.observedRepository?.toLowerCase() !== release.repository.toLowerCase() || latestAttempt.observedPrNumber !== release.pr_number || latestAttempt.observedBaseBranch !== release.base_branch || latestAttempt.observedBaseSha?.toLowerCase() !== release.base_sha.toLowerCase() || latestAttempt.observedHeadBranch !== release.head_branch || latestAttempt.observedHeadSha?.toLowerCase() !== release.head_sha.toLowerCase() || ci.expectedHeadSha.toLowerCase() !== release.head_sha.toLowerCase() || !ci.expectedHeadTree || ci.expectedHeadTree.toLowerCase() !== release.head_tree.toLowerCase() || release.repository !== input.repository || release.base_branch !== input.baseBranch || release.head_sha.toLowerCase() !== input.headSha.toLowerCase() || release.head_tree.toLowerCase() !== input.headTree.toLowerCase() || review.base_sha.toLowerCase() !== release.base_sha.toLowerCase() || ci.status !== "passed" || release.pr_number === null) throw new AcceptanceFailure("not-ready");
    const decision = input.decision ?? "accept";
    const current = await this.currentPr(input.repository, release.pr_number);
    if (current.repository.toLowerCase() !== release.repository.toLowerCase() || current.number !== release.pr_number || current.url.replace(/\/$/, "").toLowerCase() !== release.pr_url?.replace(/\/$/, "").toLowerCase() || current.headSha.toLowerCase() !== input.headSha.toLowerCase() || current.headBranch !== release.head_branch || current.baseBranch !== input.baseBranch || current.baseSha.toLowerCase() !== release.base_sha.toLowerCase()) throw new AcceptanceFailure("stale");
    const baseHead = await this.github.getBranchHead({ repository: input.repository, branch: input.baseBranch });
    if (!baseHead || baseHead.toLowerCase() !== release.base_sha.toLowerCase()) throw new AcceptanceFailure("stale");
    if (!current.isDraft) throw new AcceptanceFailure("stale");
    const existingAcceptance = this.database.authQuery((db) => db.prepare("SELECT id, status FROM forge_acceptances WHERE task_id = ? AND release_id = ? AND head_sha = ? AND decision = ? ORDER BY created_at DESC LIMIT 1").get(input.taskId, input.releaseId, input.headSha, decision) as { id: string; status: "accepted" | "requested_changes" | "cancelled" } | undefined);
    if (existingAcceptance) return { acceptanceId: existingAcceptance.id, status: existingAcceptance.status, pullRequest: current };
    const acceptanceId = id();
    const now = new Date().toISOString();
    if (decision === "accept") {
      await this.github.markReadyForReview({ repository: input.repository, number: current.number });
    }
    const status = decision === "accept" ? "accepted" : decision === "request_changes" ? "requested_changes" : "cancelled";
    this.database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_acceptances (id, task_id, company_id, release_id, review_id, final_review_id, ci_run_id, repository, base_branch, head_sha, head_tree, actor_user_id, decision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(acceptanceId, input.taskId, input.companyId, input.releaseId, input.reviewId, input.finalReviewId, input.ciRunId, input.repository, input.baseBranch, input.headSha, input.headTree, input.actorUserId, decision, status, now, now);
      db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, kind, status, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'acceptance', 'completed', ?, ?, ?) ON CONFLICT(operation_key) DO UPDATE SET status = 'completed', result_json = excluded.result_json, updated_at = excluded.updated_at").run(`provider_${randomBytes(12).toString("hex")}`, `${input.taskId}:acceptance:${input.releaseId}:${input.headSha}:${decision}`, input.taskId, input.companyId, JSON.stringify({ acceptanceId, decision, headSha: input.headSha }), now, now);
    });
    return { acceptanceId, status, pullRequest: decision === "accept" ? { ...current, isDraft: false } : current };
  }

  async reconcile(input: { taskId: string; companyId: string; releaseId: string; repository: string; number: number; expectedHeadSha: string; expectedBaseBranch: string }): Promise<{ outcome: ReconciliationOutcome; pullRequest: GithubPullRequest | null }> {
    const release = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ? AND repository = ?").get(input.releaseId, input.taskId, input.companyId, input.repository));
    if (!release) throw new AcceptanceFailure("scope");
    let current: GithubPullRequest;
    try { current = await this.github.getPullRequest({ repository: input.repository, number: input.number }); } catch { return { outcome: "provider_unavailable", pullRequest: null }; }
    if (current.state === "merged") return { outcome: current.headSha.toLowerCase() === input.expectedHeadSha.toLowerCase() && current.baseBranch === input.expectedBaseBranch ? "merged" : "changed", pullRequest: current };
    if (current.state === "closed") return { outcome: "closed_without_merge", pullRequest: current };
    if (current.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase() || current.baseBranch !== input.expectedBaseBranch) return { outcome: "changed", pullRequest: current };
    return { outcome: "open", pullRequest: current };
  }

  private async currentPr(repository: string, number: number): Promise<GithubPullRequest> {
    try { return await this.github.getPullRequest({ repository, number }); } catch { throw new AcceptanceFailure("provider"); }
  }
}
