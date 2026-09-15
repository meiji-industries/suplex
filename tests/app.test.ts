import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { providerCheckId, type HealthCheck, type HealthSnapshot } from "../src/platform/health.js";
import { REQUIRED_HEALTH_CHECK_IDS } from "../src/platform/health-contract.js";
import { healthyHost, nativeApp } from "./helpers/native-app.js";

const snapshot: HealthSnapshot = {
  generatedAt: "2026-08-11T00:00:00.000Z",
  reachableAddress: "http://forge.tailnet.ts.net:4111",
  ready: true,
  checks: [
    { id: "database", label: "Database", status: "healthy", summary: "Reachable", details: {} },
    { id: "gh-auth", label: "GitHub CLI authentication", status: "unhealthy", summary: "Authentication is unavailable", details: {} },
  ],
};

const unhealthyCheck = (id: HealthCheck["id"]): HealthCheck => ({ id, label: id, status: "unhealthy", summary: "Not available", remedy: "repair-tool", details: {} });

test("health page renders the exact reachable address and distinct states", async () => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-app-test"),
    health: {
      database: async () => snapshot.checks[0]!,
      artifactRoot: async () => snapshot.checks[0]!,
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

test.each([...REQUIRED_HEALTH_CHECK_IDS, "provider:opencode" as const])("an unhealthy %s check never redirects application pages to setup", async (id) => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-setup-gate-test"),
    health: healthyHost,
    getHealth: async () => ({ ...snapshot, checks: [...snapshot.checks, unhealthyCheck(id)] }),
  });
  try {
    for (const url of ["/tasks", "/tasks/task-test", "/projects", "/board", "/timeline", "/analytics", "/admin", "/admin/profiles", "/profile", "/templates"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers.location, url).toBeUndefined();
    }
    expect((await app.inject({ method: "GET", url: "/" })).headers.location).toBe("/tasks");
    for (const url of ["/auth", "/setup", "/health", "/api/health"]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    const setup = await app.inject({ method: "GET", url: "/setup" });
    expect(setup.body).toContain("<title>Forge · Set up</title>");
    expect(setup.body).toContain('window.__FORGE_VIEW__ = "setup"');
  } finally { await app.close(); }
});

test("a missing health snapshot does not gate application pages", async () => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-missing-health-test"),
    health: healthyHost,
    getHealth: async () => { throw new Error("probe unavailable"); },
  });
  try {
    // The /health view reports the failure; task and settings pages still render.
    for (const url of ["/tasks", "/profile"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
    }
  } finally { await app.close(); }
});

