import { assertNever } from "../../assert-never.js";
import { gitSha, gitTree, type ExecutionId, type TurnId } from "../../ids.js";
import { at } from "../../issue-phases.js";
import { issueUpdates } from "../issue-updates.js";
import type { IssueCommand } from "../../commands/registry.js";
import type { IssueWorkflowState } from "../issue-contracts.js";
import { IssueWorkflowStateSchema } from "../issue-contracts.js";
import { condition, log, runExecution, sleep } from "../registry.js";
import { turnResultSchema } from "../../turn-result-schemas.js";
import type { IssueWorkflowContext } from "./context.js";
import { inspectTaskWorktree, observeGithubPullRequest, readHerdrTurn } from "./activity-proxies.js";
import { herdrResultAnswer, ownerAnswer, type OwnerAnswer } from "./owner-answer.js";
import { meta, nextStep, type OwnerEvent } from "./step-machine.js";
import type { OwnerRead } from "./step-table.js";
import { humanBlocker } from "./state-transitions.js";

export { OwnerAnswerSchema, type OwnerAnswer } from "./owner-answer.js";

type HerdrTurn = {
  turnId: TurnId;
  executionId: ExecutionId;
  role: Extract<OwnerRead, { owner: "herdr" }>['role'];
  ledger: "agent" | "developer";
  promptKind: string;
  subject: { commit?: string | null; tree?: string | null; planRevision?: number | null };
  result: unknown | null;
  terminalFailure: string | null;
};
type WorktreeRead = { present: boolean; dirtyFileCount: number; revision: { proven: boolean; head: string | null; headTree: string | null; clean: boolean; reason?: string } | null };
type GithubRead = { exists: boolean; state: "open" | "closed" | "merged" | null; mergeable: string | null; checks: { pending: number; failing: number; total: number; successful: number } };

export type DriverDependencies = {
  inspectTaskWorktree?: (input: { taskId: string; companyId: string; workflowId: string; expectedCommit?: ReturnType<typeof gitSha>; expectedTree?: ReturnType<typeof gitTree>; expectedBranch?: string }) => Promise<WorktreeRead>;
  observeGithubPullRequest?: (input: { repository: string; branch: string; pullRequestNumber?: number | null }) => Promise<GithubRead>;
  readLatestHerdrTurn?: (input: { taskId: string; role: HerdrTurn["role"]; promptKind: string }) => Promise<HerdrTurn | null>;
  isTaskTurnLive?: (taskId: string) => Promise<{ live: boolean }>;
  now?: () => Date;
  shouldWake?: () => boolean;
  syncGithubPullRequest?: () => Promise<unknown>;
};

function parsed(value: OwnerAnswer): OwnerAnswer { return ownerAnswer(value); }
function unavailable(owner: OwnerRead["owner"], error: unknown): OwnerAnswer { return parsed({ type: "owner.unavailable", owner, reason: error instanceof Error ? error.message : `${owner} owner read failed` }); }

function memberAnswer(state: IssueWorkflowState, decision: Extract<OwnerRead, { owner: "member" }>['decision']): OwnerAnswer {
  switch (decision) {
    case "plan_approval": return parsed(state.planApproved ? { type: "owner.done" } : { type: "owner.absent" });
    case "delivery_decision": return parsed(state.deliveryDecisionArtifactId ? { type: "owner.done" } : { type: "owner.absent" });
    case "product_decision": return parsed({ type: "owner.absent" });
    case "acceptance": return parsed(state.acceptanceStatus === "accepted" ? { type: "owner.done" } : state.acceptanceStatus === "requested_changes" ? { type: "owner.failed", reason: "Member requested delivery changes" } : { type: "owner.absent" });
    default: return assertNever(decision);
  }
}

