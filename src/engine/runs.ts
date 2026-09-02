import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "../config.js";
import { ProjectionPersistenceFailure, projectionStateHash, type ForgeDatabase } from "../database.js";
import { resolveAgentProfiles } from "../projects.js";
import { jsonRequired } from "../task-utils.js";
import { createActivities, createActivityCaller, type ActivityCaller } from "./activities.js";
import { CancelledFailure, isCancellation } from "./failures.js";
import { IssueWorkflowInputSchema, IssueWorkflowStateSchema, buildInitialIssueWorkflowState, type IssueProjectionEvent, type IssueWorkflowInput, type IssueWorkflowState } from "./issue-contracts.js";
import { issueWorkflow } from "./workflows.js";
import { withWorktreeCommands } from "./workflow/state-transitions.js";
import { runExecution, type Handler, type InterruptHandler, type RunExecutionContext } from "./registry.js";
import { StructuredLogger } from "../logging.js";
import { clearAutomaticChainHalt } from "./workflow/runtime.js";
import { at } from "../issue-phases.js";
import { evidencePointer, humanBlocker } from "./workflow/state-transitions.js";

export interface EngineClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const realClock: EngineClock = {
  now: Date.now,
  wait: async (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new CancelledFailure()); }, { once: true });
  }),
};

export class Wakeable {
  private waiters = new Set<() => void>();
  wake(): void { for (const waiter of this.waiters) waiter(); this.waiters.clear(); }
  async wait(milliseconds: number, signal: AbortSignal, clock: EngineClock): Promise<void> {
    if (signal.aborted) throw new CancelledFailure();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let woken = false;
    try {
      await Promise.race([
        clock.wait(milliseconds, combined),
        new Promise<void>((resolve) => {
          const waiter = () => { woken = true; controller.abort(); resolve(); };
          this.waiters.add(waiter);
          combined.addEventListener("abort", () => this.waiters.delete(waiter), { once: true });
        }),
      ]);
    } catch (error) {
      if (!woken || signal.aborted) throw error;
    } finally {
      controller.abort();
    }
    if (signal.aborted) throw new CancelledFailure();
  }
}
function isAutomaticCommand(workflowId: string, commandId: string): boolean {
  return commandId.startsWith(`${workflowId}:auto-`);
}
type DeferredProjection = { event: IssueProjectionEvent; options: Parameters<ActivityCaller["call"]>[2] };
type InterruptOutcome = { accepted: boolean; result: unknown; deferredProjections?: DeferredProjection[] };
type CommandExecutionContext = RunExecutionContext & { deferredProjections?: DeferredProjection[] | undefined; durableProjection?: IssueProjectionEvent | undefined; projectionExpected?: boolean | undefined; interruptDispatch?: boolean | undefined };

const DUPLICATE_PROJECTION_WINDOW_MS = 10_000;
const DUPLICATE_PROJECTION_LIMIT = 20;

export class ProjectionBurstGuard {
  private readonly timestampsByState = new Map<string, number[]>();
  private readonly loggedSkips = new Set<string>();

  shouldSkip(state: IssueWorkflowState, now: number): boolean {
    const key = JSON.stringify([state.phase, state.step, state.owner, state.pendingAction, state.blocker]);
    const timestamps = (this.timestampsByState.get(key) ?? []).filter((timestamp) => now - timestamp <= DUPLICATE_PROJECTION_WINDOW_MS);
    timestamps.push(now);
    this.timestampsByState.set(key, timestamps);
    return timestamps.length > DUPLICATE_PROJECTION_LIMIT;
  }

  shouldLogSkip(state: IssueWorkflowState): boolean {
    const key = JSON.stringify([state.workflowId, state.step, state.phase]);
    if (this.loggedSkips.has(key)) return false;
    this.loggedSkips.add(key);
    return true;
  }
}

const AGENT_OWNED_STEPS: Partial<Record<IssueWorkflowState["step"], true>> = {
  planning: true, supplemental_review: true, plan_consolidation: true, development: true, reviewing_delivery: true, repair_required: true,
  releasing: true, merge_conflict_reviewing: true, merge_conflict_resolving: true, ci_repair_planning: true,
  ci_repairing: true, final_review: true, delivery_ready: true,
};

