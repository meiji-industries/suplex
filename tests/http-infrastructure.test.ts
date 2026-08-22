import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { createFastifyLogger } from "../src/logging.js";
import type { HostHealthDependencies } from "../src/health.js";
import { ProjectFailure } from "../src/projects.js";
import { jsonRequired } from "../src/task-utils.js";

const health: HostHealthDependencies = {
  temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy" as const, summary: "Ready", details: {} }),
  database: async () => ({ id: "database", label: "Database", status: "healthy" as const, summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy" as const, summary: "Ready", details: {} }),
  worker: async () => ({ id: "worker", label: "Worker", status: "healthy" as const, summary: "Ready", details: {} }),
  codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy" as const, summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy" as const, summary: "Ready", details: {} }),
};

test("Fastify request logs are correlated and omit credential-shaped request data", async () => {
  const lines: string[] = [];
  const app = createApp({
    config: createTestConfig("/tmp/forge-http-infrastructure-test"),
    health,
    getHealth: async () => ({ generatedAt: "2026-08-11T00:00:00.000Z", reachableAddress: "http://127.0.0.1:4111", ready: true, checks: [] }),
    logger: createFastifyLogger((line) => lines.push(line)),
  });

  expect((await app.inject({ method: "GET", url: "/auth?token=query-secret", headers: { cookie: "forge_session=cookie-secret", authorization: "Bearer header-secret" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/unknown?token=query-secret" })).statusCode).toBe(404);
  await app.close();

  const output = lines.join("\n");
  expect(output).not.toContain("query-secret");
  expect(output).not.toContain("cookie-secret");
  expect(output).not.toContain("header-secret");
  const records = lines.map((line) => jsonRequired(line) as Record<string, unknown>);
  expect(records.some((record) => typeof record.reqId === "string" && record.msg === "incoming request")).toBe(true);
  expect(records.some((record) => record.msg === "request completed" && typeof record.responseTime === "number")).toBe(true);
});

test("unexpected route errors are generic to callers and correlated in logs", async () => {
  const lines: string[] = [];
  const app = createApp({
    config: createTestConfig("/tmp/forge-http-error-test"),
    health,
    getHealth: async () => { throw new Error("provider secret=do-not-leak"); },
    logger: createFastifyLogger((line) => lines.push(line)),
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  await app.close();

  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ error: "Internal server error" });
  expect(response.body).not.toContain("provider secret");
  expect(lines.join("\n")).not.toContain("do-not-leak");
  expect(lines.some((line) => line.includes("Unhandled request error"))).toBe(true);
});

test("expected request failures retain sanitized reasons in logs", async () => {
  const lines: string[] = [];
  const app = createApp({
    config: createTestConfig("/tmp/forge-http-rejection-test"),
    health,
    getHealth: async () => { throw new ProjectFailure("Repository provisioning failed", [{ code: "repository-unavailable", field: "repositoryUrl", message: "Git could not clone token=secret" }], 422); },
    logger: createFastifyLogger((line) => lines.push(line)),
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  await app.close();

  expect(response.statusCode).toBe(422);
  expect(lines.join("\n")).not.toContain("token=secret");
  expect(lines.some((line) => line.includes("Request rejected") && line.includes("Repository provisioning failed") && line.includes("repository-unavailable"))).toBe(true);
});
