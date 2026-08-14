import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { ArtifactStore } from "../src/artifacts.js";
import { createApp } from "../src/app.js";
import { CapacityManager } from "../src/capacity.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { GithubAdapter } from "../src/github.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import { TaskService } from "../src/tasks.js";
import { IssueProjectionEventSchema } from "../src/temporal/issue-contracts.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createWorkflowPortFake } from "./fakes/workflow-port.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
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
  const analyst = projects.createAgent("admin-1", { name: "Analyst", role: "analyst", profileId: profile.id });
  const implementer = projects.createAgent("admin-1", { name: "Implementer", role: "implementer", profileId: profile.id });
  const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const project = await projects.createProject("admin-1", company.id, { name: "API creation project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { analyst: analyst.id, reviewer: reviewer.id, implementer: implementer.id } });
  const active = await projects.activateProject("admin-1", project.id);
  const workflow = createWorkflowPortFake({ companyId: company.id, projectId: active.id, projectRevisionId: active.activeRevisionId!, projectState: (state) => { database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state })); return state; } });
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: { temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
  const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
  const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "api-creation-admin", type: "public-key" } } });
  const rawCookie = enrolled.headers["set-cookie"]; const values = Array.isArray(rawCookie) ? rawCookie : typeof rawCookie === "string" ? [rawCookie] : [];
  const cookie = values.map((value) => value.split(";", 1)[0] ?? "").find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
  const origin = config.reachableAddress;
  try {
    const payload = { projectId: project.id, title: "API creation task", description: "# Details", idempotencyKey: "api-creation-0001", supplementalReview: true, images: [{ filename: "note.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] };
    const created = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload });
    expect(created.statusCode).toBe(201); expect(created.json()).toMatchObject({ issueKey: "APIC-1", title: "API creation task", phase: "backlog", revision: 0, allowedCommands: ["start_planning"] });
    const duplicate = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload });
    expect(duplicate.statusCode).toBe(200); expect(duplicate.json()).toMatchObject({ id: created.json().id, workflowId: created.json().workflowId });
    const task = created.json() as { id: string; workflowId: string };
    const body = await new ArtifactStore(config.artifactRoot).put(company.id, "release-public-body", { filename: "release.md", mimeType: "text/markdown", bytes: Buffer.from("## Summary\n\nAPI creation task") });
    database.authTransaction((db) => { const now = new Date().toISOString(); db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(body.id, body.companyId, body.kind, body.filename, body.mimeType, body.byteSize, body.sha256, body.storagePath, body.createdAt); db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, body_artifact_id, reused, created_at, updated_at) SELECT 'release-api-creation', id, company_id, workflow_id, 'release-api-creation-key', 'acme/forge', 'issue/api-creation-task', 'main', ?, ?, ?, 'draft', 17, 'https://github.com/acme/forge/pull/17', title, ?, 1, ?, ? FROM forge_tasks WHERE id = ?").run("a".repeat(40), "b".repeat(40), "c".repeat(40), body.id, now, now, task.id); });
    const release = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/release`, headers: { cookie, origin } });
    expect(release.statusCode).toBe(200); expect(release.headers["cache-control"]).toBe("private, no-store"); expect(release.json()).toMatchObject({ id: "release-api-creation", status: "draft", reused: true, pullRequestNumber: 17, bodyPreview: "## Summary\n\nAPI creation task" });
    const releaseBody = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/release/artifacts/${body.id}`, headers: { cookie, origin } });
    expect(releaseBody.statusCode).toBe(200); expect(releaseBody.body).toBe("## Summary\n\nAPI creation task");
    const queued = new CapacityManager(database, config).request({ companyId: company.id, taskId: task.id, workflowId: task.workflowId, turnKind: "lead" });
    const taskResponse = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: { cookie, origin } });
    expect(taskResponse.json()).toMatchObject({ issueKey: "APIC-1", capacity: { profileId: profile.id, agentName: "Analyst", status: "queued", position: 1, requestedAt: queued.requestedAt, retryAt: null } });
    expect(JSON.stringify(taskResponse.json().capacity)).not.toMatch(/requestId|laneKey|execution|session|wrapper|process|worktree|command|artifact/i);
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
