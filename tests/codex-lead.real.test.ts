import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { chromium } from "playwright";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { createForgeServer, type ForgeServer } from "../src/server.js";
import { createActivities } from "../src/temporal/activities.js";
import { ensureTemporalFoundation } from "../src/temporal/service.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

const model = process.env.FORGE_CODEX_REAL_MODEL?.trim();
if (!model) throw new Error("Real Lead release gate requires FORGE_CODEX_REAL_MODEL; this gate is intentionally non-skipping.");
try {
  execFileSync(process.env.FORGE_CODEX_COMMAND ?? "codex", ["login", "status"], { stdio: "ignore", timeout: 5_000 });
} catch {
  throw new Error("Real Lead release gate requires an authenticated Codex CLI session; run codex login first.");
}

const execFileAsync = promisify(execFile);

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a Temporal port"));
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function releaseWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) {
      return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "real-release-registration", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([7, 8, 9]), counter: 0 } };
    },
    async generateAuthenticationOptions(input) {
      return { challenge: "real-release-authentication", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

function releaseHeaders(sessionToken: string, csrfToken: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`, "content-type": "application/json", "x-csrf-v1": csrfToken };
}

async function releaseRequest<T>(server: ForgeServer, method: "GET" | "POST", url: string, sessionToken: string, csrfToken: string, body?: unknown): Promise<T> {
  const headers = releaseHeaders(sessionToken, csrfToken);
  const payload = body === undefined ? method === "POST" ? "{}" : undefined : JSON.stringify(body);
  const response = payload === undefined
    ? await server.app.inject({ method, url, headers })
    : await server.app.inject({ method, url, headers, payload });
  if (response.statusCode >= 300) throw new Error(`${method} ${url} failed with ${response.statusCode}: ${response.body}`);
  return response.json() as T;
}

test("the mandatory release seam proves HTTP, Temporal, real Codex, browser resolution, and leakage boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-real-lead-e2e-"));
  const temporalPort = await availablePort();
  const repositoryRoot = join(root, "repositories");
  const repositoryPath = join(repositoryRoot, "meiji-industries", "forge");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "Forge real release seam\n");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "forge-release@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Forge Release"], { cwd: repositoryPath });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:meiji-industries/forge.git"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "real release seam fixture"], { cwd: repositoryPath });

  let temporalProcess: ChildProcess | undefined;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let workerConnection: NativeConnection | undefined;
  let temporalConnection: Connection | undefined;
  let server: ForgeServer | undefined;
  const capturedLogs: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let listening = false;
  try {
    let config = createTestConfig(root, {
      repositoryRoot,
      worktreeRoot,
      artifactRoot: join(root, "artifacts"),
      runtimeRoot: join(root, "runtime"),
      taskQueue: `real-release-${process.pid}-${randomUUID().slice(0, 8)}`,
      temporalAddress: `127.0.0.1:${temporalPort}`,
      reachableAddress: "http://127.0.0.1:4111",
    });
    temporalProcess = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(temporalPort), "--db-filename", join(root, "temporal.db"), "--namespace", config.temporalNamespace, "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword"], { stdio: ["ignore", "ignore", "pipe"] });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        temporalConnection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(temporalConnection).toBeDefined();
    if (!temporalConnection) throw new Error("The isolated Temporal server did not start");
    await ensureTemporalFoundation(temporalConnection, config);
    temporalConnection.close();
    temporalConnection = undefined;

    server = await createForgeServer(config, { logSink: (line) => capturedLogs.push(line) });
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({ connection: workerConnection, namespace: config.temporalNamespace, taskQueue: config.taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: createActivities(server.database, config, { logSink: (line) => capturedLogs.push(line) }) });
    workerRun = worker.run();

    const auth = new AuthService(server.database, config, { webAuthn: releaseWebAuthn() });
    const invitation = auth.ensureBootstrapInvitation();
    if (!invitation) throw new Error("The release gate could not create its temporary administrator invitation");
    const registration = await auth.beginBootstrapRegistration(invitation.token);
    const enrolled = await auth.completeBootstrapRegistration({ token: invitation.token, challengeId: registration.challengeId, response: { id: "real-release-admin", type: "public-key" } });
    const csrfToken = "real-release-csrf-".padEnd(64, "x");
    const seededCredentials = [invitation.token, enrolled.sessionToken, csrfToken];

    const company = await releaseRequest<{ id: string }>(server, "POST", "/api/admin/companies", enrolled.sessionToken, csrfToken, { name: "Real Release Company" });
    const profile = await releaseRequest<{ id: string }>(server, "POST", "/api/admin/profiles", enrolled.sessionToken, csrfToken, { name: "Real Release Lead", model, reasoningLevel: "low", servicePriority: "standard", capacity: 1 });
    const createAgent = async (name: string, role: "planner" | "builder" | "reviewer") => releaseRequest<{ id: string }>(server!, "POST", "/api/admin/agents", enrolled.sessionToken, csrfToken, { name, role, profileId: profile.id });
    const planner = await createAgent("Real Release Planner", "planner");
    const builder = await createAgent("Real Release Builder", "builder");
    const reviewer = await createAgent("Real Release Reviewer", "reviewer");
    const projectDraft = await releaseRequest<{ id: string }>(server, "POST", `/api/companies/${company.id}/projects`, enrolled.sessionToken, csrfToken, {
      name: "Real Release Project",
      repositoryPath,
      worktreeRoot,
      repository: "meiji-industries/forge",
      baseBranch: "main",
      targetBranch: "main",
      setupCommand: "pnpm install",
      verificationCommand: "pnpm test",
      requiredChecks: ["Tests / unit"],
      roleDefaults: { planner: planner.id, builder: builder.id, reviewer: reviewer.id },
    });
    const project = await releaseRequest<{ id: string; status: string; activeRevisionId?: string }>(server, "POST", `/api/projects/${projectDraft.id}/activate`, enrolled.sessionToken, csrfToken);
    expect(project.status).toBe("active");
    expect(project.activeRevisionId).toBeTruthy();

    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const createTask = (title: string, description: string, idempotencyKey: string, withImage = false) => releaseRequest<{ id: string; phase: string; revision: number }>(server!, "POST", `/api/companies/${company.id}/tasks`, enrolled.sessionToken, csrfToken, {
      projectId: project.id,
      title,
      description,
      idempotencyKey,
      images: withImage ? [{ filename: "release.png", mimeType: "image/png", base64: image }] : [],
      roleAgents: { planner: planner.id },
    });
    const getTask = (taskId: string) => releaseRequest<Record<string, unknown>>(server!, "GET", `/api/tasks/${taskId}`, enrolled.sessionToken, csrfToken);
    const startPlanning = async (taskId: string, revision: number) => {
      const accepted = await releaseRequest<Record<string, unknown>>(server!, "POST", `/api/tasks/${taskId}/start-planning`, enrolled.sessionToken, csrfToken, { expectedRevision: revision });
      if (accepted.phase !== "planning") return accepted;
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const projected = await getTask(taskId);
        if (projected.phase !== "planning") return projected;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Lead planning did not finish for ${taskId}`);
    };
    const first = await createTask("Release material plan", "Produce a material plan for a small user-visible behavior change. This is intentionally material and must include the user_visible_behavior material category. Return a complete schema-bound plan.", "release-first", true);
    const firstPlan = await startPlanning(first.id, first.revision);
    expect(firstPlan.phase).toBe("approval");
    expect((firstPlan.leadOutput as { kind: string }).kind).toBe("plan");
    expect(firstPlan.leadInputManifestArtifactId).toBeTruthy();
    expect(firstPlan.leadEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    const firstSession = (firstPlan.leadOutput as { sessionRef: string }).sessionRef;
    expect(firstSession).toMatch(/^session_/);
    const rejected = await releaseRequest<Record<string, unknown>>(server, "POST", `/api/tasks/${first.id}/reject-plan`, enrolled.sessionToken, csrfToken, { expectedRevision: firstPlan.revision, note: "Keep the same scope and make the verification criterion more explicit." });
    expect(rejected.phase).toBe("planning");
    const revised = await startPlanning(first.id, rejected.revision as number);
    expect(revised.phase).toBe("approval");
    expect((revised.leadOutput as { kind: string }).kind).toBe("plan");
    expect((revised.leadOutput as { sessionRef: string }).sessionRef).toBe(firstSession);

    const second = await createTask("Release isolated plan", "Produce a small independent material plan for a separate issue. This is intentionally material and must include the user_visible_behavior material category. Return a complete schema-bound plan, not a decision blocker. Keep this issue isolated from every other issue.", "release-second");
    const secondPlan = await startPlanning(second.id, second.revision);
    expect(secondPlan.phase).toBe("approval");
    const secondSession = (secondPlan.leadOutput as { sessionRef: string }).sessionRef;
    expect(secondSession).toMatch(/^session_/);
    expect(secondSession).not.toBe(firstSession);

    const blocker = await createTask("Release decision blocker", "Do not choose a default or invent a product decision. Return a decision_blocker with exactly one human question asking whether the setting should be strict or permissive, and wait for the answer before producing a plan.", "release-blocker");
    const blocked = await startPlanning(blocker.id, blocker.revision);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.allowedCommands).toEqual(["resolve_decision_blocker", "cancel_issue"]);
    expect((blocked.leadOutput as { kind: string }).kind).toBe("decision_blocker");
    expect(blocked.blockedCategory).toBe("human_decision");
    expect(blocked.leadOutput).not.toHaveProperty("material");
    const blockerSession = (blocked.leadOutput as { sessionRef: string }).sessionRef;
    expect(blockerSession).toMatch(/^session_/);

    await server.app.listen({ host: "127.0.0.1", port: 0 });
    listening = true;
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("The release API did not expose a browser address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const narrowContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const cookies = [{ name: SESSION_COOKIE_NAME, value: enrolled.sessionToken, domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: csrfToken, domain: "127.0.0.1", path: "/" }];
    await desktopContext.addCookies(cookies);
    await narrowContext.addCookies(cookies);
    const desktop = await desktopContext.newPage();
    await desktop.goto(`${baseUrl}/tasks/${encodeURIComponent(blocker.id)}?company=${encodeURIComponent(company.id)}`);
    await desktop.getByRole("heading", { name: "Decision blocker", exact: true }).waitFor();
    const history = desktop.locator("[data-task-history]");
    await history.getByRole("tab", { name: "Invocations", exact: true }).click();
    const invocations = history.locator("[data-task-invocations]");
    await invocations.getByText("lead · attempt 1", { exact: true }).waitFor();
    await invocations.getByText("completed", { exact: true }).waitFor();
    await invocations.getByText(/^artifact_/).waitFor();
    await invocations.getByText(blockerSession, { exact: true }).waitFor();
    expect(await desktop.locator("body").innerText()).not.toContain("Start development");
    await desktop.locator("#decision-answer").fill("Choose strict mode.");
    await desktop.getByRole("button", { name: "Resolve decision", exact: true }).click();
    await desktop.getByRole("heading", { name: "Lead plan", exact: true }).waitFor({ timeout: 300_000 });
    const desktopText = await desktop.locator("body").innerText();
    expect(await desktop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const resolved = await releaseRequest<Record<string, unknown>>(server, "GET", `/api/tasks/${blocker.id}`, enrolled.sessionToken, csrfToken);
    expect(resolved.phase).toBe("approval");
    expect((resolved.leadOutput as { sessionRef: string }).sessionRef).toBe(blockerSession);
    const narrow = await narrowContext.newPage();
    await narrow.goto(`${baseUrl}/tasks/${encodeURIComponent(blocker.id)}?company=${encodeURIComponent(company.id)}`);
    await narrow.getByRole("heading", { name: "Lead plan", exact: true }).waitFor();
    const narrowText = await narrow.locator("body").innerText();
    expect(await narrow.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await desktopContext.close();
    await narrowContext.close();
    browser.close();
    browser = undefined;

    const executions = server.database.authQuery((db) => db.prepare("SELECT task_id, session_ref, resolved_model, resolved_reasoning_level, resolved_service_priority, wrapper_pid, process_pid FROM forge_agent_executions WHERE company_id = ? ORDER BY started_at").all(company.id) as Array<{ task_id: string; session_ref: string | null; resolved_model: string; resolved_reasoning_level: string; resolved_service_priority: string; wrapper_pid: number | null; process_pid: number | null }>);
    const firstExecutions = executions.filter((row) => row.task_id === first.id);
    expect(firstExecutions).toHaveLength(2);
    expect(firstExecutions[0]?.session_ref).toBe(firstExecutions[1]?.session_ref);
    expect(executions.every((row) => row.resolved_model === model && row.resolved_reasoning_level === "low" && row.resolved_service_priority === "standard")).toBe(true);
    expect(executions.every((row) => row.wrapper_pid !== null && row.process_pid !== null)).toBe(true);

    const rawSessionIds = new Set<string>();
    const sessionStore = new (await import("../src/codex-session-store.js")).FileSessionStore(config.runtimeRoot);
    for (const sessionRef of [firstSession, secondSession, blockerSession]) {
      const raw = await sessionStore.read(sessionRef);
      if (raw) rawSessionIds.add(raw);
    }
    const historyConnection = await Connection.connect({ address: config.temporalAddress });
    const historyClient = new (await import("@temporalio/client")).Client({ connection: historyConnection, namespace: config.temporalNamespace });
    const firstHistory = JSON.stringify(await historyClient.workflow.getHandle((firstPlan.workflowId as string)).fetchHistory());
    const secondHistory = JSON.stringify(await historyClient.workflow.getHandle((secondPlan.workflowId as string)).fetchHistory());
    const blockerHistory = JSON.stringify(await historyClient.workflow.getHandle((blocked.workflowId as string)).fetchHistory());
    historyConnection.close();
    const artifactRows = server.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE company_id = ?").all(company.id) as Array<{ storage_path: string }>);
    const artifactText = (await Promise.all(artifactRows.map(async (row) => (await import("node:fs/promises")).readFile(join(config.artifactRoot, row.storage_path)))).then((buffers) => buffers.map((bytes) => bytes.toString("utf8")))).join("\n");
    const publicPayload = JSON.stringify([firstPlan, revised, secondPlan, blocked, resolved]);
    const renderedText = `${desktopText}\n${narrowText}`;
    const logs = capturedLogs.join("\n");
    for (const raw of rawSessionIds) {
      expect(firstHistory).not.toContain(raw);
      expect(secondHistory).not.toContain(raw);
      expect(blockerHistory).not.toContain(raw);
      expect(artifactText).not.toContain(raw);
      expect(publicPayload).not.toContain(raw);
      expect(renderedText).not.toContain(raw);
      expect(logs).not.toContain(raw);
    }
    for (const seededCredential of seededCredentials) {
      expect(firstHistory).not.toContain(seededCredential);
      expect(secondHistory).not.toContain(seededCredential);
      expect(blockerHistory).not.toContain(seededCredential);
      expect(artifactText).not.toContain(seededCredential);
      expect(publicPayload).not.toContain(seededCredential);
      expect(renderedText).not.toContain(seededCredential);
      expect(logs).not.toContain(seededCredential);
    }
    const codexVersion = (await execFileAsync(process.env.FORGE_CODEX_COMMAND ?? "codex", ["--version"])).stdout.trim();
    const receipt = {
      codexVersion,
      model,
      sessionEquality: {
        memberRevision: true,
        decisionResolution: true,
        distinctIssue: true,
      },
      workflow: {
        first: { initial: { phase: firstPlan.phase, revision: firstPlan.revision }, revised: { phase: revised.phase, revision: revised.revision } },
        isolated: { phase: secondPlan.phase, revision: secondPlan.revision },
        blocker: { initial: { phase: blocked.phase, revision: blocked.revision }, resolved: { phase: resolved.phase, revision: resolved.revision } },
      },
      artifactHashes: [firstPlan, revised, secondPlan, blocked, resolved].flatMap((task) => [
        task.leadEvidenceSha256,
        task.leadOutputSha256,
        task.leadInputManifestSha256,
      ]).filter((hash): hash is string => typeof hash === "string"),
      sanitized: true,
    };
    await writeFile(join(process.cwd(), ".context", "lead-release-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } finally {
    await browser?.close().catch(() => undefined);
    if (listening && server) await server.app.close().catch(() => undefined);
    temporalConnection?.close();
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await workerConnection?.close();
    server?.database.close();
    temporalProcess?.kill("SIGTERM");
    if (temporalProcess && temporalProcess.exitCode === null) await new Promise<void>((resolve) => temporalProcess!.once("exit", () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);
