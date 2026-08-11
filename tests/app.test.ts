import assert from "node:assert/strict";
import { test } from "vitest";

import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import type { HealthSnapshot } from "../src/health.js";

const snapshot: HealthSnapshot = {
  generatedAt: "2026-08-11T00:00:00.000Z",
  reachableAddress: "http://forge.tailnet.ts.net:4111",
  ready: true,
  checks: [
    { id: "temporal", label: "Temporal", status: "healthy", summary: "Reachable", details: {} },
    { id: "gh-auth", label: "GitHub CLI authentication", status: "unhealthy", summary: "Authentication is unavailable", details: {} },
  ],
};

test("health page renders the exact reachable address and distinct states", async () => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-app-test"),
    health: {
      temporal: async () => snapshot.checks[0]!,
      database: async () => snapshot.checks[0]!,
      artifactRoot: async () => snapshot.checks[0]!,
      worker: async () => snapshot.checks[0]!,
      codexAuth: async () => snapshot.checks[0]!,
      ghAuth: async () => snapshot.checks[1]!,
    },
    getHealth: async () => snapshot,
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/html/);
  assert.match(response.body, /http:\/\/forge\.tailnet\.ts\.net:4111/);
  assert.match(response.body, /data-status="healthy"/);
  assert.match(response.body, /data-status="unhealthy"/);
  await app.close();
});
