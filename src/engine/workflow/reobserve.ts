import { isCancellation, runExecution } from "../registry.js";
import { IssueWorkflowStateSchema, type IssueCommand, type IssueWorkflowInput } from "../issue-contracts.js";
import { issueUpdates } from "../issue-updates.js";
import { inspectTaskWorktree, observeGithubPullRequest } from "./activity-proxies.js";
import type { IssueWorkflowContext } from "./context.js";
import { clearAutomaticChainHalt } from "./runtime.js";

function parkedCommand(ctx: IssueWorkflowContext): { command: IssueCommand | null; eligible: boolean } {
  if (ctx.state.owner !== "human") return { command: null, eligible: false };
  const blockerCategory = ctx.state.blocker?.category;
  const targetBaseFailure = ctx.state.step === "development" && Boolean(ctx.state.targetBaseBlockerCode);
  const retriesPublishOrCi = blockerCategory === "agent_exhausted" && ctx.state.blocker?.actions.some((action) => action.command === "publish_draft" || action.command === "reconcile_ci");
  const retryableFailure = retriesPublishOrCi || blockerCategory === "provider_ambiguity" || blockerCategory === "provider_authentication" || blockerCategory === "provider_connectivity_exhausted" || blockerCategory === "verification_unrecoverable" || blockerCategory === "target_drift" || blockerCategory === "unsafe_recovery";
  if (!targetBaseFailure && !retryableFailure) return { command: null, eligible: false };
  if (ctx.state.step === "delivery_ready") return { command: "review_delivery", eligible: true };
  if (ctx.state.step === "delivery_reviewed") return { command: "publish_draft", eligible: true };
  if (ctx.state.step === "ci_waiting") return { command: "reconcile_ci", eligible: true };
  if (targetBaseFailure) return { command: "retry_target_base_reconciliation", eligible: true };
  return { command: null, eligible: ctx.state.step === "releasing" };
}

export async function reobserveParkedTask(ctx: IssueWorkflowContext, input: IssueWorkflowInput): Promise<boolean> {
  const { command, eligible } = parkedCommand(ctx);
  const parked = ctx.state.owner === "human" && ["delivery_ready", "delivery_reviewed", "releasing", "ci_waiting", "development"].includes(ctx.state.step);
  if (!eligible || !parked || !ctx.state.resultCommit || !ctx.state.resultTree || !ctx.state.branchName) return false;
  const observedAt = new Date().toISOString();
  let ownerConfirmation = "git does not have the reviewed commit at HEAD.";
  try {
    const git = await inspectTaskWorktree({ taskId: input.issueId, companyId: input.companyId, workflowId: input.workflowId, expectedCommit: ctx.state.resultCommit, expectedTree: ctx.state.resultTree, expectedBranch: ctx.state.branchName });
    const github = ctx.state.releaseRepository
      ? await observeGithubPullRequest({ repository: ctx.state.releaseRepository, branch: ctx.state.branchName, pullRequestNumber: ctx.state.pullRequestNumber })
      : null;
    if (!git.revision?.proven) throw new Error(ownerConfirmation);
    ownerConfirmation = "Herdr did not confirm that the Builder turn finished.";
    if (git.activeExecution) throw new Error(ownerConfirmation);
    ownerConfirmation = "GitHub does not have the reviewed pull request head.";
    if ((ctx.state.pullRequestNumber != null && !github?.exists) || (github?.exists && (!github.headSha || github.headSha.toLowerCase() !== ctx.state.resultCommit.toLowerCase()))) throw new Error(ownerConfirmation);
  } catch (error) {
    if (isCancellation(error)) throw error;
    return false;
  }
  const commandId = command ? `${ctx.state.workflowId}:auto-reobserve:${command}:${ctx.state.resultCommit}` : null;
  if (commandId && ctx.commandAlreadyProcessed(commandId)) return false;
  const revision = ctx.state.revision + 1;
  ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision, owner: "lead", blocker: null, pendingAction: "Forge retried after the earlier failure cleared.", stateChangedAt: observedAt, ...(commandId ? { processedCommandIds: [...(ctx.state.processedCommandIds ?? []), commandId].slice(-32) } : {}), lastEventId: `${ctx.state.workflowId}:${revision}` });
  clearAutomaticChainHalt(ctx.state.workflowId);
  await ctx.project();
  if (!command || !commandId) return true;
  const handler = runExecution.current().commands.get(issueUpdates[command]);
  if (!handler) throw new Error(`Automatic ${command} handler is unavailable`);
  await Reflect.apply(handler, undefined, [{ expectedRevision: ctx.state.revision, actorUserId: "forge-auto-reobserve", commandId }]);
  return true;
}
