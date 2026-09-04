import { assertNever } from "../../assert-never.js";
import { gitSha, gitTree, type ExecutionId, type TurnId } from "../../ids.js";
import { issueUpdates } from "../issue-updates.js";
import { IssueWorkflowStateSchema, type IssueCommand, type IssueWorkflowState } from "../issue-contracts.js";
import { log, runExecution } from "../registry.js";
import { turnResultSchema } from "../../turn-result-schemas.js";
import { at, isBlocked } from "../../issue-phases.js";
import type { IssueWorkflowContext } from "./context.js";
import { inspectTaskWorktree, observeGithubPullRequest, readHerdrTurn } from "./activity-proxies.js";
import { deferCiGithubObservation } from "./register-ci.js";
import type { GithubPullRequestObservationResult } from "../contracts/activities/github-sync.js";
import { nextAdoptFirst, nextStep, type OwnerEvent } from "./step-machine.js";
import { STEP_TABLE, type OwnerRead, type Transition } from "./step-table.js";
import { herdrResultAnswer, ownerAnswer, type OwnerAnswer } from "./owner-answer.js";

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
type WorktreeRead = { present: boolean; dirtyFileCount: number; activeExecution?: boolean; revision: { proven: boolean; head: string | null; headTree: string | null; clean: boolean; reason?: string } | null };
type GithubRead = { exists: boolean; state: "open" | "closed" | "merged" | null; isDraft?: boolean | null; mergeable: string | null; checks: { pending: number; failing: number; total: number; successful: number } };

