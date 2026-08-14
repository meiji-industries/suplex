import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { ArtifactStore } from "../src/artifacts.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { CapacityManager } from "../src/capacity.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService } from "../src/tasks.js";
import { IssueProjectionEventSchema, IssueWorkflowStateSchema } from "../src/temporal/issue-contracts.js";
import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { WorktreeManager } from "../src/worktrees.js";
import { createWorkflowPortFake } from "./fakes/workflow-port.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

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

test("task API command dispatch preserves revision and evidence lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-api-commands-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  await git(["init", "-b", "main"], repositoryPath);
  await git(["config", "user.name", "Forge Test"], repositoryPath);
  await git(["config", "user.email", "forge-test@example.invalid"], repositoryPath);
  await git(["config", "commit.gpgsign", "false"], repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "base\n");
  await git(["add", "README.md"], repositoryPath);
  await git(["commit", "-m", "base"], repositoryPath);
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "API Company");
  const profile = projects.createProfile("admin-1", { name: "API profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const analyst = projects.createAgent("admin-1", { name: "Analyst", role: "analyst", profileId: profile.id });
  const implementer = projects.createAgent("admin-1", { name: "Implementer", role: "implementer", profileId: profile.id });
  const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const project = await projects.createProject("admin-1", company.id, { name: "API project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { analyst: analyst.id, reviewer: reviewer.id, implementer: implementer.id } });
  const active = await projects.activateProject("admin-1", project.id);
  const workflow = createWorkflowPortFake({ companyId: company.id, projectId: active.id, projectRevisionId: active.activeRevisionId!, projectState: (state) => {
    database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state }));
    return state;
  } });
  let acceptedPlanning = 0;
  const acceptPlanning = workflow.acceptPlanning!;
  workflow.acceptPlanning = async (workflowId, input) => { acceptedPlanning += 1; return acceptPlanning(workflowId, input); };
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: {
    temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  } });
  const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
  const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
  const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "api-admin", type: "public-key" } } });
  const adminUserId = (enrolled.json() as { user: { id: string } }).user.id;
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
  const otherCompany = auth.createCompany(adminUserId, "Other API Company");
  const memberInvitation = auth.inviteUser(adminUserId, { displayName: "Other company member" });
  const memberUserId = memberInvitation.user?.id;
  if (!memberUserId) throw new Error("Expected the invitation to identify the member");
  const memberOptions = await app.inject({ method: "POST", url: "/api/auth/invitation/options", payload: { token: memberInvitation.token } });
  const memberEnrolled = await app.inject({ method: "POST", url: "/api/auth/invitation/verify", payload: { token: memberInvitation.token, challengeId: memberOptions.json().challengeId, response: { id: "other-company-member", type: "public-key" } } });
  const memberSetCookie = memberEnrolled.headers["set-cookie"];
  const memberCookieValues = Array.isArray(memberSetCookie) ? memberSetCookie : typeof memberSetCookie === "string" ? [memberSetCookie] : [];
  const memberCookie = memberCookieValues.map((setCookie) => setCookie.split(";", 1)[0] ?? "").find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
  auth.addMembership(adminUserId, memberUserId, otherCompany.id);
  try {
    const created = await app.inject({ method: "POST", url: `/api/companies/${company.id}/tasks`, headers: { cookie, origin }, payload: { projectId: project.id, title: "API task", description: "# Details", idempotencyKey: "api-task-commands-0001", supplementalReview: true, images: [{ filename: "note.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] } });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; workflowId: string };
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
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/developer-diff`, headers: { cookie, origin } })).statusCode).toBe(409);
    const capacity = new CapacityManager(database, config);
    const queued = capacity.request({ companyId: company.id, taskId: task.id, workflowId: task.workflowId, turnKind: "lead" });
    const capacityResponse = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: { cookie, origin } });
    expect(capacityResponse.json()).toMatchObject({ capacity: { profileId: profile.id, agentName: "Analyst", status: "queued", position: 1, reason: null, requestedAt: queued.requestedAt, retryAt: null } });
    expect(JSON.stringify(capacityResponse.json().capacity)).not.toMatch(/requestId|laneKey|execution|session|wrapper|process|worktree|command|artifact/i);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start-planning`, headers: { cookie, origin }, payload: { expectedRevision: 9 } })).statusCode).toBe(409);
    const started = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start-planning`, headers: { cookie, origin }, payload: { expectedRevision: 0 } });
    expect(started.statusCode).toBe(200);
    expect(acceptedPlanning).toBe(1);
    expect(started.json()).toMatchObject({ phase: "approval", owner: "human", revision: 1, planMaterial: true });
    const planSubject = { companyId: company.id, issueId: task.id, workflowId: task.workflowId, originalPlanRevision: 1, outputId: "plan-output-api", outputRevision: 1, finalVersion: 1 as const, artifactId: "plan-artifact-api", artifactSha256: "1".repeat(64), leadExecutionId: "lead-execution-api", evidenceManifestArtifactId: "lead-manifest-api", evidenceManifestSha256: "2".repeat(64) };
    const materiality = { categories: ["user_visible_behavior"], artifactId: "materiality-api", artifactSha256: "3".repeat(64) };
    const reviewed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/request-supplemental-review`, headers: { cookie, origin }, payload: { expectedRevision: 1, subject: { originalPlan: planSubject, reviewerProfileId: profile.id, evidenceManifestArtifactId: planSubject.evidenceManifestArtifactId, evidenceManifestSha256: planSubject.evidenceManifestSha256 }, idempotencyKey: "review-api-0001" } });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ phase: "approval", revision: 2, supplementalReviewUsed: true });
    const approvalPayload = { expectedRevision: 2, subject: { plan: planSubject, materiality, expectedWorkflowRevision: 2 }, note: "Self-approved", idempotencyKey: "approve-api-0001" };
    const approved = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve-plan`, headers: { cookie, origin }, payload: approvalPayload });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ phase: "ready_for_development", owner: "lead", revision: 4 });
    const artifactStore = new ArtifactStore(config.artifactRoot);
    const reviewEvidence = await artifactStore.put(company.id, "agent-evidence", { filename: "review.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("review evidence\n") });
    const reviewOpinion = await artifactStore.put(company.id, "delivery-review", { filename: "review.json", mimeType: "application/json", bytes: Buffer.from("{\"outcome\":\"approved\"}") });
    const developerDelivery = await artifactStore.put(company.id, "developer-delivery", { filename: "developer-delivery.json", mimeType: "application/json", bytes: Buffer.from("developer delivery\n") });
    const developerEvidence = await artifactStore.put(company.id, "agent-evidence", { filename: "developer-evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("developer evidence\n") });
    const repairReport = await artifactStore.put(company.id, "developer-repair", { filename: "repair.json", mimeType: "application/json", bytes: Buffer.from("repair report\n") });
    const repairEvidence = await artifactStore.put(company.id, "agent-evidence", { filename: "repair-evidence.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("repair evidence\n") });
    const blockerEvidence = await artifactStore.put(company.id, "delivery-blocker", { filename: "blocker.json", mimeType: "application/json", bytes: Buffer.from("delivery blocker\n") });
    database.authQuery((db) => {
      const now = "2026-08-11T00:00:00.000Z";
      for (const artifact of [reviewEvidence, reviewOpinion, developerDelivery, developerEvidence, repairReport, repairEvidence, blockerEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_review_api', ?, ?, ?, 'analyst', 'completed', 1, 'session_lead_api', ?, ?, ?)").run(task.id, company.id, task.workflowId, now, now, reviewEvidence.id);
      db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, created_at) VALUES ('review_api', ?, ?, ?, 1, ?, ?, ?, 'agent_review_api', 'session_lead_api', 'approved', 'Approved API fixture.', ?, ?, ?)").run(task.id, company.id, task.workflowId, "a".repeat(40), "b".repeat(40), "c".repeat(40), reviewOpinion.id, reviewEvidence.id, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_api', ?, ?, ?, 1, 1, 'completed', 'forge/issue/api-task', '/worktree/api-task', ?, 'session_developer_api', ?, ?, ?, ?, 'clean', ?, ?)").run(task.id, company.id, task.workflowId, "a".repeat(40), now, now, "b".repeat(40), "c".repeat(40), developerDelivery.id, developerEvidence.id);
      db.prepare("INSERT INTO forge_delivery_review_attempts (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, developer_execution_id, delivery_artifact_id, developer_evidence_artifact_id, lead_execution_id, lead_session_ref, status, correction_attempts, evidence_artifact_id, completed_review_id, created_at, finished_at) VALUES ('attempt_api', ?, ?, ?, 1, ?, ?, ?, 'developer_api', ?, ?, 'agent_review_api', 'session_lead_api', 'completed', 0, ?, 'review_api', ?, ?)").run(task.id, company.id, task.workflowId, "a".repeat(40), "b".repeat(40), "c".repeat(40), developerDelivery.id, developerEvidence.id, reviewEvidence.id, now, now);
      db.prepare("INSERT INTO forge_delivery_repairs (id, task_id, company_id, workflow_id, review_id, developer_execution_id, cycle, status, subject_commit, subject_tree, result_commit, result_tree, delivery_artifact_id, evidence_artifact_id, created_at, finished_at) VALUES ('repair_api', ?, ?, ?, 'review_api', 'developer_api', 1, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)").run(task.id, company.id, task.workflowId, "b".repeat(40), "c".repeat(40), "d".repeat(40), "e".repeat(40), repairReport.id, repairEvidence.id, now, now);
    });
    const stored = database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(task.id) as { state_json: string });
    const reviewState = IssueWorkflowStateSchema.parse({ ...JSON.parse(stored.state_json), phase: "delivery_reviewed", revision: 5, owner: "human", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Publish draft pull request", lastEventId: `${task.workflowId}:5`, deliveryReviewId: "review_api", deliveryRepairBlockerEvidenceArtifactId: blockerEvidence.id });
    database.projectIssueEvent(IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: reviewState.lastEventId, state: reviewState }));
    const lineage = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: { cookie, origin } });
    expect(lineage.statusCode).toBe(200);
    expect(lineage.json().reviewLineage).toMatchObject({ currentReview: { id: "review_api", baseSha: "a".repeat(40), subjectCommit: "b".repeat(40), subjectTree: "c".repeat(40) }, reviewAttempts: [{ id: "attempt_api", completedReviewId: "review_api" }] });
    const artifactResponse = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${reviewOpinion.id}`, headers: { cookie, origin } });
    expect(artifactResponse.statusCode).toBe(200);
    expect(artifactResponse.headers["cache-control"]).toBe("private, no-store");
    expect(artifactResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(artifactResponse.body).toContain("approved");
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${developerDelivery.id}`, headers: { cookie, origin } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${developerEvidence.id}`, headers: { cookie, origin } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${repairReport.id}`, headers: { cookie, origin } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${repairEvidence.id}`, headers: { cookie, origin } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${blockerEvidence.id}`, headers: { cookie, origin } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${reviewOpinion.id}`, headers: { origin } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: { cookie: memberCookie, origin } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${reviewOpinion.id}`, headers: { cookie: memberCookie, origin } })).statusCode).toBe(404);
    const unrelated = await artifactStore.put(company.id, "task-brief", { filename: "unrelated.md", mimeType: "text/markdown", bytes: Buffer.from("unrelated") });
    database.authQuery((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(unrelated.id, unrelated.companyId, unrelated.kind, unrelated.filename, unrelated.mimeType, unrelated.byteSize, unrelated.sha256, unrelated.storagePath, unrelated.createdAt));
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${unrelated.id}`, headers: { cookie, origin } })).statusCode).toBe(404);
    database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET sha256 = ? WHERE id = ?").run("f".repeat(64), reviewOpinion.id));
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/review-artifacts/${reviewOpinion.id}`, headers: { cookie, origin } })).statusCode).toBe(500);

    const workflowId = task.workflowId;
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

    const targetBaseSha = await git(["rev-parse", "HEAD"], repositoryPath);
    const delivery = await new WorktreeManager().create({ repositoryPath, worktreeRoot, taskId: task.id, targetBaseSha });
    await writeFile(join(delivery.worktreePath, "DELIVERED.md"), "API delivery\n");
    await git(["add", "DELIVERED.md"], delivery.worktreePath);
    await git(["commit", "-m", "deliver API fixture"], delivery.worktreePath);
    const resultCommit = await git(["rev-parse", "HEAD"], delivery.worktreePath);
    const resultTree = await git(["rev-parse", "HEAD^{tree}"], delivery.worktreePath);
    const startingTree = await git(["rev-parse", `${targetBaseSha}^{tree}`], delivery.worktreePath);
    const now = "2026-08-11T00:01:00.000Z";
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_plan_authorizations (id, task_id, company_id, project_id, workflow_id, plan_revision, plan_artifact_id, plan_sha256, authorization_kind, approval_decision_id, authorized_at) VALUES ('authorization-api-diff', ?, ?, ?, ?, 1, ?, ?, 'routine_auto', NULL, ?)").run(task.id, company.id, project.id, task.workflowId, repairReport.id, repairReport.sha256, now);
      db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, legacy, status, reserved_at, activated_at) VALUES ('lease-api-diff', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)").run(task.id, company.id, project.id, task.workflowId, repositoryPath, worktreeRoot, delivery.worktreePath, delivery.branchName, targetBaseSha, "4".repeat(64), now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at, finished_at, result_commit, result_tree, dirty_state) VALUES ('developer-api-diff', ?, ?, ?, 1, 2, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, 'clean')").run(task.id, company.id, task.workflowId, delivery.branchName, delivery.worktreePath, targetBaseSha, now, now, now, resultCommit, resultTree);
      db.prepare("INSERT INTO forge_developer_execution_truth (execution_id, authorization_id, worktree_lease_id, manifest_artifact_id, manifest_sha256, reconciliation_artifact_id, reconciliation_sha256, starting_commit, starting_tree, final_commit, final_tree) VALUES ('developer-api-diff', 'authorization-api-diff', 'lease-api-diff', ?, ?, ?, ?, ?, ?, ?, ?)").run(repairReport.id, repairReport.sha256, repairReport.id, repairReport.sha256, targetBaseSha, startingTree, resultCommit, resultTree);
    });
    const developerDiff = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/developer-diff`, headers: { cookie, origin } });
    expect(developerDiff.statusCode).toBe(200);
    expect(developerDiff.json()).toMatchObject({ branchName: delivery.branchName, baseSha: targetBaseSha, headSha: resultCommit, patch: expect.stringContaining("+API delivery") });
    expect(JSON.stringify(developerDiff.json())).not.toContain(delivery.worktreePath);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve-plan`, headers: { cookie, origin }, payload: approvalPayload })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers: { cookie, origin } })).json().tasks).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/images/does-not-exist`, headers: { cookie, origin } })).statusCode).toBe(404);
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
