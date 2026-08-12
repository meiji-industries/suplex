import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { ArtifactStore } from "../src/artifacts.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectService, type LocalRepositoryAdapter } from "../src/projects.js";
import type { GithubAdapter } from "../src/github.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import { TaskResponseSchema } from "../src/http/contracts/tasks.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, type IssueWorkflowInput, type IssueWorkflowState, type StartPlanningInput } from "../src/temporal/issue-contracts.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "browser-task", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; }, async generateAuthenticationOptions(input) { return { challenge: "browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

test("task creation and the dedicated board remain usable on desktop and narrow viewports", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-browser-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  const imagePath = join(root, "evidence.png"); await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const workerDatabase = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Browser Tasks");
  const profile = projects.createProfile("admin-1", { name: "Browser task profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const project = await projects.createProject("admin-1", company.id, { name: "Browser task project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], allowedProfileIds: [profile.id], roleDefaults: { lead: profile.id, developer: profile.id } });
  const activeProject = await projects.activateProject("admin-1", project.id);
  let plannedState: IssueWorkflowState | undefined;
  let finishPlanning = (): void => {};
  const planningGate = new Promise<void>((resolve) => { finishPlanning = resolve; });
  const projectState = (state: IssueWorkflowState): void => {
    const event = IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state });
    workerDatabase.observeIssueProjection(event);
    workerDatabase.projectIssueEvent(event);
  };
  const workflow: IssueWorkflowPort = { async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) {
    plannedState = buildInitialIssueWorkflowState({ ...input, workflowId: input.workflowId! });
    projectState(plannedState);
    return { workflowId: input.workflowId!, runId: "run" };
  }, async startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const taskId = workflowId.split("-issue-")[1]!;
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    await planningGate;
    const artifactStore = new ArtifactStore(config.artifactRoot);
    const evidence = await artifactStore.put(company.id, "agent-evidence", { filename: "agent.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"turn.completed\"}\n") });
    const output = await artifactStore.put(company.id, "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "A focused browser plan", reproduction: null, rootCauseAnalysis: "The fixture was incomplete.", steps: [{ number: 1, instruction: "Inspect repository", verification: "The issue is understood" }, { number: 2, instruction: "Run focused tests", verification: "The focused suite passes" }], compatibilityAnalysis: "The change is local.", operationalAnalysis: "No operational change.", verificationStrategy: "Run the focused suite.", unresolvedTechnicalQuestions: [] })) });
    database.authQuery((db) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, output.id, output.companyId, output.kind, output.filename, output.mimeType, output.byteSize, output.sha256, output.storagePath, output.createdAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_browser', ?, ?, ?, 'lead', 'completed', 1, 'session_browser', ?, ?, ?)").run(taskId, company.id, workflowId, now, now, evidence.id);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_browser', ?, ?, ?, 'agent_browser', ?, 'plan', ?, ?, 'session_browser', 'A focused browser plan', ?)").run(taskId, company.id, workflowId, input.expectedRevision + 1, output.id, evidence.id, now);
    });
    plannedState = { workflowId, companyId: company.id, projectId: project.id, issueId: taskId, projectRevisionId: plannedState!.projectRevisionId, phase: "approval", revision: input.expectedRevision + 2, owner: "human", allowedCommands: ["request_supplemental_review", "approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${workflowId}:${input.expectedRevision + 2}`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_browser", leadExecutionId: "agent_browser", leadEvidenceArtifactId: evidence.id, leadOutputArtifactId: output.id, leadOutputKind: "plan", leadSummary: "A focused browser plan", planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: false };
    projectState(plannedState);
    return plannedState;
  }, async requestSupplementalReview(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, allowedCommands: ["approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}`, supplementalReviewUsed: true };
    projectState(plannedState);
    return plannedState;
  }, async approvePlan(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development"], pendingAction: "Start development", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    return plannedState;
  }, async publishDraft(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const releaseBody = await new ArtifactStore(config.artifactRoot).put(company.id, "release-public-body", { filename: "release.md", mimeType: "text/markdown", bytes: Buffer.from("## Summary\n\nBrowser task") });
    database.authTransaction((db) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(releaseBody.id, releaseBody.companyId, releaseBody.kind, releaseBody.filename, releaseBody.mimeType, releaseBody.byteSize, releaseBody.sha256, releaseBody.storagePath, releaseBody.createdAt);
      db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, body_artifact_id, reused, created_at, updated_at) VALUES ('release-browser', ?, ?, ?, 'release-browser-key', 'acme/forge', 'issue/browser-task', 'main', ?, ?, ?, 'draft', 21, 'https://github.com/acme/forge/pull/21', 'Browser task', ?, 1, ?, ?)").run(plannedState!.issueId, company.id, plannedState!.workflowId, "a".repeat(40), "b".repeat(40), "c".repeat(40), releaseBody.id, now, now);
    });
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue"], pendingAction: "Waiting for required CI", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    return plannedState;
  }, async startDevelopment(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const taskId = workflowId.split("-issue-")[1]!;
    const now = new Date().toISOString();
    database.authQuery((db) => db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, failure_code, failure_summary, updated_at) VALUES ('merge-browser', ?, ?, ?, ?, ?, NULL, NULL, 'blocked', '[]', ?, ?, ?, 'pre_release', ?, 'provider_unavailable', 'Provider unavailable', ?)").run(taskId, company.id, "a".repeat(40), "a".repeat(40), "c".repeat(40), now, workflowId, project.activeRevisionId!, "c".repeat(40), now));
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: "Provider unavailable", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, targetBaseSha: "a".repeat(40), targetBaseCheckId: "merge-browser", targetBaseCheckpoint: "pre_release", targetBaseOutcome: "blocked", targetBaseBlockerCode: "provider_unavailable", targetBaseBlockerOwner: "provider", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Provider unavailable", resultCommit: "c".repeat(40), resultTree: "d".repeat(40) };
    projectState(plannedState);
    return plannedState;
  }, async retryTargetBaseReconciliation(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET status = 'conflict', current_base_sha = ?, conflict_files_json = '[\"README.md\"]', conflict_file_count = 1, failure_code = NULL, failure_summary = NULL, updated_at = ? WHERE id = 'merge-browser'").run("b".repeat(40), new Date().toISOString()));
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, targetBaseOutcome: "conflict", targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null, forwardMergeId: "merge-browser", forwardMergePriorHead: "c".repeat(40), forwardMergePriorTree: "d".repeat(40), forwardMergeTargetBaseSha: "b".repeat(40), forwardMergeConflictArtifact: { id: "conflict-browser", sha256: "e".repeat(64), kind: "forward-merge-conflict" }, forwardMergeConflictFileCount: 1, mergeResolutionPlanArtifactId: "conflict-plan-browser" };
    projectState(plannedState);
    return plannedState;
  }, async resolveMergeConflict(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET status = 'merged', result_head = ?, result_tree = ?, failure_code = 'verification_failed', failure_summary = 'Pinned verification failed', updated_at = ? WHERE id = 'merge-browser'").run("f".repeat(40), "1".repeat(40), new Date().toISOString()));
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "delivery_blocked", owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: "Pinned verification failed", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, targetBaseOutcome: "blocked", targetBaseBlockerCode: "verification_failed", targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Pinned verification failed", resultCommit: "f".repeat(40), resultTree: "1".repeat(40) };
    projectState(plannedState);
    return plannedState;
  }, async retryForwardMergeVerification(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET status = 'no_drift', failure_code = NULL, failure_summary = NULL, updated_at = ? WHERE id = 'merge-browser'").run(new Date().toISOString()));
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "delivery_reviewed", owner: "lead", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Publish one exact draft pull request", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, targetBaseOutcome: "no_drift", targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null };
    projectState(plannedState);
    return plannedState;
  }, async rejectPlan(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    return plannedState;
  } };
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: { temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Browser task server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "browser-task-admin", type: "public-key" } } });
    const values = Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [enrolled.headers["set-cookie"] ?? ""];
    const cookie = values.find((value) => value.split("=", 1)[0] === SESSION_COOKIE_NAME)?.split(";", 1)[0] ?? "";
    const csrf = values.find((value) => value.split("=", 1)[0] === CSRF_COOKIE_NAME)?.split(";", 1)[0] ?? "";
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addCookies([
        { name: SESSION_COOKIE_NAME, value: cookie.split("=", 2)[1] ?? "", domain: "127.0.0.1", path: "/" },
        { name: CSRF_COOKIE_NAME, value: csrf.split("=", 2)[1] ?? "", domain: "127.0.0.1", path: "/" },
      ]);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/tasks`);
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      const newTaskButton = page.getByRole("button", { name: "New task", exact: true });
      await newTaskButton.waitFor();
      expect(await newTaskButton.isEnabled()).toBe(true);
      expect(await page.getByText("No tasks yet. Press ⌘N to create one.", { exact: true }).isVisible()).toBe(true);
      await page.keyboard.press("Meta+N");
      await page.getByRole("dialog", { name: "New task" }).waitFor();
      await page.getByRole("combobox", { name: "Project" }).click();
      await page.getByRole("option", { name: "Browser task project" }).click();
      expect(await page.locator("#task-project").innerText()).toBe("Browser task project");
      await page.getByLabel("Task title", { exact: true }).fill("Browser task");
      await page.getByLabel("Task description", { exact: true }).fill("## Browser brief\n\nImage attached.");
      await page.getByRole("button", { name: "Add images", exact: true }).waitFor();
      await page.getByLabel("Task images", { exact: true }).setInputFiles(imagePath);
      await page.getByRole("button", { name: "Remove evidence.png", exact: true }).waitFor();
      await page.getByRole("button", { name: "Create task" }).click();
      await page.waitForURL(/\/tasks\/[^/?]+/);
      const detailPath = new URL(page.url()).pathname;
      const taskId = detailPath.split("/").at(-1)!;
      const taskDetail = page.locator("[data-task-detail]");
      await taskDetail.waitFor();
      expect(await taskDetail.getByRole("heading", { name: "Browser task", exact: true, level: 2 }).isVisible()).toBe(true);
      expect(await page.locator("[data-app-header]").getByRole("link", { name: "Host health", exact: true }).count()).toBe(0);
      expect(await taskDetail.getByRole("button", { name: "Task options", exact: true }).count()).toBe(0);
      await page.locator("[data-app-header]").getByRole("button", { name: "Task options", exact: true }).click();
      expect(await page.getByRole("menuitem", { name: "Coming soon", exact: true }).isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      expect(await page.getByRole("dialog").count()).toBe(0);
      const contentBox = await taskDetail.locator("[data-task-content]").boundingBox();
      const headerContentBox = await taskDetail.locator("[data-task-header-content]").boundingBox();
      const taskActionsBox = await taskDetail.locator("[data-task-actions]").boundingBox();
      const taskActionButtonBox = await taskDetail.locator("[data-task-actions]").getByRole("button").first().boundingBox();
      const detailContentBox = await taskDetail.locator("[data-task-content-inner]").boundingBox();
      const propertiesBox = await taskDetail.locator("[data-task-properties]").boundingBox();
      expect(contentBox).not.toBeNull(); expect(headerContentBox).not.toBeNull(); expect(taskActionsBox).not.toBeNull(); expect(taskActionButtonBox).not.toBeNull(); expect(detailContentBox).not.toBeNull(); expect(propertiesBox).not.toBeNull();
      expect(propertiesBox!.x).toBeGreaterThan(contentBox!.x);
      expect(Math.abs(headerContentBox!.x - detailContentBox!.x)).toBeLessThan(1);
      expect(Math.abs(headerContentBox!.x + headerContentBox!.width - taskActionsBox!.x - taskActionsBox!.width)).toBeLessThan(1);
      expect(Math.abs(headerContentBox!.x + headerContentBox!.width - taskActionButtonBox!.x - taskActionButtonBox!.width)).toBeLessThan(1);
      const observer = await context.newPage();
      await observer.goto(page.url());
      const observerDetail = observer.locator("[data-task-detail]");
      await observerDetail.getByRole("heading", { name: "Browser task", exact: true, level: 2 }).waitFor();
      await taskDetail.getByRole("button", { name: "Start planning", exact: true }).click();
      await taskDetail.locator('[data-status="planning"]').waitFor();
      await observerDetail.locator('[data-status="planning"]').waitFor();
      database.authTransaction((db) => {
        const task = db.prepare("SELECT workflow_id AS workflowId FROM forge_tasks WHERE id = ?").get(taskId) as { workflowId: string };
        const observedAt = "2026-08-11T12:00:00.000Z";
        const baseSha = "a".repeat(40); const headSha = "b".repeat(40); const treeSha = "c".repeat(40);
        db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-ci-browser', ?, ?, ?, 'browser-release', 'acme/forge', 'issue/browser-task', 'main', ?, ?, ?, 'draft', 77, 'https://github.com/acme/forge/pull/77', 'Browser release', ?, ?)").run(taskId, company.id, task.workflowId, baseSha, headSha, treeSha, observedAt, observedAt);
        db.prepare("INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, expected_head_tree, project_revision_id, policy_hash, policy_json, status, attempt, summary, first_observed_at, propagation_deadline, overall_deadline, completed_at, created_at, updated_at) VALUES ('ci-browser', ?, ?, 'release-ci-browser', ?, ?, ?, ?, ?, 'failed', 1, 'One required check failed', ?, '2026-08-11T12:05:00.000Z', '2026-08-11T13:00:00.000Z', ?, ?, ?)").run(taskId, company.id, headSha, treeSha, activeProject.activeRevisionId, "f".repeat(64), JSON.stringify({ projectRevisionId: activeProject.activeRevisionId, requiredChecks: ["Tests / unit with an intentionally long but bounded display name that must wrap safely"], acceptedConclusions: ["success"] }), observedAt, observedAt, observedAt, observedAt);
        db.prepare("INSERT INTO forge_ci_attempts (id, run_id, attempt_number, observed_repository, observed_pr_number, observed_base_branch, observed_base_sha, observed_head_branch, observed_head_sha, outcome, reason, owner, repairable, summary, created_at) VALUES ('ci-attempt-browser', 'ci-browser', 1, 'acme/forge', 77, 'main', ?, 'issue/browser-task', ?, 'failed', 'required_check_failed', 'lead', 1, ?, ?)").run(baseSha, headSha, `The focused check failed safely. ${"bounded ".repeat(40)}`, observedAt);
        db.prepare("INSERT INTO forge_ci_attempt_checks (id, attempt_id, provider_check_id, name, head_sha, status, conclusion, details_url, summary, started_at, completed_at, selected_for_evaluation, created_at) VALUES ('ci-check-browser', 'ci-attempt-browser', '90071992547409932', 'Tests / unit with an intentionally long but bounded display name that must wrap safely', ?, 'completed', 'failure', 'https://github.com/acme/forge/actions/runs/77', 'A bounded failure summary', ?, ?, 1, ?)").run(headSha, observedAt, observedAt, observedAt);
      });
      finishPlanning();
      await expect.poll(() => plannedState?.phase).toBe("approval");
      TaskResponseSchema.parse(tasks.getTask((enrolled.json() as { user: { id: string } }).user.id, taskId));
      await expect.poll(() => workerDatabase.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get(plannedState!.issueId))).toEqual({ revision: 2, phase: "approval" });
      await taskDetail.locator('[data-status="approval"]').waitFor();
      await observerDetail.locator('[data-status="approval"]').waitFor();
      await taskDetail.getByText("evidence.png", { exact: true }).waitFor();
      await taskDetail.getByText("Lead plan", { exact: true }).waitFor();
      await taskDetail.getByText("Inspect repository", { exact: true }).waitFor();
      const ciDetail = taskDetail.locator("[data-task-ci]");
      await ciDetail.getByText("Exact-head CI", { exact: true }).waitFor();
      expect(await ciDetail.getByText("required_check_failed:", { exact: false }).isVisible()).toBe(true);
      const prLink = ciDetail.getByRole("link", { name: "PR #77", exact: true });
      await prLink.focus();
      expect(await prLink.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await taskDetail.locator('[data-task-lead-plan] [data-slot="accordion"]').count()).toBe(1);
      await taskDetail.getByRole("button", { name: "Inspect repository", exact: true }).click();
      await taskDetail.getByText("The issue is understood", { exact: true }).waitFor();
      await taskDetail.getByRole("button", { name: "Request review", exact: true }).click();
      await taskDetail.getByRole("button", { name: "Approve plan", exact: true }).waitFor();
      await taskDetail.getByRole("button", { name: "Approve plan", exact: true }).click();
      await taskDetail.locator('[data-status="ready_for_development"]').waitFor();
      await taskDetail.getByRole("button", { name: "Start development", exact: true }).click();
      await taskDetail.locator('[data-status="delivery_blocked"]').waitFor();
      await taskDetail.getByText("Target-base reconciliation", { exact: true }).waitFor();
      await taskDetail.getByText("Provider unavailable", { exact: true }).first().waitFor();
      await taskDetail.getByRole("button", { name: "Retry reconciliation", exact: true }).click();
      await expect.poll(() => plannedState?.phase).toBe("merge_conflict_required");
      await taskDetail.locator('[data-status="merge_conflict_required"]').waitFor();
      await taskDetail.getByRole("button", { name: "Resolve conflicts", exact: true }).click();
      await taskDetail.locator('[data-status="delivery_blocked"]').waitFor();
      await taskDetail.getByText("Pinned verification failed", { exact: true }).first().waitFor();
      await taskDetail.getByRole("button", { name: "Retry verification", exact: true }).click();
      await taskDetail.locator('[data-status="delivery_reviewed"]').waitFor();
      await taskDetail.getByText("no_drift", { exact: true }).waitFor();
      await taskDetail.getByRole("button", { name: "Publish draft", exact: true }).click();
      await taskDetail.locator('[data-status="ci_waiting"]').waitFor();
      await observerDetail.locator('[data-status="ci_waiting"]').waitFor();
      await taskDetail.getByRole("heading", { name: "Draft publication" }).waitFor();
      expect(await taskDetail.getByText("acme/forge · main ← issue/browser-task", { exact: true }).isVisible()).toBe(true);
      await taskDetail.getByText("Preview title and body", { exact: true }).click();
      expect(await taskDetail.getByText(/## Summary/).isVisible()).toBe(true);
      const progress = taskDetail.locator("[data-task-progress]");
      expect(await progress.locator('[data-slot="timeline"][data-orientation="horizontal"]').count()).toBe(1);
      expect(await progress.getByText("Done in 1 min", { exact: true }).first().isVisible()).toBe(true);
      expect(await progress.getByText(/^Step [123]$/).count()).toBe(0);
      expect(new URL(page.url()).pathname).toBe(detailPath);
      const history = taskDetail.locator("[data-task-history]");
      expect(await history.getByRole("tab", { name: "Activity", exact: true }).getAttribute("aria-selected")).toBe("true");
      expect(await history.locator('[data-task-activity] [data-slot="timeline"][data-orientation="vertical"]').count()).toBe(1);
      await history.getByRole("tab", { name: "Invocations", exact: true }).click();
      expect(await history.locator('[data-task-invocations] [data-slot="timeline"][data-orientation="vertical"]').count()).toBe(1);
      expect(await history.getByText("lead · attempt 1", { exact: true }).isVisible()).toBe(true);
      const deliveredState: IssueWorkflowState = { ...plannedState!, phase: "delivery_ready", revision: plannedState!.revision + 1, owner: "lead", allowedCommands: ["review_delivery"], pendingAction: "Lead delivery review", lastEventId: `${plannedState!.workflowId}:${plannedState!.revision + 1}` };
      projectState(deliveredState);
      await page.reload();
      await taskDetail.locator('[data-status="delivery_ready"]').waitFor();
      expect(await taskDetail.getByRole("button", { name: "LGTM", exact: true }).isVisible()).toBe(true);
      await taskDetail.getByRole("button", { name: "Request changes", exact: true }).click();
      await taskDetail.locator('[data-status="planning"]').waitFor();
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page.waitForURL(/\/tasks\?company=/);
      expect(new URL(page.url()).pathname).toBe("/tasks");
      expect(new URL(page.url()).searchParams.get("company")).toBe(company.id);
      const taskList = page.locator("[data-task-list]");
      await taskList.getByText("In progress", { exact: true }).waitFor();
      expect(await taskList.locator("[data-task-row]").getByText("Browser task", { exact: true }).isVisible()).toBe(true);
      expect(await taskList.getByText("Browser task project", { exact: true }).isVisible()).toBe(true);

      await page.getByRole("link", { name: "Board", exact: true }).click();
      await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/board");
      expect(await page.getByText("Backlog", { exact: true }).isVisible()).toBe(true);
      for (const phase of ["Planning", "Development", "Reviewing", "Waiting for CI", "Final review", "Done"]) expect(await page.getByText(phase, { exact: true }).isVisible()).toBe(true);
      const boardTask = page.getByRole("button", { name: /Browser task/ });
      await boardTask.waitFor();
      await boardTask.scrollIntoViewIfNeeded();
      expect(await boardTask.isVisible()).toBe(true);
      await boardTask.click();
      await page.locator("[data-task-detail]").waitFor();
      expect(new URL(page.url()).pathname).toMatch(/^\/board\//);
      expect(await page.locator("[data-task-detail]").getByRole("heading", { name: "Browser task", exact: true, level: 2 }).isVisible()).toBe(true);

      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.goto(`${baseUrl}${detailPath}`);
      expect(await narrow.getByRole("button", { name: "Open navigation" }).isVisible()).toBe(true);
      const narrowDetail = narrow.locator("[data-task-detail]");
      await narrowDetail.waitFor();
      expect(await narrowDetail.getByRole("heading", { name: "Browser task", exact: true, level: 2 }).isVisible()).toBe(true);
      expect(await narrowDetail.getByText(/Image attached\./).isVisible()).toBe(true);
      expect(await narrowDetail.locator('[data-task-progress] [data-slot="timeline"][data-orientation="horizontal"]').count()).toBe(1);
      await narrowDetail.getByText("Exact-head CI", { exact: true }).waitFor();
      expect(await narrowDetail.getByRole("heading", { name: "Draft publication" }).isVisible()).toBe(true);
      expect(await narrow.getByRole("dialog").count()).toBe(0);
      expect(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const activity = narrowDetail.locator("[data-task-activity]");
      expect(await activity.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await narrowDetail.locator("[data-task-history]").getByRole("tab", { name: "Invocations", exact: true }).click();
      expect(await narrowDetail.locator('[data-task-invocations] [data-slot="timeline"][data-orientation="vertical"]').count()).toBe(1);
      const narrowContentBox = await narrowDetail.locator("[data-task-content]").boundingBox();
      const narrowHeaderContentBox = await narrowDetail.locator("[data-task-header-content]").boundingBox();
      const narrowTaskActionsBox = await narrowDetail.locator("[data-task-actions]").boundingBox();
      const narrowTaskActionButtonBox = await narrowDetail.locator("[data-task-actions]").getByRole("button").first().boundingBox();
      const narrowDetailContentBox = await narrowDetail.locator("[data-task-content-inner]").boundingBox();
      const narrowPropertiesBox = await narrowDetail.locator("[data-task-properties]").boundingBox();
      expect(narrowContentBox).not.toBeNull(); expect(narrowHeaderContentBox).not.toBeNull(); expect(narrowTaskActionsBox).not.toBeNull(); expect(narrowTaskActionButtonBox).not.toBeNull(); expect(narrowDetailContentBox).not.toBeNull(); expect(narrowPropertiesBox).not.toBeNull();
      expect(narrowPropertiesBox!.y).toBeGreaterThan(narrowContentBox!.y);
      expect(Math.abs(narrowHeaderContentBox!.x - narrowDetailContentBox!.x)).toBeLessThan(1);
      expect(Math.abs(narrowHeaderContentBox!.x + narrowHeaderContentBox!.width - narrowTaskActionsBox!.x - narrowTaskActionsBox!.width)).toBeLessThan(1);
      expect(Math.abs(narrowHeaderContentBox!.x + narrowHeaderContentBox!.width - narrowTaskActionButtonBox!.x - narrowTaskActionButtonBox!.width)).toBeLessThan(1);
      await page.goto(`${baseUrl}/tasks/missing-task`);
      await page.getByText("Task not found for this company.", { exact: true }).waitFor();
      expect(await page.getByRole("link", { name: "Back to Tasks", exact: true }).isVisible()).toBe(true);
      await narrow.close(); await observer.close(); await page.close(); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); workerDatabase.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