export function issueRunInputFromSnapshotRow(db: Parameters<typeof resolveAgentProfiles>[0], row: Record<string, unknown>, state: IssueWorkflowState): IssueWorkflowInput {
  const actor = (db.prepare("SELECT actor_user_id FROM forge_audit_events WHERE action = 'task_created' AND json_extract(metadata_json, '$.taskId') = ? ORDER BY created_at LIMIT 1").get(state.issueId) as { actor_user_id: string | null } | undefined)?.actor_user_id;
  const repository = (db.prepare("SELECT repository_identity AS repository FROM forge_projects WHERE id = ? AND company_id = ?").get(state.projectId, state.companyId) as { repository: string | null } | undefined)?.repository ?? undefined;
  return IssueWorkflowInputSchema.parse({
    workflowId: state.workflowId, companyId: state.companyId, projectId: state.projectId, issueId: state.issueId, projectRevisionId: state.projectRevisionId,
    briefArtifactId: row.brief_artifact_id, imageArtifactIds: jsonRequired(String(row.image_artifact_ids_json)), roleProfiles: resolveAgentProfiles(db, jsonRequired(String(row.role_agents_json))),
    supplementalReview: Boolean(row.supplemental_review), requestHash: row.request_hash ?? undefined, predecessorTaskId: row.predecessor_task_id ?? undefined,
    autoApprovePlan: Boolean(row.auto_approve_plan), autoApprovePlanActorUserId: row.auto_approve_plan && actor ? actor : undefined, pullRequestMode: row.pull_request_mode ?? undefined, deliveryTarget: row.delivery_target ?? undefined,
    autoMergeActorUserId: row.delivery_target === "merged" && actor ? actor : undefined,
    runProjectTests: Boolean(row.run_project_tests), visualEvidence: row.visual_evidence ?? undefined, repository, continuationState: state,
  });
}

