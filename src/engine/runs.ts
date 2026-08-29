import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "../config.js";
import type { ForgeDatabase } from "../database.js";
import { createActivities, createActivityCaller, type ActivityCaller } from "./activities.js";
import { CancelledFailure } from "./failures.js";
import { IssueWorkflowInputSchema, IssueWorkflowStateSchema, buildInitialIssueWorkflowState, type IssueWorkflowInput, type IssueWorkflowState } from "./issue-contracts.js";
import { issueWorkflow } from "./workflows.js";
import { runExecution, type Handler } from "./registry.js";

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

  constructor(
    readonly input: IssueWorkflowInput,
    private readonly database: ForgeDatabase,
    private readonly caller: ActivityCaller,
    private readonly clock: EngineClock = realClock,
  ) {
    this.initialState = IssueWorkflowStateSchema.parse(input.continuationState ?? buildInitialIssueWorkflowState(input));
  }

  get workflowId(): string { return this.input.workflowId; }
  get state(): IssueWorkflowState {
    const query = this.queries.get("issueState");
    return IssueWorkflowStateSchema.parse(query ? query() : this.initialState);
  }
  get error(): unknown { return this.loopError; }

  start(): void {
    if (this.workflowPromise) return;
    const context = {
      workflowId: this.workflowId,
      runId: this.runId,
      signal: this.controller.signal,
      commands: this.commands,
      queries: this.queries,
      activity: (name: string, args: unknown[], options: Parameters<ActivityCaller["call"]>[2]) => this.caller.call(name, args, options, this.controller.signal, this.workflowId),
      wait: (milliseconds: number) => this.wakeable.wait(milliseconds, this.controller.signal, this.clock),
      wake: () => this.wakeable.wake(),
    };
    this.workflowPromise = runExecution.run(context, () => issueWorkflow(this.input));
    void this.workflowPromise.catch((error) => {
      if (!this.controller.signal.aborted) this.loopError = error;
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
      if (commandId !== "legacy-command") {
        const stored = this.database.authQuery((db) => db.prepare("SELECT result_json FROM forge_engine_commands WHERE command_id = ? AND workflow_id = ?").get(commandId, this.workflowId) as { result_json: string } | undefined);
        if (stored) return IssueWorkflowStateSchema.parse(JSON.parse(stored.result_json));
      }
      const handler = this.commands.get(name);
      if (!handler) throw new Error(`Unknown issue command: ${name}`);
      const result = IssueWorkflowStateSchema.parse(await handler(input as never));
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
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`Unknown issue signal: ${name}`);
    await handler(...args as never[]);
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
