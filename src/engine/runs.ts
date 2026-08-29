import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "../config.js";
import type { ForgeDatabase } from "../database.js";
import { createActivities, createActivityCaller, type ActivityCaller } from "./activities.js";
import { CancelledFailure } from "./failures.js";
import { IssueWorkflowInputSchema, IssueWorkflowStateSchema, buildInitialIssueWorkflowState, type IssueWorkflowInput, type IssueWorkflowState } from "./issue-contracts.js";
import { issueWorkflow } from "./workflows.js";
import { runExecution, type Handler, type RunExecutionContext } from "./registry.js";
import { StructuredLogger } from "../logging.js";

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
    await Promise.race([
      clock.wait(milliseconds, combined),
      new Promise<void>((resolve) => {
        const waiter = () => { controller.abort(); resolve(); };
        this.waiters.add(waiter);
        combined.addEventListener("abort", () => this.waiters.delete(waiter), { once: true });
      }),
    ]);
  }
}
function isAutomaticCommand(workflowId: string, commandId: string): boolean {
  return commandId.startsWith(`${workflowId}:auto-`);
}

const AGENT_OWNED_PHASES: Record<string, true> = {
  planning: true, supplemental_review: true, plan_consolidation: true, development: true, reviewing_delivery: true, repair_required: true,
  releasing: true, merge_conflict_reviewing: true, merge_conflict_required: true, merge_conflict_resolving: true, ci_repair_planning: true,
  ci_repairing: true, final_review: true, delivery_ready: true,
};

