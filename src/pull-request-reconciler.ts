/**
 * GitHub-first delivery decision table.  This module intentionally has no
 * runtime dependencies: it is imported by the legacy workflow service workflow bundle.
 */
export type PullRequestTarget = "draft" | "ready" | "merged";
export type PullRequestPhase = "Opening PR" | "Forge waits for CI" | "Forge merges the pull request" | "Resolving conflicts" | "Done" | "Blocked";
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
  step?: string | null;
  owner?: PullRequestOwner | null;
  pendingAction?: string | null;
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
  | { kind: "resolve_conflicts" }
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
  /** The engine must retain its full current state. */
  unchanged?: true;
}

export function pullRequestObservationKey(observed: PullRequestObservation): string {
  return [observed.number ?? "none", observed.state ?? "none", observed.isDraft ?? "none", observed.headSha ?? "none", observed.reviewDecision ?? "none", observed.checks].join(":");
}

function feedOnce(current: PullRequestCurrent, observed: PullRequestObservation, message: string): PullRequestAction[] {
  return current.adoptedObservationKey === pullRequestObservationKey(observed) ? [] : [{ kind: "feed", message }];
}


function done(current: PullRequestCurrent, observed: PullRequestObservation, message: string): PullRequestReconciliation {
  return { phase: "Done", pendingAction: message, owner: "none", allowedCommands: [], actions: feedOnce(current, observed, message) };
}

/** Reconciles a single GitHub observation without performing I/O. */
export function reconcile(input: { observed: PullRequestObservation; target: PullRequestTarget; current: PullRequestCurrent }): PullRequestReconciliation {
  const { observed, target, current } = input;
  if (!observed.exists || observed.branchExists === false) {
    const action = target === "draft" ? "push_open_draft" : "push_open_ready";
    return { phase: "Opening PR", pendingAction: "Forge opens the pull request", owner: "lead", allowedCommands: [], actions: [{ kind: action }] };
  }
  if (observed.state === "merged") return done(current, observed, "Merged");
  if (observed.state === "closed") {
    const number = observed.number ?? current.pullRequestNumber ?? "";
    const pendingAction = `Pull request #${number} was closed on GitHub`;
    return { phase: "Blocked", pendingAction, owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], actions: feedOnce(current, observed, pendingAction) };
  }
  if (observed.isDraft) {
    if (target === "draft") return done(current, observed, "Draft PR open");
    return { phase: "Blocked", pendingAction: "The pull request is a draft on GitHub. Mark it ready to continue.", owner: "human", allowedCommands: ["mark_ready", "cancel_issue"], actions: feedOnce(current, observed, "Pull request was converted to a draft on GitHub") };
  }
  if (observed.state === "open" && observed.mergeable === "CONFLICTING") {
    return { phase: "Resolving conflicts", pendingAction: "Forge resolves merge conflicts with the base branch", owner: "lead", allowedCommands: ["cancel_issue"], actions: [...feedOnce(current, observed, "Pull request has merge conflicts on GitHub"), { kind: "resolve_conflicts" }] };
  }
  if (observed.headSha && current.headSha && observed.headSha.toLowerCase() !== current.headSha.toLowerCase()) {
    return { phase: "Forge waits for CI", pendingAction: "The Planner reviews the latest changes", owner: "lead", allowedCommands: ["review_delivery"], actions: [...feedOnce(current, observed, "Pull request head changed on GitHub"), { kind: "review_delivery", headSha: observed.headSha }] };
  }
  if (observed.reviewDecision === "CHANGES_REQUESTED") {
    const by = observed.reviewLogin ? ` by ${observed.reviewLogin}` : "";
    const message = `Changes requested on GitHub${by}`;
    return { phase: "Done", pendingAction: "The pull request is ready", owner: "none", allowedCommands: ["send_planner_note"], actions: [...feedOnce(current, observed, message), { kind: "send_planner_note", message }] };
  }
  if (target !== "merged") return done(current, observed, "The pull request is ready");
  if (current.owner === "human" && (current.step === "ci_repairing" || (["delivery_ready", "reviewing_delivery", "delivery_reviewed", "final_review"].includes(current.step ?? "") && /\bCI\b/i.test(current.pendingAction ?? ""))) && current.adoptedObservationKey === pullRequestObservationKey(observed) && (observed.checks === "pending" || observed.checks === "none" || observed.checks === "failed")) return { phase: "Blocked", pendingAction: current.pendingAction ?? "", owner: "human", allowedCommands: [], actions: [], unchanged: true };
  if (observed.checks === "pending" || observed.checks === "none") return { phase: "Forge waits for CI", pendingAction: "Forge waits for CI", owner: "lead", allowedCommands: [], actions: feedOnce(current, observed, "Pull request marked ready on GitHub") };
  if (observed.checks === "failed") return { phase: "Forge waits for CI", pendingAction: "The Planner inspects the CI failure", owner: "lead", allowedCommands: [], actions: [...feedOnce(current, observed, "CI failed on GitHub"), { kind: "repair_ci" }] };
  const number = observed.number!;
  const headSha = observed.headSha!;
  if (observed.autoMergeEnabled) return { phase: "Forge merges the pull request", pendingAction: "Forge merges the pull request", owner: "lead", allowedCommands: [], actions: feedOnce(current, observed, "Auto-merge enabled on GitHub") };
  const action: PullRequestAction = current.autoMergeAvailable === false ? { kind: "merge", number, headSha } : { kind: "enable_auto_merge", number, headSha };
  return { phase: "Forge merges the pull request", pendingAction: "Forge merges the pull request", owner: "lead", allowedCommands: [], actions: [...feedOnce(current, observed, "CI passed on GitHub"), action] };
}
