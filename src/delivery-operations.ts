import type { DeliveryOperation } from "./root-contracts.js";
import type { RootIdentity } from "./root-contracts.js";
import type { GithubReleasePort, GithubPullRequest, GithubPullRequestObservation } from "./github-release.js";
import { createGithubReleasePort } from "./github-release.js";
import type { PullRequestReference, TaskControl } from "./task-control.js";
import { TaskControlStore } from "./root-session-store.js";

export class DeliveryOperationFailure extends Error {
  constructor(readonly code: "worktree_missing" | "pull_request_ambiguous" | "pull_request_closed" | "head_diverged" | "approval_missing" | "checks_pending" | "checks_failed", message: string) {
    super(message);
    this.name = "DeliveryOperationFailure";
  }
}

function reference(pull: GithubPullRequest): PullRequestReference {
  return { repository: pull.repository, number: pull.number, url: pull.url, headSha: pull.headSha, state: pull.state, mergedAt: pull.mergedAt };
}

function currentPull(repository: string, observed: GithubPullRequestObservation): PullRequestReference | null {
  if (!observed.exists || observed.number === null || observed.url === null || observed.headSha === null || observed.state === null) return null;
  return { repository, number: observed.number, url: observed.url, headSha: observed.headSha, state: observed.state, mergedAt: null };
}

export class DeliveryOperations {
  constructor(private readonly store: TaskControlStore, private readonly github: GithubReleasePort = createGithubReleasePort()) {}

