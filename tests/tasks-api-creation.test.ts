import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { ArtifactStore } from "../src/artifacts.js";
import { BrowserProofService } from "../src/browser-proof.js";
import { createApp } from "../src/app.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { GithubAdapter } from "../src/github.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import { TaskService } from "../src/tasks.js";
import { IssueProjectionEventSchema } from "../src/engine/issue-contracts.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createWorkflowPortFake } from "./fakes/workflow-port.js";
import { MAX_TASK_REQUEST_BYTES } from "../src/task-attachment-limits.js";
async function git(args: string[], cwd: string): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
}

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "api-creation", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "api-creation-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

test("task API creation is idempotent and exposes safe backlog/read models", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-api-creation-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  await git(["init", "-b", "main"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await git(["config", "commit.gpgsign", "false"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "base\n"); await git(["add", "README.md"], repositoryPath); await git(["commit", "-m", "base"], repositoryPath);
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "API Creation Company");
  auth.setCompanyIssueCode("admin-1", company.id, "apic");
  const profile = projects.createProfile("admin-1", { name: "API creation profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const planner = projects.createAgent("admin-1", { name: "Planner", role: "planner", profileId: profile.id });
  const builder = projects.createAgent("admin-1", { name: "Builder", role: "builder", profileId: profile.id });
  const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const project = await projects.createProject("admin-1", company.id, { name: "API creation project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { planner: planner.id, reviewer: reviewer.id, builder: builder.id } });
  const active = await projects.activateProject("admin-1", project.id);
  const workflow = createWorkflowPortFake({ companyId: company.id, projectId: active.id, projectRevisionId: active.activeRevisionId!, projectState: (state) => { database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state })); return state; } });
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
  const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
  const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "api-creation-admin", type: "public-key" } } });
  const rawCookie = enrolled.headers["set-cookie"]; const values = Array.isArray(rawCookie) ? rawCookie : typeof rawCookie === "string" ? [rawCookie] : [];
  const cookie = values.map((value) => value.split(";", 1)[0] ?? "").find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
  const origin = config.reachableAddress;
  try {
    const pngBytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2 * 1024 * 1024 - 8)]);
    const payload = { projectId: project.id, title: "API creation task", description: "# Details", idempotencyKey: "api-creation-0001", supplementalReview: true, images: [{ filename: "note.png", mimeType: "image/png", base64: pngBytes.toString("base64") }] };
    const created = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload });
    expect(created.statusCode).toBe(201); expect(created.json()).toMatchObject({ issueKey: "APIC-1", title: "API creation task", phase: "backlog", revision: 0, allowedCommands: ["start_planning", "cancel_issue", "send_planner_note"] });
    expect(created.json().images[0]).toEqual({ artifactId: expect.any(String), filename: "note.png", mimeType: "image/png", byteSize: pngBytes.length });
    const oversized = await app.inject({ method: "PATCH", url: `/api/tasks/${created.json().id}`, headers: { cookie, origin, "content-type": "application/json" }, payload: JSON.stringify({ description: "x".repeat(1_100_000) }) });
    expect(oversized.statusCode).toBe(413); expect(oversized.json()).toEqual({ error: "Request is too large", findings: [{ code: "request-too-large", field: "images", message: "Attach fewer or smaller images and submit again" }] });
    const duplicate = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload });
    expect(duplicate.statusCode).toBe(200); expect(duplicate.json()).toMatchObject({ id: created.json().id, workflowId: created.json().workflowId });
    const largePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2 * 1024 * 1024 - 8)]);
    const largeCreation = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload: { ...payload, title: "Large image task", idempotencyKey: "api-creation-0002", images: [{ filename: "large.png", mimeType: "image/png", base64: largePng.toString("base64") }] } });
    expect(largeCreation.statusCode).toBe(201); expect(largeCreation.json().images).toEqual([expect.objectContaining({ byteSize: 2_097_152 })]);
    const task = created.json() as { id: string; workflowId: string };
    const proofRoot = join(repositoryPath, ".forge-proof"); await mkdir(proofRoot, { recursive: true });
    const proofBytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.alloc(17), Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.alloc(4)]);
    await writeFile(join(proofRoot, "api.png"), proofBytes);
    const proof = await new BrowserProofService(database, new ArtifactStore(config.artifactRoot, database)).ingest({ taskId: task.id, companyId: company.id, developerExecutionId: "developer-api", resultCommit: "d".repeat(40), resultTree: "e".repeat(40), worktreePath: repositoryPath, control: "required", evidence: { captured: true, paths: [".forge-proof/api.png"] } });
    const executionId = "agent_activity_test";
    database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES (?, ?, ?, ?, 'planner', 'running', 1, ?)").run(executionId, task.id, company.id, task.workflowId, new Date().toISOString()));
    database.authQuery((db) => db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, lead_session_ref, status, correction_attempts, failure_code, failure_summary, created_at, finished_at) VALUES ('cancelled-review-attempt', ?, ?, ?, 0, ?, ?, ?, ?, 'lead-session', 'failed', 0, 'cancelled', 'The Codex Lead turn was cancelled.', ?, ?)").run(task.id, company.id, task.workflowId, "a".repeat(40), "b".repeat(40), "c".repeat(40), executionId, new Date().toISOString(), new Date().toISOString()));
    const list = await app.inject({ method: "GET", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin } });
    expect(list.statusCode).toBe(200); expect(list.json().tasks[0]).toMatchObject({ id: task.id, title: "API creation task", agentInvocations: [expect.objectContaining({ id: executionId, role: "planner" })] }); expect(list.json().tasks[0]).not.toHaveProperty("timeline"); expect(list.json().tasks[0]).not.toHaveProperty("activity"); expect(list.json().tasks[0]).not.toHaveProperty("reviewLineage");
    const detail = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: { cookie, origin } });
    expect(detail.statusCode).toBe(200); expect(detail.json().reviewLineage.reviewAttempts).toContainEqual(expect.objectContaining({ id: "cancelled-review-attempt", code: "cancelled" })); expect(detail.json().browserProof).toHaveLength(1);
    const proofResponse = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/artifacts/${proof!.artifactIds[0]}`, headers: { cookie, origin } });
    expect(proofResponse.statusCode).toBe(200); expect(proofResponse.rawPayload).toEqual(proofBytes); expect(proofResponse.headers).toMatchObject({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-type": "image/png", "content-disposition": "inline; filename=\"api.png\"" });
    const wrongTask = await app.inject({ method: "GET", url: `/api/tasks/not-this-task/artifacts/${proof!.artifactIds[0]}`, headers: { cookie, origin } }); expect(wrongTask.statusCode).toBe(404);
    const activity = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/activity`, headers: { cookie, origin } });
    expect(activity.statusCode).toBe(200);
    expect(activity.headers["cache-control"]).toBe("private, no-store");
    expect(activity.json()).toMatchObject({ execution: { id: executionId, role: "planner", status: "running" }, events: expect.arrayContaining([expect.objectContaining({ kind: "status" })]) });
    const body = await new ArtifactStore(config.artifactRoot).putArtifact(company.id, "release-public-body", { filename: "release.md", mimeType: "text/markdown", bytes: Buffer.from("## Summary\n\nAPI creation task") });
    database.authTransaction((db) => { const now = new Date().toISOString(); db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(body.id, body.companyId, body.kind, body.filename, body.mimeType, body.byteSize, body.sha256, body.storagePath, body.createdAt); db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, pr_number, pr_url, title, body_artifact_id, reused, created_at, updated_at) SELECT 'release-api-creation', id, company_id, workflow_id, 'release-api-creation-key', 'acme/forge', 'issue/api-creation-task', 'main', ?, ?, ?, 17, 'https://github.com/acme/forge/pull/17', title, ?, 1, ?, ? FROM forge_tasks WHERE id = ?").run("a".repeat(40), "b".repeat(40), "c".repeat(40), body.id, now, now, task.id); });
    const release = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/release`, headers: { cookie, origin } });
    expect(release.statusCode).toBe(200); expect(release.headers["cache-control"]).toBe("private, no-store"); expect(release.json()).toMatchObject({ id: "release-api-creation", status: "ready", reused: true, pullRequestNumber: 17, bodyPreview: "## Summary\n\nAPI creation task" });
    const releaseBody = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/release/artifacts/${body.id}`, headers: { cookie, origin } });
    expect(releaseBody.statusCode).toBe(200); expect(releaseBody.body).toBe("## Summary\n\nAPI creation task");
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});

