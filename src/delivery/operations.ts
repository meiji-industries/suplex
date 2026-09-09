import type { DeliveryOperation, DeliveryReview, PullRequestBody, PullRequestTitle } from "../coordination/root-contracts.js";
import { inspectDeliveryDiff, reviewEquivalence } from "./review.js";
import type { RootIdentity } from "../coordination/root-contracts.js";
import type { GithubConditionalMergeResult, GithubPullRequest, GithubPullRequestObservation } from "../integrations/github/delivery.js";
import { createGithubReleasePort } from "../integrations/github/delivery.js";
import { GithubReleaseFailure } from "../integrations/github/failure.js";
import type { GithubTriggerPullRequestInspection } from "../integrations/github/trigger-inspection.js";
import { matchesGithubTriggerProtectedPaths } from "../integrations/github/trigger-paths.js";
import type { PullRequestReference, TaskControl } from "../tasks/control.js";
import type { TaskControlStore } from "../coordination/root-session-store.js";
import { deliveryDecision, deliveryWaitFingerprint, freshReviewHint, latestReview, reviewRole, sameRange, rangeDifferences, type DeliveryDecision, type DeliveryFailureCode, type LocalSourceFacts, type ReviewRange, type WorkflowCompletion } from "../coordination/workflows.js";
import { checkSummary, matchesDeliveryIntent, observedPullReference, pullReference } from "./pull-reference.js";
import { DeliveryOperationFailure } from "./failure.js";
import { createOrAdoptPublication, pushPublication, type DeliveryGithubPort, type PublicationDependencies } from "./publication.js";

export { DeliveryOperationFailure } from "./failure.js";
export type { DeliveryGithubPort } from "./publication.js";

export const DELIVERY_WAIT_NEXT = "End this Coordinator turn. Forge will resume it when delivery state changes.";
type Recheck = () => void;
type AdoptionOptions = { explicit?: boolean | undefined; recheck?: Recheck | undefined };
type CompletionOptions = AdoptionOptions & { isDraft?: boolean | undefined; validatedRange?: ReviewRange | undefined };
type Decision = DeliveryDecision;
type CommitDecision = Decision | { ok: false; code: DeliveryFailureCode; reason: string; cancelled: true };
type LocalRevisionFacts = { branch: string; headSha: string; clean: boolean };

function selectDiscoveredPull(control: TaskControl, pulls: GithubPullRequest[]): GithubPullRequest | null {
  const matches = pulls.filter(pull => matchesDeliveryIntent(control, pull));
  const eligible = matches.filter(pull => pull.state !== "closed");
  if (eligible.length > 1) throw new DeliveryOperationFailure("pull_request_ambiguous", "GitHub returned more than one pull request for this task intent");
  return eligible[0] ?? matches[0] ?? null;
}


export class DeliveryOperations {
  constructor(private readonly store: TaskControlStore, private readonly github: DeliveryGithubPort = createGithubReleasePort()) {}

  async observe(taskId: string): Promise<PullRequestReference | null> {
    const control = this.store.get(taskId);
    if (control.status === "cancelled" || control.status === "delivered") return control.pullRequest;
    if (control.deliveryTarget === "local_worktree") return null;
    return this.observeKnownPull(control);
  }

  /** Re-observes a persisted CI/mergeability wait. The wait is consumed exactly once; the loser of two observations returns none. */
  async observeDeliveryWait(taskId: string): Promise<"none" | "unchanged" | "changed" | "finished"> {
    const control = this.store.get(taskId);
    const wait = control.workflowState.deliveryWait;
    if (!wait || control.status !== "active") return "none";
    const repository = control.deliveryIntent.repository;
    let observed: GithubPullRequestObservation;
    try {
      observed = await this.github.observePullRequest({ repository, branch: control.deliveryIntent.headBranch, pullRequestNumber: control.pullRequest?.number ?? control.deliveryIntent.pullRequestNumber });
    } catch (error) {
      if (error instanceof GithubReleaseFailure && error.code === "authentication-required") {
        // A credential or permission failure is a human blocker; the expected-wait comparison keeps overlapping failures to one question.
        const asked = this.store.failDeliveryWait(taskId, wait, `GitHub could not access this pull request. Restore the GitHub CLI login or repository permission, then continue. ${error.message}`);
        return asked ? "changed" : "none";
      }
      throw error;
    }
    if (observed.state === "merged" && observed.number !== null) {
      const pull = await this.github.getPullRequest({ repository, number: observed.number });
      await this.adoptKnownPull(this.store.get(taskId), pull);
      this.store.clearDeliveryWait(taskId, wait);
      return "finished";
    }
    if (wait.reason === "observation") {
      const base = await this.github.getBranchHead({ repository, branch: control.deliveryIntent.baseBranch });
      if (base === null) return "unchanged";
      const prompt = `GitHub evidence is available again (the head of ${control.deliveryIntent.baseBranch}). Retry the delivery operation with your current review; no source change is needed.`;
      return this.store.resumeDeliveryWait(taskId, wait, prompt) ? "changed" : "none";
    }
    const fingerprint = deliveryWaitFingerprint(observed);
    if (observed.exists && fingerprint === wait.fingerprint) return "unchanged";
    const prompt = `Delivery state changed while Forge waited (${wait.reason}). Current observation: ${JSON.stringify({ exists: observed.exists, state: observed.state, headSha: observed.headSha, isDraft: observed.isDraft, mergeable: observed.mergeable, mergeStateStatus: observed.mergeStateStatus, reviewDecision: observed.reviewDecision, checks: observed.checks })}. If checks failed, obtain their evidence and continue the workflow; if the pull request is eligible, request merge_pull_request with your current review; otherwise observe_checks again.`;
    return this.store.resumeDeliveryWait(taskId, wait, prompt) ? "changed" : "none";
  }

