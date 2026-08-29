export { createActivities } from "./activities/index.js";
export type { ActivityOptions } from "./activities/context.js";
export { asNonRetryableApplicationFailure, asRetryableAgentFailure } from "./activities/context.js";

import { randomUUID } from "node:crypto";

import type { ForgeDatabase } from "../database.js";
import { StructuredLogger } from "../logging.js";
import { activityContext } from "./activity-context.js";
import { ActivityFailure, ApplicationFailure, CancelledFailure } from "./failures.js";
import { durationMs, type ActivityCallOptions } from "./registry.js";

export interface ActivityCaller {
  call(name: string, args: unknown[], options: ActivityCallOptions, runSignal: AbortSignal, workflowId: string): Promise<unknown>;
}

function failureType(error: unknown): string | undefined {
  if (error instanceof ApplicationFailure) return error.type;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : undefined;
}

export function createActivityCaller(database: ForgeDatabase, activities: object, wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = async (milliseconds, signal) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new CancelledFailure()); }, { once: true });
  });
}): ActivityCaller {
  const logger = new StructuredLogger();
  return {
    async call(name, args, options, runSignal, workflowId) {
      const operation = (activities as Record<string, (...values: unknown[]) => unknown>)[name];
      if (typeof operation !== "function") throw new Error(`Unknown activity: ${name}`);
      const attempts = options.retry?.maximumAttempts ?? 1;
      let delay = durationMs(options.retry?.initialInterval) ?? 1_000;
      const maxDelay = durationMs(options.retry?.maximumInterval) ?? delay;
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const id = randomUUID();
        const startedAt = new Date().toISOString();
        const timeoutController = new AbortController();
        const signal = AbortSignal.any([runSignal, timeoutController.signal]);
        const timeout = durationMs(options.startToCloseTimeout);
        const timer = timeout === undefined ? undefined : setTimeout(() => timeoutController.abort(), timeout);
        database.authTransaction((db) => db.prepare("INSERT INTO forge_engine_activities (id, workflow_id, activity, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)").run(id, workflowId, name, startedAt, startedAt));
        try {
          return await activityContext.run({
            signal,
            heartbeat: () => database.authTransaction((db) => db.prepare("UPDATE forge_engine_activities SET heartbeat_at = ? WHERE id = ?").run(new Date().toISOString(), id)),
            log: logger,
          }, () => Promise.resolve(operation(...args)));
        } catch (error) {
          lastError = signal.aborted ? new CancelledFailure(timeoutController.signal.aborted && !runSignal.aborted ? `Activity ${name} timed out` : "Activity cancelled") : error;
          const type = failureType(lastError);
          if (runSignal.aborted || lastError instanceof ApplicationFailure && lastError.nonRetryable || type && options.retry?.nonRetryableErrorTypes?.includes(type) || attempt === attempts) break;
          await wait(Math.min(delay, maxDelay), runSignal);
          delay = Math.min(maxDelay, delay * (options.retry?.backoffCoefficient ?? 2));
        } finally {
          if (timer) clearTimeout(timer);
          database.authTransaction((db) => db.prepare("DELETE FROM forge_engine_activities WHERE id = ?").run(id));
        }
      }
      if (lastError instanceof CancelledFailure) throw lastError;
      throw new ActivityFailure(`Activity ${name} failed`, lastError);
    },
  };
}