async function createTaskEnvironment(companyName: string) {
  const root = await mkdtemp(join(tmpdir(), "forge-task-api-creation-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  await git(["init", "-b", "main"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await git(["config", "commit.gpgsign", "false"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "base\n"); await git(["add", "README.md"], repositoryPath); await git(["commit", "-m", "base"], repositoryPath);
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", companyName);
  auth.setCompanyIssueCode("admin-1", company.id, "apic");
  const profile = projects.createProfile("admin-1", { name: "API creation profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const planner = projects.createAgent("admin-1", { name: "Planner", role: "planner", profileId: profile.id });
  const builder = projects.createAgent("admin-1", { name: "Builder", role: "builder", profileId: profile.id });
  const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const project = await projects.createProject("admin-1", company.id, { name: "API creation project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { planner: planner.id, reviewer: reviewer.id, builder: builder.id } });
  const active = await projects.activateProject("admin-1", project.id);
  const workflow = createWorkflowPortFake({ companyId: company.id, projectId: active.id, projectRevisionId: active.activeRevisionId!, projectState: (state) => { database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state })); return state; } });
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
  const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
  const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "api-creation-admin", type: "public-key" } } });
  const rawCookie = enrolled.headers["set-cookie"]; const values = Array.isArray(rawCookie) ? rawCookie : typeof rawCookie === "string" ? [rawCookie] : [];
  const cookie = values.map((value) => value.split(";", 1)[0] ?? "").find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
  return { app, config, company, project: active, cookie, close: async () => { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("task creation starts planning only when requested", async () => {
  const t = await createTaskEnvironment("Immediate start Company");
  try {
    const headers = { cookie: t.cookie, origin: t.config.reachableAddress };
    const immediately = await t.app.inject({ method: "POST", url: `/api/companies/${t.company.id}/tasks`, headers, payload: { projectId: t.project.id, title: "Immediate task", description: "# Details", idempotencyKey: "immediate-start-0001", startImmediately: true } });
    expect(immediately.statusCode).toBe(201);
    expect(immediately.json().phase).not.toBe("backlog");
    expect(immediately.json().allowedCommands).not.toContain("start_planning");

    const backlog = await t.app.inject({ method: "POST", url: `/api/companies/${t.company.id}/tasks`, headers, payload: { projectId: t.project.id, title: "Backlog task", description: "# Details", idempotencyKey: "backlog-start-0001", startImmediately: false } });
    expect(backlog.statusCode).toBe(201);
    expect(backlog.json()).toMatchObject({ phase: "backlog" });
    expect(backlog.json().allowedCommands).toContain("start_planning");
  } finally { await t.close(); }
});

test("task creation accepts a multi-megabyte image attachment", async () => {
  const t = await createTaskEnvironment("Large Image Company");
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2 * 1024 * 1024 - 8)]);
    const created = await t.app.inject({ method: "POST", url: `/api/companies/${t.company.id}/tasks`, headers: { cookie: t.cookie, origin: t.config.reachableAddress }, payload: { projectId: t.project.id, title: "Large image task", description: "# Details", idempotencyKey: "large-image-0001", images: [{ filename: "big.png", mimeType: "image/png", base64: png.toString("base64") }] } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: "Large image task", images: [expect.objectContaining({ filename: "big.png", byteSize: 2 * 1024 * 1024 })] });
  } finally { await t.close(); }
});

test("task creation body larger than the route limit answers 413", async () => {
  const t = await createTaskEnvironment("Oversize Company");
  try {
    const oversized = "A".repeat(MAX_TASK_REQUEST_BYTES + 1);
    const rejected = await t.app.inject({ method: "POST", url: `/api/companies/${t.company.id}/tasks`, headers: { cookie: t.cookie, origin: t.config.reachableAddress }, payload: { projectId: t.project.id, title: "Oversize task", description: "# Details", idempotencyKey: "oversize-0001", images: [{ filename: "big.png", mimeType: "image/png", base64: oversized }] } });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toMatchObject({ error: "Request is too large", findings: [{ code: "request-too-large", field: "images" }] });
  } finally { await t.close(); }
});
