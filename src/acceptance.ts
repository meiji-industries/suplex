import { randomBytes } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import type { GithubPullRequest, GithubReleasePort } from "./github-release.js";

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
}

export interface AcceptanceResult {
  acceptanceId: string;
  status: "accepted" | "requested_changes" | "cancelled";
  pullRequest: GithubPullRequest;
}

export class AcceptanceService {
  constructor(private readonly database: ForgeDatabase, private readonly github: GithubReleasePort) {}

  async accept(input: AcceptanceInput): Promise<AcceptanceResult> {
    const release = this.database.authQuery((db) => db.prepare("SELECT id, repository, base_branch, base_sha, head_sha, head_tree, pr_number, pr_url FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ?").get(input.releaseId, input.taskId, input.companyId) as { id: string; repository: string; base_branch: string; base_sha: string; head_sha: string; head_tree: string; pr_number: number | null; pr_url: string | null } | undefined);
    const review = this.database.authQuery((db) => db.prepare("SELECT id, outcome, subject_commit, subject_tree, base_sha FROM forge_delivery_reviews WHERE id = ? AND task_id = ? AND company_id = ?").get(input.reviewId, input.taskId, input.companyId) as { id: string; outcome: string; subject_commit: string; subject_tree: string; base_sha: string } | undefined);
    const ci = this.database.authQuery((db) => db.prepare("SELECT status FROM forge_ci_runs WHERE id = ? AND task_id = ? AND company_id = ? AND release_id = ?").get(input.ciRunId, input.taskId, input.companyId, input.releaseId) as { status: string } | undefined);
    if (!release || !review || review.outcome !== "approved" || review.subject_commit !== input.headSha || review.subject_tree !== input.headTree || !ci || release.repository !== input.repository || release.base_branch !== input.baseBranch || release.head_sha !== input.headSha || release.head_tree !== input.headTree || review.base_sha !== release.base_sha || ci.status !== "passed" || release.pr_number === null) throw new AcceptanceFailure("not-ready");
    const current = await this.currentPr(input.repository, release.pr_number);
    if (current.headSha.toLowerCase() !== input.headSha.toLowerCase() || current.baseBranch !== input.baseBranch) throw new AcceptanceFailure("stale");
    if (!current.isDraft) throw new AcceptanceFailure("stale");
    const acceptanceId = id();
    const now = new Date().toISOString();
    const decision = input.decision ?? "accept";
    if (decision === "accept") {
      if (!this.github.markReadyForReview) throw new AcceptanceFailure("provider");
      await this.github.markReadyForReview({ repository: input.repository, number: current.number });
    }
    const status = decision === "accept" ? "accepted" : decision === "request_changes" ? "requested_changes" : "cancelled";
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_acceptances (id, task_id, company_id, release_id, review_id, ci_run_id, repository, base_branch, head_sha, head_tree, actor_user_id, decision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(acceptanceId, input.taskId, input.companyId, input.releaseId, input.reviewId, input.ciRunId, input.repository, input.baseBranch, input.headSha, input.headTree, input.actorUserId, decision, status, now, now));
    return { acceptanceId, status, pullRequest: decision === "accept" ? { ...current, isDraft: false } : current };
  }

  async reconcile(input: { taskId: string; companyId: string; releaseId: string; repository: string; number: number; expectedHeadSha: string; expectedBaseBranch: string }): Promise<{ outcome: ReconciliationOutcome; pullRequest: GithubPullRequest | null }> {
    const release = this.database.authQuery((db) => db.prepare("SELECT id FROM forge_releases WHERE id = ? AND task_id = ? AND company_id = ? AND repository = ?").get(input.releaseId, input.taskId, input.companyId, input.repository));
    if (!release || !this.github.getPullRequest) throw new AcceptanceFailure("scope");
    let current: GithubPullRequest;
    try { current = await this.github.getPullRequest({ repository: input.repository, number: input.number }); } catch { return { outcome: "provider_unavailable", pullRequest: null }; }
    if (current.state === "merged") return { outcome: current.headSha.toLowerCase() === input.expectedHeadSha.toLowerCase() && current.baseBranch === input.expectedBaseBranch ? "merged" : "changed", pullRequest: current };
    if (current.state === "closed") return { outcome: "closed_without_merge", pullRequest: current };
    if (current.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase() || current.baseBranch !== input.expectedBaseBranch) return { outcome: "changed", pullRequest: current };
    return { outcome: "open", pullRequest: current };
  }

  private async currentPr(repository: string, number: number): Promise<GithubPullRequest> {
    if (!this.github.getPullRequest) throw new AcceptanceFailure("provider");
    try { return await this.github.getPullRequest({ repository, number }); } catch { throw new AcceptanceFailure("provider"); }
  }
}