async function readHerdr(ctx: IssueWorkflowContext, waitsOn: Extract<OwnerRead, { owner: "herdr" }>, dependencies: DriverDependencies): Promise<OwnerAnswer> {
  if (!dependencies.readLatestHerdrTurn || !dependencies.isTaskTurnLive) {
    return readHerdrTurn({
      taskId: ctx.input.issueId,
      companyId: ctx.input.companyId,
      workflowId: ctx.input.workflowId,
      role: waitsOn.role,
      promptKind: waitsOn.promptKind,
      subject: {
        ...(ctx.state.resultCommit !== undefined ? { commit: ctx.state.resultCommit } : {}),
        ...(ctx.state.resultTree !== undefined ? { tree: ctx.state.resultTree } : {}),
        ...(ctx.state.planRevision !== undefined ? { planRevision: ctx.state.planRevision } : {}),
      },
    });
  }
  const turn = await dependencies.readLatestHerdrTurn({ taskId: ctx.input.issueId, role: waitsOn.role, promptKind: waitsOn.promptKind });
  if (turn && turn.role === waitsOn.role && turn.promptKind === waitsOn.promptKind) {
    if (turn.result !== null) {
      const result = turnResultSchema(turn.ledger, turn.promptKind)?.safeParse(turn.result);
      if (result?.success) return herdrResultAnswer(result.data);
    }
    if (turn.terminalFailure) return parsed({ type: "owner.failed", reason: turn.terminalFailure });
  }
  return (await dependencies.isTaskTurnLive(ctx.input.issueId)).live ? parsed({ type: "owner.live" }) : parsed({ type: "owner.absent" });
}

async function readGit(ctx: IssueWorkflowContext, waitsOn: Extract<OwnerRead, { owner: "git" }>, dependencies: DriverDependencies): Promise<OwnerAnswer> {
  const expectedCommit = waitsOn.what === "delivery" ? ctx.state.resultCommit : ctx.state.targetBaseSha;
  if (!expectedCommit) return parsed({ type: "owner.absent" });
  const expectedTree = waitsOn.what === "delivery" ? ctx.state.resultTree : undefined;
  const inspect = dependencies.inspectTaskWorktree ?? inspectTaskWorktree;
  const worktree = await inspect({ taskId: ctx.input.issueId, companyId: ctx.input.companyId, workflowId: ctx.input.workflowId, expectedCommit: gitSha(expectedCommit), ...(expectedTree ? { expectedTree: gitTree(expectedTree) } : {}), ...(ctx.state.branchName ? { expectedBranch: ctx.state.branchName } : {}) });
  if (!worktree.present) return parsed({ type: "owner.absent" });
  if (worktree.dirtyFileCount > 0 || worktree.revision?.clean === false) return parsed({ type: "owner.failed", reason: "Git worktree is dirty" });
  return parsed(worktree.revision?.proven ? { type: "owner.done" } : { type: "owner.failed", reason: worktree.revision?.reason ?? "Git head differs from the expected revision" });
}

async function readGithub(ctx: IssueWorkflowContext, waitsOn: Extract<OwnerRead, { owner: "github" }>, dependencies: DriverDependencies): Promise<OwnerAnswer> {
  const repository = ctx.state.releaseRepository ?? ctx.input.repository;
  const branch = ctx.state.branchName;
  if (!repository || !branch) return parsed({ type: "owner.absent" });
  const observe = dependencies.observeGithubPullRequest ?? observeGithubPullRequest;
  const observation = await observe({ repository, branch, ...(ctx.state.pullRequestNumber ? { pullRequestNumber: ctx.state.pullRequestNumber } : {}) });
  if (!observation.exists) return parsed({ type: "owner.absent" });
  if (observation.state === "merged") return parsed({ type: "owner.done" });
  if (observation.state === "closed") return parsed({ type: "owner.failed", reason: "Pull request closed without merge" });
  if (["CONFLICTING", "DIRTY"].includes(observation.mergeable ?? "")) return parsed({ type: "owner.failed", reason: "Pull request has merge conflicts" });
  if (waitsOn.what === "checks") return parsed(observation.checks.failing > 0 ? { type: "owner.failed", reason: "Required checks failed" } : observation.checks.pending > 0 || observation.checks.total === 0 || observation.checks.successful !== observation.checks.total ? { type: "owner.live" } : { type: "owner.done" });
  return parsed({ type: "owner.live" });
}

export async function readOwner(ctx: IssueWorkflowContext, waitsOn: OwnerRead, dependencies: DriverDependencies = {}): Promise<OwnerEvent> {
  try {
    switch (waitsOn.owner) {
      case "member": return memberAnswer(ctx.state, waitsOn.decision);
      case "timer": {
        const dueAt = ctx.state[waitsOn.field];
        if (!dueAt) return parsed({ type: "owner.absent" });
        return Date.parse(dueAt) <= (dependencies.now?.() ?? new Date()).getTime() ? parsed({ type: "owner.done" }) : parsed({ type: "owner.live" });
      }
      case "herdr": return await readHerdr(ctx, waitsOn, dependencies);
      case "git": return await readGit(ctx, waitsOn, dependencies);
      case "github": return await readGithub(ctx, waitsOn, dependencies);
      default: return assertNever(waitsOn);
    }
  } catch (error) {
    return unavailable(waitsOn.owner, error);
  }
}

