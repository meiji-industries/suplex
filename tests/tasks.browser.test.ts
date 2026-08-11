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
import type { IssueWorkflowInput, IssueWorkflowState, StartPlanningInput } from "../src/temporal/issue-contracts.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return { async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "browser-task", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; }, async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; }, async generateAuthenticationOptions(input) { return { challenge: "browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; }, async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; } };
}

const localRepository: LocalRepositoryAdapter = { async inspect(input) { return { canonicalPath: input.repositoryPath, remoteRepository: "acme/forge", clean: true, baseSha: "base", targetSha: "target" }; } };
const github: GithubAdapter = { async checkAuthentication() {}, async getRepository(input) { return { nameWithOwner: input.nameWithOwner, url: `https://github.com/${input.nameWithOwner}` }; } };

test("task desktop flow attaches an image, shows Backlog, starts planning, and remains usable on narrow viewports", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-browser-test-"));
  const repositoryRoot = join(root, "repositories"); const worktreeRoot = join(root, "worktrees"); const repositoryPath = join(repositoryRoot, "repo");
  await mkdir(repositoryPath, { recursive: true }); await mkdir(worktreeRoot, { recursive: true });
  const imagePath = join(root, "evidence.png"); await writeFile(imagePath, "browser-image");
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin-1', 'Admin', 'admin@forge.local', 'admin', 'active', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run());
  const config = createTestConfig(root, { repositoryRoot, worktreeRoot, reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  const projects = new ProjectService(database, auth, config, { localRepository, github });
  const company = auth.createCompany("admin-1", "Browser Tasks");
  const profile = projects.createProfile("admin-1", { name: "Browser task profile", model: "gpt-5.6-sol", reasoningLevel: "medium", servicePriority: "standard", capacity: 2 });
  const project = await projects.createProject("admin-1", company.id, { name: "Browser task project", repositoryPath, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"], allowedProfileIds: [profile.id], roleDefaults: { lead: profile.id, developer: profile.id } });
  await projects.activateProject("admin-1", project.id);
  let plannedState: IssueWorkflowState | undefined;
  const workflow: IssueWorkflowPort = { async start(input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }) { return { workflowId: input.workflowId!, runId: "run" }; }, async startPlanning(workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    const taskId = workflowId.split("-issue-")[1]!;
    const artifactStore = new ArtifactStore(config.artifactRoot);
    const evidence = await artifactStore.put(company.id, "agent-evidence", { filename: "agent.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"turn.completed\"}\n") });
    const output = await artifactStore.put(company.id, "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "A focused browser plan", reproduction: null, rootCauseAnalysis: "The fixture was incomplete.", steps: [{ number: 1, instruction: "Inspect repository", verification: "The issue is understood" }, { number: 2, instruction: "Run focused tests", verification: "The focused suite passes" }], compatibilityAnalysis: "The change is local.", operationalAnalysis: "No operational change.", verificationStrategy: "Run the focused suite.", unresolvedTechnicalQuestions: [] })) });
    database.authQuery((db) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt, output.id, output.companyId, output.kind, output.filename, output.mimeType, output.byteSize, output.sha256, output.storagePath, output.createdAt);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_browser', ?, ?, ?, 'lead', 'completed', 1, 'session_browser', ?, ?, ?)").run(taskId, company.id, workflowId, now, now, evidence.id);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at) VALUES ('output_browser', ?, ?, ?, 'agent_browser', ?, 'plan', ?, ?, 'session_browser', 'A focused browser plan', ?)").run(taskId, company.id, workflowId, input.expectedRevision + 1, output.id, evidence.id, now);
    });
    plannedState = { workflowId, companyId: company.id, projectId: project.id, issueId: taskId, projectRevisionId: project.activeRevisionId!, phase: "approval", revision: input.expectedRevision + 1, owner: "human", allowedCommands: ["request_supplemental_review", "approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${workflowId}:${input.expectedRevision + 1}`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_browser", leadExecutionId: "agent_browser", leadEvidenceArtifactId: evidence.id, leadOutputArtifactId: output.id, leadOutputKind: "plan", leadSummary: "A focused browser plan", planRevision: 1, planMaterial: true, materialCategories: ["user_visible_behavior"], supplementalReviewUsed: false };
    return plannedState;
  }, async requestSupplementalReview(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, allowedCommands: ["approve_plan", "reject_plan"], pendingAction: "Approve final plan", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}`, supplementalReviewUsed: true };
    return plannedState;
  }, async approvePlan(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development"], pendingAction: "Start development", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
    return plannedState;
  }, async rejectPlan(_workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
    plannedState = { ...plannedState!, revision: input.expectedRevision + 1, phase: "planning", owner: "lead", allowedCommands: ["start_planning"], pendingAction: "Lead plan revision", lastEventId: `${plannedState!.workflowId}:${input.expectedRevision + 1}` };
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
      await page.locator("#task-project").selectOption(project.id);
      await page.getByLabel("Task title", { exact: true }).fill("Browser task");
      await page.getByLabel("Task description", { exact: true }).fill("## Browser brief\n\nImage attached.");
      await page.getByRole("button", { name: "Add images", exact: true }).waitFor();
      await page.getByLabel("Task images", { exact: true }).setInputFiles(imagePath);
      await page.getByRole("button", { name: "Remove evidence.png", exact: true }).waitFor();
      await page.getByRole("button", { name: "Create task" }).click();
      await page.getByRole("button", { name: /Browser task/ }).waitFor();
      await page.getByRole("button", { name: "Start planning", exact: true }).waitFor();
      await page.getByRole("button", { name: "Start planning", exact: true }).click();
      await page.getByText(/approval · revision 1/).waitFor();
      await page.getByText("evidence.png", { exact: true }).waitFor();
      await page.getByText("Lead plan", { exact: true }).waitFor();
      await page.getByText("Inspect repository", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Request review", exact: true }).click();
      await page.getByText(/approval · revision 2/).waitFor();
      await page.getByRole("button", { name: "Approve plan", exact: true }).click();
      await page.getByText(/ready_for_development · revision 3/).waitFor();
      const narrow = await context.newPage(); await narrow.setViewportSize({ width: 390, height: 844 }); await narrow.goto(`${baseUrl}/tasks`); expect(await narrow.getByRole("button", { name: "Open navigation" }).isVisible()).toBe(true); await narrow.close(); await page.close(); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
