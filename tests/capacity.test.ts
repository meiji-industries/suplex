import { expect, test } from "vitest";

import { CapacityManager } from "../src/capacity.js";
import { createTestConfig } from "../src/config.js";

function capacity() {
  return new CapacityManager(null as never, createTestConfig("/tmp/forge-capacity-test", { externalTurnCapacity: 1, externalTurnCapacityByProvider: { codex: 1, claude: 1 } }));
}

test("second turn waits for the provider slot then runs", async () => {
  const slots = capacity();
  const first = await slots.acquire();
  let ran = false;
  let waiting = false;
  const second = slots.run(async () => { ran = true; }, "codex", () => { waiting = true; });
  expect(waiting).toBe(true);
  expect(ran).toBe(false);
  first();
  await second;
  expect(ran).toBe(true);
});

test("provider buckets are independent and queued waits heartbeat then abort", async () => {
  const slots = capacity();
  const release = await slots.acquire("codex");
  const claudeRelease = await slots.acquire("claude");
  const controller = new AbortController();
  const details: unknown[] = [];
  const queued = slots.acquire("codex", (detail) => details.push(detail), controller.signal);
  expect(details).toContainEqual({ queued: true, provider: "codex", position: 1, activeCount: 1 });
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: "CancelledFailure" });
  release();
  claudeRelease();
});

test("a restarted worker does not retain stale slots", async () => {
  const staleWorker = capacity();
  await staleWorker.acquire();
  const restartedWorker = capacity();
  const release = await restartedWorker.acquire();
  release();
});