test("page and health API sessions are checked before any host health is read", async () => {
  const fixture = await nativeApp();
  let reads = 0;
  const app = createApp({
    config: fixture.config,
    auth: fixture.auth,
    health: healthyHost,
    getHealth: async () => {
      reads += 1;
      return { ...snapshot, checks: [{ id: "herdr-readiness", label: "Herdr", status: "unhealthy", summary: "Host status", details: {} }] };
    },
  });
  try {
    const untrusted = { host: "outside.example" };
    for (const url of ["/tasks", "/setup", "/health", `/companies/${fixture.company.id}/settings`]) {
      const response = await app.inject({ method: "GET", url, headers: untrusted });
      expect(response.statusCode, url).toBe(302);
      expect(response.headers.location, url).toBe("/auth");
    }
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { ...untrusted, "cache-control": "no-cache" } })).statusCode).toBe(401);
    expect(reads).toBe(0);
    expect((await app.inject({ method: "GET", url: "/companies/not-found/settings", headers: fixture.headers })).statusCode).toBe(404);
    expect(reads).toBe(0);
    const invitation = fixture.auth.inviteUser(fixture.userId, { displayName: "Setup member" });
    const options = await app.inject({ method: "POST", url: "/api/auth/invitation/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/invitation/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "setup-member", type: "public-key" } } });
    expect(enrolled.statusCode).toBe(200);
    const cookies = enrolled.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies ?? ""]).map((value) => value.split(";")[0]).join("; ");
    expect((await app.inject({ method: "GET", url: `/companies/${fixture.company.id}/settings`, headers: { ...untrusted, cookie } })).statusCode).toBe(404);
    expect(reads).toBe(0);
    // Unhealthy host checks never gate pages for an authorized user.
    for (const url of ["/tasks", `/companies/${fixture.company.id}/settings`]) {
      const response = await app.inject({ method: "GET", url, headers: fixture.headers });
      expect(response.statusCode, url).toBe(200);
    }
    expect(reads).toBe(0);
    for (const url of ["/setup", "/health", "/api/health", "/api/auth/me"]) expect((await app.inject({ method: "GET", url, headers: fixture.headers })).statusCode, url).toBe(200);
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("health API resolves authorized profile and project provider contexts", async () => {
  const fixture = await nativeApp();
  const providerReads: string[] = [];
  const app = createApp({
    config: fixture.config,
    auth: fixture.auth,
    profiles: fixture.profiles,
    projects: fixture.projects,
    health: {
      ...healthyHost,
      provider: async (kind) => {
        providerReads.push(kind);
        return { id: providerCheckId(kind), label: kind, status: "healthy", summary: "Signed in", details: {}, provider: kind };
      },
    },
  });
  try {
    // The seeded project uses Codex CLI profiles for both roles: one check only.
    const projectContext = await app.inject({ method: "GET", url: `/api/health?projectId=${fixture.project.id}`, headers: fixture.headers });
    expect(projectContext.statusCode).toBe(200);
    expect(projectContext.json().checks.filter((check: HealthCheck) => check.provider !== undefined).map((check: HealthCheck) => check.id)).toEqual(["provider:codex"]);
    expect(providerReads).toEqual(["codex"]);

    // Distinct Coordinator/Worker providers both appear.
    const claude = fixture.profiles.create(fixture.userId, { name: "Reviewer", role: "worker", avatarSeed: "a".repeat(32), provider: "claude-code", model: "claude-sonnet-5", reasoningLevel: "high", serviceTier: "default" });
    providerReads.length = 0;
    const both = await app.inject({ method: "GET", url: `/api/health?profileIds=${encodeURIComponent(`profile_native_root,${claude.id},profile_native_root`)}`, headers: fixture.headers });
    expect(both.statusCode).toBe(200);
    expect(both.json().checks.filter((check: HealthCheck) => check.provider !== undefined).map((check: HealthCheck) => check.provider).sort()).toEqual(["claude-code", "codex"]);
    expect(providerReads.sort()).toEqual(["claude-code", "codex"]);

    // Base requests carry no provider checks.
    const base = await app.inject({ method: "GET", url: "/api/health", headers: fixture.headers });
    expect(base.json().checks.filter((check: HealthCheck) => check.provider !== undefined)).toEqual([]);
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("health API rejects provider contexts the session user cannot read", async () => {
  const fixture = await nativeApp();
  const app = createApp({
    config: fixture.config,
    auth: fixture.auth,
    profiles: fixture.profiles,
    projects: fixture.projects,
    health: healthyHost,
  });
  try {
    expect((await app.inject({ method: "GET", url: "/api/health?profileIds=profile_missing", headers: fixture.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health?projectId=project_missing", headers: fixture.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health?profileIds=profile_native_root", headers: { host: "outside.example" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/health?projectId=${fixture.project.id}&profileIds=profile_native_root`, headers: fixture.headers })).statusCode).toBe(400);
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("a tool installed after a failed check is healthy on the next forced request", async () => {
  const fixture = await nativeApp();
  let installed = false;
  const app = createApp({
    config: fixture.config,
    auth: fixture.auth,
    profiles: fixture.profiles,
    projects: fixture.projects,
    health: {
      ...healthyHost,
      provider: async (kind) => ({ id: providerCheckId(kind), label: kind, status: installed ? "healthy" : "unhealthy", summary: installed ? "Signed in" : "Not installed", details: {}, provider: kind }),
    },
  });
  try {
    const url = `/api/health?profileIds=profile_native_root`;
    const first = await app.inject({ method: "GET", url, headers: fixture.headers });
    expect(first.json().checks.find((check: HealthCheck) => check.provider === "codex")).toMatchObject({ status: "unhealthy" });
    installed = true;
    // The forced request probes fresh state with no restart or reset.
    const second = await app.inject({ method: "GET", url, headers: { ...fixture.headers, "cache-control": "no-cache" } });
    expect(second.json().checks.find((check: HealthCheck) => check.provider === "codex")).toMatchObject({ status: "healthy" });
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("development pages are transformable and load the Vite source entry", async () => {
  const app = createApp({
    config: createTestConfig("/tmp/forge-vite-app-test"),
    health: {
      database: async () => snapshot.checks[0]!,
      artifactRoot: async () => snapshot.checks[0]!,
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