  async execute(root: RootIdentity, operation: DeliveryOperation, expectedHead?: string): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    const control = this.store.get(root.taskId);
    const known = await this.observeKnownPull(control);
    if (known?.state === "merged") return this.completeIfTargetMatches(control, known);
    if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "Forge has no observed worktree for this task");
    const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
    this.store.setWorktree(root.taskId, { ...control.worktree, branch: local.branch, headSha: local.headSha, dirty: !local.clean });
    const refreshed = this.store.get(root.taskId);
    const repository = refreshed.deliveryIntent.repository;
    const remote = await this.github.getRemoteRepository({ cwd: refreshed.worktree!.path });
    if (remote !== repository) throw new DeliveryOperationFailure("head_diverged", "The worktree remote does not match this task intent");
    const pull = await this.observePull(refreshed, repository, local.branch);
    if (pull?.state === "merged") return this.completeIfTargetMatches(refreshed, pull);
    switch (operation) {
      case "observe_pull_request":
        return pull;
      case "push_branch":
        return this.push(refreshed, repository, local);
      case "create_or_adopt_pull_request":
        return this.createOrAdopt(refreshed, repository, local, pull);
      case "observe_checks":
        return this.checks(refreshed, repository, local.branch);
      case "rerun_or_diagnose_checks":
        return this.diagnoseChecks(refreshed, repository, local.branch);
      case "request_review":
        return this.requestReview(refreshed, repository, local.branch, expectedHead);
      case "merge_after_approval":
        return this.merge(refreshed, repository, local.branch, expectedHead);
    }
    throw new Error("delivery_operation_invalid");
  }

  private async observeKnownPull(control: TaskControl): Promise<PullRequestReference | null> {
    const number = control.pullRequest?.number ?? control.deliveryIntent.pullRequestNumber;
    if (number !== null) {
      const pull = await this.github.getPullRequest({ repository: control.deliveryIntent.repository, number });
      return this.adoptKnownPull(control, pull);
    }
    const candidates = await this.github.listPullRequests({ repository: control.deliveryIntent.repository, owner: control.deliveryIntent.repository.split("/")[0]!, headBranch: control.deliveryIntent.headBranch, baseBranch: control.deliveryIntent.baseBranch });
    if (candidates.length > 1) throw new DeliveryOperationFailure("pull_request_ambiguous", "GitHub returned more than one pull request for this task intent");
    return candidates[0] ? this.adoptKnownPull(control, candidates[0]) : null;
  }

  private adoptKnownPull(control: TaskControl, pull: GithubPullRequest): PullRequestReference {
    if (pull.repository !== control.deliveryIntent.repository || pull.headBranch !== control.deliveryIntent.headBranch || pull.baseBranch !== control.deliveryIntent.baseBranch) throw new DeliveryOperationFailure("pull_request_ambiguous", "The stored pull request no longer matches this task intent");
    const result = reference(pull);
    this.store.setPullRequest(control.taskId, result);
    return result;
  }

  private async observePull(control: TaskControl, repository: string, branch: string): Promise<PullRequestReference | null> {
    const observed = await this.github.observePullRequest?.({ repository, branch, ...(control.pullRequest ? { pullRequestNumber: control.pullRequest.number } : {}) });
    const pull = currentPull(repository, observed ?? { exists: false, number: null, url: null, state: null, isDraft: null, headSha: null, baseSha: null, mergeable: null, checks: { total: 0, pending: 0, failing: 0, successful: 0 }, autoMergeEnabled: null, reviewDecision: null });
    if (pull) this.store.setPullRequest(control.taskId, pull);
    return pull;
  }

  private async push(control: TaskControl, repository: string, local: { branch: string; headSha: string; clean: boolean }): Promise<unknown> {
    const remoteHead = await this.github.getBranchHead({ repository, branch: local.branch });
    if (remoteHead === local.headSha) return { kind: "adopted", headSha: local.headSha };
    await this.github.pushNormal({ cwd: control.worktree!.path, branch: local.branch });
    const observed = await this.github.getBranchHead({ repository, branch: local.branch });
    if (observed !== local.headSha) throw new DeliveryOperationFailure("head_diverged", "The remote branch does not match the observed worktree head");
    return { kind: "pushed", headSha: observed };
  }

  private async createOrAdopt(control: TaskControl, repository: string, local: { branch: string; headSha: string }, pull: PullRequestReference | null): Promise<PullRequestReference> {
    if (pull) {
      if (pull.state === "closed") throw new DeliveryOperationFailure("pull_request_closed", "The matching pull request is closed and was not merged");
      if (pull.headSha !== local.headSha && pull.state !== "merged") throw new DeliveryOperationFailure("head_diverged", "The pull request head does not match the observed worktree head");
      return pull;
    }
    if (local.branch !== control.deliveryIntent.headBranch) throw new DeliveryOperationFailure("head_diverged", "The worktree branch does not match this task intent");
    const matches = await this.github.listPullRequests({ repository, owner: repository.split("/")[0]!, headBranch: local.branch, baseBranch: control.deliveryIntent.baseBranch });
    const candidates = matches.filter((candidate) => candidate.headSha === local.headSha);
    if (candidates.length > 1) throw new DeliveryOperationFailure("pull_request_ambiguous", "GitHub returned more than one matching pull request");
    const created = candidates[0] ?? await this.github.createDraftPullRequest({ repository, owner: repository.split("/")[0]!, headBranch: local.branch, baseBranch: control.deliveryIntent.baseBranch, title: control.objective.slice(0, 120), body: control.objective });
    const result = reference(created);
    this.store.setPullRequest(control.taskId, result);
    return result;
  }

  private async checks(control: TaskControl, repository: string, branch: string): Promise<GithubPullRequestObservation> {
    const observed = await this.github.observePullRequest?.({ repository, branch, ...(control.pullRequest ? { pullRequestNumber: control.pullRequest.number } : {}) });
    if (!observed?.exists) throw new DeliveryOperationFailure("pull_request_closed", "GitHub did not return the pull request");
    return observed;
  }

  private async diagnoseChecks(control: TaskControl, repository: string, branch: string): Promise<GithubPullRequestObservation> {
    const observed = await this.checks(control, repository, branch);
    if (observed.checks.pending > 0) throw new DeliveryOperationFailure("checks_pending", "GitHub checks are still running");
    if (observed.checks.failing > 0) throw new DeliveryOperationFailure("checks_failed", "GitHub checks failed for the current head");
    return observed;
  }

  private async requestReview(control: TaskControl, repository: string, branch: string, expectedHead?: string): Promise<GithubPullRequestObservation> {
    const observed = await this.checks(control, repository, branch);
    if (observed.headSha !== control.worktree!.headSha) throw new DeliveryOperationFailure("head_diverged", "GitHub returned a pull request for another head");
    if (!expectedHead || expectedHead !== observed.headSha) throw new DeliveryOperationFailure("head_diverged", "The Root must review the current observed pull request head before requesting merge");
    return observed;
  }

  private async merge(control: TaskControl, repository: string, branch: string, expectedHead?: string): Promise<unknown> {
    const observed = await this.checks(control, repository, branch);
    if (observed.state === "merged") return this.completeIfTargetMatches(control, currentPull(repository, observed)!);
    if (observed.headSha !== control.worktree!.headSha) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed after review");
    if (!expectedHead || expectedHead !== observed.headSha) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed after the Root reviewed it");
    if (observed.checks.pending > 0) throw new DeliveryOperationFailure("checks_pending", "GitHub checks are still running");
    if (observed.checks.failing > 0) throw new DeliveryOperationFailure("checks_failed", "GitHub checks failed for the current pull request head");
    await this.github.mergePullRequest?.({ repository, number: observed.number!, headSha: observed.headSha! });
    const final = await this.github.getPullRequest({ repository, number: observed.number! });
    if (final.state !== "merged") return reference(final);
    return this.completeIfTargetMatches(control, reference(final));
  }

  private completeIfTargetMatches(control: TaskControl, pull: PullRequestReference): PullRequestReference {
    this.store.setPullRequest(control.taskId, pull);
    if (control.deliveryTarget === "merged" && pull.state === "merged") this.store.markDelivered(control.taskId);
    return pull;
  }
}
