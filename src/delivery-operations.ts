import { PullRequestTitleSchema, type DeliveryOperation, type DeliveryReview, type PullRequestTitle } from "./root-contracts.js";
import { inspectDeliveryDiff, matchesDeliveryReview } from "./delivery-review.js";
import type { RootIdentity } from "./root-contracts.js";
import type { GithubReleaseAdapter, GithubPullRequest, GithubPullRequestObservation } from "./github-delivery.js";
import { createGithubReleasePort } from "./github-delivery.js";
import type { PullRequestReference, TaskControl } from "./task-control.js";
import type { TaskControlStore } from "./root-session-store.js";

export class DeliveryOperationFailure extends Error {
  constructor(readonly code: "worktree_missing" | "pull_request_ambiguous" | "pull_request_closed" | "head_diverged" | "delivery_target_mismatch" | "delivery_review_required" | "pull_request_title_required", message: string) {
    super(message);
    this.name = "DeliveryOperationFailure";
  }
}

export type DeliveryGithubPort = Required<Pick<GithubReleaseAdapter,
  "getRemoteRepository" | "getBranchHead" | "inspectLocalRevision" | "pushNormal" |
  "listPullRequests" | "createDraftPullRequest" | "getPullRequest" |
  "observePullRequest" | "markReadyForReview" | "mergePullRequest"
>>;

function reference(pull: GithubPullRequest): PullRequestReference {
  return { repository: pull.repository, number: pull.number, url: pull.url, headSha: pull.headSha, state: pull.state, mergedAt: pull.mergedAt };
}

function matchesIntent(control: TaskControl, pull: GithubPullRequest): boolean {
  return pull.repository === control.deliveryIntent.repository && pull.headBranch === control.deliveryIntent.headBranch && pull.baseBranch === control.deliveryIntent.baseBranch && !pull.isCrossRepository;
}

function currentPull(repository: string, observed: GithubPullRequestObservation): PullRequestReference | null {
  if (!observed.exists || observed.number === null || observed.url === null || observed.headSha === null || observed.state === null) return null;
  return { repository, number: observed.number, url: observed.url, headSha: observed.headSha, state: observed.state, mergedAt: null };
}

export class DeliveryOperations {
  constructor(private readonly store: TaskControlStore, private readonly github: DeliveryGithubPort = createGithubReleasePort()) {}

  async observe(taskId: string): Promise<PullRequestReference | null> {
    const control = this.store.get(taskId);
    if (control.status === "cancelled" || control.status === "delivered") return control.pullRequest;
    if (control.deliveryTarget === "local_worktree") return null;
    return this.observeKnownPull(control);
  }

