import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { inspectHostHealth, type HealthCheck } from "../src/health.js";

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
