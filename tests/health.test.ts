import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { checkArtifactRoot, checkDatabase } from "../src/platform/host-health.js";
import { inspectHostHealth, type HealthCheck } from "../src/platform/health.js";
import { checkGithubAuthentication } from "../src/profiles/provider-readiness.js";

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
    opencode: async () => check("opencode", "unhealthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
  });

  expect(snapshot.ready).toBe(true);
  expect(
    snapshot.checks.map(({ id, status }) => ({ id, status })),
  ).toEqual([
      { id: "database", status: "healthy" },
      { id: "artifact-root", status: "healthy" },
      { id: "opencode", status: "unhealthy" },
      { id: "gh-auth", status: "healthy" },
    ],
  );
});

test("host readiness is false when an owned service is unavailable", async () => {
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-test"), {
    database: async () => check("database", "unhealthy"),
    artifactRoot: async () => check("artifact-root", "healthy"),
    opencode: async () => check("opencode", "healthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
  });

  expect(snapshot.ready).toBe(false);
});

test("the API health probe is cached for ten seconds", async () => {
  let now = 0;
  let reads = 0;
  const app = createApp({
    config: createTestConfig("/tmp/forge-health-route-cache-test"),
    health: {
      database: async () => check("database", "healthy"),
      artifactRoot: async () => check("artifact-root", "healthy"),
      opencode: async () => check("opencode", "healthy"),
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
  expect(reads).toBe(1);

  now = 10_001;
  await app.inject({ method: "GET", url: "/api/health" });
  expect(reads).toBe(2);
  await app.close();
});

test("health snapshot does not expose host paths or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-health-redaction-test-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  try {
    const snapshot = await inspectHostHealth(config, {
      database: async () => checkDatabase(database),
      artifactRoot: async () => checkArtifactRoot(config.artifactRoot),
      opencode: async () => check("opencode", "healthy"),
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