function recoverInterruptedOperation(state: IssueWorkflowState, database: ForgeDatabase): IssueWorkflowState {
  if (!state.activeOperation || !AGENT_OWNED_PHASES[state.phase]) return state;
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
  if (state.phase === "development") return IssueWorkflowStateSchema.parse({ ...state, revision, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer execution was interrupted — retry is available", activeOperation: null, developerRecoveryStatus: "interrupted", developerRecoveryReasonCode: "execution_not_live", developerRecoverySummary: "Developer execution was interrupted.", lastEventId: `${state.workflowId}:${revision}` });
  if (state.phase === "repair_required" || (state.phase === "delivery_blocked" && state.developerTurnKind === "repair")) return IssueWorkflowStateSchema.parse({ ...state, revision, phase: "delivery_blocked", owner: "human", allowedCommands: ["repair_delivery", "retry_development", "cancel_issue"], pendingAction: "Developer repair was interrupted — retry is available", activeOperation: null, developerRecoveryStatus: "interrupted", developerRecoveryReasonCode: "execution_not_live", developerRecoverySummary: "Developer repair was interrupted.", lastEventId: `${state.workflowId}:${revision}` });
  if (state.phase === "merge_conflict_reviewing" || state.phase === "merge_conflict_resolving") return IssueWorkflowStateSchema.parse({ ...state, revision, phase: "merge_conflict_required", owner: "human", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution was interrupted — retry is available", activeOperation: null, developerRecoveryStatus: "interrupted", developerRecoveryReasonCode: "execution_not_live", developerRecoverySummary: "Developer conflict resolution was interrupted.", lastEventId: `${state.workflowId}:${revision}` });
  if (["planning", "supplemental_review", "plan_consolidation"].includes(state.phase)) return IssueWorkflowStateSchema.parse({ ...state, revision, phase: "planning", owner: "human", allowedCommands: ["start_planning", "cancel_issue"], pendingAction: "Planning was interrupted — retry is available", activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
  if (["reviewing_delivery", "delivery_ready", "final_review"].includes(state.phase)) return IssueWorkflowStateSchema.parse({ ...state, revision, phase: "delivery_ready", owner: "human", allowedCommands: ["review_delivery", "cancel_issue"], pendingAction: "Delivery review was interrupted — retry is available", activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
  if (["ci_repair_planning", "ci_repairing"].includes(state.phase)) return IssueWorkflowStateSchema.parse({ ...state, revision, phase: "ci_repair_required", owner: "human", allowedCommands: ["repair_ci", "reconcile_ci", "cancel_issue"], pendingAction: "CI repair was interrupted — retry is available", activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
  return IssueWorkflowStateSchema.parse({ ...state, revision, owner: "human", pendingAction: "Agent operation was interrupted — human action is required", activeOperation: null, lastEventId: `${state.workflowId}:${revision}` });
}


export class IssueRun {
  readonly runId = randomUUID();
  readonly controller = new AbortController();
  readonly wakeable = new Wakeable();
  readonly commands = new Map<string, Handler>();
  readonly queries = new Map<string, Handler>();
  private chain: Promise<unknown> = Promise.resolve();
  private workflowPromise?: Promise<IssueWorkflowState>;
  private loopError?: unknown;
  private initialState: IssueWorkflowState;
  private executionContext?: RunExecutionContext;
  private projectionTimes: number[] = [];
  private projectionSignatures: string[] = [];
  private runawayHalted = false;

  constructor(
    readonly input: IssueWorkflowInput,
    private readonly database: ForgeDatabase,
    private readonly caller: ActivityCaller,
    private readonly clock: EngineClock = realClock,
    private readonly logger = new StructuredLogger(),
  ) {
    // A continuation snapshot is a partial state: layer it over the initial state as the workflow always did.
    const initial = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState(input), activeOperation: null, processedCommandIds: [], ...(input.continuationState ?? {}) });
    this.initialState = recoverInterruptedOperation(initial, database);
    if (this.initialState !== initial) this.input.continuationState = this.initialState;
  }
  get workflowId(): string { return this.input.workflowId; }
  get state(): IssueWorkflowState {
    const query = this.queries.get("issueState");
    return IssueWorkflowStateSchema.parse(this.loopError ? this.initialState : query ? query() : this.initialState);
  }
  get error(): unknown { return this.loopError; }

  start(): void {
    if (this.workflowPromise) return;
    const context: RunExecutionContext = {
      workflowId: this.workflowId,
      runId: this.runId,
      signal: this.controller.signal,
      commands: this.commands,
      queries: this.queries,
      activity: (name: string, args: unknown[], options: Parameters<ActivityCaller["call"]>[2]) => {
        if (name === "projectIssueState") {
          const now = this.clock.now();
          this.projectionTimes = this.projectionTimes.filter((time) => now - time <= 10_000);
          this.projectionSignatures = this.projectionSignatures.slice(-this.projectionTimes.length);
          this.projectionTimes.push(now);
          const event = args[0] as { schemaVersion: number; runId: string; eventId: string; state: IssueWorkflowState };
          this.projectionSignatures.push(`${event.state.phase}\u0000${event.state.pendingAction}`);
          if (this.projectionTimes.length > 50 && !this.runawayHalted && new Set(this.projectionSignatures).size <= 2 && this.projectionSignatures.every((signature) => signature.startsWith("merge_conflict_required\u0000") || signature.startsWith("merge_conflict_resolving\u0000"))) {
            this.runawayHalted = true;
            const state = IssueWorkflowStateSchema.parse({ ...event.state, owner: "human", allowedCommands: [...new Set([...event.state.allowedCommands, "cancel_issue"])], pendingAction: "Runaway transition loop halted", lastHandlerError: { command: "workflow", reason: "Runaway transition loop halted", at: new Date(now).toISOString() } });
            this.initialState = state;
            this.logger.error("Runaway transition loop halted", { workflowId: this.workflowId, runId: this.runId });
            return this.caller.call(name, [{ ...event, eventId: state.lastEventId, state }], options, this.controller.signal, this.workflowId);
          }
        }
        if (this.runawayHalted && name !== "projectIssueState") throw new Error("Runaway transition loop halted");
        return this.caller.call(name, args, options, this.controller.signal, this.workflowId);
      },
      wait: (milliseconds: number) => this.wakeable.wait(milliseconds, this.controller.signal, this.clock),
      now: () => this.clock.now(),
      wake: () => this.wakeable.wake(),
      autoActionsHalted: () => this.runawayHalted,
    };
    this.executionContext = context;
    this.workflowPromise = runExecution.run(context, () => issueWorkflow(this.input));
    void this.workflowPromise.catch(async (error) => {
      if (this.controller.signal.aborted) return;
      this.loopError = error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Issue workflow run failed", { workflowId: this.workflowId }, { error: message, stack: error instanceof Error ? error.stack : undefined });
      const current = this.state;
      const now = new Date(this.clock.now()).toISOString();
      const state = IssueWorkflowStateSchema.parse({ ...current, revision: current.revision + 1, owner: "human", allowedCommands: [...new Set([...current.allowedCommands, "cancel_issue"])], pendingAction: message, lastHandlerError: { command: "workflow", reason: message, at: now }, stateChangedAt: now, lastEventId: `${current.workflowId}:${current.revision + 1}` });
      this.initialState = state;
      await this.caller.call("projectIssueState", [{ schemaVersion: 1, runId: this.runId, eventId: state.lastEventId, state }], { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 5, initialInterval: "1 second", maximumInterval: "15 seconds" } }, this.controller.signal, this.workflowId).catch((projectionError) => this.logger.error("Issue workflow failure projection failed", { workflowId: this.workflowId }, { error: projectionError instanceof Error ? projectionError.message : String(projectionError), stack: projectionError instanceof Error ? projectionError.stack : undefined }));
    });
  }

  async ready(): Promise<void> {
    this.start();
    for (let attempt = 0; attempt < 100 && !this.queries.has("issueState"); attempt += 1) await Promise.resolve();
    if (!this.queries.has("issueState")) throw this.loopError ?? new Error(`Issue run ${this.workflowId} did not register its state query`);
  }

  execute(name: string, input: unknown, commandId = "legacy-command"): Promise<IssueWorkflowState> {
    const operation = this.chain.then(async () => {
      await this.ready();
      const automatic = isAutomaticCommand(this.workflowId, commandId);
      if (this.runawayHalted && !automatic && commandId !== "legacy-command") {
        this.runawayHalted = false;
        this.projectionTimes = [];
        this.projectionSignatures = [];
      }
      if (commandId !== "legacy-command") {
        const stored = this.database.authQuery((db) => db.prepare("SELECT result_json FROM forge_engine_commands WHERE command_id = ? AND workflow_id = ?").get(commandId, this.workflowId) as { result_json: string } | undefined);
        if (stored) return IssueWorkflowStateSchema.parse(JSON.parse(stored.result_json));
      }
      const handler = this.commands.get(name);
      if (!handler) throw new Error(`Unknown issue command: ${name}`);
      const result = IssueWorkflowStateSchema.parse(await runExecution.run(this.executionContext!, () => handler(input as never)));
      if (commandId !== "legacy-command") this.database.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_engine_commands (command_id, workflow_id, command, result_json, created_at) VALUES (?, ?, ?, ?, ?)").run(commandId, this.workflowId, name, JSON.stringify(result), new Date(this.clock.now()).toISOString()));
      this.initialState = result;
      this.wakeable.wake();
      return result;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  async signal(name: string, ...args: unknown[]): Promise<void> {
    await this.ready();
    if (this.runawayHalted) return;
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
    this.caller = createActivityCaller(database, activities, options.clock?.wait);
    this.clock = options.clock ?? realClock;
  }
  private readonly clock: EngineClock;

  async create(input: IssueWorkflowInput): Promise<IssueRun> {
    const validated = IssueWorkflowInputSchema.parse(input);
    if (this.runs.has(validated.workflowId)) throw new Error(`Issue run already exists: ${validated.workflowId}`);
    const run = new IssueRun(validated, this.database, this.caller, this.clock);
    this.runs.set(validated.workflowId, run);
    await run.ready();
    return run;
  }

  run(workflowId: string): IssueRun {
    const run = this.runs.get(workflowId);
    if (!run) throw new Error(`Issue run not loaded: ${workflowId}`);
    return run;
  }

  dispose(): void { for (const run of this.runs.values()) run.dispose(); this.runs.clear(); }
}
