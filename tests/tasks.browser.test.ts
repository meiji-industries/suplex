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
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      await context.addCookies([
        { name: SESSION_COOKIE_NAME, value: cookie.split("=", 2)[1] ?? "", domain: "127.0.0.1", path: "/" },
        { name: CSRF_COOKIE_NAME, value: csrf.split("=", 2)[1] ?? "", domain: "127.0.0.1", path: "/" },
      ]);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/tasks`);
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
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
      expect(await page.getByRole("dialog").count()).toBe(0);
      const contentBox = await taskDetail.locator("[data-task-content]").boundingBox();
      const propertiesBox = await taskDetail.locator("[data-task-properties]").boundingBox();
      expect(contentBox).not.toBeNull(); expect(propertiesBox).not.toBeNull(); expect(propertiesBox!.x).toBeGreaterThan(contentBox!.x);
      const observer = await context.newPage();
      await observer.goto(page.url());
      const observerDetail = observer.locator("[data-task-detail]");
      await observerDetail.getByRole("heading", { name: "Browser task", exact: true, level: 2 }).waitFor();
      await taskDetail.getByRole("button", { name: "Start planning", exact: true }).click();
      await taskDetail.getByText(/planning · revision 1/).waitFor();
      await observerDetail.getByText(/planning · revision 1/).waitFor();
      database.authTransaction((db) => {
        const task = db.prepare("SELECT workflow_id AS workflowId FROM forge_tasks WHERE id = ?").get(taskId) as { workflowId: string };
        const observedAt = "2026-08-11T12:00:00.000Z";
        const baseSha = "a".repeat(40); const headSha = "b".repeat(40); const treeSha = "c".repeat(40);
        db.prepare("INSERT INTO forge_releases (id, task_id, company_id, workflow_id, release_key, repository, head_branch, base_branch, base_sha, head_sha, head_tree, status, pr_number, pr_url, title, created_at, updated_at) VALUES ('release-browser', ?, ?, ?, 'browser-release', 'acme/forge', 'issue/browser-task', 'main', ?, ?, ?, 'draft', 77, 'https://github.com/acme/forge/pull/77', 'Browser release', ?, ?)").run(taskId, company.id, task.workflowId, baseSha, headSha, treeSha, observedAt, observedAt);
        db.prepare("INSERT INTO forge_ci_runs (id, task_id, company_id, release_id, expected_head_sha, expected_head_tree, project_revision_id, policy_hash, policy_json, status, attempt, summary, first_observed_at, propagation_deadline, overall_deadline, completed_at, created_at, updated_at) VALUES ('ci-browser', ?, ?, 'release-browser', ?, ?, ?, ?, ?, 'failed', 1, 'One required check failed', ?, '2026-08-11T12:05:00.000Z', '2026-08-11T13:00:00.000Z', ?, ?, ?)").run(taskId, company.id, headSha, treeSha, activeProject.activeRevisionId, "f".repeat(64), JSON.stringify({ projectRevisionId: activeProject.activeRevisionId, requiredChecks: ["Tests / unit with an intentionally long but bounded display name that must wrap safely"], acceptedConclusions: ["success"] }), observedAt, observedAt, observedAt, observedAt);
        db.prepare("INSERT INTO forge_ci_attempts (id, run_id, attempt_number, observed_repository, observed_pr_number, observed_base_branch, observed_base_sha, observed_head_branch, observed_head_sha, outcome, reason, owner, repairable, summary, created_at) VALUES ('ci-attempt-browser', 'ci-browser', 1, 'acme/forge', 77, 'main', ?, 'issue/browser-task', ?, 'failed', 'required_check_failed', 'lead', 1, ?, ?)").run(baseSha, headSha, `The focused check failed safely. ${"bounded ".repeat(40)}`, observedAt);
        db.prepare("INSERT INTO forge_ci_attempt_checks (id, attempt_id, provider_check_id, name, head_sha, status, conclusion, details_url, summary, started_at, completed_at, selected_for_evaluation, created_at) VALUES ('ci-check-browser', 'ci-attempt-browser', '90071992547409932', 'Tests / unit with an intentionally long but bounded display name that must wrap safely', ?, 'completed', 'failure', 'https://github.com/acme/forge/actions/runs/77', 'A bounded failure summary', ?, ?, 1, ?)").run(headSha, observedAt, observedAt, observedAt);
      });
      finishPlanning();
      await expect.poll(() => plannedState?.phase).toBe("approval");
      TaskResponseSchema.parse(tasks.getTask((enrolled.json() as { user: { id: string } }).user.id, taskId));
      await expect.poll(() => workerDatabase.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get(plannedState!.issueId))).toEqual({ revision: 2, phase: "approval" });
      await taskDetail.getByText(/approval · revision 2/).waitFor();
      await observerDetail.getByText(/approval · revision 2/).waitFor();
      await taskDetail.getByText("evidence.png", { exact: true }).waitFor();
      await taskDetail.getByText("Lead plan", { exact: true }).waitFor();
      await taskDetail.getByText("Inspect repository", { exact: true }).waitFor();
      const ciDetail = taskDetail.locator("[data-task-ci]");
      await ciDetail.getByText("Exact-head CI", { exact: true }).waitFor();
      expect(await ciDetail.getByText("required_check_failed:", { exact: false }).isVisible()).toBe(true);
      const prLink = ciDetail.getByRole("link", { name: "PR #77", exact: true });
      await prLink.focus();
      expect(await prLink.evaluate((element) => element === document.activeElement)).toBe(true);
      await taskDetail.getByRole("button", { name: "Request review", exact: true }).click();
      await taskDetail.getByText(/approval · revision 3/).waitFor();
      await taskDetail.getByRole("button", { name: "Approve plan", exact: true }).click();
      await taskDetail.getByText(/ready_for_development · revision 4/).waitFor();
      expect(new URL(page.url()).pathname).toBe(detailPath);
      expect(await taskDetail.locator('[data-slot="timeline"][data-orientation="horizontal"]').count()).toBe(1);
      await taskDetail.getByRole("link", { name: "Tasks", exact: true }).click();
      await page.waitForURL(/\/tasks\?company=/);
      expect(new URL(page.url()).pathname).toBe("/tasks");
      expect(new URL(page.url()).searchParams.get("company")).toBe(company.id);

      await page.getByRole("link", { name: "Board", exact: true }).click();
      await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/board");
      expect(await page.getByText("Backlog", { exact: true }).isVisible()).toBe(true);
      for (const group of ["Planning", "Building", "Review", "CI", "Acceptance", "Done"]) expect(await page.getByText(group, { exact: true }).isVisible()).toBe(true);
      const boardTask = page.getByRole("button", { name: /Browser task/ });
      await boardTask.waitFor();
      await boardTask.scrollIntoViewIfNeeded();
      expect(await boardTask.isVisible()).toBe(true);
      await boardTask.click();
      await page.locator("[data-task-detail]").waitFor();
      expect(new URL(page.url()).pathname).toMatch(/^\/board\//);
      expect(await page.locator("[data-task-detail]").getByRole("link", { name: "Board", exact: true }).isVisible()).toBe(true);

      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.goto(`${baseUrl}${detailPath}`);
      expect(await narrow.getByRole("button", { name: "Open navigation" }).isVisible()).toBe(true);
      const narrowDetail = narrow.locator("[data-task-detail]");
      await narrowDetail.waitFor();
      expect(await narrowDetail.getByRole("heading", { name: "Browser task", exact: true, level: 2 }).isVisible()).toBe(true);
      expect(await narrowDetail.getByText("Description", { exact: true }).isVisible()).toBe(true);
      await narrowDetail.getByText("Exact-head CI", { exact: true }).waitFor();
      expect(await narrow.getByRole("dialog").count()).toBe(0);
      expect(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const activity = narrowDetail.locator("[data-task-activity-scroll]");
      expect(await activity.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      const narrowContentBox = await narrowDetail.locator("[data-task-content]").boundingBox();
      const narrowPropertiesBox = await narrowDetail.locator("[data-task-properties]").boundingBox();
      expect(narrowContentBox).not.toBeNull(); expect(narrowPropertiesBox).not.toBeNull(); expect(narrowPropertiesBox!.y).toBeGreaterThan(narrowContentBox!.y);
      await page.goto(`${baseUrl}/tasks/missing-task`);
      await page.getByText("Task not found for this company.", { exact: true }).waitFor();
      expect(await page.getByRole("link", { name: "Back to Tasks", exact: true }).isVisible()).toBe(true);
      await narrow.close(); await observer.close(); await page.close(); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); workerDatabase.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
