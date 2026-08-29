import { IssueWorkflowStateSchema, type IssueWorkflowState } from "./issue-contracts.js";
import { humanBlocker } from "./workflow/state-transitions.js";

type Observed = { exists: boolean; number: number | null; state: "open" | "closed" | "merged" | null; isDraft: boolean | null; headSha: string | null };

/** Pre-reconciler histories (no `forge-pr-reconciler-v1` marker): adopt a merged/closed/ready observation into state. */
export function applyLegacyGithubObservation(state: IssueWorkflowState, observed: Observed, common: Partial<IssueWorkflowState>, number: number | null | undefined, wasDraft: boolean | null | undefined): IssueWorkflowState {
  const revision = state.revision + 1, event = `${state.workflowId}:${revision}`, changedAt = new Date().toISOString();
  if (observed.state === "merged") return IssueWorkflowStateSchema.parse({ ...state, ...common, revision, phase: "done", owner: "human", allowedCommands: [], pendingAction: "Merged on GitHub", mergeOutcome: "merged", resultCommit: observed.headSha ?? state.resultCommit, stateChangedAt: changedAt, lastEventId: event });
  if (observed.state === "closed" || (!observed.exists && number != null)) {
    const summary = observed.state === "closed" ? `Pull request #${number} was closed on GitHub` : "Branch no longer on GitHub";
    return IssueWorkflowStateSchema.parse({ ...state, ...common, revision, phase: "delivery_blocked", owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: summary, blocker: humanBlocker("target_drift", summary, [{ command: "publish_draft", label: "Reopen or re-publish", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel issue", requiresNote: false, destructive: true }], undefined), stateChangedAt: changedAt, lastEventId: event });
  }
  return IssueWorkflowStateSchema.parse({ ...state, ...common, revision, ...(observed.exists && observed.isDraft === false && wasDraft === true ? { releaseStatus: "ready" as const, pendingAction: `PR #${observed.number} was marked ready on GitHub` } : {}), stateChangedAt: changedAt, lastEventId: event });
}