function ownerSummary(event: Extract<OwnerEvent, { type: "owner.unavailable" }>): string {
  return `${event.owner[0]!.toUpperCase()}${event.owner.slice(1)} is unavailable. Forge retries after a short backoff.`;
}

async function runDriverCommand(ctx: IssueWorkflowContext, command: IssueCommand, step: IssueWorkflowState["step"], event: OwnerEvent): Promise<void> {
  const revision = ctx.state.revision;
  const commandId = `${ctx.state.workflowId}:driver:${step}:${revision}:${event.type}`;
  if (ctx.commandAlreadyProcessed(commandId)) return;
  const handler = runExecution.current().commands.get(issueUpdates[command]);
  if (!handler) throw new Error(`Driver ${command} handler is unavailable`);
  ctx.markCommandProcessed(commandId);
  ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: revision + 1, allowedCommands: ctx.state.allowedCommands.includes(command) ? ctx.state.allowedCommands : [...ctx.state.allowedCommands, command], lastEventId: `${ctx.state.workflowId}:${revision + 1}` });
  await ctx.project();
  await Reflect.apply(handler, undefined, [{ expectedRevision: ctx.state.revision, actorUserId: "forge-driver", commandId }]);
}

function changeStep(ctx: IssueWorkflowContext, step: IssueWorkflowState["step"], owner: "lead" | "human"): boolean {
  const rule = meta(step);
  const humanAction = owner === "human" ? rule.humanAction : undefined;
  const pendingAction = owner === "human" ? "Your action is necessary." : "Forge reads the next owner.";
  if (ctx.state.step === step && ctx.state.owner === owner && ctx.state.pendingAction === pendingAction) return false;
  const revision = ctx.state.revision + 1;
  ctx.state = IssueWorkflowStateSchema.parse({
    ...ctx.state,
    revision,
    ...at(step),
    owner,
    allowedCommands: owner === "human" && humanAction ? [humanAction, "cancel_issue"] : owner === "human" ? ["cancel_issue"] : ["cancel_issue"],
    pendingAction,
    blocker: owner === "human" && humanAction
      ? humanBlocker("member_authorization", pendingAction, [{ command: humanAction, label: "Continue", requiresNote: false, destructive: false }, { command: "cancel_issue", label: "Cancel the task", requiresNote: false, destructive: true }], undefined)
      : null,
    stateChangedAt: new Date().toISOString(),
    lastEventId: `${ctx.state.workflowId}:${revision}`,
  });
  return true;
}

export async function evaluateStep(ctx: IssueWorkflowContext, dependencies: DriverDependencies = {}): Promise<void> {
  const step = ctx.state.step;
  const rule = meta(step);
  if (rule.waitsOn.owner === "github" && dependencies.syncGithubPullRequest) {
    const revision = ctx.state.revision;
    await dependencies.syncGithubPullRequest();
    if (ctx.state.step !== step || ctx.state.revision !== revision) return;
  }
  const event = await readOwner(ctx, rule.waitsOn as OwnerRead, dependencies);
  const { actions } = nextStep(step, event);
  for (const action of actions) {
    if (action.type === "runCommand") await runDriverCommand(ctx, action.params.command, step, event);
    else if (action.type === "changeStep") {
      if (changeStep(ctx, action.params.step, action.params.owner)) await ctx.project();
    } else if (event.type === "owner.unavailable") {
      const summary = ownerSummary(event);
      const retryAt = new Date((dependencies.now?.() ?? new Date()).getTime() + (action.params.pollMs ?? 15_000)).toISOString();
      if (!ctx.state.ciNextPollAt || Date.parse(ctx.state.ciNextPollAt) <= (dependencies.now?.() ?? new Date()).getTime()) {
        const revision = ctx.state.revision + 1;
        ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision, ciNextPollAt: retryAt, lastEventId: `${ctx.state.workflowId}:${revision}` });
        await ctx.project();
      }
      log.warn(summary, { workflowId: ctx.state.workflowId, step });
      await sleep(action.params.pollMs ?? 15_000);
    } else if (action.params.on === "signal") await condition(dependencies.shouldWake ?? (() => false));
    else await sleep(action.params.pollMs ?? 60_000);
  }
}
