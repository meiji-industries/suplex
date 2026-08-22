import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { FastifyInstance } from "fastify";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivities } from "../src/temporal/activities.js";
import { ensureTemporalFoundation } from "../src/temporal/service.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService } from "../src/tasks.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

const execFileAsync = promisify(execFile);

interface ArtifactRef { id: string; sha256: string }
interface CommandView { name: string; expectedRevision: number; subject?: { kind: string; value: unknown } }
interface PublicTask {
  id: string;
  revision: number;
  phase: string;
  commands: CommandView[];
  governance: {
    originalPlan?: { subject: PlanSubjectView };
    finalPlan?: { subject: PlanSubjectView };
    materiality?: { evidenceArtifactId: string; evidenceArtifactSha256: string };
    supplementalReview?: { artifactId: string; artifactSha256: string; leadResponse: ArtifactRef };
    originalPlanSubject?: PlanSubjectView | null;
    finalPlanSubject?: PlanSubjectView | null;
    materialityEvidence?: { artifactId: string; artifactSha256: string } | null;
    decision?: { decisionId: string; noteArtifactId: string; noteArtifactSha256: string; subject: unknown };
  };
}
interface PlanSubjectView {
  outputId: string;
  outputRevision: number;
  finalVersion: number;
  artifactId: string;
  artifactSha256: string;
  leadSessionRef: string;
  evidenceManifestArtifactId: string;
  evidenceManifestSha256: string;
  originalPlanRevision: number;
}
interface Ticket07Proof {
  status: "passed";
  repository: string;
  forgeCommitSha: string;
  codexVersion: string;
  model: string;
  profileSettings: { planner: string; reviewer: string };
  productionPath: "api_temporal_activities_sqlite_artifacts";
  leadSessionRef: string;
  reviewerSessionRef: string;
  artifacts: Record<"manifest" | "initialPlan" | "review" | "leadResponse" | "consolidatedPlan" | "materiality" | "revisionNote" | "decision", ArtifactRef>;
  workflowRevisions: number[];
  finalPhase: string;
  finalCommands: string[];
  startedAt: string;
  endedAt: string;
}

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "ticket-07-real", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "ticket-07-real-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/ticket-07-fixture", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a Temporal port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function cookieValue(headers: { "set-cookie"?: string | string[] | undefined }, name: string): string {
  const values = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"] ?? ""];
  const value = values.find((entry) => entry.split("=", 1)[0] === name)?.split(";", 1)[0] ?? "";
  return value.split("=", 2)[1] ?? "";
}

function command(task: PublicTask, name: string): CommandView {
  const value = task.commands.find((entry) => entry.name === name);
  if (!value) throw new Error(`Expected exact command ${name}`);
  return value;
}

async function taskRequest(app: FastifyInstance, taskId: string, cookie: string, origin: string): Promise<PublicTask> {
  const response = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: { cookie, origin } });
  if (response.statusCode !== 200) throw new Error(`Task read failed with HTTP ${response.statusCode}`);
  return response.json() as PublicTask;
}

async function waitForTask(app: FastifyInstance, taskId: string, cookie: string, origin: string, predicate: (task: PublicTask) => boolean, timeoutMs = 180_000): Promise<PublicTask> {
  const deadline = Date.now() + timeoutMs;
  let task = await taskRequest(app, taskId, cookie, origin);
  while (!predicate(task) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    task = await taskRequest(app, taskId, cookie, origin);
  }
  if (!predicate(task)) throw new Error(`Ticket 07 workflow did not reach the expected state before timeout: ${task.phase}`);
  return task;
}

function exactPlan(task: PublicTask, which: "original" | "final"): PlanSubjectView {
  const subject = which === "original" ? task.governance.originalPlanSubject ?? task.governance.originalPlan?.subject : task.governance.finalPlanSubject ?? task.governance.finalPlan?.subject;
  if (!subject) throw new Error(`Missing ${which} exact plan subject`);
  return subject;
}

function exactArtifact(id: string, sha256: string): ArtifactRef {
  return { id, sha256 };
}

