import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/activity";
import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { chromium } from "playwright";
import { expect, test } from "vitest";

import { createApp } from "../src/app.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { GithubAdapter } from "../src/github.js";
import type { HostHealthDependencies } from "../src/health.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import { TaskService } from "../src/tasks.js";
import { createActivities } from "../src/temporal/activities.js";
import { ensureTemporalFoundation } from "../src/temporal/service.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "temporal-browser", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; }, async generateAuthenticationOptions(input) { return { challenge: "temporal-browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test("browser task remains in authoritative Planning across API, Worker, and Temporal restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-temporal-browser-"));
  const temporalPort = await availablePort();
  const apiPort = await availablePort();
  const taskQueue = `tasks-browser-${process.pid}-${randomUUID().slice(0, 8)}`;
  const repositoryPath = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  const config = createTestConfig(root, { repositoryRoot: root, worktreeRoot, temporalAddress: `127.0.0.1:${temporalPort}`, taskQueue, reachableAddress: `http://127.0.0.1:${apiPort}`, port: apiPort });
  const imagePath = join(root, "evidence.png");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

  let temporalProcess: ChildProcess | undefined;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let workerConnection: NativeConnection | undefined;
  let workerDatabase: ForgeDatabase | undefined;
  let apiDatabase: ForgeDatabase | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let workflowId = "";

  const startTemporal = async (): Promise<void> => {
    temporalProcess = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(temporalPort), "--db-filename", join(root, "temporal.db"), "--namespace", config.temporalNamespace, "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword"], { stdio: "ignore" });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const connection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" });
        await ensureTemporalFoundation(connection, config);
        connection.close();
        return;
      } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    throw new Error("Temporal did not start");
  };
  const stopTemporal = async (): Promise<void> => {
    const process = temporalProcess;
    temporalProcess = undefined;
    if (!process || process.exitCode !== null) return;
    process.kill("SIGTERM");
    await new Promise((resolve) => process.once("exit", resolve));
  };
  const startWorker = async (): Promise<void> => {
    workerDatabase = new ForgeDatabase(config.databasePath);
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({ connection: workerConnection, namespace: config.temporalNamespace, taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: createActivities(workerDatabase, config, { agent: { async runLeadPlanning() { throw ApplicationFailure.create({ message: "Controlled Planning hold", type: "controlled-planning-hold", nonRetryable: false, nextRetryDelay: "500ms" }); } } }) });
    workerRun = worker.run();
  };
  const stopWorker = async (): Promise<void> => {
    worker?.shutdown();
    await workerRun;
    worker = undefined; workerRun = undefined;
    await workerConnection?.close(); workerConnection = undefined;
    workerDatabase?.close(); workerDatabase = undefined;
  };
  const health: HostHealthDependencies = { temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) };
  const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
  const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };
  const startApi = async (): Promise<{ auth: AuthService; projects: ProjectService }> => {
    apiDatabase = new ForgeDatabase(config.databasePath);
    const auth = new AuthService(apiDatabase, config, { webAuthn: fakeWebAuthn() });
    const projects = new ProjectService(apiDatabase, auth, config, { localRepository, github });
    const tasks = new TaskService(apiDatabase, auth, projects, config);
    app = createApp({ config, auth, projects, tasks, health });
    await app.listen({ host: "127.0.0.1", port: apiPort });
    return { auth, projects };
  };
  const stopApi = async (): Promise<void> => {
    app?.server.closeAllConnections();
    await app?.close();
    app = undefined;
    apiDatabase?.close();
    apiDatabase = undefined;
  };

  try {
    await startTemporal();
    const seed = new ForgeDatabase(config.databasePath);
    seed.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
    seed.close();
    const { auth, projects } = await startApi();
    const company = auth.createCompany("admin-1", "Temporal Browser");
    const profile = projects.createProfile("admin-1", { name: "Controlled profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 1 });
    const analyst = projects.createAgent("admin-1", { name: "Analyst", role: "analyst", profileId: profile.id });
    const implementer = projects.createAgent("admin-1", { name: "Implementer", role: "implementer", profileId: profile.id });
    const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
    const project = await projects.createProject("admin-1", company.id, { name: "Temporal project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { analyst: analyst.id, implementer: implementer.id, reviewer: reviewer.id } });
    await projects.activateProject("admin-1", project.id);
    await startWorker();

    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    const options = await app!.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app!.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "temporal-browser-admin", type: "public-key" } } });
    const cookies = (Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [enrolled.headers["set-cookie"] ?? ""]).map((value) => value.split(";", 1)[0]!);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      await context.addCookies(cookies.map((cookie) => { const [name, value] = cookie.split("=", 2); return { name: name!, value: value!, domain: "127.0.0.1", path: "/" }; }).filter((cookie) => cookie.name === SESSION_COOKIE_NAME || cookie.name === CSRF_COOKIE_NAME));
      const page = await context.newPage();
      let taskListResponses = 0;
      page.on("response", (response) => { if (/\/api\/companies\/[^/]+\/tasks$/.test(new URL(response.url()).pathname)) taskListResponses += 1; });
      await page.goto(`${config.reachableAddress}/tasks?company=${encodeURIComponent(company.id)}&new=1`);
      await page.getByRole("dialog", { name: "New task" }).waitFor();
      await page.getByRole("combobox", { name: "Project" }).click();
      await page.getByRole("option", { name: "Temporal project" }).click();
      await page.getByLabel("Task title", { exact: true }).fill("Durable browser task");
      await page.getByLabel("Task description", { exact: true }).fill("## Durable brief\n\nSurvive the restart.");
      await page.getByLabel("Task images", { exact: true }).setInputFiles(imagePath);
      await page.getByRole("button", { name: "Create task" }).click();
      await page.waitForURL(/\/tasks\/[^/?]+/);
      const pane = page.locator("[data-task-detail]");
      await pane.waitFor();
      await pane.getByRole("heading", { name: "Durable browser task", exact: true }).waitFor();
      const persisted = apiDatabase!.authQuery((db) => db.prepare("SELECT id, workflow_id, role_agents_json, supplemental_review FROM forge_tasks WHERE title = 'Durable browser task'").get() as { id: string; workflow_id: string; role_agents_json: string; supplemental_review: number });
      workflowId = persisted.workflow_id;
      expect(JSON.parse(persisted.role_agents_json)).toMatchObject({ analyst: analyst.id, implementer: implementer.id });
      expect(persisted.supplemental_review).toBe(0);
      expect(apiDatabase!.authQuery((db) => db.prepare("SELECT state FROM forge_task_creation_intents WHERE task_id = ?").get(persisted.id))).toEqual({ state: "started" });
      expect(apiDatabase!.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE id = ?").get(persisted.id))).toEqual({ count: 1 });
      expect(apiDatabase!.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE company_id = ?").get(company.id))).toEqual({ count: 2 });
      const attachment = pane.getByRole("link", { name: "evidence.png" });
      await attachment.waitFor();
      const attachmentResponse = await page.request.get(new URL((await attachment.getAttribute("href"))!, page.url()).toString());
      expect(attachmentResponse.status()).toBe(200);
      expect(Buffer.from(await attachmentResponse.body())).toEqual(await readFile(imagePath));
      await pane.locator('[data-status="planning"]').first().waitFor();
      // Capacity admission (#25) records a second planning revision after start_planning.
      await expect.poll(() => apiDatabase!.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE workflow_id = ? ORDER BY revision").all(workflowId))).toEqual([{ revision: 0 }, { revision: 1 }, { revision: 2 }]);
      await pane.getByText("Current · r2", { exact: true }).waitFor();
      const stale = await page.evaluate(async (id) => { const csrf = document.cookie.split("; ").find((value) => value.startsWith("csrf_v1="))?.split("=", 2)[1] ?? ""; const response = await fetch(`/api/tasks/${id}/start-planning`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-V1": csrf }, body: JSON.stringify({ expectedRevision: 0 }) }); return { status: response.status, body: await response.json() }; }, workflowId.split("-issue-").at(-1)!);
      expect(stale).toMatchObject({ status: 409, body: { current: { revision: 2, phase: "planning" } } });

      const responsesBeforeRestart = taskListResponses;
      await stopApi(); await stopWorker(); await stopTemporal();
      await startTemporal(); await startWorker(); await startApi();
      await expect.poll(() => taskListResponses, { timeout: 15_000 }).toBeGreaterThan(responsesBeforeRestart);
      await pane.locator('[data-status="planning"]').first().waitFor();
      await pane.getByText("Current · r2", { exact: true }).waitFor();
      expect(apiDatabase!.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE workflow_id = ? ORDER BY revision").all(workflowId))).toEqual([{ revision: 0 }, { revision: 1 }, { revision: 2 }]);
      expect(apiDatabase!.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_tasks WHERE workflow_id = ?").get(workflowId))).toEqual({ count: 1 });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await pane.getByText("Owner", { exact: true }).isVisible()).toBe(true);
      expect(await pane.getByText("Projection", { exact: true }).isVisible()).toBe(true);
      expect(await pane.getByRole("link", { name: "evidence.png" }).isVisible()).toBe(true);
      await pane.locator('[data-status="planning"]').first().waitFor();

      const temporal = await Connection.connect({ address: config.temporalAddress });
      try {
        const history = await temporal.workflowService.getWorkflowExecutionHistory({ namespace: config.temporalNamespace, execution: { workflowId } });
        const serialized = JSON.stringify(history).toLowerCase();
        for (const forbidden of ["durable browser task", "survive the restart", imagePath.toLowerCase(), root.toLowerCase(), "ivborw0kggo", invitation.token.toLowerCase(), cookies.join(";").toLowerCase()]) expect(serialized).not.toContain(forbidden);
        await new (await import("@temporalio/client")).Client({ connection: temporal, namespace: config.temporalNamespace }).workflow.getHandle(workflowId).terminate("test complete");
      } finally { temporal.close(); }
      await context.close();
    } finally { await browser.close(); }
  } finally {
    await stopApi().catch(() => undefined);
    await stopWorker().catch(() => undefined);
    await stopTemporal().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
