import { expect, test } from "vitest";
import { activityContext } from "../src/engine/activity-context.js";
import { createActivityCaller } from "../src/engine/activities.js";
import { ApplicationFailure, CancelledFailure } from "../src/engine/failures.js";
import { durableCommand } from "../src/engine/service.js";
import { Wakeable } from "../src/engine/runs.js";
import { createEngineHarness } from "./helpers/engine-harness.js";

test("durable command IDs are stable", () => {
  const input = { expectedRevision: 0, actorUserId: "member" };
  expect(durableCommand("workflow", "cancel", input).commandId).toBe(durableCommand("workflow", "cancel", input).commandId);
});

test("wake interrupts an engine wait", async () => {
  const wakeable = new Wakeable(); const controller = new AbortController(); let resolved = false;
  const waiting = wakeable.wait(60_000, controller.signal, { now: Date.now, wait: async (_ms, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new CancelledFailure()), { once: true })) }).then(() => { resolved = true; });
  wakeable.wake(); await waiting; expect(resolved).toBe(true);
});

test("activity retries honor attempts and non-retryable types", async () => {
  let attempts = 0; const harness = await createEngineHarness();
  try {
    const caller = createActivityCaller(harness.database, { retrying() { attempts += 1; throw new Error("retry"); }, terminal() { attempts += 1; throw ApplicationFailure.nonRetryable("stop", "stop"); } }, async () => undefined);
    await expect(caller.call("retrying", [], { retry: { maximumAttempts: 3, initialInterval: 1 } }, new AbortController().signal, "workflow")).rejects.toThrow("failed");
    expect(attempts).toBe(3); attempts = 0;
    await expect(caller.call("terminal", [], { retry: { maximumAttempts: 3 } }, new AbortController().signal, "workflow")).rejects.toThrow("failed");
    expect(attempts).toBe(1);
  } finally { await harness.stop(); }
});

test("activity timeout aborts the activity signal and clears its ledger row", async () => {
  const harness = await createEngineHarness(); let aborted = false;
  try {
    const caller = createActivityCaller(harness.database, { hanging: async () => new Promise<void>((_resolve, reject) => { const signal = activityContext.current().signal; signal.addEventListener("abort", () => { aborted = true; reject(new CancelledFailure()); }, { once: true }); }) });
    await expect(caller.call("hanging", [], { startToCloseTimeout: 5 }, new AbortController().signal, "workflow")).rejects.toBeInstanceOf(CancelledFailure);
    expect(aborted).toBe(true);
    expect(harness.database.authQuery((db) => (db.prepare("SELECT count(*) count FROM forge_engine_activities").get() as { count: number }).count)).toBe(0);
  } finally { await harness.stop(); }
});
