import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { ArtifactStore } from "../src/artifacts.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, type IssueWorkflowInput, type IssueWorkflowState, type StartPlanningInput } from "../src/temporal/issue-contracts.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "api-challenge", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "auth-challenge", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
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
  const projectState = (state: IssueWorkflowState): IssueWorkflowState => {
    database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state }));
    return state;
  };
  const workflow: IssueWorkflowPort = {
    async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) { const state = buildInitialIssueWorkflowState({ ...input, workflowId: input.workflowId! }); projectState(state); return { workflowId: input.workflowId!, runId: "run" }; },
    async startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return projectState({ workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "approval", revision: input.expectedRevision + 1, owner: "human", allowedCommands: ["request_supplemental_review", "approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: false }); },
    async requestSupplementalReview(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return projectState({ workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "approval", revision: input.expectedRevision + 1, owner: "human", allowedCommands: ["approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: true }); },
    async approvePlan(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return projectState({ workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "ready_for_development", revision: input.expectedRevision + 1, owner: "lead", allowedCommands: ["start_development"], pendingAction: "Start development", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: true }); },
    async rejectPlan(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return projectState({ workflowId, companyId: company.id, projectId: active.id, issueId: workflowId.split("-issue-")[1]!, projectRevisionId: active.activeRevisionId!, phase: "planning", revision: input.expectedRevision + 1, owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, planRevision: null, planMaterial: null, materialCategories: [], supplementalReviewUsed: false }); },
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
    const created = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload: { projectId: project.id, title: "API task", description: "# Details", idempotencyKey: "api-task-0001", supplementalReview: true, images: [{ filename: "note.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: "API task", phase: "backlog", revision: 0, allowedCommands: ["start_planning"] });
    const duplicate = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload: { projectId: project.id, title: "API task", description: "# Details", idempotencyKey: "api-task-0001", supplementalReview: true, images: [{ filename: "note.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] } });
    expect(duplicate.statusCode).toBe(200);
    const task = created.json() as { id: string };
    const body = await new ArtifactStore(config.artifactRoot).put(company.id, "release-public-body", { filename: "release.md", mimeType: "text/markdown", bytes: Buffer.from("## Summary\n\nAPI task") });
    database.authTransaction((db) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(body.id, body.companyId, body.kind, body.filename, body.mimeType, body.byteSize, body.sha256, body.storagePath, body.createdAt);
      db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, body_artifact_id, reused, created_at, updated_at) SELECT 'release-api', id, company_id, workflow_id, 'release-api-key', 'acme/forge', 'issue/api-task', 'main', ?, ?, ?, 'draft', 17, 'https://github.com/acme/forge/pull/17', title, ?, 1, ?, ? FROM forge_tasks WHERE id = ?").run("a".repeat(40), "b".repeat(40), "c".repeat(40), body.id, now, now, task.id);
      db.prepare("INSERT INTO forge_provider_operations (id, operation_key, task_id, company_id, workflow_id, project_revision_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, kind, status, attempt, started_at, observed_at, completed_at, created_at, updated_at) SELECT 'provider-api', 'release-api-key:create-draft-pr', id, company_id, workflow_id, project_revision_id, 'release-api-key', 'acme/forge', 'issue/api-task', 'main', ?, ?, ?, 'create-draft-pr', 'completed', 3, ?, ?, ?, ?, ? FROM forge_tasks WHERE id = ?").run("a".repeat(40), "b".repeat(40), "c".repeat(40), now, now, now, now, now, task.id);
    });
    const release = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/release`, headers: { cookie, origin } });
    expect(release.statusCode).toBe(200);
    expect(release.headers["cache-control"]).toBe("private, no-store");
    expect(release.json()).toMatchObject({ id: "release-api", status: "draft", reused: true, pullRequestNumber: 17, bodyPreview: "## Summary\n\nAPI task", operation: { kind: "create-draft-pr", status: "completed", attempt: 3 } });
    const releaseBody = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/release/artifacts/${body.id}`, headers: { cookie, origin } });
    expect(releaseBody.statusCode).toBe(200);
    expect(releaseBody.headers["cache-control"]).toBe("private, no-store");
    expect(releaseBody.body).toBe("## Summary\n\nAPI task");
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/release/artifacts/does-not-exist`, headers: { cookie, origin } })).statusCode).toBe(404);
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
    const workflowId = (created.json() as { workflowId: string }).workflowId;
    const baseSha = "a".repeat(40); const headSha = "b".repeat(40); const treeSha = "c".repeat(40); const observedAt = "2026-08-11T12:00:00.000Z";
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-ci-api', ?, ?, ?, 'api-release', 'acme/forge', 'issue/api-task', 'main', ?, ?, ?, 'draft', 88, 'https://github.com/acme/forge/pull/88', 'API release', ?, ?)").run(task.id, company.id, workflowId, baseSha, headSha, treeSha, observedAt, observedAt);
      db.prepare("INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, expected_head_tree, project_revision_id, policy_hash, policy_json, status, attempt, summary, first_observed_at, propagation_deadline, overall_deadline, created_at, updated_at) VALUES ('ci-api', ?, ?, 'release-ci-api', ?, ?, ?, ?, ?, 'failed', 1, 'failed', ?, '2026-08-11T12:05:00.000Z', '2026-08-11T13:00:00.000Z', ?, ?)").run(task.id, company.id, headSha, treeSha, active.activeRevisionId, "e".repeat(64), JSON.stringify({ projectRevisionId: active.activeRevisionId, requiredChecks: ["Tests / unit"], acceptedConclusions: ["success"] }), observedAt, observedAt, observedAt);
      db.prepare("INSERT INTO forge_ci_attempts (id, run_id, attempt_number, observed_repository, observed_pr_number, observed_base_branch, observed_base_sha, observed_head_branch, observed_head_sha, outcome, reason, owner, repairable, summary, created_at) VALUES ('ci-attempt-api', 'ci-api', 1, 'acme/forge', 88, 'main', ?, 'issue/api-task', ?, 'failed', 'required_check_failed', 'lead', 1, 'failed', ?)").run(baseSha, headSha, observedAt);
      db.prepare("INSERT INTO forge_ci_attempt_checks (id, attempt_id, provider_check_id, name, head_sha, status, conclusion, selected_for_evaluation, created_at) VALUES ('ci-check-api', 'ci-attempt-api', '1', 'Tests / unit', ?, 'completed', 'failure', 1, ?)").run(headSha, observedAt);
    });
    expect(tasks.getTask((enrolled.json() as { user: { id: string } }).user.id, task.id).ci).toBeDefined();
    const projected = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: { cookie, origin } });
    expect(projected.statusCode, projected.body).toBe(200);
    expect(projected.json()).toMatchObject({ ci: { runId: "ci-api", policy: { projectRevisionId: active.activeRevisionId, requiredChecks: ["Tests / unit"], acceptedConclusions: ["success"] }, attempts: [{ id: "ci-attempt-api", checks: [{ providerCheckId: "1", selectedForEvaluation: true }] }] } });
    expect(projected.body).not.toMatch(/session_ref|worktree_path|provider response body|raw logs/i);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve-plan`, headers: { cookie, origin }, payload: { expectedRevision: 2 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers: { cookie, origin } })).json().tasks).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/images/does-not-exist`, headers: { cookie, origin } })).statusCode).toBe(404);
    const artifactStore = new ArtifactStore(config.artifactRoot);
    const otherCompany = auth.createCompany((enrolled.json() as { user: { id: string } }).user.id, "Other API Company");
    const [unlinked, crossCompany] = await Promise.all([
      artifactStore.put(company.id, "ci-evidence", { filename: "unlinked.json", mimeType: "application/json", bytes: Buffer.from("{}") }),
      artifactStore.put(otherCompany.id, "ci-evidence", { filename: "foreign.json", mimeType: "application/json", bytes: Buffer.from("{}") }),
    ]);
    database.authTransaction((db) => {
      for (const artifact of [unlinked, crossCompany]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    });
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/artifacts/${unlinked.id}`, headers: { cookie, origin } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/artifacts/${crossCompany.id}`, headers: { cookie, origin } })).statusCode).toBe(404);
  } finally {
    await app.close(); database.close(); await rm(root, { recursive: true, force: true });
  }
});
