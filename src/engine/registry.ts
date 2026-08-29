import { AsyncLocalStorage } from "node:async_hooks";

import { isCancellation } from "./failures.js";

export type Handler = (...args: never[]) => unknown;
export interface RunExecutionContext {
  workflowId: string;
  runId: string;
  signal: AbortSignal;
  commands: Map<string, Handler>;
  queries: Map<string, Handler>;
  activity(name: string, args: unknown[], options: ActivityCallOptions): Promise<unknown>;
  wait(milliseconds: number): Promise<void>;
  wake(): void;
}
export interface ActivityCallOptions {
  startToCloseTimeout?: string | number;
  retry?: { maximumAttempts?: number; initialInterval?: string | number; maximumInterval?: string | number; backoffCoefficient?: number; nonRetryableErrorTypes?: string[] };
}

const execution = new AsyncLocalStorage<RunExecutionContext>();
export const runExecution = {
  current(): RunExecutionContext {
    const value = execution.getStore();
    if (!value) throw new Error("No issue run is active");
    return value;
  },
  run<T>(context: RunExecutionContext, operation: () => T): T { return execution.run(context, operation); },
};

export function defineUpdate<T = unknown, A extends unknown[] = unknown[]>(name: string): string { void (0 as unknown as T); void (0 as unknown as A); return name; }
export function defineQuery<T = unknown>(name: string): string { void (0 as unknown as T); return name; }
export function defineSignal<A extends unknown[] = unknown[]>(name: string): string { void (0 as unknown as A); return name; }
export function setHandler(name: string, handler: (...args: any[]) => any, options?: { validator?(input: any): void }): void {
  const ctx = runExecution.current();
  const registered = options?.validator ? ((...args: any[]) => { options.validator!(args[0]); return handler(...args); }) : handler;
  (name === "issueState" || name === "probeState" ? ctx.queries : ctx.commands).set(name, registered as Handler);
  ctx.wake();
}
export function workflowInfo(): { runId: string; workflowId: string; historyLength: number; continueAsNewSuggested: boolean; unsafe: { now(): number } } {
  const ctx = runExecution.current();
  return { runId: ctx.runId, workflowId: ctx.workflowId, historyLength: 0, continueAsNewSuggested: false, unsafe: { now: Date.now } };
}

export function durationMs(value: string | number | undefined): number | undefined {
  if (value === undefined || typeof value === "number") return value;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(millisecond|second|minute|hour)s?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * ({ millisecond: 1, second: 1_000, minute: 60_000, hour: 3_600_000 }[match[2]!]!);
}

export async function sleep(value: string | number): Promise<void> {
  const ctx = runExecution.current();
  await ctx.wait(durationMs(value)!);
}
export async function condition(predicate: () => boolean, timeout?: string | number): Promise<boolean> {
  const deadline = timeout === undefined ? undefined : Date.now() + durationMs(timeout)!;
  while (!predicate()) {
    if (deadline !== undefined && Date.now() >= deadline) return false;
    await sleep(Math.min(50, deadline === undefined ? 50 : Math.max(1, deadline - Date.now())));
  }
  return true;
}
export function allHandlersFinished(): boolean { return true; }

export class CancellationScope {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  constructor(_options: { cancellable?: boolean } = {}) { this.signal = this.controller.signal; }
  cancel(): void { this.controller.abort(); }
  run<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
  static cancellable<T>(operation: () => Promise<T>): Promise<T> { return new CancellationScope().run(operation); }
  static nonCancellable<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
  static current(): CancellationScope { return new CancellationScope(); }
}

export const log = {
  info(message: string, attributes?: unknown) { console.info(message, attributes ?? ""); },
  warn(message: string, attributes?: unknown) { console.warn(message, attributes ?? ""); },
  error(message: string, attributes?: unknown) { console.error(message, attributes ?? ""); },
  debug(message: string, attributes?: unknown) { console.debug(message, attributes ?? ""); },
};

export { isCancellation };
