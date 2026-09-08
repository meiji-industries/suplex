import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import type { HealthSnapshot } from "../src/platform/health.js";

const snapshot: HealthSnapshot = {
  generatedAt: "2026-08-11T00:00:00.000Z",
  reachableAddress: "http://forge.tailnet.ts.net:4111",
  ready: true,
  checks: [
    { id: "database", label: "Database", status: "healthy", summary: "Reachable", details: {} },
    { id: "gh-auth", label: "GitHub CLI authentication", status: "unhealthy", summary: "Authentication is unavailable", details: {} },
  ],
};

test("health page renders the exact reachable address and distinct states", async () => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-app-test"),
    health: {
      database: async () => snapshot.checks[0]!,
      artifactRoot: async () => snapshot.checks[0]!,
      opencode: async () => snapshot.checks[0]!,
      ghAuth: async () => snapshot.checks[1]!,
    },
    getHealth: async () => snapshot,
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"] ?? "").toMatch(/text\/html/);
  expect(response.body).toMatch(/http:\/\/forge\.tailnet\.ts\.net:4111/);
  expect(response.body).toMatch(/data-status="healthy"/);
  expect(response.body).toMatch(/data-status="unhealthy"/);
  await app.close();
});

test("development pages are transformable and load the Vite source entry", async () => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-vite-app-test"),
    health: {
      database: async () => snapshot.checks[0]!,
      artifactRoot: async () => snapshot.checks[0]!,
      opencode: async () => snapshot.checks[0]!,
      ghAuth: async () => snapshot.checks[1]!,
    },
    getHealth: async () => snapshot,
    frontendDevelopment: {
      transformIndexHtml: async (_url, html) => html.replace("</head>", "    <meta name=\"development-transform\">\n  </head>"),
    },
  });

  const response = await app.inject({ method: "GET", url: "/auth" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toContain("development-transform");
  expect(response.body).toContain("/src/frontend/main.tsx");
  expect(response.body).not.toContain("/assets/forge-ui.js");
  expect((await app.inject({ method: "GET", url: "/assets/forge-ui.js" })).statusCode).toBe(404);
  await app.close();
});
