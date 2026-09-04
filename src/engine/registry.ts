import { AsyncLocalStorage } from "node:async_hooks";

import { isCancellation } from "./failures.js";

export type Handler = (...args: never[]) => unknown;
interface HandlerValidationInput {
  expectedRevision: number;
  actorUserId: string;
  commandId?: string;
}
export interface InterruptHandler {
  cancelActive?: boolean;
  coalesceKey?: (input: unknown) => string | undefined;
  validate?: Handler;
  run?: Handler;
}
export interface RunExecutionContext {
  workflowId: string;
  runId: string;
  signal: AbortSignal;
  commands: Map<string, Handler>;
  queries: Map<string, Handler>;
  interrupts: Map<string, InterruptHandler>;
  acceptedInterrupt: string | undefined;
  interruptResult: unknown;
  activity(name: string, args: unknown[], options: ActivityCallOptions): Promise<unknown>;
  wait(milliseconds: number): Promise<void>;
  now(): number;
  wake(): void;
  driverReconciled?(): void;
  autoActionsHalted(): boolean;
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

export function setHandler(name: string, handler: Handler, options?: { validator?(input: HandlerValidationInput): void }): void {
  const ctx = runExecution.current();
  // Interrupts validate before their out-of-band effect; the serialized handler may run after the state advances.
  const registered: Handler = options?.validator ? ((...args: never[]) => { if (runExecution.current().acceptedInterrupt !== name) options.validator!(args[0]!); return handler(...args); }) : handler;
  (name === "issueState" ? ctx.queries : ctx.commands).set(name, registered);
  ctx.wake();
}
export function setInterruptHandler(name: string, interrupt: InterruptHandler): void {
  runExecution.current().interrupts.set(name, interrupt);
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
  const ctx = runExecution.current();
  const deadline = timeout === undefined ? undefined : ctx.now() + durationMs(timeout)!;
  // Commands and signals wake the run, so the predicate is re-checked on every state change; the
  // 1 s cap only bounds clock-driven predicates. Polling faster re-parses the state and burns CPU.
  while (!predicate()) {
    if (deadline !== undefined && ctx.now() >= deadline) return false;
    await sleep(Math.min(1_000, deadline === undefined ? 1_000 : Math.max(1, deadline - ctx.now())));
  }
  return true;
}
export const log = {
  info(message: string, attributes?: unknown) { console.info(message, attributes ?? ""); },
  warn(message: string, attributes?: unknown) { console.warn(message, attributes ?? ""); },
  error(message: string, attributes?: unknown) { console.error(message, attributes ?? ""); },
  debug(message: string, attributes?: unknown) { console.debug(message, attributes ?? ""); },
};

export { isCancellation };
