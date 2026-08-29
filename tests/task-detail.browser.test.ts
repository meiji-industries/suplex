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
import { issueCommands } from "../src/commands/registry.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, type IssueWorkflowInput, type IssueWorkflowState, type PlanRevisionCommand, type StartPlanningInput } from "../src/engine/issue-contracts.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "browser-task", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; }, async generateAuthenticationOptions(input) { return { challenge: "browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "a".repeat(40), targetSha: "b".repeat(40) }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

test("task detail remains truthful and usable on desktop and narrow viewports", { timeout: 120_000 }, async () => {
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
  auth.setCompanyIssueCode("admin-1", company.id, "task");
  const profile = projects.createProfile("admin-1", { name: "Browser task profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const planner = projects.createAgent("admin-1", { name: "Planner", role: "planner", profileId: profile.id });
  const builder = projects.createAgent("admin-1", { name: "Builder", role: "builder", profileId: profile.id });
  const reviewer = projects.createAgent("admin-1", { name: "Reviewer", role: "reviewer", profileId: profile.id });
  const project = await projects.createProject("admin-1", company.id, { name: "Browser task project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], roleDefaults: { planner: planner.id, builder: builder.id, reviewer: reviewer.id } });
  await projects.activateProject("admin-1", project.id);
  let plannedState: IssueWorkflowState | undefined;
  const planningGate = new Promise<void>(() => undefined);
  const forwardMergeVerificationGate = new Promise<void>(() => undefined);
  const projectState = (state: IssueWorkflowState): void => {
    const event = IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state });
    workerDatabase.projectIssueEvent(event);
    workerDatabase.observeIssueProjection(event);
  };
  const beginPlanning = (workflowId: string, expectedRevision: number): IssueWorkflowState => {
    const taskId = workflowId.split("-issue-")[1]!;
    plannedState = { ...plannedState!, revision: expectedRevision + 1, phase: "planning", owner: "lead", allowedCommands: [], pendingAction: "Lead planning", lastEventId: `${workflowId}:${expectedRevision + 1}` };
    projectState(plannedState);
    database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, purpose, profile_id, resolved_model, resolved_reasoning_level, resolved_service_priority, started_at) VALUES ('agent_browser', ?, ?, ?, 'planner', 'running', 1, 'planning', ?, ?, ?, ?, ?)").run(taskId, company.id, workflowId, profile.id, profile.model, profile.reasoningLevel, profile.servicePriority, new Date().toISOString()));
    return plannedState;
  };
  const completePlanning = async (workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> => {
    const taskId = workflowId.split("-issue-")[1]!;
    await planningGate;
    const artifactStore = new ArtifactStore(config.artifactRoot);
    const evidence = await artifactStore.put(company.id, "agent-evidence", { filename: "agent.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"summary\\\":\\\"On it\\\"}\"}}\n") });
    const output = await artifactStore.put(company.id, "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "A focused browser plan", gitPresentation: { branchSlug: "improve-browser-task", pullRequestTitle: "Improve browser task", pullRequestDescription: "Make the browser task easier to review." }, reproduction: null, rootCauseAnalysis: "The fixture was incomplete.", steps: [{ number: 1, instruction: "Inspect repository", entryPoint: null, completionCriterion: "The issue is understood", verification: "Review the repository evidence" }, { number: 2, instruction: "Run focused tests", entryPoint: null, completionCriterion: "The focused suite passes", verification: "Confirm the focused suite result" }], compatibilityAnalysis: "The change is local.", operationalAnalysis: "No operational change.", verificationStrategy: "Run the focused suite.", unresolvedTechnicalQuestions: [], materialCategories: [], affectedPaths: ["src/browser-fixture.ts"], materiality: [{ category: "user_visible_behavior", rationale: "The fixture changes a user-visible task detail.", evidenceRefs: ["step:1"] }] })) });
    database.authQuery((db) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, output.id, output.companyId, output.kind, output.filename, output.mimeType, output.byteSize, output.sha256, output.storagePath, output.createdAt);
      db.prepare("UPDATE forge_agent_executions SET status = 'completed', session_ref = 'session_browser', finished_at = ?, heartbeat_at = ?, evidence_artifact_id = ? WHERE id = 'agent_browser'").run(now, now, evidence.id);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_browser', ?, ?, ?, 'agent_browser', ?, 'plan', ?, ?, 'session_browser', 'A focused browser plan', ?)").run(taskId, company.id, workflowId, input.expectedRevision + 1, output.id, evidence.id, now);
    });
    const planSubject = { companyId: company.id, issueId: taskId, workflowId, originalPlanRevision: 1, outputId: "output_browser", outputRevision: 1, finalVersion: 1 as const, artifactId: output.id, artifactSha256: output.sha256, leadSessionRef: "session_browser", leadExecutionId: "agent_browser", evidenceManifestArtifactId: evidence.id, evidenceManifestSha256: evidence.sha256 };
    const materialityEvidence = { categories: ["user_visible_behavior" as const], artifactId: evidence.id, artifactSha256: evidence.sha256 };
    plannedState = { workflowId, companyId: company.id, projectId: project.id, issueId: taskId, projectRevisionId: plannedState!.projectRevisionId, phase: "approval", revision: input.expectedRevision + 2, owner: "human", allowedCommands: ["request_supplemental_review", "approve_plan", "request_plan_revision"], pendingAction: "Approve final plan", lastEventId: `${workflowId}:${input.expectedRevision + 2}`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_browser", leadExecutionId: "agent_browser", leadEvidenceArtifactId: evidence.id, leadOutputArtifactId: output.id, leadOutputKind: "plan", leadSummary: "A focused browser plan", planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: false, originalPlanSubject: planSubject, finalPlanSubject: planSubject, materialityEvidence };
    projectState(plannedState);
    return plannedState;
  };
  const workflow = { async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) {
    plannedState = buildInitialIssueWorkflowState({ ...input, workflowId: input.workflowId! });
    projectState(plannedState);
    return { workflowId: input.workflowId!, runId: "run" };
  }, async execute(command: keyof typeof issueCommands, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const handler = (workflow as unknown as Record<string, (workflowId: string, input: StartPlanningInput) => Promise<IssueWorkflowState>>)[issueCommands[command].updateName];
    if (!handler) throw new Error(`Unsupported browser fixture command: ${command}`);
    return handler(workflowId, input);
  }, async startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    beginPlanning(workflowId, input.expectedRevision);
    return completePlanning(workflowId, input);
  }, async acceptPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const state = beginPlanning(workflowId, input.expectedRevision);
    void completePlanning(workflowId, input);
    return state;
  }, async requestSupplementalReview(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, allowedCommands: ["approve_plan", "request_plan_revision"], pendingAction: "Approve final plan", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}`, supplementalReviewUsed: true };
    projectState(plannedState);
    return plannedState;
  }, async approvePlan(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development"], pendingAction: "Start development", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    return plannedState;
  }, async acceptDevelopment(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    return (workflow as unknown as { startDevelopment(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> }).startDevelopment(workflowId, input);
  }, async publishDraft(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const releaseBody = await new ArtifactStore(config.artifactRoot).put(company.id, "release-public-body", { filename: "release.md", mimeType: "text/markdown", bytes: Buffer.from("## Summary\n\nBrowser task") });
    database.authTransaction((db) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(releaseBody.id, releaseBody.companyId, releaseBody.kind, releaseBody.filename, releaseBody.mimeType, releaseBody.byteSize, releaseBody.sha256, releaseBody.storagePath, releaseBody.createdAt);
      db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, body_artifact_id, reused, created_at, updated_at) VALUES ('release-browser', ?, ?, ?, 'release-browser-key', 'acme/forge', 'issue/browser-task', 'main', ?, ?, ?, 'draft', 21, 'https://github.com/acme/forge/pull/21', 'Browser task', ?, 1, ?, ?)").run(plannedState!.issueId, company.id, plannedState!.workflowId, "a".repeat(40), "b".repeat(40), "c".repeat(40), releaseBody.id, now, now);
    });
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "ci_waiting", owner: "lead", allowedCommands: ["cancel_issue", "revise_plan"], pendingAction: "Waiting for CI", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    return plannedState;
  }, async startDevelopment(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const taskId = workflowId.split("-issue-")[1]!;
    const now = new Date().toISOString();
    database.authQuery((db) => db.prepare("INSERT INTO forge_forward_merges (id, task_id, company_id, expected_base_sha, current_base_sha, prior_head, merge_commit, tree, status, conflict_files_json, created_at, workflow_id, project_revision_id, checkpoint, prior_tree, failure_code, failure_summary, updated_at) VALUES ('merge-browser', ?, ?, ?, ?, ?, NULL, NULL, 'blocked', '[]', ?, ?, ?, 'pre_release', ?, 'provider_unavailable', 'Provider unavailable', ?)").run(taskId, company.id, "a".repeat(40), "a".repeat(40), "c".repeat(40), now, workflowId, project.activeRevisionId!, "c".repeat(40), now));
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_target_base_reconciliation", "cancel_issue"], pendingAction: "Provider unavailable", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, targetBaseSha: "a".repeat(40), targetBaseCheckId: "merge-browser", targetBaseCheckpoint: "pre_release", targetBaseOutcome: "blocked", targetBaseBlockerCode: "provider_unavailable", targetBaseBlockerOwner: "provider", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Provider unavailable", resultCommit: "c".repeat(40), resultTree: "d".repeat(40) };
    projectState(plannedState);
    return plannedState!;
  }, async retryTargetBaseReconciliation(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET status = 'conflict', current_base_sha = ?, conflict_files_json = '[\"README.md\"]', conflict_file_count = 1, failure_code = NULL, failure_summary = NULL, updated_at = ? WHERE id = 'merge-browser'").run("b".repeat(40), new Date().toISOString()));
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "merge_conflict_required", owner: "lead", allowedCommands: ["resolve_merge_conflict", "cancel_issue"], pendingAction: "Developer conflict resolution requires the Lead plan", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, targetBaseOutcome: "conflict", targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null, forwardMergeId: "merge-browser", forwardMergePriorHead: "c".repeat(40), forwardMergePriorTree: "d".repeat(40), forwardMergeTargetBaseSha: "b".repeat(40), forwardMergeConflictArtifact: { id: "conflict-browser", kind: "forward-merge-conflict" }, forwardMergeConflictFileCount: 1 };
    projectState(plannedState!);
    return plannedState!;
  }, async resolveMergeConflict(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET status = 'merged', result_head = ?, result_tree = ?, failure_code = 'verification_failed', failure_summary = 'Pinned verification failed', updated_at = ? WHERE id = 'merge-browser'").run("f".repeat(40), "1".repeat(40), new Date().toISOString()));
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "delivery_blocked", owner: "lead", allowedCommands: ["retry_forward_merge_verification", "cancel_issue"], pendingAction: "Pinned verification failed", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, targetBaseOutcome: "blocked", targetBaseBlockerCode: "verification_failed", targetBaseBlockerOwner: "lead", targetBaseBlockerRetryable: true, targetBaseBlockerSummary: "Pinned verification failed", resultCommit: "f".repeat(40), resultTree: "1".repeat(40) };
    projectState(plannedState);
    return plannedState;
  }, async retryForwardMergeVerification(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, owner: "lead", allowedCommands: [], pendingAction: "Retrying pinned forward-merge verification", lastEventId: `${workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    await forwardMergeVerificationGate;
    database.authQuery((db) => db.prepare("UPDATE forge_forward_merges SET status = 'no_drift', failure_code = NULL, failure_summary = NULL, updated_at = ? WHERE id = 'merge-browser'").run(new Date().toISOString()));
    plannedState = { ...plannedState!, revision: plannedState!.revision + 1, phase: "delivery_reviewed", owner: "lead", allowedCommands: ["publish_draft", "cancel_issue"], pendingAction: "Publish one exact draft pull request", lastEventId: `${workflowId}:${plannedState!.revision + 1}`, targetBaseOutcome: "no_drift", targetBaseBlockerCode: null, targetBaseBlockerOwner: null, targetBaseBlockerRetryable: null, targetBaseBlockerSummary: null };
    projectState(plannedState);
    return plannedState;
  }, async rejectPlan(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    return plannedState;
  }, async revisePlan(_workflowId: string, input: PlanRevisionCommand): Promise<IssueWorkflowState> {
    if (input.worktreeDisposition !== "new") throw new Error("The browser fixture only supports a new exact-base worktree");
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning", "cancel_issue", "revise_plan"], pendingAction: "Run revised Lead planning", revisionRequestId: `revision_browser_${input.expectedRevision}`, revisedExecutionCoordinates: { disposition: "new", revisionRequestId: `revision_browser_${input.expectedRevision}`, exactBaseSha: input.exactBaseSha! }, lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    projectState(plannedState);
    return plannedState;
  } } as unknown as IssueWorkflowPort;
  const tasks = new TaskService(database, auth, projects, config, { workflow });
  const app = createApp({ config, auth, projects, tasks, health: { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
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
      let page = await context.newPage();
      await page.goto(`${baseUrl}/tasks?company=${encodeURIComponent(company.id)}&new=1`);
      await page.getByRole("dialog", { name: "New task" }).waitFor();
      await page.getByRole("button", { name: "Project", exact: true }).click();
      await page.getByRole("menuitem", { name: /Browser task project/ }).click();
      expect(await page.getByRole("button", { name: "Project", exact: true }).innerText()).toContain("Browser task project");
      await page.getByLabel("Task title", { exact: true }).fill("Browser task");
      await page.getByLabel("Task description", { exact: true }).fill("## Browser brief\n\nImage attached.");
      await page.getByRole("button", { name: "Add images", exact: true }).waitFor();
      await page.getByLabel("Task images", { exact: true }).setInputFiles(imagePath);
      await page.getByRole("button", { name: "Remove evidence.png", exact: true }).waitFor();
      await page.getByRole("button", { name: "Create task" }).click();
      await page.waitForURL(/\/tasks\/[^/?]+/);
      const detailPath = new URL(page.url()).pathname;
      let taskDetail = page.locator("[data-task-detail]");
      await taskDetail.waitFor();
      expect(await page.locator("[data-app-header]").textContent()).toContain("TASK-1 · Browser task");
      expect(await taskDetail.locator("[data-task-properties]").getByText("TASK-1", { exact: true }).isVisible()).toBe(true);
      expect(await taskDetail.getByRole("button", { name: "Edit task title", exact: true }).textContent()).toBe("Browser task");
      const plannerAgent = taskDetail.locator("#task-agent-planner");
      await plannerAgent.getByText("Planner", { exact: true }).waitFor();
      expect((await plannerAgent.boundingBox())?.height).toBe(24);
      expect(await taskDetail.getByRole("combobox", { name: "Planner", exact: true }).count()).toBe(0);
      await plannerAgent.click();
      await page.getByRole("menuitem", { name: /Planner.*Selected/ }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Task options", exact: true }).click();
      await page.getByRole("menuitem", { name: "Duplicate…", exact: true }).click();
      const duplicateDialog = page.getByRole("dialog", { name: "New task" });
      await duplicateDialog.waitFor();
      expect(await duplicateDialog.getByLabel("Task title", { exact: true }).inputValue()).toBe("Browser task (2)");
      expect(await duplicateDialog.getByLabel("Task description", { exact: true }).inputValue()).toBe("## Browser brief\n\nImage attached.");
      await page.keyboard.press("Escape");
      await duplicateDialog.waitFor({ state: "hidden" });
      const taskListPage = await context.newPage();
      await taskListPage.goto(`${baseUrl}/tasks?company=${encodeURIComponent(company.id)}`);
      await taskListPage.locator("[data-task-row]").filter({ hasText: "Browser task" }).waitFor();
      expect(await taskListPage.locator("[data-task-row]").count()).toBe(1);
      await taskListPage.close();
      expect(await taskDetail.locator("[data-task-work-tabs]").getByRole("tab", { name: "Other", exact: true }).isVisible()).toBe(true);
      expect(await page.locator("[data-app-header]").getByRole("link", { name: "Host health", exact: true }).count()).toBe(0);
      expect(await page.getByRole("dialog").count()).toBe(0);
      const contentBox = await taskDetail.locator("[data-task-content]").boundingBox();
      const headerContentBox = await taskDetail.locator("[data-task-header-content]").boundingBox();
      const taskActionButton = taskDetail.locator("[data-task-actions]").getByRole("button").first();
      const taskActionButtonBox = (await taskActionButton.count()) > 0 ? await taskActionButton.boundingBox() : null;
      expect(await taskDetail.locator("[data-task-actions] [data-slot=\"card-footer\"]").count()).toBe(taskActionButtonBox ? 1 : 0);
      const currentBox = await taskDetail.locator("[data-task-current]").boundingBox();
      const detailContentBox = await taskDetail.locator("[data-task-content-inner]").boundingBox();
      const propertiesBox = await taskDetail.locator("[data-task-properties]").boundingBox();
      const initialProgressBox = await taskDetail.locator("[data-task-progress]").boundingBox();
      expect(contentBox).not.toBeNull(); expect(headerContentBox).not.toBeNull(); expect(currentBox).not.toBeNull(); expect(detailContentBox).not.toBeNull(); expect(propertiesBox).not.toBeNull(); expect(initialProgressBox).not.toBeNull();
      expect(propertiesBox!.x).toBeGreaterThan(contentBox!.x);
      expect(initialProgressBox!.x).toBeGreaterThan(contentBox!.x);
      expect(Math.abs(headerContentBox!.x - detailContentBox!.x)).toBeLessThan(1);
      expect(currentBox!.x).toBeLessThanOrEqual(detailContentBox!.x);
      if (taskActionButtonBox) expect(taskActionButtonBox.x).toBeGreaterThanOrEqual(currentBox!.x);
      const observer = await context.newPage();
      await observer.goto(`${baseUrl}${detailPath}?company=${encodeURIComponent(company.id)}`);
      const observerDetail = observer.locator("[data-task-detail]");
      await observerDetail.getByRole("button", { name: "Edit task title", exact: true }).waitFor();
      await observer.close(); await page.close();
      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.goto(`${baseUrl}${detailPath}?company=${encodeURIComponent(company.id)}`);
      const narrowDetail = narrow.locator("[data-task-detail]");
      await narrowDetail.getByRole("button", { name: "Edit task title", exact: true }).waitFor();
      expect(await narrowDetail.getByRole("button", { name: "Edit task description", exact: true }).innerText()).toContain("Image attached.");
      expect(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await narrow.close(); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); workerDatabase.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