export type DriverDependencies = {
  inspectTaskWorktree?: (input: { taskId: string; companyId: string; workflowId: string; expectedCommit?: ReturnType<typeof gitSha>; expectedTree?: ReturnType<typeof gitTree>; expectedBranch?: string }) => Promise<WorktreeRead>;
  observeGithubPullRequest?: (input: { repository: string; branch: string; pullRequestNumber?: number | null }) => Promise<GithubRead>;
  syncGithubPullRequest?: () => Promise<GithubPullRequestObservationResult | null>;
  reconcileCi?: (observation: GithubPullRequestObservationResult | null) => Promise<void>;
  takeGithubSyncSignal?: () => boolean;
  readLatestHerdrTurn?: (input: { taskId: string; role: HerdrTurn["role"]; promptKind: string }) => Promise<HerdrTurn | null>;
  isTaskTurnLive?: (taskId: string) => Promise<{ live: boolean }>;
  now?: () => Date;
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

function matchesSubject(state: IssueWorkflowState, subject: HerdrTurn["subject"]): boolean {
  return (!subject.commit || subject.commit === state.resultCommit)
    && (!subject.tree || subject.tree === state.resultTree)
    && (subject.planRevision === undefined || subject.planRevision === null || subject.planRevision === state.planRevision);
}

function resultAnswer(result: unknown): OwnerAnswer {
  return herdrResultAnswer(result);
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
  if (turn && turn.role === waitsOn.role && turn.promptKind === waitsOn.promptKind && matchesSubject(ctx.state, turn.subject)) {
    if (turn.result !== null) {
      const parsedResult = turnResultSchema(turn.ledger, turn.promptKind)?.safeParse(turn.result);
      if (parsedResult?.success) return resultAnswer(parsedResult.data);
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
  if (worktree.activeExecution || worktree.dirtyFileCount > 0 || worktree.revision?.clean === false) return parsed({ type: "owner.live" });
  return parsed(worktree.revision?.proven ? { type: "owner.done" } : { type: "owner.failed", reason: worktree.revision?.reason ?? "Git head differs from the expected revision" });
}

function releaseTargetComplete(ctx: IssueWorkflowContext, observation: GithubRead | GithubPullRequestObservationResult): boolean {
  if (observation.state === "merged") return true;
  if (ctx.input.deliveryTarget === "pull_request_draft") return observation.isDraft === true;
  return ctx.input.deliveryTarget === "pull_request_ready" && observation.state === "open" && observation.isDraft === false;
}

function githubAnswer(ctx: IssueWorkflowContext, waitsOn: Extract<OwnerRead, { owner: "github" }>, observation: GithubRead | GithubPullRequestObservationResult | null): OwnerAnswer {
  if (!observation) return parsed({ type: "owner.absent" });
  if (!observation.exists) return parsed({ type: "owner.absent" });
  if (waitsOn.what === "pull_request" && ctx.state.step !== "manual_merge" && releaseTargetComplete(ctx, observation)) return parsed({ type: "owner.done" });
  if (observation.state === "merged") return parsed({ type: "owner.done" });
  if (observation.state === "closed") return parsed({ type: "owner.failed", reason: "Pull request closed without merge" });
  if (["CONFLICTING", "DIRTY"].includes(observation.mergeable ?? "")) return parsed({ type: "owner.failed", reason: "Pull request has merge conflicts" });
  if (waitsOn.what === "checks") return parsed(observation.checks.failing > 0 ? { type: "owner.failed", reason: "Required checks failed" } : observation.checks.pending > 0 || observation.checks.total === 0 || observation.checks.successful !== observation.checks.total ? { type: "owner.live" } : { type: "owner.done" });
  return parsed({ type: "owner.live" });
}

async function readGithub(ctx: IssueWorkflowContext, waitsOn: Extract<OwnerRead, { owner: "github" }>, dependencies: DriverDependencies): Promise<OwnerAnswer> {
  if (dependencies.syncGithubPullRequest) {
    let observation: GithubPullRequestObservationResult | null;
    try {
      observation = await dependencies.syncGithubPullRequest();
    } catch (error) {
      if (waitsOn.what === "checks") await deferCiGithubObservation(ctx, error);
      throw error;
    }
    if (waitsOn.what === "checks" && ctx.state.owner === "lead" && dependencies.reconcileCi) await dependencies.reconcileCi(observation);
    return githubAnswer(ctx, waitsOn, observation);
  }
  const repository = ctx.state.releaseRepository ?? ctx.input.repository;
  const branch = ctx.state.branchName;
  if (!repository || !branch) return parsed({ type: "owner.absent" });
  const observe = dependencies.observeGithubPullRequest ?? observeGithubPullRequest;
  const observation = await observe({ repository, branch, ...(ctx.state.pullRequestNumber ? { pullRequestNumber: ctx.state.pullRequestNumber } : {}) });
  return githubAnswer(ctx, waitsOn, observation);
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

const refusedDriverCommands = new Set<string>();

function sameState(left: IssueWorkflowState, right: IssueWorkflowState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isGuardRefusal(error: unknown): boolean {
  return error instanceof Error && /not available in the current phase/i.test(error.message);
}

async function runDriverCommand(ctx: IssueWorkflowContext, command: IssueCommand, step: IssueWorkflowState["step"], event: OwnerEvent): Promise<boolean> {
  const revision = ctx.state.revision;
  const commandId = `${ctx.state.workflowId}:driver:${step}:${revision}:${event.type}`;
  if (ctx.commandAlreadyProcessed(commandId)) return false;
  if (command === "publish_draft" && step === "releasing") {
    ctx.markCommandProcessed(commandId);
    if (!ctx.state.releaseRetryAt) {
      const releaseRevision = ctx.state.revision + 1;
      ctx.state = IssueWorkflowStateSchema.parse({
        ...ctx.state,
        revision: releaseRevision,
        ...at("delivery_ready"),
        owner: "lead",
        allowedCommands: ctx.addRevisionCommand(["review_delivery", "cancel_issue"]),
        pendingAction: "The publish stopped. Review again before you publish.",
        lastEventId: `${ctx.state.workflowId}:${releaseRevision}`,
      });
      await ctx.project();
      return true;
    }
    await ctx.runPublishTurn();
    return true;
  }
  const handler = runExecution.current().commands.get(issueUpdates[command]);
  if (!handler) throw new Error(`Driver ${command} handler is unavailable`);
  const before = ctx.state;
  if (command !== "start_development" && command !== "retry_development") {
    ctx.markCommandProcessed(commandId);
    ctx.state = IssueWorkflowStateSchema.parse({ ...ctx.state, revision: revision + 1, allowedCommands: ctx.state.allowedCommands.includes(command) ? ctx.state.allowedCommands : [...ctx.state.allowedCommands, command], lastEventId: `${ctx.state.workflowId}:${revision + 1}` });
  }
  const claimed = ctx.state;
  try {
    await Reflect.apply(handler, undefined, [{ expectedRevision: claimed.revision, actorUserId: "forge-driver", commandId }]);
  } catch (error) {
    ctx.state = before;
    if (!isGuardRefusal(error)) throw error;
    if (!refusedDriverCommands.has(commandId)) {
      refusedDriverCommands.add(commandId);
      log.warn("Driver command refused by phase guard", { command, commandId, step });
    }
    return false;
  }
  if (sameState(ctx.state, claimed)) {
    ctx.state = before;
    return false;
  }
  return true;
}

const DIRECT_STEP_DETAILS: Partial<Record<IssueWorkflowState["step"], Pick<IssueWorkflowState, "allowedCommands" | "pendingAction">>> = {
  done: { allowedCommands: [], pendingAction: "Done. Pull request reached the delivery target." },
  delivery_reviewed: { allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Forge opens the pull request" },
  repair_required: { allowedCommands: ["repair_delivery", "cancel_issue"], pendingAction: "The Builder fixes the review findings" },
  accepted: { allowedCommands: ["accept_delivery", "request_delivery_changes", "cancel_issue"], pendingAction: "Your delivery decision is necessary" },
  delivery_ready: { allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "The Planner reviews the delivery" },
  development: { allowedCommands: ["request_delivery_changes", "cancel_issue"], pendingAction: "Your delivery decision is necessary" },
  merge_conflict_reviewing: { allowedCommands: ["cancel_issue"], pendingAction: "Forge prepares a conflict plan" },
};

function directStepDetails(step: IssueWorkflowState["step"]): Pick<IssueWorkflowState, "allowedCommands" | "pendingAction"> {
  const details = DIRECT_STEP_DETAILS[step];
  if (!details) throw new Error(`No direct driver transition details for ${step}`);
  return details;
}

async function applyDirectStep(ctx: IssueWorkflowContext, target: Extract<Transition, { step: IssueWorkflowState["step"] }>, step: IssueWorkflowState["step"], event: OwnerEvent): Promise<void> {
  const revision = ctx.state.revision;
  const commandId = `${ctx.state.workflowId}:driver:${step}:${revision}:${event.type}`;
  if (ctx.commandAlreadyProcessed(commandId)) return;
  const details = directStepDetails(target.step);
  ctx.markCommandProcessed(commandId);
  ctx.state = IssueWorkflowStateSchema.parse({
    ...ctx.state,
    revision: revision + 1,
    ...at(target.step),
    owner: target.owner,
    ...details,
    blocker: null,
    lastEventId: `${ctx.state.workflowId}:${revision + 1}`,
  });
  await ctx.project();
}

export async function evaluateStep(ctx: IssueWorkflowContext, dependencies: DriverDependencies = {}): Promise<boolean> {
  const step = ctx.state.step;
  const rule = STEP_TABLE[step];
  const githubWaiting = step === "releasing" || step === "ci_waiting" || step === "manual_merge";
  const ciWaiting = step === "ci_waiting" && rule.waitsOn.owner === "github" && rule.waitsOn.what === "checks";
  if (step === "releasing" && ctx.state.releaseRetryAt && Date.parse(ctx.state.releaseRetryAt) > (dependencies.now?.().getTime() ?? runExecution.current().now())) return false;
  if (rule.terminal || (!rule.adoptFirst && rule.waitsOn.owner !== "herdr" && !githubWaiting) || ctx.state.activeOperation !== null) return false;
  if (ciWaiting) {
    const now = dependencies.now?.().getTime() ?? runExecution.current().now();
    const pollAt = ctx.state.ciNextPollAt ? Date.parse(ctx.state.ciNextPollAt) : now;
    const signalled = dependencies.takeGithubSyncSignal?.() ?? false;
    if (pollAt > now && !signalled) return false;
  }
  if (rule.adoptFirst && isBlocked(ctx.state)) return false;
  if (rule.adoptFirst) {
    const adopted = await readOwner(ctx, rule.adoptFirst, dependencies);
    if (adopted.type === "owner.unavailable" || adopted.type === "owner.cancel") return false;
    const adoption = nextAdoptFirst(step, adopted);
    if (!adoption.continue) {
      for (const action of adoption.actions) {
        if (action.type === "runCommand" && !await runDriverCommand(ctx, action.params.command, step, adopted)) return false;
        if (action.type === "changeStep") await applyDirectStep(ctx, action.params, step, adopted);
        if (action.type === "wait") return false;
      }
      return true;
    }
  }
  const revision = ctx.state.revision;
  const event = await readOwner(ctx, rule.waitsOn, dependencies);
  if (githubWaiting && (ctx.state.step !== step || ctx.state.revision !== revision)) return true;
  const { actions } = nextStep(step, event);
  for (const action of actions) {
    switch (action.type) {
      case "runCommand": if (!await runDriverCommand(ctx, action.params.command, step, event)) return false; break;
      case "changeStep": await applyDirectStep(ctx, action.params, step, event); break;
      case "wait": return false;
      default: assertNever(action);
    }
  }
  return true;
}

export function driverPollDelay(state: IssueWorkflowState, now: number): number | undefined {
  const rule = STEP_TABLE[state.step];
  if (rule.terminal) return undefined;
  const transition = rule.on.live;
  if (!("wait" in transition) || transition.wait === "signal") return undefined;
  if (state.step === "releasing" && state.releaseRetryAt) return Math.max(1, Date.parse(state.releaseRetryAt) - now);
  if (state.step === "ci_waiting") return state.owner === "lead" && state.ciNextPollAt ? Math.max(1, Date.parse(state.ciNextPollAt) - now) : undefined;
  return transition.wait.pollMs;
}
