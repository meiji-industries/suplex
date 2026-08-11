import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { checkArtifactRoot, checkDatabase, checkWorker } from "../src/host-health.js";
import { inspectHostHealth, type HealthCheck } from "../src/health.js";
import { checkGithubAuthentication, CodexReadinessProbe } from "../src/provider-readiness.js";
import { TemporalHealthProbe } from "../src/temporal/service.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";

const check = (id: HealthCheck["id"], status: "healthy" | "unhealthy"): HealthCheck => ({
  id,
  label: id,
  status,
  summary: status,
  details: {},
});

test("host readiness reports owned-service health separately from provider authentication", async () => {
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-test"), {
    temporal: async () => check("temporal", "healthy"),
    database: async () => check("database", "healthy"),
    artifactRoot: async () => check("artifact-root", "healthy"),
    worker: async () => check("worker", "healthy"),
    codexAuth: async () => check("codex-auth", "unhealthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
  });

  expect(snapshot.ready).toBe(true);
  expect(
    snapshot.checks.map(({ id, status }) => ({ id, status })),
  ).toEqual([
      { id: "temporal", status: "healthy" },
      { id: "database", status: "healthy" },
      { id: "artifact-root", status: "healthy" },
      { id: "worker", status: "healthy" },
      { id: "codex-auth", status: "unhealthy" },
      { id: "gh-auth", status: "healthy" },
    ],
  );
});

test("host readiness is false when an owned service is unavailable", async () => {
  const snapshot = await inspectHostHealth(createTestConfig("/tmp/forge-health-test"), {
    temporal: async () => check("temporal", "unhealthy"),
    database: async () => check("database", "healthy"),
    artifactRoot: async () => check("artifact-root", "healthy"),
    worker: async () => check("worker", "healthy"),
    codexAuth: async () => check("codex-auth", "healthy"),
    ghAuth: async () => check("gh-auth", "healthy"),
  });

  expect(snapshot.ready).toBe(false);
});

test("health snapshot does not expose host paths or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-health-redaction-test-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const identifiers = runtimeIdentifiers(config.installationId);
  try {
    database.registerWorker({
      workerId: `${identifiers.workerPrefix}-live`,
      taskQueue: config.taskQueue,
      buildId: identifiers.buildId,
    });
    const codexProbe = new CodexReadinessProbe("codex");
    const snapshot = await inspectHostHealth(config, {
      temporal: new TemporalHealthProbe(config).check,
      database: async () => checkDatabase(database),
      artifactRoot: async () => checkArtifactRoot(config.artifactRoot),
      worker: async () => checkWorker(database, config.taskQueue, config.installationId),
      codexAuth: async () => codexProbe.check(),
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