function recoverInterruptedOperation(state: IssueWorkflowState, database: ForgeDatabase): IssueWorkflowState {
  // CI reconciliation can enter its agent-owned repair phases from the workflow
  // loop rather than a user command. Those turns therefore have no
  // `activeOperation` to recover, even though an interrupted planner or repair
  // must still be made actionable after a worker restart.
  const ciRepairStep = state.step === "ci_repair_planning" || state.step === "ci_repairing";
  if ((!state.activeOperation && !ciRepairStep) || !AGENT_OWNED_STEPS[state.step]) return state;
  const live = database.authQuery((db) => Boolean(db.prepare(`
    SELECT 1 FROM forge_developer_executions execution
    JOIN forge_herdr_turns turn ON turn.ledger = 'developer' AND turn.execution_id = execution.id AND turn.task_id = execution.task_id
    JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.task_id = execution.task_id
    WHERE execution.task_id = ? AND execution.company_id = ? AND execution.workflow_id = ?
      AND execution.status IN ('starting', 'running')
      AND session.is_current = 1 AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human')
    UNION ALL
    SELECT 1 FROM forge_agent_executions execution
    JOIN forge_herdr_turns turn ON turn.ledger = 'agent' AND turn.execution_id = execution.id AND turn.task_id = execution.task_id
    JOIN forge_herdr_role_sessions session ON session.id = turn.role_session_id AND session.task_id = execution.task_id
    WHERE execution.task_id = ? AND execution.company_id = ? AND execution.workflow_id = ?
      AND execution.status IN ('starting', 'running')
      AND session.is_current = 1 AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human')
    LIMIT 1`).get(state.issueId, state.companyId, state.workflowId, state.issueId, state.companyId, state.workflowId)));
  if (live) return state;
  const revision = state.revision + 1;
  // Keep these projections aligned with the non-completed paths in the handlers.
  // A resumed run has no suspended handler to perform that transition itself.
  const blocker = (summary: string, actions: IssueWorkflowState["allowedCommands"], evidence = evidencePointer(state.leadOutputArtifactId ?? undefined, "lead-plan")) => humanBlocker("agent_exhausted", summary, actions.map((command) => ({ command, label: command.replaceAll("_", " "), requiresNote: false, destructive: command === "cancel_issue" })), evidence);
  if (state.step === "development") return IssueWorkflowStateSchema.parse({ ...state, ...at("development"), revision, owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer execution was interrupted — retry is available", blocker: blocker("Developer execution was interrupted.", ["retry_development", "cancel_issue"]), activeOperation: null, developerRecoveryStatus: "interrupted", developerRecoveryReasonCode: "execution_not_live", developerRecoverySummary: "Developer execution was interrupted.", lastEventId: `${state.workflowId}:${revision}` });
  if (state.step === "repair_required") return IssueWorkflowStateSchema.parse({ ...state, ...at("repair_required"), revision, owner: "human", allowedCommands: ["repair_delivery", "retry_development", "cancel_issue"], pendingAction: "Developer repair was interrupted — retry is available", blocker: blocker("Developer repair was interrupted.", ["repair_delivery", "retry_development", "cancel_issue"]), activeOperation: null, developerRecoveryStatus: "interrupted", developerRecoveryReasonCode: "execution_not_live", developerRecoverySummary: "Developer repair was interrupted.", lastEventId: `${state.workflowId}:${revision}` });
  if (state.step === "merge_conflict_reviewing" || state.step === "merge_conflict_resolving") return IssueWorkflowStateSchema.parse({ ...state, ...at("merge_conflict_resolving"), revision, owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution was interrupted — retry is available", blocker: blocker("Developer conflict resolution was interrupted.", ["resolve_merge_conflict", "cancel_issue"], evidencePointer(state.forwardMergeConflictArtifact?.id, "merge-conflict-plan")), activeOperation: null, developerRecoveryStatus: "interrupted", developerRecoveryReasonCode: "execution_not_live", developerRecoverySummary: "Developer conflict resolution was interrupted.", lastEventId: `${state.workflowId}:${revision}` });
  if (["planning", "supplemental_review", "plan_consolidation"].includes(state.step)) return IssueWorkflowStateSchema.parse({ ...state, ...at("planning"), revision, owner: "human", allowedCommands: ["start_planning", "cancel_issue"], pendingAction: "Planning was interrupted — retry is available", blocker: blocker("Planning was interrupted.", ["start_planning", "cancel_issue"]), activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
  if (["reviewing_delivery", "delivery_ready", "final_review"].includes(state.step)) return IssueWorkflowStateSchema.parse({ ...state, ...at("delivery_ready"), revision, owner: "human", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Delivery review was interrupted — retry is available", blocker: blocker("Delivery review was interrupted.", ["review_delivery", "cancel_issue"]), activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
  if (["ci_repair_planning", "ci_repairing"].includes(state.step)) return IssueWorkflowStateSchema.parse({ ...state, ...at("ci_waiting"), revision, owner: "human", allowedCommands: ["repair_ci", "reconcile_ci", "cancel_issue"], pendingAction: "CI repair was interrupted — retry is available", blocker: blocker("CI repair was interrupted.", ["repair_ci", "reconcile_ci", "cancel_issue"], evidencePointer(state.ciEvidenceArtifactId ?? undefined, "ci-evidence")), activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
  return IssueWorkflowStateSchema.parse({ ...state, revision, owner: "human", pendingAction: "Agent operation was interrupted — human action is required", blocker: blocker("Agent operation was interrupted.", ["cancel_issue"]), activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
}


export class IssueRun {
  readonly runId = randomUUID();
  readonly controller = new AbortController();
  readonly wakeable = new Wakeable();
  readonly commands = new Map<string, Handler>();
  readonly queries = new Map<string, Handler>();
  readonly interrupts = new Map<string, InterruptHandler>();
  private chain: Promise<unknown> = Promise.resolve();
  private workflowPromise?: Promise<IssueWorkflowState>;
  private loopError?: unknown;
  private failureProjection?: Promise<void>;
  private restarting?: Promise<IssueRun>;
  private initialState: IssueWorkflowState;
  private executionContext?: RunExecutionContext;
  private activeCommand: { name: string; controller: AbortController; deferredProjections: DeferredProjection[]; context: CommandExecutionContext; settled: Promise<void> } | undefined;
  private activeEffect: AbortController | undefined;
  private interruptPending = false;
  private interruptBarrier: Promise<void> | undefined;
  private releaseInterrupt: (() => void) | undefined;
  private interrupting = new Map<string, Promise<InterruptOutcome>>();
  private readonly projectionBurstGuard = new ProjectionBurstGuard();

  constructor(
    readonly input: IssueWorkflowInput,
    private readonly database: ForgeDatabase,
    private readonly caller: ActivityCaller,
    private readonly clock: EngineClock = realClock,
    private readonly logger = new StructuredLogger(),
    private readonly invalidate?: (run: IssueRun) => void,
    private readonly restart?: () => Promise<IssueRun>,
  ) {
    // A continuation snapshot is a partial state: layer it over the initial state as the workflow always did.
    const initial = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState(input), activeOperation: null, processedCommandIds: [], ...(input.continuationState ?? {}) });
    const recovered = recoverInterruptedOperation(initial, database);
    let durable = recovered;
    if (input.continuationState) {
      durable = withWorktreeCommands(durable);
      const revision = initial.revision + 1;
      durable = IssueWorkflowStateSchema.parse({ ...durable, revision, lastEventId: `${durable.workflowId}:${revision}`, continuationCount: initial.continuationCount + 1 });
      database.projectIssueEvent({ schemaVersion: 1, runId: this.runId, eventId: durable.lastEventId, state: durable });
      this.input.continuationState = IssueWorkflowStateSchema.parse({ ...durable, continuationCount: durable.continuationCount - 1 });
    } else if (durable !== initial) {
      database.projectIssueEvent({ schemaVersion: 1, runId: this.runId, eventId: durable.lastEventId, state: durable });
      this.input.continuationState = durable;
    }
    this.initialState = durable;
  }
  get workflowId(): string { return this.input.workflowId; }
  get state(): IssueWorkflowState {
    if (this.loopError) return this.initialState;
    const query = this.queries.get("issueState");
    const live = IssueWorkflowStateSchema.parse(query ? query() : this.initialState);
    return this.initialState.revision >= live.revision ? this.initialState : live;
  }
  get error(): unknown { return this.loopError; }

  start(): void {
    if (this.workflowPromise) return;
    let durableProjection: IssueProjectionEvent | undefined;
    try { durableProjection = this.loadCommandAuthority(); } catch { /* A new workflow establishes authority through its initial projection. */ }
    const context: RunExecutionContext = {
      workflowId: this.workflowId,
      runId: this.runId,
      signal: this.controller.signal,
      commands: this.commands,
      queries: this.queries,
      interrupts: this.interrupts,
      acceptedInterrupt: undefined,
      interruptResult: undefined,
      activity: async (name: string, args: unknown[], options: Parameters<ActivityCaller["call"]>[2]) => {
        const execution = runExecution.current() as CommandExecutionContext;
        await this.waitForActiveCommand(execution);
        if (this.interruptPending && !execution.interruptDispatch && !execution.acceptedInterrupt) throw new CancelledFailure();
        if (name === "projectIssueState") {
          const event = args[0] as IssueProjectionEvent;
          if (this.projectionBurstGuard.shouldSkip(event.state, this.clock.now())) {
            if (this.projectionBurstGuard.shouldLogSkip(event.state)) this.logger.warn("Issue run skipped duplicate projections", { workflowId: this.workflowId }, { step: event.state.step, phase: event.state.phase, revision: event.state.revision });
            return event.state;
          }
          if (execution.deferredProjections) {
            execution.projectionExpected = true;
            execution.deferredProjections.push({ event, options });
            return event.state;
          }
          const projected = await this.caller.call(name, [event], options, execution.signal, this.workflowId);
          this.database.projectIssueEvents([event]);
          if (event.state.revision >= this.initialState.revision) this.initialState = event.state;
          this.updateCommandAuthority(execution, event);
          return projected;
        }
        if (execution.deferredProjections) await this.flushCommandProjections(execution);
        const effect = new AbortController();
        this.activeEffect = effect;
        try {
          const result = await this.caller.call(name, args, options, AbortSignal.any([execution.signal, effect.signal]), this.workflowId, async () => {
            await this.waitForActiveCommand(execution);
          });
          await this.waitForActiveCommand(execution);
          return result;
        } finally {
          if (this.activeEffect === effect) this.activeEffect = undefined;
        }
      },
      wait: async (milliseconds: number) => {
        const execution = runExecution.current() as CommandExecutionContext;
        await this.waitForActiveCommand(execution);
        if (this.interruptPending && !execution.interruptDispatch && !execution.acceptedInterrupt) { await this.interruptBarrier; return; }
        if (execution.deferredProjections) await this.flushCommandProjections(execution);
        const effect = new AbortController();
        this.activeEffect = effect;
        try {
          try {
            await this.wakeable.wait(milliseconds, AbortSignal.any([execution.signal, effect.signal]), this.clock);
          } catch (error) {
            if (!this.interruptPending || execution.interruptDispatch || execution.acceptedInterrupt) throw error;
            await this.interruptBarrier;
            return;
          }
          await this.waitForActiveCommand(execution);
        } finally {
          if (this.activeEffect === effect) this.activeEffect = undefined;
        }
      },
      now: () => this.clock.now(),
      wake: () => this.wakeable.wake(),
      autoActionsHalted: () => false,
    };
    if (durableProjection) (context as CommandExecutionContext).durableProjection = durableProjection;
    this.executionContext = context;
    this.workflowPromise = runExecution.run(context, () => issueWorkflow(this.input));
    void this.workflowPromise.catch(async (error) => {
      if (this.controller.signal.aborted || isCancellation(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      const current = IssueWorkflowStateSchema.parse(this.queries.get("issueState")?.() ?? this.initialState);
      const now = new Date(this.clock.now()).toISOString();
      const state = IssueWorkflowStateSchema.parse({ ...current, owner: "human", lastHandlerError: { command: "workflow", reason: message.slice(0, 200), at: now } });
      this.loopError = error;
      this.initialState = state;
      this.logger.error("Issue workflow run failed", { workflowId: this.workflowId }, { error: message, stack: error instanceof Error ? error.stack : undefined });
      this.failureProjection = this.caller.call("projectIssueState", [{ schemaVersion: 1, runId: this.runId, eventId: state.lastEventId, state }], { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "15 seconds" } }, this.controller.signal, this.workflowId)
        .then(() => {
          this.database.authTransaction((db) => db.prepare("UPDATE forge_workflow_snapshots SET state_json = ?, updated_at = ? WHERE task_id = ? AND revision = ?").run(JSON.stringify(state), now, state.issueId, state.revision));
        })
        .catch((projectionError) => this.logger.error("Issue workflow failure projection failed", { workflowId: this.workflowId }, { error: projectionError instanceof Error ? projectionError.message : String(projectionError), stack: projectionError instanceof Error ? projectionError.stack : undefined }));
    });
  }

  private async restartAfterLoopFailure(name: string, input: unknown, commandId: string): Promise<IssueWorkflowState> {
    await this.failureProjection;
    if (!this.loopError || !this.restart) throw this.loopError;
    this.logger.error("Restarting failed issue workflow", { workflowId: this.workflowId }, { error: this.loopError instanceof Error ? this.loopError.message : String(this.loopError) });
    this.dispose();
    const run = await (this.restarting ??= this.restart());
    return run.execute(name, input, commandId);
  }

  async ready(): Promise<void> {
    this.start();
    for (let attempt = 0; attempt < 100 && !this.queries.has("issueState"); attempt += 1) await Promise.resolve();
    if (!this.queries.has("issueState")) throw this.loopError ?? new Error(`Issue run ${this.workflowId} did not register its state query`);
  }

  private async waitForActiveCommand(context: CommandExecutionContext): Promise<void> {
    while (this.activeCommand && this.activeCommand.context !== context && !context.interruptDispatch) {
      await this.activeCommand.settled;
    }
    if (context.signal.aborted) throw new CancelledFailure();
    if (this.loopError) throw this.loopError;
  }

  private coalesceCommandProjections(projections: DeferredProjection[]): DeferredProjection[] {
    const pending: DeferredProjection[] = [];
    for (const projection of projections) {
      const prior = pending.find((candidate) => candidate.event.eventId === projection.event.eventId && candidate.event.state.revision === projection.event.state.revision);
      if (!prior) {
        pending.push(projection);
      } else if (prior.event.runId !== projection.event.runId || projectionStateHash(prior.event.state) !== projectionStateHash(projection.event.state)) {
        throw new ProjectionPersistenceFailure("conflict", "Command emitted conflicting projections for one immutable event revision");
      }
    }
    pending.sort((left, right) => left.event.state.revision - right.event.state.revision);
    return pending;
  }
  private loadCommandAuthority(): IssueProjectionEvent {
    const row = this.database.authQuery((db) => db.prepare("SELECT p.last_run_id AS runId, s.state_json AS stateJson FROM forge_issue_projections p JOIN forge_workflow_snapshots s ON s.task_id = p.task_id AND s.revision = p.revision WHERE p.workflow_id = ?").get(this.workflowId) as { runId: string | null; stateJson: string } | undefined);
    let stored: unknown;
    try { stored = row ? jsonRequired(row.stateJson) : undefined; } catch { stored = undefined; }
    const state = IssueWorkflowStateSchema.safeParse(stored);
    if (!row?.runId || !state.success) throw new ProjectionPersistenceFailure("not-durable", "Issue command has no readable durable projection authority");
    return { schemaVersion: 1, runId: row.runId, eventId: state.data.lastEventId, state: state.data };
  }

  private updateCommandAuthority(context: CommandExecutionContext, event: IssueProjectionEvent): void {
    context.durableProjection = event;
    const base = this.executionContext as CommandExecutionContext | undefined;
    if (base && base !== context) base.durableProjection = event;
  }

  private async replayDurableProjections(projections: DeferredProjection[], context: CommandExecutionContext): Promise<void> {
    for (const projection of projections) {
      try {
        const options = { ...projection.options, retry: { ...projection.options.retry, maximumAttempts: 1 } };
        await this.caller.call("projectIssueState", [projection.event], options, context.signal, this.workflowId);
      } catch (error) {
        this.logger.warn("Durable projection activity replay failed", { workflowId: this.workflowId, runId: this.runId }, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async flushCommandProjections(context: CommandExecutionContext): Promise<void> {
    const deferred = context.deferredProjections;
    if (!deferred?.length) return;
    const pending = this.coalesceCommandProjections(deferred);
    if (pending.length > 0) {
      try {
        this.database.projectIssueEvents(pending.map((projection) => projection.event));
      } catch (error) {
        this.failClosedToDurable(error);
        throw error;
      }
      const latest = pending.at(-1)!.event;
      if (latest.state.revision >= this.initialState.revision) this.initialState = latest.state;
      this.updateCommandAuthority(context, latest);
    }
    deferred.splice(0);
    await this.replayDurableProjections(pending, context);
  }

  private failClosedToDurable(error: unknown): void {
    const row = this.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1").get(this.workflowId) as { state_json: string } | undefined);
    if (row) {
      try { this.initialState = IssueWorkflowStateSchema.parse(jsonRequired(row.state_json)); } catch { /* Preserve the last known in-memory fallback if durable state is unreadable. */ }
    }
    this.loopError = error;
    this.finishInterrupt();
    this.controller.abort(error);
    this.invalidate?.(this);
  }
  private finishInterrupt(): void {
    this.interruptPending = false;
    this.releaseInterrupt?.();
    this.interruptBarrier = undefined;
    this.releaseInterrupt = undefined;
  }


  private async runInterrupt(name: string, input: unknown): Promise<InterruptOutcome> {
    await this.ready();
    const interrupt = this.interrupts.get(name);
    if (!interrupt) return { accepted: false, result: undefined };
    const accepted = interrupt.validate ? runExecution.run(this.executionContext!, () => interrupt.validate!(input as never)) : undefined;
    if (accepted === false) return { accepted: false, result: undefined };
    const active = this.activeCommand;
    if (interrupt.cancelActive && active) await this.flushCommandProjections(active.context);
    const deferredProjections = interrupt.cancelActive ? active?.deferredProjections : undefined;
    if (interrupt.cancelActive) {
      if (!this.interruptPending) this.interruptBarrier = new Promise<void>((resolve) => { this.releaseInterrupt = resolve; });
      this.interruptPending = true;
      this.activeCommand?.controller.abort();
      this.activeEffect?.abort();
    }
    const interruptContext: CommandExecutionContext = { ...this.executionContext!, interruptDispatch: true };
    try {
      const result = interrupt.run ? await runExecution.run(interruptContext, () => interrupt.run!(input as never)) : undefined;
      return { accepted: true, result, ...(deferredProjections ? { deferredProjections } : {}) };
    } catch (error) {
      if (interrupt.cancelActive) this.finishInterrupt();
      throw error;
    }
  }

  execute(name: string, input: unknown, commandId = "legacy-command"): Promise<IssueWorkflowState> {
    if (commandId !== "legacy-command") {
      const stored = this.database.authQuery((db) => db.prepare("SELECT workflow_id, command, result_json FROM forge_engine_commands WHERE command_id = ?").get(commandId) as { workflow_id: string; command: string; result_json: string } | undefined);
      if (stored && (stored.workflow_id !== this.workflowId || stored.command !== name)) throw new ProjectionPersistenceFailure("conflict", "Issue command identity already belongs to another workflow or command");
      if (stored) return Promise.resolve(IssueWorkflowStateSchema.parse(jsonRequired(stored.result_json)));
    }
    if (this.loopError) return this.restartAfterLoopFailure(name, input, commandId);
    this.start();
    const registeredInterrupt = this.interrupts.get(name);
    const coalesceKey = registeredInterrupt?.coalesceKey?.(input);
    const interruptKey = coalesceKey ?? (registeredInterrupt && commandId !== "legacy-command" ? `command\u0000${commandId}` : undefined);
    let interrupt = interruptKey ? this.interrupting.get(interruptKey) : undefined;
    if (registeredInterrupt && !interrupt) {
      interrupt = this.runInterrupt(name, input);
      if (interruptKey) this.interrupting.set(interruptKey, interrupt);
    }
    const acceptedInterrupt = interrupt;
    const operation = this.chain.then(async () => {
      const interruptOutcome = acceptedInterrupt ? await acceptedInterrupt : undefined;
      await this.ready();
      if (this.loopError) throw this.loopError;
      const automatic = isAutomaticCommand(this.workflowId, commandId);
      if (commandId !== "legacy-command") {
        if (this.loopError) throw this.loopError;
        const stored = this.database.authQuery((db) => db.prepare("SELECT workflow_id, command, result_json FROM forge_engine_commands WHERE command_id = ?").get(commandId) as { workflow_id: string; command: string; result_json: string } | undefined);
        if (stored && (stored.workflow_id !== this.workflowId || stored.command !== name)) throw new ProjectionPersistenceFailure("conflict", "Issue command identity already belongs to another workflow or command");
        if (stored) return IssueWorkflowStateSchema.parse(jsonRequired(stored.result_json));
      }
      const handler = this.commands.get(name);
      if (!handler) throw new Error(`Unknown issue command: ${name}`);
      const controller = new AbortController();
      let finishCommand!: () => void;
      const settled = new Promise<void>((resolve) => { finishCommand = resolve; });
      const deferredProjections: DeferredProjection[] = commandId === "legacy-command" ? [] : [...(interruptOutcome?.deferredProjections ?? [])];
      let durableProjection: IssueProjectionEvent | undefined;
      if (commandId !== "legacy-command") {
        try { durableProjection = this.loadCommandAuthority(); }
        catch (error) { this.failClosedToDurable(error); throw error; }
      }
      const context: CommandExecutionContext = { ...this.executionContext!, signal: AbortSignal.any([this.controller.signal, controller.signal]), acceptedInterrupt: interruptOutcome?.accepted ? name : undefined, interruptResult: interruptOutcome?.result, ...(commandId === "legacy-command" ? {} : { deferredProjections, ...(durableProjection ? { durableProjection } : {}), projectionExpected: deferredProjections.length > 0 }) };
      this.activeCommand = { name, controller, deferredProjections, context, settled };
      try {
        let result = IssueWorkflowStateSchema.parse(await runExecution.run(context, () => handler(input as never)));
        if (this.loopError) throw this.loopError;
        if (commandId !== "legacy-command") {
          const liveState = this.state;
          if (liveState.revision >= result.revision) result = liveState;
          const committedProjections = this.coalesceCommandProjections(deferredProjections);
          const projectedResult = committedProjections.at(-1)?.event.state;
          if (projectedResult && projectedResult.revision >= result.revision) {
            if (projectedResult.workflowId !== result.workflowId || projectedResult.issueId !== result.issueId) {
              throw new ProjectionPersistenceFailure("identity-mismatch", "Command projection result identity does not match its handler result");
            }
            result = projectedResult;
          }
          try {
            result = this.database.commitIssueCommand({ commandId, workflowId: this.workflowId, runId: this.runId, command: name, result, events: committedProjections.map((projection) => projection.event), createdAt: new Date(this.clock.now()).toISOString() });
          } catch (error) {
            this.failClosedToDurable(error);
            throw error;
          }
          if (context.projectionExpected) {
            const authority = committedProjections.at(-1)?.event ?? context.durableProjection;
            if (authority) this.updateCommandAuthority(context, authority);
          }
          await this.replayDurableProjections(committedProjections, context);
        }
        if (context.acceptedInterrupt) this.finishInterrupt();
        this.initialState = result;
        this.wakeable.wake();
        return result;
      } finally {
        if (this.activeCommand?.controller === controller) this.activeCommand = undefined;
        if (!automatic && commandId !== "legacy-command") clearAutomaticChainHalt(this.workflowId);
        finishCommand();
      }
    });
    if (interruptKey) {
      const clear = () => { if (this.interrupting.get(interruptKey) === acceptedInterrupt) this.interrupting.delete(interruptKey); };
      void operation.then(clear, clear);
    }
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  async signal(name: string, ...args: unknown[]): Promise<void> {
    await this.ready();
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`Unknown issue signal: ${name}`);
    await runExecution.run(this.executionContext!, () => handler(...args as never[]));
    this.wakeable.wake();
  }

  dispose(): void { this.controller.abort(); this.wakeable.wake(); }
}

export class IssueEngine {
  readonly runs = new Map<string, IssueRun>();
  readonly database: ForgeDatabase;
  private readonly caller: ActivityCaller;

  constructor(readonly config: ForgeConfig, database: ForgeDatabase, options: { activities?: object; clock?: EngineClock } = {}) {
    this.database = database;
    const activities = options.activities ?? createActivities(database, config);
    this.caller = createActivityCaller(database, activities, options.clock ? options.clock.wait.bind(options.clock) : undefined);
    this.clock = options.clock ?? realClock;
  }
  private readonly clock: EngineClock;

  private invalidateRun(run: IssueRun): void {
    if (this.runs.get(run.workflowId) === run) this.runs.delete(run.workflowId);
  }

  async create(input: IssueWorkflowInput): Promise<IssueRun> {
    const validated = IssueWorkflowInputSchema.parse(input);
    if (this.runs.has(validated.workflowId)) throw new Error(`Issue run already exists: ${validated.workflowId}`);
    const run = new IssueRun(validated, this.database, this.caller, this.clock, undefined, (failed) => this.invalidateRun(failed), () => createRunFromLatestSnapshot(this, validated.workflowId));
    this.runs.set(validated.workflowId, run);
    await run.ready();
    return run;
  }

  run(workflowId: string): IssueRun {
    const existing = this.runs.get(workflowId);
    if (existing) return existing;
    const input = this.database.authQuery((db) => {
      const row = db.prepare(`SELECT s.task_id, s.state_json, t.brief_artifact_id, t.image_artifact_ids_json, t.role_agents_json, t.supplemental_review, t.request_hash, t.predecessor_task_id, t.auto_approve_plan, t.pull_request_mode, t.delivery_target, t.run_project_tests, t.visual_evidence FROM forge_workflow_snapshots s JOIN forge_tasks t ON t.id = s.task_id WHERE s.workflow_id = ? ORDER BY s.revision DESC LIMIT 1`).get(workflowId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Issue run not loaded: ${workflowId}`);
      const state = IssueWorkflowStateSchema.parse(jsonRequired(String(row.state_json)));
      return issueRunInputFromSnapshotRow(db, row, state);
    });
    const projectionExists = this.database.authQuery((db) => Boolean(db.prepare("SELECT 1 FROM forge_issue_projections WHERE workflow_id = ?").get(workflowId)));
    if (!projectionExists && input.continuationState) {
      const state = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState(input), ...(input.continuationState ?? {}) });
      if (state.revision !== 0) throw new ProjectionPersistenceFailure("not-durable", "Issue continuation has no exact persisted projection authority");
      this.database.bootstrapIssueProjection({ schemaVersion: 1, runId: `${workflowId}:snapshot-bootstrap`, eventId: state.lastEventId, state });
    }
    const run = new IssueRun(input, this.database, this.caller, this.clock, undefined, (failed) => this.invalidateRun(failed), () => createRunFromLatestSnapshot(this, workflowId));
    this.runs.set(workflowId, run);
    run.start();
    return run;
  }

  dispose(): void { for (const run of this.runs.values()) run.dispose(); this.runs.clear(); }
}

export async function createRunFromLatestSnapshot(engine: IssueEngine, workflowId: string): Promise<IssueRun> {
  const current = engine.runs.get(workflowId);
  current?.dispose();
  engine.runs.delete(workflowId);
  const input = engine.database.authQuery((db) => {
    const row = db.prepare(`SELECT s.task_id, s.state_json, t.brief_artifact_id, t.image_artifact_ids_json, t.role_agents_json, t.supplemental_review, t.request_hash, t.predecessor_task_id, t.auto_approve_plan, t.pull_request_mode, t.delivery_target, t.run_project_tests, t.visual_evidence FROM forge_workflow_snapshots s JOIN forge_tasks t ON t.id = s.task_id WHERE s.workflow_id = ? ORDER BY s.revision DESC LIMIT 1`).get(workflowId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Issue run snapshot is missing: ${workflowId}`);
    const state = IssueWorkflowStateSchema.parse(jsonRequired(String(row.state_json)));
    return issueRunInputFromSnapshotRow(db, row, state);
  });
  return engine.create(input);
}
