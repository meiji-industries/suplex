import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/identity/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import type { HostHealthDependencies } from "../src/platform/health.js";
import { UpdateResponseSchema } from "../src/http/contracts/update.js";
import { SelfUpdateService, SelfUpdateStore } from "../src/platform/updates/self-update.js";
import { inspectUpdateAvailability, type GitCommand } from "../src/platform/updates/update.js";

const headRevision = "a".repeat(40);
const remoteRevision = "b".repeat(40);
const newerRevision = "c".repeat(40);

const health: HostHealthDependencies = {
  database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
  artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
  ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
};

function scriptedGit(responses: Record<string, string | Error>): { runGit: GitCommand; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runGit: GitCommand = async (args, cwd) => {
    const normalizedArgs = [...args];
    calls.push({ args: normalizedArgs, cwd });
    const response = responses[normalizedArgs.join(" ")];
    if (response === undefined) throw new Error(`Unexpected git command: ${normalizedArgs.join(" ")}`);
    if (response instanceof Error) throw response;
    return response;
  };
  return { runGit, calls };
}

function availableResponses(remoteUrl: string, remote = "origin"): Record<string, string | Error> {
  return {
    "symbolic-ref --short HEAD": "main\n",
    remote: `${remote}\n`,
    [`remote get-url ${remote}`]: `${remoteUrl}\n`,
    "rev-parse --verify HEAD^{commit}": `${headRevision}\n`,
    [`fetch --no-tags ${remote} refs/heads/main:refs/remotes/${remote}/main`]: "",
    [`rev-parse --verify refs/remotes/${remote}/main^{commit}`]: `${remoteRevision}\n`,
    [`rev-list --count HEAD..refs/remotes/${remote}/main`]: "2\n",
  };
}

