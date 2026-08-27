/**
 * GitHub-first delivery decision table.  This module intentionally has no
 * runtime dependencies: it is imported by the Temporal workflow bundle.
 */
export type PullRequestTarget = "draft" | "ready" | "merged";
export type PullRequestPhase = "Opening PR" | "Waiting for CI" | "Merging" | "Done" | "Blocked";
export type PullRequestOwner = "lead" | "human" | "none";

export interface PullRequestObservation {
  exists: boolean;
  /** A missing branch is represented independently because an old observation can have no PR. */
  branchExists?: boolean;
  number: number | null;
  state: "open" | "closed" | "merged" | null;
  isDraft: boolean | null;
  headSha: string | null;
  mergeable: string | null;
  checks: "pending" | "failed" | "success" | "none";
  reviewDecision: string | null;
  reviewLogin?: string | null;
  autoMergeEnabled: boolean | null;
  mergedSha?: string | null;
}

export interface PullRequestCurrent {
  phase?: string | null;
  pullRequestNumber?: number | null;
  observedHeadSha?: string | null;
  /** The delivery head last accepted by Forge. */
  headSha?: string | null;
  /** Whether this repository supports GitHub auto-merge. */
  autoMergeAvailable?: boolean | null;
  /** Used solely to make external-change feed rows idempotent. */
  adoptedObservationKey?: string | null;
}

export type PullRequestAction =
  | { kind: "push_open_draft" }
  | { kind: "push_open_ready" }
  | { kind: "mark_ready"; number: number }
  | { kind: "enable_auto_merge"; number: number; headSha: string }
  | { kind: "merge"; number: number; headSha: string }
  | { kind: "repair_ci" }
  | { kind: "review_delivery"; headSha: string }
  | { kind: "send_planner_note"; message: string }
  | { kind: "feed"; message: string };

export interface PullRequestReconciliation {
  phase: PullRequestPhase;
  pendingAction: string;
  owner: PullRequestOwner;
  allowedCommands: string[];
  actions: PullRequestAction[];
}

function feedOnce(current: PullRequestCurrent, observed: PullRequestObservation, message: string): PullRequestAction[] {
  const key = [observed.number ?? "none", observed.state ?? "none", observed.isDraft ?? "none", observed.headSha ?? "none", observed.reviewDecision ?? "none"].join(":");
  return current.adoptedObservationKey === key ? [] : [{ kind: "feed", message }];
}

function done(current: PullRequestCurrent, observed: PullRequestObservation, message: string): PullRequestReconciliation {
  return { phase: "Done", pendingAction: message, owner: "none", allowedCommands: [], actions: feedOnce(current, observed, message) };
}

/** Reconciles a single GitHub observation without performing I/O. */
export function reconcile(input: { observed: PullRequestObservation; target: PullRequestTarget; current: PullRequestCurrent }): PullRequestReconciliation {
  const { observed, target, current } = input;
  if (!observed.exists || observed.branchExists === false) {
    const action = target === "draft" ? "push_open_draft" : "push_open_ready";
    return { phase: "Opening PR", pendingAction: "Opening pull request", owner: "lead", allowedCommands: [], actions: [{ kind: action }] };
  }
  if (observed.state === "merged") return done(current, observed, "Merged");
  if (observed.state === "closed") {
    const number = observed.number ?? current.pullRequestNumber ?? "";
    const pendingAction = `Pull request #${number} was closed on GitHub`;
    return { phase: "Blocked", pendingAction, owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], actions: feedOnce(current, observed, pendingAction) };
  }
  if (observed.isDraft) {
    if (target === "draft") return done(current, observed, "Draft PR open");
    return { phase: "Blocked", pendingAction: "Pull request is a draft on GitHub — mark it ready to continue", owner: "human", allowedCommands: ["mark_ready", "cancel_issue"], actions: feedOnce(current, observed, "Pull request was converted to a draft on GitHub") };
  }
  if (observed.headSha && current.headSha && observed.headSha.toLowerCase() !== current.headSha.toLowerCase()) {
    return { phase: "Waiting for CI", pendingAction: "Reviewing the latest changes", owner: "lead", allowedCommands: ["review_delivery"], actions: [...feedOnce(current, observed, "Pull request head changed on GitHub"), { kind: "review_delivery", headSha: observed.headSha }] };
  }
  if (observed.reviewDecision === "CHANGES_REQUESTED") {
    const by = observed.reviewLogin ? ` by ${observed.reviewLogin}` : "";
    const message = `Changes requested on GitHub${by}`;
    return { phase: "Done", pendingAction: "Pull request ready", owner: "none", allowedCommands: ["send_planner_note"], actions: [...feedOnce(current, observed, message), { kind: "send_planner_note", message }] };
  }
  if (target !== "merged") return done(current, observed, "Pull request ready");
  if (observed.checks === "pending" || observed.checks === "none") return { phase: "Waiting for CI", pendingAction: "Waiting for CI", owner: "lead", allowedCommands: [], actions: feedOnce(current, observed, "Pull request marked ready on GitHub") };
  if (observed.checks === "failed") return { phase: "Waiting for CI", pendingAction: "Lead diagnosis", owner: "lead", allowedCommands: [], actions: [...feedOnce(current, observed, "CI failed on GitHub"), { kind: "repair_ci" }] };
  const number = observed.number!;
  const headSha = observed.headSha!;
  if (observed.autoMergeEnabled) return { phase: "Merging", pendingAction: "Merging", owner: "lead", allowedCommands: [], actions: feedOnce(current, observed, "Auto-merge enabled on GitHub") };
  const action: PullRequestAction = current.autoMergeAvailable === false ? { kind: "merge", number, headSha } : { kind: "enable_auto_merge", number, headSha };
  return { phase: "Merging", pendingAction: "Merging", owner: "lead", allowedCommands: [], actions: [...feedOnce(current, observed, "CI passed on GitHub"), action] };
}