  /** The live pull request check observation for Advisor evidence; null when there is no pull request or GitHub cannot answer. */
  async checksObservation(taskId: string): Promise<GithubPullRequestObservation | null> {
    const control = this.store.get(taskId);
    const number = control.pullRequest?.number ?? control.deliveryIntent.pullRequestNumber;
    if (number === null) return null;
    try { return await this.github.observePullRequest({ repository: control.deliveryIntent.repository, branch: control.deliveryIntent.headBranch, pullRequestNumber: number }); }
    catch { return null; }
  }

  /** The current GitHub-base-to-local-head range with the tree state; workflow delegation pins Advisor and Worker inputs to it. */
  async currentRange(taskId: string): Promise<DeliveryReview & { clean: boolean }> {
    const control = this.store.get(taskId);
    if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "The task has no worktree");
    const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
    const diff = await this.deliveryDiff(control, local.headSha);
    return { baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits, patchDigest: diff.patchDigest, clean: local.clean };
  }

  async execute(root: RootIdentity, operation: DeliveryOperation, expectedHead?: string, review?: DeliveryReview, pullRequestTitle?: PullRequestTitle, pullRequestBody?: PullRequestBody, options: { recheck?: () => void } = {}): Promise<unknown> {
    this.store.assertCurrentRoot(root);
    const control = this.store.get(root.taskId);
    const recheck: Recheck = () => { this.store.assertCurrentRoot(root); options.recheck?.(); };
    if (operation === "inspect_delivery_diff") {
      if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "The task has no worktree");
      const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
      return this.deliveryDiff(control, local.headSha);
    }
    if (operation === "complete_local_work") return this.completeLocal(control, expectedHead, recheck);
    const known = operation === "push_branch" ? null : await this.observeKnownPull(control, { recheck });
    if (this.store.get(root.taskId).status === "delivered") return known;
    if (known?.state === "merged") return known;
    if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "Forge has no observed worktree for this task");
    const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
    if (local.branch !== control.deliveryIntent.headBranch) throw new DeliveryOperationFailure("head_diverged", "The worktree branch does not match this task intent");
    this.store.setWorktree(root.taskId, { ...control.worktree, branch: local.branch, headSha: local.headSha, dirty: !local.clean });
    const refreshed = this.store.get(root.taskId);
    const repository = refreshed.deliveryIntent.repository;
    const remote = await this.github.getRemoteRepository({ cwd: refreshed.worktree!.path });
    if (remote !== repository) throw new DeliveryOperationFailure("head_diverged", "The worktree remote does not match this task intent");
    const mutation = ["push_branch", "create_or_adopt_pull_request", "request_review", "merge_pull_request"].includes(operation);
    let actual: ReviewRange | undefined;
    if (mutation) {
      if (!review || expectedHead !== local.headSha) throw new DeliveryOperationFailure("delivery_review_required", "Inspect delivery with inspect_delivery_diff. Independently review the entire GitHub-base-to-head diff and every commit, then supply expectedHead and review { baseSha, headSha, files, commits }. Do not approve unrelated changes or import unpublished local main; ask the human if the task depends on unpublished work.");
      let diff;
      try { diff = await this.deliveryDiff(refreshed, local.headSha); }
      catch (error) {
        if (operation === "merge_pull_request" && refreshed.pullRequest && this.observationUnavailable(error)) return this.observationWait(refreshed, local.headSha, `the head of ${refreshed.deliveryIntent.baseBranch}`);
        throw error;
      }
      actual = { baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits, patchDigest: diff.patchDigest };
      if (review.baseSha === actual.baseSha) {
        if (!sameRange(review, actual)) throw new DeliveryOperationFailure("delivery_review_required", `The reviewed delivery range differs in: ${rangeDifferences(review, actual).join(", ")}. Inspect delivery again and review the new range before retrying.`);
      } else {
        const equivalent = await reviewEquivalence(refreshed.worktree!.path, review, actual.baseSha);
        if (!equivalent.ok) throw new DeliveryOperationFailure("delivery_review_required", `${equivalent.reason} Inspect delivery again and review the new range before retrying.`);
        actual = equivalent.range;
      }
      this.gateWorkflow(refreshed, actual, { clean: local.clean });
      recheck();
    }
    const pull = operation === "push_branch" ? null : await this.observePull(refreshed, repository, local.branch);
    if (pull?.state === "merged") return this.adoptKnownPull(refreshed, await this.github.getPullRequest({ repository, number: pull.number }), { recheck });
    if (mutation && actual) this.store.updateWorkflowState(root.taskId, state => ({ ...state, acceptedDelivery: actual! }));
    switch (operation) {
      case "observe_pull_request":
        return pull;
      case "push_branch":
        return this.push(recheck, refreshed, repository, local, actual!);
      case "create_or_adopt_pull_request":
        return this.createOrAdopt(recheck, refreshed, repository, local, pull, actual!, pullRequestTitle, pullRequestBody);
      case "observe_checks":
        return this.observeChecks(refreshed, repository, local);
      case "request_review":
        return this.requestReview(recheck, refreshed, repository, local.branch, expectedHead, actual!);
      case "merge_pull_request":
        return this.merge(recheck, refreshed, repository, local.branch, expectedHead, actual!);
    }
    throw new Error("delivery_operation_invalid");
  }

  /** Every review-gated publication path for non-Standard workflows applies the one shared policy to fresh state. */
  private gateWorkflow(control: TaskControl, actual: ReviewRange, local: LocalSourceFacts): void {
    const decision = this.workflowDecision(control, actual, local);
    if (!decision.ok) throw new DeliveryOperationFailure(decision.code, decision.reason);
  }

  private workflowDecision(control: TaskControl, actual: ReviewRange, local: LocalSourceFacts): Decision {
    return deliveryDecision(this.store.get(control.taskId), this.store.sessions(control.taskId), this.store.turns(control.taskId), actual, local);
  }

  /** The final guard before a mutation: after every provider await, the local source must still be the reviewed head on the task branch, clean, without a delegate, and still gated; then the root and tool ownership must still hold. */
  private async finalRecheck(control: TaskControl, actual: ReviewRange, recheck: Recheck): Promise<void> {
    if (control.workflow !== "standard") {
      const local = await this.github.inspectLocalRevision({ cwd: control.worktree!.path });
      this.gateWorkflow(control, actual, local);
    }
    recheck();
  }

  private async deliveryDiff(control: TaskControl, headSha: string) {
    const baseSha = await this.github.getBranchHead({ repository: control.deliveryIntent.repository, branch: control.deliveryIntent.baseBranch });
    if (!baseSha) throw new DeliveryOperationFailure("observation_unavailable", `GitHub did not return the head of ${control.deliveryIntent.baseBranch}. Forge cannot compute the delivery range until that observation is available; no source change is needed.`);
    return inspectDeliveryDiff(control.worktree!.path, baseSha, headSha);
  }

  private observationUnavailable(error: unknown): boolean {
    return error instanceof DeliveryOperationFailure && error.code === "observation_unavailable"
      || error instanceof GithubReleaseFailure && (error.code === "provider-unavailable" || error.code === "provider-rate-limited");
  }

  private observationWait(control: TaskControl, headSha: string, evidence: string) {
    const wait = { headSha, fingerprint: `observation:${evidence}`, since: new Date().toISOString(), reason: "observation" as const };
    this.store.updateWorkflowState(control.taskId, state => ({ ...state, deliveryWait: wait }));
    this.store.scheduleWake(control.taskId, new Date(Date.now() + 30_000).toISOString());
    return { kind: "waiting", problems: [`${evidence} is unavailable`], wait, next: DELIVERY_WAIT_NEXT };
  }

  /**
   * The completion commit boundary: one last local observation after every provider, base, and diff await, then one store transaction that reloads
   * task, review, and delegate state, applies the policy to the validated range, rechecks ownership, and writes completion and delivery together.
   */
  private async commitCompletion(control: TaskControl, range: ReviewRange, pullRequestNumber: number | null, options: { requireAccepted: boolean; recheck?: Recheck | undefined; projectWorktree?: boolean | undefined }): Promise<CommitDecision> {
    if (!control.worktree) return { ok: false, code: "worktree_missing", reason: "The task has no observed worktree to confirm the reviewed source." };
    let local: LocalRevisionFacts;
    try { local = await this.github.inspectLocalRevision({ cwd: control.worktree.path }); }
    catch (error) { return { ok: false, code: "worktree_missing", reason: `The local source could not be observed: ${error instanceof Error ? error.message : String(error)}` }; }
    // The stored worktree projection reflects the final facts whether or not completion follows; only an active task holds a mutable projection.
    if (options.projectWorktree && this.store.get(control.taskId).status === "active") this.store.setWorktree(control.taskId, { ...control.worktree, branch: local.branch, headSha: local.headSha, dirty: !local.clean });
    const result = this.store.completeWorkflowDelivery({ taskId: control.taskId, range, local, pullRequestNumber, requireAccepted: options.requireAccepted, recheck: options.recheck });
    switch (result.kind) {
      case "completed":
      case "already":
        return { ok: true };
      case "cancelled":
        return { ok: false, code: "workflow_review_required", reason: "The task was cancelled; Forge recorded no workflow completion.", cancelled: true };
      case "declined":
        return { ok: false, code: result.code, reason: result.reason };
    }
  }

  private async completeLocal(control: TaskControl, expectedHead: string | undefined, recheck: Recheck) {
    if (control.deliveryTarget !== "local_worktree") throw new DeliveryOperationFailure("delivery_target_mismatch", "This task has a different delivery target");
    if (!control.worktree) throw new DeliveryOperationFailure("worktree_missing", "The task has no worktree");
    const local = await this.github.inspectLocalRevision({ cwd: control.worktree.path });
    if (!expectedHead || local.headSha !== expectedHead || local.branch !== control.deliveryIntent.headBranch) throw new DeliveryOperationFailure("head_diverged", "Review the current worktree before completing the task");
    if (control.workflow === "standard") {
      recheck();
      this.store.setWorktree(control.taskId, { ...control.worktree, headSha: local.headSha, dirty: !local.clean });
      this.store.markDelivered(control.taskId);
      return { kind: "local_work_completed", headSha: local.headSha };
    }
    const diff = await this.deliveryDiff(control, local.headSha);
    const actual = { baseSha: diff.baseSha, headSha: diff.headSha, files: diff.files, commits: diff.commits, patchDigest: diff.patchDigest };
    const decision = await this.commitCompletion(control, actual, null, { requireAccepted: false, recheck, projectWorktree: true });
    if (!decision.ok) {
      if ("cancelled" in decision) recheck();
      throw new DeliveryOperationFailure(decision.code, decision.reason);
    }
    return { kind: "local_work_completed", headSha: actual.headSha };
  }

  private async observeKnownPull(control: TaskControl, options: AdoptionOptions = {}): Promise<PullRequestReference | null> {
    const pinnedNumber = control.deliveryIntent.pullRequestNumber;
    if (pinnedNumber !== null) {
      const pull = await this.github.getPullRequest({ repository: control.deliveryIntent.repository, number: pinnedNumber });
      return this.adoptKnownPull(control, pull, options);
    }
    const pull = selectDiscoveredPull(control, await this.github.listPullRequests({ repository: control.deliveryIntent.repository, owner: control.deliveryIntent.repository.split("/")[0]!, headBranch: control.deliveryIntent.headBranch, baseBranch: control.deliveryIntent.baseBranch }));
    if (pull) return this.adoptKnownPull(control, pull, options);
    if (control.pullRequest) this.store.setPullRequest(control.taskId, null);
    return null;
  }

  private async adoptKnownPull(control: TaskControl, pull: GithubPullRequest, options: AdoptionOptions = {}): Promise<PullRequestReference> {
    if (!matchesDeliveryIntent(control, pull)) throw new DeliveryOperationFailure("pull_request_ambiguous", "The stored pull request no longer matches this task intent");
    return this.completeIfTargetMatches(control, pullReference(pull), { isDraft: pull.isDraft, explicit: options.explicit, recheck: options.recheck });
  }

  private async observePull(control: TaskControl, repository: string, branch: string): Promise<PullRequestReference | null> {
    if (!control.pullRequest) return null;
    const observed = await this.github.observePullRequest({ repository, branch, ...(control.pullRequest ? { pullRequestNumber: control.pullRequest.number } : {}) });
    const pull = observedPullReference(repository, observed);
    if (pull) this.store.setPullRequest(control.taskId, pull);
    return pull;
  }

  private publicationDependencies(): PublicationDependencies {
    return {
      github: this.github,
      store: this.store,
      finalRecheck: (control, actual, recheck) => this.finalRecheck(control, actual, recheck),
      adoptKnownPull: (control, pull, options) => this.adoptKnownPull(control, pull, options),
      completeRemoteBranch: (control, actual, recheck) => this.completeRemoteBranch(control, actual, recheck),
      inspectTriggerPolicy: (control, input) => this.inspectTriggerPolicy(control, input),
      triggerBlocked: (control, question, code) => this.triggerBlocked(control, question, code),
      selectDiscoveredPull,
    };
  }

  private async push(recheck: Recheck, control: TaskControl, repository: string, local: LocalRevisionFacts, actual: ReviewRange): Promise<unknown> {
    return pushPublication(this.publicationDependencies(), recheck, control, repository, local, actual);
  }

  /** The remote-branch target completes after the published or adopted head is observed, through the same final boundary as every other completion. */
  private async completeRemoteBranch(control: TaskControl, actual: ReviewRange, recheck: Recheck): Promise<void> {
    if (control.workflow === "standard") { this.store.markDelivered(control.taskId); return; }
    const decision = await this.commitCompletion(control, actual, null, { requireAccepted: true, recheck });
    if (!decision.ok) {
      if ("cancelled" in decision) recheck();
      throw new DeliveryOperationFailure(decision.code, decision.reason);
    }
  }

  private async createOrAdopt(recheck: Recheck, control: TaskControl, repository: string, local: { branch: string; headSha: string }, pull: PullRequestReference | null, actual: ReviewRange, pullRequestTitle?: PullRequestTitle, pullRequestBody?: PullRequestBody): Promise<PullRequestReference> {
    return createOrAdoptPublication(this.publicationDependencies(), recheck, control, repository, local, pull, actual, pullRequestTitle, pullRequestBody);
  }

  private async checks(control: TaskControl, repository: string, branch: string): Promise<GithubPullRequestObservation> {
    if (!control.pullRequest) throw new DeliveryOperationFailure("pull_request_closed", "No matching pull request was found for this task");
    const observed = await this.github.observePullRequest({ repository, branch, ...(control.pullRequest ? { pullRequestNumber: control.pullRequest.number } : {}) });
    if (!observed.exists) throw new DeliveryOperationFailure("pull_request_closed", "GitHub did not return the pull request");
    return observed;
  }

  /** GitHub reports check details here; its exact-head merge response remains authoritative for eligibility. */
  private async observeChecks(control: TaskControl, repository: string, local: { branch: string; headSha: string }): Promise<unknown> {
    const observed = await this.checks(control, repository, local.branch);
    const summary = { ...observed, checkSummary: checkSummary(observed) };
    if (observed.headSha !== local.headSha) return { ...summary, note: "The pull request head differs from the local head. Push the reviewed head before observing its checks." };
    return summary;
  }

  private async requestReview(recheck: Recheck, control: TaskControl, repository: string, branch: string, expectedHead: string | undefined, actual: ReviewRange): Promise<GithubPullRequestObservation> {
    const observed = await this.checks(control, repository, branch);
    if (observed.headSha !== control.worktree!.headSha) throw new DeliveryOperationFailure("head_diverged", "GitHub returned a pull request for another head");
    if (!expectedHead || expectedHead !== observed.headSha) throw new DeliveryOperationFailure("head_diverged", "The Coordinator must review the current observed pull request head before requesting merge");
    if (observed.state !== "open" || observed.number === null) throw new DeliveryOperationFailure("pull_request_closed", "The pull request is not open for review");
    await this.finalRecheck(control, actual, recheck);
    await this.github.markReadyForReview({ repository, number: observed.number });
    const final = await this.github.getPullRequest({ repository, number: observed.number });
    if (final.headSha !== expectedHead) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed while requesting review");
    await this.adoptKnownPull(control, final, { explicit: true, recheck });
    return this.checks(this.store.get(control.taskId), repository, branch);
  }

  private async merge(recheck: Recheck, control: TaskControl, repository: string, branch: string, expectedHead: string | undefined, actual: ReviewRange): Promise<unknown> {
    const observed = await this.checks(control, repository, branch);
    if (observed.state === "merged" && observed.number !== null) return this.adoptKnownPull(control, await this.github.getPullRequest({ repository, number: observed.number }), { recheck });
    if (observed.headSha !== control.worktree!.headSha) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed after review");
    if (!expectedHead || expectedHead !== observed.headSha) throw new DeliveryOperationFailure("head_diverged", "The pull request head changed after the Coordinator reviewed it");
    const trigger = await this.inspectTriggerPolicy(control, { expectedHead, protectedPaths: true });
    if (trigger || control.workflow !== "standard") {
      let base: string | null;
      try { base = await this.github.getBranchHead({ repository, branch: control.deliveryIntent.baseBranch }); }
      catch (error) { if (this.observationUnavailable(error)) return this.observationWait(control, observed.headSha!, `the head of ${control.deliveryIntent.baseBranch}`); throw error; }
      if (base === null) return this.observationWait(control, observed.headSha!, `the head of ${control.deliveryIntent.baseBranch}`);
      // Concrete harm prevented: merging content the accepted review never covered. Evidence: Git integration result on the current authoritative base.
      const equivalent = await reviewEquivalence(control.worktree!.path, actual, base);
      if (!equivalent.ok) throw new DeliveryOperationFailure("delivery_review_required", `${equivalent.reason}${freshReviewHint(control.workflow)}`);
    }
    await this.finalRecheck(control, actual, recheck);
    recheck();
    const requested = observed.number!;
    let mergeResult: GithubConditionalMergeResult | void;
    if (trigger) {
      if (observed.autoMergeEnabled) throw this.triggerBlocked(control, "Auto-merge is enabled for this trigger pull request. Review delivery manually.", "merge_not_eligible");
      if (!this.github.mergePullRequestDirect) throw new DeliveryOperationFailure("merge_not_eligible", "GitHub cannot perform a conditional trigger merge");
      mergeResult = await this.github.mergePullRequestDirect({ repository, number: requested, headSha: observed.headSha! });
    } else mergeResult = await this.github.mergePullRequest({ repository, number: requested, headSha: observed.headSha! });
    if (mergeResult && !mergeResult.merged) {
      const disposition = "disposition" in mergeResult ? mergeResult.disposition : undefined;
      const message = "message" in mergeResult ? mergeResult.message : "GitHub has not completed the merge";
      if (disposition === "blocked") throw new DeliveryOperationFailure("merge_not_eligible", message);
      const reason = disposition === "waiting" ? "checks" as const : "merge_queue" as const;
      const wait = { headSha: observed.headSha!, fingerprint: deliveryWaitFingerprint(observed), since: new Date().toISOString(), reason };
      this.store.updateWorkflowState(control.taskId, state => ({ ...state, deliveryWait: wait }));
      this.store.scheduleWake(control.taskId, new Date(Date.now() + 30_000).toISOString());
      return disposition === "queued"
        ? { kind: "merge_requested", checkSummary: checkSummary(observed), wait, next: DELIVERY_WAIT_NEXT }
        : { kind: "waiting", problems: [message], wait, next: DELIVERY_WAIT_NEXT };
    }
    const final = await this.github.getPullRequest({ repository, number: requested });
    if (final.state !== "merged") {
      // The provider accepted the request without merging: a queue or asynchronous merge. Observe its actual outcome.
      const wait = { headSha: observed.headSha!, fingerprint: deliveryWaitFingerprint(observed), since: new Date().toISOString(), reason: "merge_queue" as const };
      this.store.updateWorkflowState(control.taskId, state => ({ ...state, deliveryWait: wait }));
      this.store.scheduleWake(control.taskId, new Date(Date.now() + 30_000).toISOString());
      return { kind: "merge_requested", pullRequest: pullReference(final), checkSummary: checkSummary(observed), wait, next: DELIVERY_WAIT_NEXT };
    }
    // The merge result must identify this task's pull request before Forge records anything from it; a mismatched head is external, not verified.
    this.assertMergeResultIdentity(control, repository, requested, final);
    return { ...await this.completeIfTargetMatches(control, pullReference(final), { validatedRange: actual, recheck }), checkSummary: checkSummary(observed), reviewedHead: observed.headSha };
  }
  private triggerBlocked(control: TaskControl, question: string, code: "head_diverged" | "merge_not_eligible"): DeliveryOperationFailure { if (control.status === "active") this.store.askHuman(control.taskId, question); return new DeliveryOperationFailure(code, question); }
  private async inspectTriggerPolicy(control: TaskControl, input: { expectedHead?: string; protectedPaths: boolean }): Promise<{ policy: { dispatchId: string; repositoryId: number; repositoryName: string; pullRequestNumber: number; headSha: string; baseSha: string; headBranch: string; baseBranch: string; protectedPaths: string[] }; authorizedHead: string; pull: GithubTriggerPullRequestInspection } | null> {
    const policy = this.store.readTriggerDeliveryPolicy(control.taskId); if (!policy) return null;
    const authorizedHead = this.store.authorizedTriggerHead(control.taskId); if (!authorizedHead || !this.github.inspectPullRequest) throw new DeliveryOperationFailure("head_diverged", "GitHub trigger delivery policy could not be inspected");
    let pull: GithubTriggerPullRequestInspection; try { pull = await this.github.inspectPullRequest({ repository: policy.repositoryName, number: policy.pullRequestNumber }); } catch { throw new DeliveryOperationFailure("head_diverged", "GitHub trigger delivery policy could not be inspected"); }
    const valid = pull.number === policy.pullRequestNumber && pull.state === "open" && !pull.isDraft && !pull.isCrossRepository && pull.baseRepository.id === policy.repositoryId && pull.baseRepository.fullName.toLowerCase() === policy.repositoryName && pull.headRepository?.id === policy.repositoryId && pull.headRepository.fullName.toLowerCase() === policy.repositoryName && pull.headBranch === policy.headBranch && pull.baseBranch === policy.baseBranch && pull.headSha === authorizedHead && (!input.expectedHead || pull.headSha === input.expectedHead);
    if (!valid) throw this.triggerBlocked(control, "The trigger pull request changed outside Forge-authorized delivery. Review delivery manually.", "head_diverged");
    if (input.protectedPaths && pull.files.some(file => [file.filename, file.previousFilename].some(path => path && matchesGithubTriggerProtectedPaths(policy.protectedPaths, { filename: path })))) throw this.triggerBlocked(control, "The trigger pull request changes a protected path. Review delivery manually.", "merge_not_eligible");
    return { policy, authorizedHead, pull };
  }

  /** A merge result is adopted only for the requested repository and number, the captured number when one exists, the intended branches, and the same repository. */
  private assertMergeResultIdentity(control: TaskControl, repository: string, requested: number, final: GithubPullRequest): void {
    const captured = control.pullRequest?.number ?? control.deliveryIntent.pullRequestNumber;
    if (final.repository !== repository || final.number !== requested || (captured !== null && final.number !== captured) || !matchesDeliveryIntent(control, final)) {
      throw new DeliveryOperationFailure("pull_request_ambiguous", `GitHub returned ${final.repository}#${final.number} (${final.headBranch} into ${final.baseBranch}${final.isCrossRepository ? ", cross-repository" : ""}) for the merge request of ${repository}#${requested}; the result does not identify this task's pull request.`);
    }
  }

  /** The unverified outcome for a merged pull request: the latest valid review's head is kept in history, never relabeled. */
  private externalCompletion(current: TaskControl, pullRequestNumber: number): WorkflowCompletion {
    const role = reviewRole(current.workflow);
    const latest = role ? latestReview(current.workflowState.reviews, role) : undefined;
    return { kind: "external_merge", reviewedHead: latest?.result ? latest.range.headSha : null, pullRequestNumber, observedAt: new Date().toISOString() };
  }

  private recordExternalMerge(control: TaskControl, pull: PullRequestReference): void {
    this.store.recordWorkflowOutcome(control.taskId, this.externalCompletion(this.store.get(control.taskId), pull.number));
  }

  /** Direct proof for a merge Forge requested: GitHub's pull request head must be the validated head; the merge commit itself can differ. */
  private directMergeProof(pull: PullRequestReference, validatedRange: ReviewRange): Decision {
    if (pull.headSha !== validatedRange.headSha) return { ok: false, code: "head_diverged", reason: `GitHub reports the merged pull request head ${pull.headSha.slice(0, 12)}, not the reviewed head ${validatedRange.headSha.slice(0, 12)}.` };
    return { ok: true };
  }

  /** Passive proof rejects concrete harm only: no accepted Forge decision, or a GitHub merge of a different head. */
  private passiveMergeProof(control: TaskControl, pull: PullRequestReference): Decision {
    const accepted = control.workflowState.acceptedDelivery;
    if (!accepted) return { ok: false, code: "workflow_review_required", reason: "No accepted delivery decision exists for this pull request." };
    if (accepted.headSha !== pull.headSha) return { ok: false, code: "head_diverged", reason: `The merged head ${pull.headSha.slice(0, 12)} is not the accepted head ${accepted.headSha.slice(0, 12)}.` };
    return { ok: true };
  }

  /** An open pull request at a draft/ready target completes only when the accepted range is proven against the remote base and the Git range, then committed through the final boundary. */
  private async openCompletionDecision(control: TaskControl, pull: PullRequestReference, recheck: Recheck | undefined): Promise<CommitDecision> {
    const accepted = control.workflowState.acceptedDelivery;
    if (!accepted) return { ok: false, code: "workflow_review_required", reason: "No accepted delivery decision exists for this pull request yet. Complete the workflow's review and request delivery." };
    if (pull.headSha !== accepted.headSha) return { ok: false, code: "head_diverged", reason: `The pull request head ${pull.headSha.slice(0, 12)} is not the accepted head ${accepted.headSha.slice(0, 12)}.` };
    let remoteBase: string | null;
    try { remoteBase = await this.github.getBranchHead({ repository: control.deliveryIntent.repository, branch: control.deliveryIntent.baseBranch }); }
    catch { return { ok: false, code: "observation_unavailable", reason: `GitHub did not return the head of ${control.deliveryIntent.baseBranch}; Forge will observe it again.` }; }
    if (remoteBase === null) return { ok: false, code: "observation_unavailable", reason: `GitHub did not return the head of ${control.deliveryIntent.baseBranch}; Forge will observe it again.` };
    if (!control.worktree) return { ok: false, code: "worktree_missing", reason: "The task has no observed worktree to confirm the reviewed source." };
    const equivalent = await reviewEquivalence(control.worktree.path, accepted, remoteBase);
    if (!equivalent.ok) return { ok: false, code: "delivery_review_required", reason: `${equivalent.reason}${freshReviewHint(control.workflow)}` };
    return this.commitCompletion(control, accepted, pull.number, { requireAccepted: true, recheck });
  }

  /** Observation updates external facts. Standard completes on a matching endpoint; other workflows complete only through the final boundary, or record an external merge truthfully. */
  private async completeIfTargetMatches(control: TaskControl, pull: PullRequestReference, options: CompletionOptions = {}): Promise<PullRequestReference> {
    this.store.setPullRequest(control.taskId, pull);
    const reached = pull.state === "merged"
      || pull.state === "open" && (control.deliveryTarget === "pull_request_draft"
        || control.deliveryTarget === "pull_request_ready" && options.isDraft === false);
    if (!reached) return pull;
    const current = this.store.get(control.taskId);
    if (current.status === "cancelled") {
      // An accepted remote request finished after cancellation: record the outcome, issue nothing further, and stay cancelled.
      if (control.workflow !== "standard" && !current.workflowState.completion && pull.state === "merged") this.store.recordWorkflowOutcome(control.taskId, this.cancelledOutcome(current, pull, options.validatedRange));
      return pull;
    }
    if (control.workflow === "standard") { this.store.markDelivered(control.taskId); return pull; }
    if (current.workflowState.completion) { if (current.status !== "delivered") this.store.markDelivered(control.taskId); return pull; }
    if (pull.state === "merged") {
      const proof = options.validatedRange ? this.directMergeProof(pull, options.validatedRange) : this.passiveMergeProof(current, pull);
      const range = options.validatedRange ?? current.workflowState.acceptedDelivery;
      const decision: CommitDecision = proof.ok && range ? await this.commitCompletion(current, range, pull.number, { requireAccepted: options.validatedRange === undefined, recheck: options.recheck }) : proof;
      if (decision.ok) return pull;
      if ("cancelled" in decision) this.store.recordWorkflowOutcome(control.taskId, this.cancelledOutcome(this.store.get(control.taskId), pull, options.validatedRange));
      else this.recordExternalMerge(current, pull);
      return pull;
    }
    const decision = await this.openCompletionDecision(current, pull, options.recheck);
    if (decision.ok) return pull;
    if (options.explicit) throw new DeliveryOperationFailure(decision.code, decision.reason);
    return pull;
  }

  /** After cancellation, a merge Forge requested on the validated head is its own outcome; any other merged head is external. */
  private cancelledOutcome(current: TaskControl, pull: PullRequestReference, validatedRange: ReviewRange | undefined): WorkflowCompletion {
    if (validatedRange && validatedRange.headSha === pull.headSha) return { kind: "workflow", reviewedHead: validatedRange.headSha, pullRequestNumber: pull.number, observedAt: new Date().toISOString() };
    return this.externalCompletion(current, pull.number);
  }
}