test.each([
  ["HTTPS", "https://github.com/meiji-industries/forge.git"],
  ["SCP SSH", "git@github.com:meiji-industries/forge.git"],
  ["SSH URL", "ssh://git@github.com/meiji-industries/forge.git"],
])("detects a Forge update from a %s remote URL", async (_label, remoteUrl) => {
  const { runGit, calls } = scriptedGit(availableResponses(remoteUrl));

  await expect(inspectUpdateAvailability({ cwd: "/forge", runGit })).resolves.toEqual({ available: true, revision: remoteRevision });
  expect(calls.every((call) => call.cwd === "/forge")).toBe(true);
  expect(calls.map((call) => call.args)).toContainEqual(["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
});

test("requires the server repository to be on main", async () => {
  const { runGit, calls } = scriptedGit({ "symbolic-ref --short HEAD": "feature/update\n" });

  await expect(inspectUpdateAvailability({ cwd: "/forge", runGit })).resolves.toEqual({ available: false });
  expect(calls).toHaveLength(1);
});

test("requires a remote for the pinned Forge repository", async () => {
  const { runGit, calls } = scriptedGit({
    "symbolic-ref --short HEAD": "main\n",
    remote: "origin\nupstream\n",
    "remote get-url origin": "https://github.com/example/forge.git\n",
    "remote get-url upstream": "git@github.com:example/forge.git\n",
  });

  await expect(inspectUpdateAvailability({ cwd: "/forge", runGit })).resolves.toEqual({ available: false });
  expect(calls.some((call) => call.args[0] === "fetch")).toBe(false);
});

test.each([
  ["HEAD", "rev-parse --verify HEAD^{commit}"],
  ["fetch", "fetch --no-tags origin refs/heads/main:refs/remotes/origin/main"],
  ["remote main", "rev-parse --verify refs/remotes/origin/main^{commit}"],
])("fails closed when the %s command fails", async (_label, failedCommand) => {
  const responses = availableResponses("https://github.com/meiji-industries/forge");
  responses[failedCommand] = new Error("command failed");
  const { runGit } = scriptedGit(responses);

  await expect(inspectUpdateAvailability({ cwd: "/forge", runGit })).resolves.toEqual({ available: false });
});

test("fails closed for an invalid commit count and reports no update when the count is zero", async () => {
  const invalid = availableResponses("https://github.com/meiji-industries/forge");
  invalid["rev-list --count HEAD..refs/remotes/origin/main"] = "not-a-count\n";
  await expect(inspectUpdateAvailability({ cwd: "/forge", runGit: scriptedGit(invalid).runGit })).resolves.toEqual({ available: false });

  const current = availableResponses("https://github.com/meiji-industries/forge");
  current["rev-list --count HEAD..refs/remotes/origin/main"] = "0\n";
  await expect(inspectUpdateAvailability({ cwd: "/forge", runGit: scriptedGit(current).runGit })).resolves.toEqual({ available: false });
});

test("compares fetched main with the running revision when checkout HEAD has already advanced", async () => {
  const responses = availableResponses("https://github.com/meiji-industries/forge");
  responses["rev-parse --verify HEAD^{commit}"] = new Error("HEAD must not be the comparison base");
  delete responses["rev-list --count HEAD..refs/remotes/origin/main"];
  responses[`rev-list --count ${headRevision}..refs/remotes/origin/main`] = "2\n";
  const { runGit, calls } = scriptedGit(responses);

  await expect(inspectUpdateAvailability({ cwd: "/forge", runGit, currentRevision: headRevision })).resolves.toEqual({ available: true, revision: remoteRevision });
  expect(calls.filter((call) => call.args[0] === "fetch")).toHaveLength(1);
  expect(calls.map((call) => call.args)).not.toContainEqual(["rev-parse", "--verify", "HEAD^{commit}"]);
});

test("the update API requires authentication and returns the typed injected observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-update-api-test-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  const database = new ForgeDatabase(config.databasePath);
  const auth = new AuthService(database, config);
  const app = createApp({ config, auth, health, readUpdate: async () => ({ available: true, revision: remoteRevision }) });
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/update" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ error: "Authentication required" });

    const authenticated = await app.inject({ method: "GET", url: "/api/update", headers: { host: `127.0.0.1:${config.port}` } });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.headers["cache-control"]).toBe("private, no-store");
    expect(UpdateResponseSchema.parse(authenticated.json())).toEqual({ available: true, revision: remoteRevision, canRestart: true });
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the update API advertises a newer remote revision after a failed target", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-update-api-failed-target-test-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  const database = new ForgeDatabase(config.databasePath);
  const auth = new AuthService(database, config);
  const store = new SelfUpdateStore(config.runtimeRoot);
  await store.writeStatus({ operationId: "77777777-7777-4777-8777-777777777777", status: "failed", targetRevision: remoteRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z", error: "build failed" });
  const service = new SelfUpdateService({
    config,
    store,
    runningRevision: headRevision,
    runGit: async (args) => {
      switch ([...args].join(" ")) {
        case "symbolic-ref --short HEAD": return "main\n";
        case "remote": return "origin\n";
        case "remote get-url origin": return "https://github.com/meiji-industries/forge.git\n";
        case "rev-parse --verify HEAD^{commit}": return `${remoteRevision}\n`;
        case "fetch --no-tags origin refs/heads/main:refs/remotes/origin/main": return "";
        case "rev-parse --verify refs/remotes/origin/main^{commit}": return `${newerRevision}\n`;
        case `rev-list --count ${headRevision}..refs/remotes/origin/main`: return "1\n";
        default: throw new Error(`unexpected Git observation: ${[...args].join(" ")}`);
      }
    },
    argv: ["node", "src/server.ts"],
    environment: {},
  });
  const app = createApp({ config, auth, health, readUpdate: async () => service.readUpdate() });
  try {
    const response = await app.inject({ method: "GET", url: "/api/update", headers: { host: `127.0.0.1:${config.port}` } });
    expect(response.statusCode).toBe(200);
    expect(UpdateResponseSchema.parse(response.json())).toMatchObject({ available: true, revision: newerRevision, currentRevision: headRevision, operation: { status: "failed", targetRevision: remoteRevision } });
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the update API fails closed when its observation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-update-api-failure-test-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  const database = new ForgeDatabase(config.databasePath);
  const auth = new AuthService(database, config);
  const app = createApp({ config, auth, health, readUpdate: async () => { throw new Error("git failed"); } });
  try {
    const response = await app.inject({ method: "GET", url: "/api/update", headers: { host: `127.0.0.1:${config.port}` } });
    expect(response.statusCode).toBe(200);
    expect(UpdateResponseSchema.parse(response.json())).toEqual({ available: false, canRestart: true });
  } finally {
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
