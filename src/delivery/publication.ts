import { PullRequestBodySchema, PullRequestTitleSchema, type PullRequestBody, type PullRequestTitle } from "../coordination/root-contracts.js";
import type { GithubReleaseAdapter, GithubPullRequest } from "../integrations/github/delivery.js";
import type { GithubTriggerPort, GithubTriggerPullRequestInspection } from "../integrations/github/trigger-inspection.js";
import type { PullRequestReference, TaskControl } from "../tasks/control.js";
import type { TaskControlStore } from "../coordination/root-session-store.js";
import type { ReviewRange } from "../coordination/workflows.js";
import { DeliveryOperationFailure } from "./failure.js";

export type DeliveryGithubPort = Required<Pick<GithubReleaseAdapter,
  "getRemoteRepository" | "getBranchHead" | "inspectLocalRevision" | "pushNormal" |
  "listPullRequests" | "createDraftPullRequest" | "getPullRequest" |
  "observePullRequest" | "markReadyForReview" | "mergePullRequest"
>> & Partial<Pick<GithubReleaseAdapter, "mergePullRequestDirect">> & Partial<Pick<GithubTriggerPort, "inspectPullRequest">>;

type Recheck = () => void;
type Trigger = { policy: { dispatchId: string; repositoryId: number; repositoryName: string; pullRequestNumber: number; headSha: string; baseSha: string; headBranch: string; baseBranch: string; protectedPaths: string[] }; authorizedHead: string; pull: GithubTriggerPullRequestInspection } | null;

export type PublicationDependencies = {
  github: DeliveryGithubPort;
  store: TaskControlStore;
  finalRecheck: (control: TaskControl, actual: ReviewRange, recheck: Recheck) => Promise<void>;
  adoptKnownPull: (control: TaskControl, pull: GithubPullRequest, options: { explicit?: boolean; recheck?: Recheck }) => Promise<PullRequestReference>;
  completeRemoteBranch: (control: TaskControl, actual: ReviewRange, recheck: Recheck) => Promise<void>;
  inspectTriggerPolicy: (control: TaskControl, input: { expectedHead?: string; protectedPaths: boolean }) => Promise<Trigger>;
  triggerBlocked: (control: TaskControl, question: string, code: "head_diverged" | "merge_not_eligible") => DeliveryOperationFailure;
  selectDiscoveredPull: (control: TaskControl, pulls: GithubPullRequest[]) => GithubPullRequest | null;
};

export async function pushPublication(dependencies: PublicationDependencies, recheck: Recheck, control: TaskControl, repository: string, local: { branch: string; headSha: string; clean: boolean }, actual: ReviewRange): Promise<unknown> {
  const trigger = await dependencies.inspectTriggerPolicy(control, { protectedPaths: false });
  const remoteHead = await dependencies.github.getBranchHead({ repository, branch: local.branch });
  await dependencies.finalRecheck(control, actual, recheck);
  if (trigger && remoteHead !== trigger.authorizedHead) throw dependencies.triggerBlocked(control, "The trigger pull request head is not an authorized Forge delivery head.", "head_diverged");
  if (remoteHead === local.headSha) {
    if (trigger && remoteHead !== trigger.authorizedHead) throw dependencies.triggerBlocked(control, "The trigger pull request head is not an authorized Forge delivery head.", "head_diverged");
    if (control.deliveryTarget === "remote_branch") await dependencies.completeRemoteBranch(control, actual, recheck);
    return { kind: "adopted", headSha: local.headSha };
  }
  await dependencies.github.pushNormal({ cwd: control.worktree!.path, branch: local.branch, headSha: local.headSha });
  const observed = await dependencies.github.getBranchHead({ repository, branch: local.branch });
  if (observed !== local.headSha) throw new DeliveryOperationFailure("head_diverged", "The remote branch does not match the observed worktree head");
  if (trigger) dependencies.store.recordTriggerPush({ taskId: control.taskId, dispatchId: trigger.policy.dispatchId, fromHeadSha: trigger.authorizedHead, toHeadSha: local.headSha, review: actual });
  recheck();
  if (control.deliveryTarget === "remote_branch") await dependencies.completeRemoteBranch(control, actual, recheck);
  return { kind: "pushed", headSha: observed };
}

export async function createOrAdoptPublication(dependencies: PublicationDependencies, recheck: Recheck, control: TaskControl, repository: string, local: { branch: string; headSha: string }, pull: PullRequestReference | null, actual: ReviewRange, pullRequestTitle?: PullRequestTitle, pullRequestBody?: PullRequestBody): Promise<PullRequestReference> {
  if (pull) {
    if (pull.state === "closed") throw new DeliveryOperationFailure("pull_request_closed", "The matching pull request is closed and was not merged");
    if (pull.headSha !== local.headSha && pull.state !== "merged") throw new DeliveryOperationFailure("head_diverged", "The pull request head does not match the observed worktree head. Push the reviewed head first.");
    const full = await dependencies.github.getPullRequest({ repository, number: pull.number });
    await dependencies.finalRecheck(control, actual, recheck);
    return dependencies.adoptKnownPull(control, full, { explicit: true, recheck });
  }
  if (control.deliveryIntent.pullRequestNumber !== null) throw new DeliveryOperationFailure("pull_request_closed", "GitHub did not return the pinned pull request");
  if (local.branch !== control.deliveryIntent.headBranch) throw new DeliveryOperationFailure("head_diverged", "The worktree branch does not match this task intent");
  const candidate = dependencies.selectDiscoveredPull(control, await dependencies.github.listPullRequests({ repository, owner: repository.split("/")[0]!, headBranch: local.branch, baseBranch: control.deliveryIntent.baseBranch }));
  if (candidate?.state === "closed") throw new DeliveryOperationFailure("pull_request_closed", "The matching pull request is closed and was not merged");
  if (candidate && candidate.state !== "merged" && candidate.headSha !== local.headSha) throw new DeliveryOperationFailure("head_diverged", "The pull request head does not match the observed worktree head");
  await dependencies.finalRecheck(control, actual, recheck);
  if (candidate) return dependencies.adoptKnownPull(control, candidate, { explicit: true, recheck });
  const title = PullRequestTitleSchema.safeParse(pullRequestTitle);
  if (!title.success) throw new DeliveryOperationFailure("pull_request_title_required", "Supply a concise title that describes the final solution before you create a pull request.");
  const body = PullRequestBodySchema.safeParse(pullRequestBody);
  if (!body.success) throw new DeliveryOperationFailure("pull_request_body_required", "Supply a pull request description with the headings ## Summary, ## Why, ## Validation, ## Review notes, in order, before you create a pull request.");
  const created = await dependencies.github.createDraftPullRequest({ repository, owner: repository.split("/")[0]!, headBranch: local.branch, baseBranch: control.deliveryIntent.baseBranch, title: title.data, body: body.data });
  return dependencies.adoptKnownPull(control, created, { explicit: true, recheck });
}
