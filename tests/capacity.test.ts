import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { CapacityManager } from "../src/capacity.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

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

test("profile capacity overrides raise the provider limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-capacity-profile-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    const now = new Date().toISOString();
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_codex', 'Codex Profile', 'codex', 'gpt-5.6-sol', 'medium', 'standard', 3, ?, ?)").run(now, now);
    });
    const slots = new CapacityManager(database, createTestConfig(root, { externalTurnCapacity: 1, externalTurnCapacityByProvider: { codex: 1, claude: 1, openrouter: 1 } }));
    const details: unknown[] = [];
    const releases = [await slots.acquire("codex", (detail) => details.push(detail)), await slots.acquire("codex", (detail) => details.push(detail)), await slots.acquire("codex", (detail) => details.push(detail))];
    expect(details).not.toContainEqual(expect.objectContaining({ queued: true }));
    expect(slots.snapshot("codex").codex?.capacity).toBe(3);
    expect(slots.snapshot("openrouter").openrouter?.capacity).toBe(1);
    for (const release of releases) release();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