test("authenticated Ticket 07 production proof is present and complete", async () => {
  const missing = [
    ["FORGE_TICKET_07_REAL=1", process.env.FORGE_TICKET_07_REAL === "1" ? "1" : ""],
    ["FORGE_TICKET_07_REAL_REPOSITORY", process.env.FORGE_TICKET_07_REAL_REPOSITORY],
    ["FORGE_TICKET_07_REAL_PROOF", process.env.FORGE_TICKET_07_REAL_PROOF],
  ].filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length) throw new Error(`BLOCKED: verify-ticket-07 requires authenticated Codex proof configuration: ${missing.join(", ")}`);

  const startedAt = new Date().toISOString();
  const root = await mkdtemp(join(tmpdir(), "forge-ticket-07-real-"));
  const repositoryRoot = join(root, "repositories");
  const repositoryPath = join(repositoryRoot, "fixture");
  const worktreeRoot = join(root, "worktrees");
  const temporalPort = await availablePort();
  const installationId = `ticket07-${randomUUID().slice(0, 12)}`;
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, installationId, temporalAddress: `127.0.0.1:${temporalPort}`, taskQueue: `ticket07-${randomUUID().slice(0, 12)}`, reachableAddress: "http://127.0.0.1:4111" });
  const repository = process.env.FORGE_TICKET_07_REAL_REPOSITORY!;
  const model = process.env.FORGE_TICKET_07_REAL_MODEL ?? process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-sol";
  let temporalProcess: ChildProcess | undefined;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let app: FastifyInstance | undefined;
  let database: ForgeDatabase | undefined;
  try {
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(join(repositoryPath, "README.md"), "# Ticket 07 fixture\n");
    await execFileAsync("git", ["init", "--quiet", repositoryPath]);
    await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "ticket-07@forge.local"]);
    await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Ticket 07"]);
    await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
    await execFileAsync("git", ["-C", repositoryPath, "commit", "--quiet", "-m", "fixture"]);

    temporalProcess = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(temporalPort), "--db-filename", join(root, "temporal.db"), "--namespace", config.temporalNamespace, "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword"], { stdio: ["ignore", "ignore", "pipe"] });
    let temporalConnection: Connection | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { temporalConnection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    if (!temporalConnection) throw new Error("BLOCKED: local Temporal could not be started for the real Ticket 07 proof");
    await ensureTemporalFoundation(temporalConnection, config);
    await temporalConnection.close();

    database = new ForgeDatabase(config.databasePath);
    database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('ticket07-admin', 'Ticket 07 Admin', 'ticket07-admin@forge.local', 'admin', 'active', ?, ?)").run(startedAt, startedAt));
    const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
    const projects = new ProjectService(database, auth, config, { localRepository, github });
    const company = auth.createCompany("ticket07-admin", "Ticket 07 Fixture Company");
    const lead = projects.createProfile("ticket07-admin", { name: "Ticket 07 Lead", model, reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
    const reviewer = projects.createProfile("ticket07-admin", { name: "Ticket 07 Reviewer", model, reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
    const developer = projects.createProfile("ticket07-admin", { name: "Ticket 07 Developer", model, reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
    const planner = projects.createAgent("ticket07-admin", { name: "Planner", role: "planner", profileId: lead.id });
    const builder = projects.createAgent("ticket07-admin", { name: "Builder", role: "builder", profileId: developer.id });
    const reviewerAgent = projects.createAgent("ticket07-admin", { name: "Reviewer", role: "reviewer", profileId: reviewer.id });
    const project = await projects.createProject("ticket07-admin", company.id, { name: "Ticket 07 Fixture Project", repositoryPath, worktreeRoot, repository, baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { planner: planner.id, reviewer: reviewerAgent.id, builder: builder.id } });
    await projects.activateProject("ticket07-admin", project.id);
    const tasks = new TaskService(database, auth, projects, config);
    app = createApp({ config, auth, projects, tasks, health: {
      temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    } });
    connection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({ connection, namespace: config.temporalNamespace, taskQueue: config.taskQueue, workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)), activities: createActivities(database, config) });
    const workerRun = worker.run();

    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "ticket07-admin", type: "public-key" } } });
    const cookie = `${SESSION_COOKIE_NAME}=${cookieValue(enrolled.headers, SESSION_COOKIE_NAME)}; ${CSRF_COOKIE_NAME}=${cookieValue(enrolled.headers, CSRF_COOKIE_NAME)}`;
    const origin = config.reachableAddress;
    const createdResponse = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload: { projectId: project.id, title: "Exact plan authority fixture", description: "Investigate the fixture repository and produce a complete material plan. Preserve the exact evidence manifest and explain the verification path.", idempotencyKey: randomUUID(), supplementalReview: true } });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as PublicTask;
    const startedResponse = await app.inject({ method: "POST", url: `/api/tasks/${created.id}/start-planning`, headers: { cookie, origin }, payload: { expectedRevision: created.revision } });
    expect(startedResponse.statusCode).toBe(200);
    const planned = await waitForTask(app, created.id, cookie, origin, (task) => task.phase === "approval" && Boolean(task.commands.find((entry) => entry.name === "request_supplemental_review")));
    const initialPlan = exactPlan(planned, "original");
    const reviewCommand = command(planned, "request_supplemental_review");
    const reviewResponse = await app.inject({ method: "POST", url: `/api/tasks/${created.id}/request-supplemental-review`, headers: { cookie, origin }, payload: { expectedRevision: reviewCommand.expectedRevision, subject: reviewCommand.subject?.value, idempotencyKey: randomUUID() } });
    expect(reviewResponse.statusCode).toBe(200);
    const consolidated = await waitForTask(app, created.id, cookie, origin, (task) => task.phase === "approval" && Boolean(task.governance.supplementalReview) && Boolean(task.governance.finalPlanSubject) && task.governance.finalPlanSubject?.finalVersion === 2);
    const consolidatedPlan = exactPlan(consolidated, "final");
    expect(consolidatedPlan.leadSessionRef).toBe(initialPlan.leadSessionRef);
    expect(consolidatedPlan.artifactSha256).not.toBe(initialPlan.artifactSha256);
    const approval = command(consolidated, "approve_plan");
    const approvedResponse = await app.inject({ method: "POST", url: `/api/tasks/${created.id}/approve-plan`, headers: { cookie, origin }, payload: { expectedRevision: approval.expectedRevision, subject: approval.subject?.value, note: "The exact consolidated material plan is approved.", idempotencyKey: randomUUID() } });
    expect(approvedResponse.statusCode).toBe(200);
    const approved = await waitForTask(app, created.id, cookie, origin, (task) => task.phase === "ready_for_development" && Boolean(task.governance.decision));
    const revision = command(approved, "request_plan_revision");
    const revisionResponse = await app.inject({ method: "POST", url: `/api/tasks/${created.id}/request-plan-revision`, headers: { cookie, origin }, payload: { expectedRevision: revision.expectedRevision, subject: revision.subject?.value, note: "Please clarify the rollback verification step.", idempotencyKey: randomUUID() } });
    expect(revisionResponse.statusCode).toBe(200);
    const revised = await waitForTask(app, created.id, cookie, origin, (task) => task.phase === "approval" && (task.governance.finalPlanSubject?.originalPlanRevision ?? 0) > initialPlan.originalPlanRevision);
    const revisionPlan = exactPlan(revised, "final");
    expect(revisionPlan.leadSessionRef).toBe(initialPlan.leadSessionRef);

    const decisionRow = database.authQuery((db) => db.prepare("SELECT id, subject_hash AS subjectHash, note_artifact_id AS noteArtifactId, note_artifact_sha256 AS noteArtifactSha256 FROM forge_plan_decisions WHERE task_id = ? AND decision = 'approve' ORDER BY created_at DESC LIMIT 1").get(created.id) as { id: string; subjectHash: string; noteArtifactId: string; noteArtifactSha256: string } | undefined);
    const revisionNoteRow = database.authQuery((db) => db.prepare("SELECT note_artifact_id AS noteArtifactId, note_artifact_sha256 AS noteArtifactSha256 FROM forge_plan_decisions WHERE task_id = ? AND decision = 'request_revision' ORDER BY created_at DESC LIMIT 1").get(created.id) as { noteArtifactId: string; noteArtifactSha256: string } | undefined);
    const reviewerSessionRow = database.authQuery((db) => db.prepare("SELECT session_ref AS sessionRef FROM forge_plan_reviews WHERE task_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1").get(created.id, company.id) as { sessionRef: string } | undefined);
    if (!decisionRow || !revisionNoteRow || !reviewerSessionRow || !consolidated.governance.supplementalReview || !consolidated.governance.materiality) throw new Error("Real proof is missing an exact persisted artifact receipt");
    const codexVersion = (await execFileAsync(process.env.FORGE_CODEX_COMMAND ?? "codex", ["--version"])).stdout.trim();
    const forgeCommitSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
    const proof: Ticket07Proof = {
      status: "passed",
      repository,
      forgeCommitSha,
      codexVersion,
      model,
      profileSettings: { planner: lead.id, reviewer: reviewer.id },
      productionPath: "api_temporal_activities_sqlite_artifacts",
      leadSessionRef: initialPlan.leadSessionRef,
      reviewerSessionRef: reviewerSessionRow.sessionRef,
      artifacts: {
        manifest: exactArtifact(initialPlan.evidenceManifestArtifactId, initialPlan.evidenceManifestSha256),
        initialPlan: exactArtifact(initialPlan.artifactId, initialPlan.artifactSha256),
        review: exactArtifact(consolidated.governance.supplementalReview.artifactId, consolidated.governance.supplementalReview.artifactSha256),
        leadResponse: consolidated.governance.supplementalReview.leadResponse,
        consolidatedPlan: exactArtifact(consolidatedPlan.artifactId, consolidatedPlan.artifactSha256),
        materiality: exactArtifact(consolidated.governance.materiality.evidenceArtifactId, consolidated.governance.materiality.evidenceArtifactSha256),
        revisionNote: exactArtifact(revisionNoteRow.noteArtifactId, revisionNoteRow.noteArtifactSha256),
        decision: exactArtifact(decisionRow.noteArtifactId, decisionRow.noteArtifactSha256),
      },
      workflowRevisions: [created.revision, planned.revision, consolidated.revision, approved.revision, revised.revision],
      finalPhase: revised.phase,
      finalCommands: revised.commands.map((entry) => entry.name),
      startedAt,
      endedAt: new Date().toISOString(),
    };
    await mkdir(dirname(process.env.FORGE_TICKET_07_REAL_PROOF!), { recursive: true });
    await writeFile(process.env.FORGE_TICKET_07_REAL_PROOF!, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    expect(proof.artifacts.decision.sha256).toMatch(/^[a-f0-9]{64}$/);
    await worker?.shutdown();
    await workerRun;
  } finally {
    await app?.close().catch(() => undefined);
    worker?.shutdown();
    await connection?.close().catch(() => undefined);
    if (temporalProcess && !temporalProcess.killed) temporalProcess.kill("SIGTERM");
    database?.close();
    await rm(root, { recursive: true, force: true });
  }

  const proof = JSON.parse(await readFile(process.env.FORGE_TICKET_07_REAL_PROOF!, "utf8")) as Partial<Ticket07Proof>;
  expect(proof.status).toBe("passed");
  expect(proof.repository).toBe(process.env.FORGE_TICKET_07_REAL_REPOSITORY);
  expect(proof.forgeCommitSha).toMatch(/^[a-f0-9]{40,64}$/i);
  expect(proof.codexVersion).toBeTruthy();
  expect(proof.model).toBeTruthy();
  expect(proof.profileSettings?.planner).toBeTruthy();
  expect(proof.profileSettings?.reviewer).toBeTruthy();
  expect(proof.productionPath).toBe("api_temporal_activities_sqlite_artifacts");
  expect(proof.leadSessionRef).toBeTruthy();
  expect(proof.reviewerSessionRef).toBeTruthy();
  expect(proof.reviewerSessionRef).not.toBe(proof.leadSessionRef);
  for (const artifact of Object.values(proof.artifacts ?? {})) {
    expect(artifact.id).toBeTruthy();
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(Object.keys(proof.artifacts ?? {}).sort()).toEqual(["consolidatedPlan", "decision", "initialPlan", "leadResponse", "manifest", "materiality", "revisionNote", "review"]);
  expect(proof.workflowRevisions).toEqual(expect.arrayContaining([expect.any(Number)]));
  expect(proof.finalPhase).toBeTruthy();
  expect(proof.finalCommands).toEqual(expect.any(Array));
  expect(proof.startedAt).toMatch(/Z$/);
  expect(proof.endedAt).toMatch(/Z$/);
});
