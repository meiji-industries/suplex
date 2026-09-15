import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { checkArtifactRoot, checkDatabase, checkDiskSpace } from "../src/platform/host-health.js";
import { inspectHostHealth, providerCheckId, type HealthCheck } from "../src/platform/health.js";
import { updateEnvironmentSettings } from "../src/platform/environment-settings.js";
import { checkGithubAuthentication } from "../src/profiles/provider-readiness.js";
import { cachedHealthReader } from "../src/http/routes/health.js";
import { healthyHost } from "./helpers/native-app.js";

const check = (id: HealthCheck["id"], status: "healthy" | "unhealthy"): HealthCheck => ({
  id,
  label: id,
  status,
  summary: status,
  details: {},
});

test("host readiness reports owned-service health separately from provider authentication", async () => {
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-test"), {
    database: async () => check("database", "healthy"),
    artifactRoot: async () => check("artifact-root", "healthy"),
    git: async () => check("git", "unhealthy"),
    herdrReadiness: async () => check("herdr-readiness", "unhealthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
    pnpm: async () => check("pnpm", "unhealthy"),
    tailscale: async () => check("tailscale", "unhealthy"),
    backup: async () => check("backup", "healthy"),
    provider: async (kind) => ({ ...check(providerCheckId(kind), "unhealthy"), provider: kind }),
  }, ["opencode", "claude-code", "codex", "opencode"]);

  expect(snapshot.ready).toBe(true);
  expect(
    snapshot.checks.map(({ id, status }) => ({ id, status })),
  ).toEqual([
      { id: "database", status: "healthy" },
      { id: "artifact-root", status: "healthy" },
      { id: "git", status: "unhealthy" },
      { id: "herdr-readiness", status: "unhealthy" },
      { id: "gh-auth", status: "healthy" },
      { id: "pnpm", status: "unhealthy" },
      { id: "tailscale", status: "unhealthy" },
      { id: "backup", status: "healthy" },
      { id: "provider:opencode", status: "unhealthy" },
      { id: "provider:claude-code", status: "unhealthy" },
      { id: "provider:codex", status: "unhealthy" },
    ],
  );
});

test("health snapshot remedies survive inspection and HTTP response serialization", async () => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-health-remedy-test"),
    health: {
      database: async () => check("database", "healthy"),
      artifactRoot: async () => check("artifact-root", "healthy"),
      git: async () => ({ ...check("git", "unhealthy"), remedy: "xcode-select --install" }),
      ghAuth: async () => check("gh-auth", "healthy"),
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ready: true, checks: expect.arrayContaining([expect.objectContaining({ id: "git", remedy: "xcode-select --install" })]) });
  } finally { await app.close(); }
});

test("host readiness is false when an owned service is unavailable", async () => {
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-test"), {
    database: async () => check("database", "unhealthy"),
    artifactRoot: async () => check("artifact-root", "healthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
  });

  expect(snapshot.ready).toBe(false);
});

test("disk space warns below its current configured minimum without affecting readiness", async () => {
  const config = createTestConfig("/tmp/forge-disk-space-test");
  const database = new ForgeDatabase(":memory:");
  updateEnvironmentSettings(database, { minFreeDiskGb: 5, defaultBudgetUsd: 15, defaultMaxTurns: 40 });
  const diskSpace = checkDiskSpace(config, database, async (root) => ({ bavail: root === config.worktreeRoot ? 6 : 4, bsize: 1024 ** 3 }));
  try {
    const disk = await diskSpace();
    expect(disk).toMatchObject({ id: "disk-space", status: "warning", details: { freeBytes: 4 * 1024 ** 3, minFreeBytes: 5 * 1024 ** 3 } });
    const snapshot = await inspectHostHealth(config, {
      database: async () => check("database", "healthy"),
      artifactRoot: async () => check("artifact-root", "healthy"),
      diskSpace,
      ghAuth: async () => check("gh-auth", "healthy"),
    });
    expect(snapshot.ready).toBe(true);
  } finally { database.close(); }
});

test("disk space is healthy at or above the minimum, disabled at zero, and re-reads changed settings", async () => {
  const config = createTestConfig("/tmp/forge-disk-space-settings-test");
  const database = new ForgeDatabase(":memory:");
  let freeGb = 5;
  const diskSpace = checkDiskSpace(config, database, async () => ({ bavail: freeGb, bsize: 1024 ** 3 }));
  try {
    updateEnvironmentSettings(database, { minFreeDiskGb: 5, defaultBudgetUsd: 15, defaultMaxTurns: 40 });
    expect((await diskSpace()).status).toBe("healthy");
    updateEnvironmentSettings(database, { minFreeDiskGb: 6, defaultBudgetUsd: 15, defaultMaxTurns: 40 });
    expect((await diskSpace()).status).toBe("warning");
    freeGb = 7;
    expect((await diskSpace()).status).toBe("healthy");
    updateEnvironmentSettings(database, { minFreeDiskGb: 0, defaultBudgetUsd: 15, defaultMaxTurns: 40 });
    expect((await diskSpace()).status).toBe("healthy");
  } finally { database.close(); }
});

