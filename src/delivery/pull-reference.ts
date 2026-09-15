import type { GithubPullRequest, GithubPullRequestObservation } from "../integrations/github/delivery.js";
import type { PullRequestReference, TaskControl } from "../tasks/control.js";

const noRemoteChecks = "No remote checks reported";

export const pullReference = (pull: GithubPullRequest): PullRequestReference => ({ repository: pull.repository, number: pull.number, url: pull.url, headSha: pull.headSha, state: pull.state, mergedAt: pull.mergedAt });

export const matchesDeliveryIntent = (control: TaskControl, pull: GithubPullRequest): boolean => {
  const pinnedNumber = control.deliveryIntent.pullRequestNumber;
  return pull.repository === control.deliveryIntent.repository
    && pull.headBranch === control.deliveryIntent.headBranch
    && !pull.isCrossRepository
    && (pinnedNumber === null ? pull.baseBranch === control.deliveryIntent.baseBranch : pull.number === pinnedNumber);
};

export const observedPullReference = (repository: string, observed: GithubPullRequestObservation): PullRequestReference | null => observed.exists && observed.number !== null && observed.url !== null && observed.headSha !== null && observed.state !== null ? { repository, number: observed.number, url: observed.url, headSha: observed.headSha, state: observed.state, mergedAt: null } : null;

export const checkSummary = (observed: GithubPullRequestObservation): string => observed.checks.total === 0 ? noRemoteChecks : `${observed.checks.successful} successful, ${observed.checks.pending} pending, ${observed.checks.failing} failing`;