  async execute(root: RootIdentity, operation: DeliveryOperation, expectedHead?: string, review?: DeliveryReview, pullRequestTitle?: PullRequestTitle): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    const control = this.store.get(root.taskId);
    if (operation === "inspect_delivery_diff") {
      if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "The task has no worktree");
      const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
      return this.deliveryDiff(control, local.headSha);
    }
    if (operation === "complete_local_work") return this.completeLocal(root, control, expectedHead);
    const known = operation === "push_branch" ? null : await this.observeKnownPull(control);
    if (this.store.get(root.taskId).status === "delivered") return known;
    if (known?.state === "merged") return this.completeIfTargetMatches(control, known);
    if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "Forge has no observed worktree for this task");
    const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
    if (local.branch !== control.deliveryIntent.headBranch) throw new DeliveryOperationFailure("head_diverged", "The worktree branch does not match this task intent");
    this.store.setWorktree(root.taskId, { ...control.worktree, branch: local.branch, headSha: local.headSha, dirty: !local.clean });
    const refreshed = this.store.get(root.taskId);
    const repository = refreshed.deliveryIntent.repository;
    const remote = await this.github.getRemoteRepository({ cwd: refreshed.worktree!.path });
    if (remote !== repository) throw new DeliveryOperationFailure("head_diverged", "The worktree remote does not match this task intent");
    if (["push_branch", "create_or_adopt_pull_request", "request_review", "merge_pull_request"].includes(operation)) {
      if (!review || expectedHead !== local.headSha) throw new DeliveryOperationFailure("delivery_review_required", "Inspect delivery with inspect_delivery_diff. Independently review the entire GitHub-base-to-head diff and every commit, then supply expectedHead and review { baseSha, headSha, files, commits }. Do not approve unrelated changes or import unpublished local main; ask the human if the task depends on unpublished work.");
      const actual = await this.deliveryDiff(refreshed, local.headSha);
      if (!matchesDeliveryReview(review, actual)) throw new DeliveryOperationFailure("delivery_review_required", "The GitHub base, task head, files, or commits differ from the reviewed delivery range. Inspect delivery again and review the whole range before retrying.");
      this.store.assertCurrentRoot(root);
    }
    const pull = operation === "push_branch" ? null : await this.observePull(refreshed, repository, local.branch);
    if (pull?.state === "merged") return this.completeIfTargetMatches(refreshed, pull);
    switch (operation) {
      case "observe_pull_request":
        return pull;
      case "push_branch":
        return this.push(root, refreshed, repository, local);
      case "create_or_adopt_pull_request":
        return this.createOrAdopt(root, refreshed, repository, local, pull, pullRequestTitle);
      case "observe_checks":
        return this.checks(refreshed, repository, local.branch);
      case "request_review":
        return this.requestReview(root, refreshed, repository, local.branch, expectedHead);
      case "merge_pull_request":
        return this.merge(root, refreshed, repository, local.branch, expectedHead);
    }
    throw new Error("delivery_operation_invalid");
  }

  private async deliveryDiff(control: TaskControl, headSha: string) {
    const baseSha = await this.github.getBranchHead({ repository: control.deliveryIntent.repository, branch: control.deliveryIntent.baseBranch });
    if (!baseSha) throw new DeliveryOperationFailure("head_diverged", "GitHub did not return the intended delivery base");
    return inspectDeliveryDiff(control.worktree!.path, baseSha, headSha);
  }

  private async completeLocal(root: RootIdentity, control: TaskControl, expectedHead?: string) {
    if (control.deliveryTarget !== "local_worktree") throw new DeliveryOperationFailure("delivery_target_mismatch", "This task has a different delivery target");
    if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "The task has no worktree");
    const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
    if (!expectedHead || local.headSha !== expectedHead || local.branch !== control.deliveryIntent.headBranch) throw new DeliveryOperationFailure("head_diverged", "Review the current worktree before completing the task");
    this.store.assertCurrentRoot(root);
    this.store.setWorktree(control.taskId, { ...control.worktree, headSha: local.headSha, dirty: !local.clean });
    this.store.markDelivered(control.taskId);
    return { kind: "local_work_completed", headSha: local.headSha };
  }

  private async observeKnownPull(control: TaskControl): Promise<PullRequestReference | null> {
    const number = control.pullRequest?.number ?? control.deliveryIntent.pullRequestNumber;
    if (number !== null) {
      const pull = await this.github.getPullRequest({ repository: control.deliveryIntent.repository, number });
      return this.adoptKnownPull(control, pull);
    }
    const candidates = (await this.github.listPullRequests({ repository: control.deliveryIntent.repository, owner: control.deliveryIntent.repository.split("/")[0]!, headBranch: control.deliveryIntent.headBranch, baseBranch: control.deliveryIntent.baseBranch })).filter(pull => matchesIntent(control, pull));
    if (candidates.length > 1) throw new DeliveryOperationFailure("pull_request_ambiguous", "GitHub returned more than one pull request for this task intent");
    return candidates[0] ? this.adoptKnownPull(control, candidates[0]) : null;
  }

  private adoptKnownPull(control: TaskControl, pull: GithubPullRequest): PullRequestReference {
    if (!matchesIntent(control, pull)) throw new DeliveryOperationFailure("pull_request_ambiguous", "The stored pull request no longer matches this task intent");
    const result = reference(pull);
    return this.completeIfTargetMatches(control, result, pull.isDraft);
  }

  private async observePull(control: TaskControl, repository: string, branch: string): Promise<PullRequestReference | null> {
    if (!control.pullRequest) return null;
    const observed = await this.github.observePullRequest({ repository, branch, ...(control.pullRequest ? { pullRequestNumber: control.pullRequest.number } : {}) });
    const pull = currentPull(repository, observed);
    if (pull) this.store.setPullRequest(control.taskId, pull);
    return pull;
  }

  private async push(root: RootIdentity, control: TaskControl, repository: string, local: { branch: string; headSha: string; clean: boolean }): Promise<unknown> {
    const remoteHead = await this.github.getBranchHead({ repository, branch: local.branch });
    this.store.assertCurrentRoot(root);
    if (remoteHead === local.headSha) {
      if (control.deliveryTarget === "remote_branch") this.store.markDelivered(control.taskId);
      return { kind: "adopted", headSha: local.headSha };
    }
    await this.github.pushNormal({ cwd: control.worktree!.path, branch: local.branch, headSha: local.headSha });
    const observed = await this.github.getBranchHead({ repository, branch: local.branch });
    if (observed !== local.headSha) throw new DeliveryOperationFailure("head_diverged", "The remote branch does not match the observed worktree head");
    this.store.assertCurrentRoot(root);
    if (control.deliveryTarget === "remote_branch") this.store.markDelivered(control.taskId);
    return { kind: "pushed", headSha: observed };
  }

  private async createOrAdopt(root: RootIdentity, control: TaskControl, repository: string, local: { branch: string; headSha: string }, pull: PullRequestReference | null, pullRequestTitle?: PullRequestTitle): Promise<PullRequestReference> {
    if (pull) {
      if (pull.state === "closed") throw new DeliveryOperationFailure("pull_request_closed", "The matching pull request is closed and was not merged");
      if (pull.headSha !== local.headSha && pull.state !== "merged") throw new DeliveryOperationFailure("head_diverged", "The pull request head does not match the observed worktree head");
      return pull;
    }
    if (local.branch !== control.deliveryIntent.headBranch) throw new DeliveryOperationFailure("head_diverged", "The worktree branch does not match this task intent");
    const matches = await this.github.listPullRequests({ repository, owner: repository.split("/")[0]!, headBranch: local.branch, baseBranch: control.deliveryIntent.baseBranch });
    const candidates = matches.filter((candidate) => matchesIntent(control, candidate) && candidate.headSha === local.headSha);
    if (candidates.length > 1) throw new DeliveryOperationFailure("pull_request_ambiguous", "GitHub returned more than one matching pull request");
    this.store.assertCurrentRoot(root);
    if (candidates[0]) return this.adoptKnownPull(control, candidates[0]);
    const title = PullRequestTitleSchema.safeParse(pullRequestTitle);
    if (!title.success) throw new DeliveryOperationFailure("pull_request_title_required", "Supply a concise title that describes the final solution before you create a pull request.");
    const created = await this.github.createDraftPullRequest({ repository, owner: repository.split("/")[0]!, headBranch: local.branch, baseBranch: control.deliveryIntent.baseBranch, title: title.data, body: control.objective });
    return this.adoptKnownPull(control, created);
  }

  private async checks(control: TaskControl, repository: string, branch: string): Promise<GithubPullRequestObservation> {
    if (!control.pullRequest) throw new DeliveryOperationFailure("pull_request_closed", "No matching pull request was found for this task");
    const observed = await this.github.observePullRequest({ repository, branch, ...(control.pullRequest ? { pullRequestNumber: control.pullRequest.number } : {}) });
    if (!observed.exists) throw new DeliveryOperationFailure("pull_request_closed", "GitHub did not return the pull request");
    return observed;
  }

  private async requestReview(root: RootIdentity, control: TaskControl, repository: string, branch: string, expectedHead?: string): Promise<GithubPullRequestObservation> {
    const observed = await this.checks(control, repository, branch);
    if (observed.headSha !== control.worktree!.headSha) throw new DeliveryOperationFailure("head_diverged", "GitHub returned a pull request for another head");
    if (!expectedHead || expectedHead !== observed.headSha) throw new DeliveryOperationFailure("head_diverged", "The Coordinator must review the current observed pull request head before requesting merge");
    if (observed.state !== "open" || observed.number === null) throw new DeliveryOperationFailure("pull_request_closed", "The pull request is not open for review");
    this.store.assertCurrentRoot(root);
    await this.github.markReadyForReview({ repository, number: observed.number });
    const final = await this.github.getPullRequest({ repository, number: observed.number });
    if (final.headSha !== expectedHead) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed while requesting review");
    this.adoptKnownPull(control, final);
    return this.checks(this.store.get(control.taskId), repository, branch);
  }

  private async merge(root: RootIdentity, control: TaskControl, repository: string, branch: string, expectedHead?: string): Promise<unknown> {
    const observed = await this.checks(control, repository, branch);
    if (observed.state === "merged") return this.completeIfTargetMatches(control, currentPull(repository, observed)!);
    if (observed.headSha !== control.worktree!.headSha) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed after review");
    if (!expectedHead || expectedHead !== observed.headSha) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed after the Coordinator reviewed it");
    this.store.assertCurrentRoot(root);
    await this.github.mergePullRequest({ repository, number: observed.number!, headSha: observed.headSha! });
    const final = await this.github.getPullRequest({ repository, number: observed.number! });
    if (final.state !== "merged") return reference(final);
    return this.completeIfTargetMatches(control, reference(final));
  }

  private completeIfTargetMatches(control: TaskControl, pull: PullRequestReference, isDraft?: boolean): PullRequestReference {
    this.store.setPullRequest(control.taskId, pull);
    const reached = pull.state === "merged"
      || pull.state === "open" && (control.deliveryTarget === "pull_request_draft"
        || control.deliveryTarget === "pull_request_ready" && isDraft === false);
    if (reached) this.store.markDelivered(control.taskId);
    return pull;
  }
}