test("disk space warns when its filesystem cannot be read", async () => {
  const config = createTestConfig("/tmp/forge-disk-space-failure-test");
  const database = new ForgeDatabase(":memory:");
  const diskSpace = checkDiskSpace(config, database, async () => { throw new Error("statfs failed"); });
  try {
    expect(await diskSpace()).toMatchObject({ id: "disk-space", status: "warning", summary: "Free disk space could not be read" });
  } finally { database.close(); }
});

test("the API health probe is cached for ten seconds", async () => {
  let now = 0;
  let reads = 0;
  const app = createApp({
    config: createTestConfig("/tmp/forge-health-route-cache-test"),
    health: {
      database: async () => check("database", "healthy"),
      artifactRoot: async () => check("artifact-root", "healthy"),
      ghAuth: async () => check("gh-auth", "healthy"),
    },
    getHealth: async () => {
      reads += 1;
      return { generatedAt: new Date(now).toISOString(), reachableAddress: "http://127.0.0.1:4111", ready: true, checks: [] };
    },
    healthNow: () => now,
  });
  await app.inject({ method: "GET", url: "/api/health" });
  await app.inject({ method: "GET", url: "/api/health" });
  await app.inject({ method: "GET", url: "/tasks" });
  await app.inject({ method: "GET", url: "/health" });
  expect(reads).toBe(1);

  now = 5_000;
  await app.inject({ method: "GET", url: "/api/health", headers: { "cache-control": "no-cache" } });
  await app.inject({ method: "GET", url: "/api/health" });
  expect(reads).toBe(2);
  now = 14_999;
  await app.inject({ method: "GET", url: "/health" });
  expect(reads).toBe(2);
  now = 15_000;
  await app.inject({ method: "GET", url: "/api/health" });
  expect(reads).toBe(3);
  await app.close();
});

test("cached health shares concurrent probes, including forced refreshes", async () => {
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-concurrent-test"), healthyHost);
  let finish = (_snapshot: typeof snapshot): void => { throw new Error("Probe did not start"); };
  const read = vi.fn(() => new Promise<typeof snapshot>((resolve) => { finish = resolve; }));
  const cached = cachedHealthReader(read);
  const first = cached();
  const forced = cached(true);
  const another = cached();
  expect(read).toHaveBeenCalledTimes(1);
  finish(snapshot);
  expect(await Promise.all([first, forced, another])).toEqual([snapshot, snapshot, snapshot]);
  expect(await cached()).toBe(snapshot);
  expect(read).toHaveBeenCalledTimes(1);
});

test("failed health refreshes clear the pending probe and do not extend the old cache", async () => {
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-failed-cache-test"), healthyHost);
  let now = 0;
  const read = vi.fn<() => Promise<typeof snapshot>>()
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new Error("private probe failure"))
    .mockResolvedValueOnce({ ...snapshot, generatedAt: "2026-09-08T00:00:00.000Z" });
  const cached = cachedHealthReader(read, () => now);
  expect(await cached()).toBe(snapshot);
  now = 9_000;
  await expect(cached(true)).rejects.toThrow("private probe failure");
  expect(await cached()).toBe(snapshot);
  now = 10_000;
  expect((await cached()).generatedAt).toBe("2026-09-08T00:00:00.000Z");
  expect(read).toHaveBeenCalledTimes(3);
});

test("health snapshot does not expose host paths or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-health-redaction-test-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const snapshot = await inspectHostHealth(config, {
      database: async () => checkDatabase(database),
      artifactRoot: async () => checkArtifactRoot(config.artifactRoot),
      ghAuth: checkGithubAuthentication("gh"),
    });
    const json = JSON.stringify(snapshot);
    expect(json).not.toMatch(config.artifactRoot);
    expect(json).not.toMatch(config.databasePath);
    expect(json).not.toMatch(/\/(Users|home)\/[^/"]+/);
    expect(json).not.toMatch(/gho_[A-Za-z0-9]+/);
    expect(json).not.toMatch(/keychain|token|password|secret/i);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
