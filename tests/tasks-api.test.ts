import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import type { IssueWorkflowInput, IssueWorkflowState, StartPlanningInput } from "../src/temporal/issue-contracts.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "api-challenge", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "auth-challenge", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "base", targetSha: "target" }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

test("task API creates an idempotent backlog card and accepts only the current planning revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-api-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "API Company");
  const profile = projects.createProfile("admin-1", { name: "API profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const project = await projects.createProject("admin-1", company.id, { name: "API project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], allowedProfileIds: [profile.id], roleDefaults: { lead: profile.id, developer: profile.id } });
  const active = await projects.activateProject("admin-1", project.id);
  const workflow: IssueWorkflowPort = {
    async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) { return { workflowId: input.workflowId!, runId: "run" }; },
    async startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return { workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "approval", revision: input.expectedRevision + 1, owner: "human", allowedCommands: ["request_supplemental_review", "approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: false }; },
    async requestSupplementalReview(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return { workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "approval", revision: input.expectedRevision + 1, owner: "human", allowedCommands: ["approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: true }; },
    async approvePlan(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return { workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "ready_for_development", revision: input.expectedRevision + 1, owner: "lead", allowedCommands: ["start_development"], pendingAction: "Start development", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: true }; },
    async rejectPlan(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return { workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "planning", revision: input.expectedRevision + 1, owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false }; },
  };
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: {
    temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  } });
  const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
  const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "api-admin", type: "public-key" } } });
  const rawCookie = enrolled.headers["set-cookie"];
  const values = Array.isArray(rawCookie) ? rawCookie : typeof rawCookie === "string" ? [rawCookie] : [];
  const cookie = (() => {
    for (const setCookie of values) {
      const pair = setCookie.split(";", 1)[0] ?? "";
      const [name, value] = pair.split("=", 2);
      if (name?.trim() === SESSION_COOKIE_NAME && value !== undefined) return `${name.trim()}=${value}`;
    }
    return "";
  })();
  const origin = config.reachableAddress;
  try {
    const created = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload: { projectId: project.id, title: "API task", description: "# Details", idempotencyKey: "api-task-0001", supplementalReview: true, images: [{ filename: "note.png", mimeType: "image/png", base64: Buffer.from("image").toString("base64") }] } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: "API task", phase: "backlog", revision: 0, allowedCommands: ["start_planning"] });
    const duplicate = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload: { projectId: project.id, title: "Other", description: "Other", idempotencyKey: "api-task-0001", images: [] } });
    expect(duplicate.statusCode).toBe(200);
    const task = created.json() as { id: string };
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start-planning`, headers: { cookie, origin }, payload: { expectedRevision: 9 } })).statusCode).toBe(409);
    const started = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start-planning`, headers: { cookie, origin }, payload: { expectedRevision: 0 } });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ phase: "approval", owner: "human", revision: 1, planMaterial: true });
    const reviewed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/request-supplemental-review`, headers: { cookie, origin }, payload: { expectedRevision: 1 } });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ phase: "approval", revision: 2, supplementalReviewUsed: true });
    const approved = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve-plan`, headers: { cookie, origin }, payload: { expectedRevision: 2, note: "Self-approved" } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ phase: "ready_for_development", owner: "lead", revision: 3 });
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve-plan`, headers: { cookie, origin }, payload: { expectedRevision: 2 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers: { cookie, origin } })).json().tasks).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/images/does-not-exist`, headers: { cookie, origin } })).statusCode).toBe(404);
  } finally {
    await app.close(); database.close(); await rm(root, { recursive: true, force: true });
  }
});
