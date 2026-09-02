import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { TaskResponseSchema } from "../src/http/contracts/tasks.js";

const projectId = "recovery-browser-project";
const taskId = "recovery-browser-task";

type RecoveryStatus = "starting" | "active" | "reconnecting" | "result_pending_claim" | "interrupted" | "cancellation_requested" | "cancelling" | "cancelled" | "failed";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "recovery-browser", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "recovery-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

function taskState(companyId: string, status: RecoveryStatus, revision = 3, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cancelled = status === "cancelled";
  const interrupted = status === "interrupted";
  const failed = status === "failed";
  const commands = cancelled || failed ? ["retry_development"] : interrupted ? ["retry_development", "cancel_issue"] : status === "cancelling" || status === "cancellation_requested" ? [] : ["cancel_development"];
  return TaskResponseSchema.parse({
    id: taskId,
    companyId,
    projectId,
    issueKey: "REC-1",
    title: "Recovery task",
    archivedAt: null,
    description: "A safe recovery browser fixture.",
    prompts: { overrides: [] },
    briefArtifactId: "recovery-brief",
    images: [],
    roleAgents: {},
    supplementalReview: false,
    autoApprovePlan: false,
    deliveryTarget: "pull_request_ready",
    executionControls: { runProjectTests: true, visualEvidence: "off", supplementalReview: false },
    browserProof: [],
    deliveryReceipt: null,
    worktreeState: "present",
    worktreePath: "/forge/worktrees/recovery-browser-task",
    pullRequestMode: "ready",
    workflowId: "recovery-browser-workflow",
    projectRevisionId: "recovery-browser-revision",
    phase: "building",
    step: "development",
    blocked: failed,
    revision,
    owner: interrupted || failed ? "human" : "lead",
    allowedCommands: commands,
    commands: [],
    governance: {},
    pendingAction: cancelled ? "Developer turn cancelled; retry or continue" : failed ? "The Developer turn failed" : "Developer execution",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    projection: { authoritativeRevision: revision, projectedRevision: revision, projectedAt: "2026-08-12T00:00:00.000Z", status: "current", message: null },
    timeline: [{ id: "recovery-browser-workflow:3", revision, eventType: "phase_development", metadata: { revision, phase: "development" }, createdAt: "2026-08-12T00:00:00.000Z" }],
    activity: [],
    agentInvocations: [],
    capacity: null,
    reviewLineage: { currentReview: null, priorReviews: [], reviewAttempts: [], repairAttempts: [] },
    planHistory: [],
    planDecisionHistory: [],
    revisionHistory: [],
    developerExecutionHistory: [],
    deliveryReviewHistory: [],
    developerExecution: { id: cancelled ? "developer-cancelled" : "developer-attempt-1", status: cancelled ? "terminated" : "running", attempt: 1, branchName: "forge/issue/recovery-browser-task", targetBaseSha: "a".repeat(40), startedAt: "2026-08-12T00:00:00.000Z", finishedAt: null, summary: cancelled ? "Termination confirmed; worktree and branch preserved." : "Developer is working in the preserved worktree." },
    targetBaseReconciliation: {
      checkId: null,
      checkpoint: null,
      status: null,
      expectedBaseSha: null,
      observedBaseSha: null,
      priorHead: null,
      priorTree: null,
      resultHead: null,
      resultTree: null,
      conflictFileCount: null,
      conflictArtifact: null,
      verificationArtifact: null,
      deliveryArtifact: null,
      invalidatedDeliveryReviewId: null,
      invalidatedCiRunId: null,
      invalidatedFinalReviewId: null,
      invalidatedAcceptanceId: null,
      releaseId: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      blockerCode: null,
      blockerOwner: null,
      retryable: null,
      summary: null,
      actions: [],
    },
    developerRecovery: { status, reasonCode: interrupted ? "developer-worker-lost" : failed ? "developer-failed" : null, summary: interrupted ? "The Developer worker stopped before the result was claimed." : failed ? "The Developer turn could not complete." : cancelled ? "Developer termination confirmed and preserved." : status === "cancelling" ? "Confirming Developer termination." : status === "reconnecting" ? "Reconnecting to the recorded Developer supervisor." : "Forge is tracking the Developer turn.", lastHeartbeatAt: "2026-08-12T00:00:00.000Z", currentOwner: "forge", evidenceArtifactId: "recovery-evidence", nextAction: interrupted || cancelled || failed ? { command: "retry_development", label: "Retry development", requiresConfirmation: true } : { command: "cancel_development", label: "Cancel development", requiresConfirmation: true } },
    ...overrides,
  });
}

test.each([1280, 390])("INV-12 recovery journeys are truthful and fail closed at %ipx", async (viewportWidth) => {
  const root = await mkdtemp(join(tmpdir(), "forge-recovery-browser-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  database.authQuery((db) => db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('recovery-admin', 'Recovery Admin', 'recovery-admin', 'admin', 'active', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')").run());
  const company = auth.createCompany("recovery-admin", "Recovery Browser");
  const app = createApp({ config, auth, health: {
    engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }),
    database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
    artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
    worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }),
    codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
    ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
  } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("Recovery browser server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "recovery-browser-admin", type: "public-key" } } });
    const cookies = Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [enrolled.headers["set-cookie"] ?? ""];
    const session = cookies.find((value) => value.split("=", 1)[0] === SESSION_COOKIE_NAME)?.split(";", 1)[0]?.split("=", 2)[1] ?? "";
    const csrf = cookies.find((value) => value.split("=", 1)[0] === CSRF_COOKIE_NAME)?.split(";", 1)[0]?.split("=", 2)[1] ?? "";
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportWidth === 390 ? 844 : 800 } });
      await context.addCookies([{ name: SESSION_COOKIE_NAME, value: session, domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: csrf, domain: "127.0.0.1", path: "/" }]);
      let current = taskState(company.id, "active");
      let cancellationListReads = 0;
      let staleCancellation = false;
      await context.route("**/api/companies/*/projects", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ projects: [{ id: projectId, companyId: company.id, name: "Recovery project", repositoryPath: "repository", worktreeRoot: "worktrees", repository: "acme/recovery", baseBranch: "main", targetBranch: "main", setupCommand: "", verificationCommand: "pnpm test", requiredChecks: [], roleDefaults: {}, status: "active", configurationRevision: 1, activeRevisionId: "recovery-browser-revision" }] }) }));
      await context.route("**/api/companies/*/tasks", async (route) => {
        const recoveryState = current["developerRecovery"] as { status?: string } | undefined;
        if (recoveryState?.status === "cancelling") {
          cancellationListReads += 1;
          if (cancellationListReads > 1) current = taskState(company.id, "cancelled", 5);
        }
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [current] }) });
      });
      await context.route(/\/api\/agents(?:\?.*)?$/, async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ agents: [] }) }));
      await context.route("**/api/tasks/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.endsWith("/events")) { await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ready\n\n" }); return; }
        if (request.method() !== "POST") { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) }); return; }
        if (url.pathname.endsWith("/retry-development")) { current = taskState(company.id, "active", 7, { developerExecution: { id: "developer-attempt-2", status: "running", attempt: 2, branchName: "forge/issue/recovery-browser-task", targetBaseSha: "a".repeat(40), startedAt: "2026-08-12T00:00:00.000Z", finishedAt: null, summary: "Linked attempt 2 reconnected to the preserved worktree." } }); await route.fulfill({ contentType: "application/json", body: JSON.stringify(current) }); return; }
        if (url.pathname.endsWith("/cancel-development")) {
          if (staleCancellation) { staleCancellation = false; current = taskState(company.id, "active", 8); await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "stale_workflow_revision" }) }); return; }
          cancellationListReads = 0; current = taskState(company.id, "cancelling", 8); await route.fulfill({ contentType: "application/json", body: JSON.stringify(current) }); return;
        }
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(current) });
      });
      await context.route(new RegExp(`/api/tasks/${taskId}$`), async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) }));
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      const openTask = async (): Promise<void> => {
        await page.goto(`${baseUrl}/tasks/${taskId}?company=${company.id}`);
        await page.getByRole("alert").waitFor();
      };
      const reloadTask = async (): Promise<void> => {
        await page.reload();
        await page.getByRole("alert").waitFor();
      };
      const recovery = page.getByRole("alert");

      await openTask();
      expect(await recovery.locator('[data-slot="card-footer"]').count()).toBe(1);
      await recovery.getByText("Active", { exact: true }).waitFor();
      current = taskState(company.id, "reconnecting", 4);
      await reloadTask();
      await recovery.getByText("Reconnecting", { exact: true }).waitFor();
      current = taskState(company.id, "active", 5, { phase: "delivery_ready", pendingAction: "Lead delivery review" });
      await reloadTask();
      expect(await page.getByText("Ready for review", { exact: true }).count()).toBeGreaterThan(0);

      current = taskState(company.id, "interrupted", 3);
      await reloadTask();
      await recovery.getByText("Interrupted", { exact: true }).waitFor();
      await recovery.getByRole("button", { name: "Retry development" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Confirm retry" }).click();
      await recovery.getByText("Active", { exact: true }).waitFor();

      current = taskState(company.id, "active");
      await reloadTask();
      await recovery.getByRole("button", { name: "Cancel development" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Confirm cancellation" }).click();
      await recovery.getByText("Cancelling", { exact: true }).waitFor();
      current = taskState(company.id, "cancelled", 5);
      await reloadTask();
      await recovery.getByText("Cancelled", { exact: true }).waitFor();

      current = taskState(company.id, "active"); staleCancellation = true;
      await reloadTask();
      await recovery.getByRole("button", { name: "Cancel development" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Confirm cancellation" }).click();
      await recovery.getByText("Active", { exact: true }).waitFor();

      current = taskState(company.id, "failed", 9, { developerRecovery: { ...taskState(company.id, "failed").developerRecovery as object, evidenceArtifactId: "recovery-evidence" } });
      await reloadTask();
      await recovery.getByText("Failed", { exact: true }).waitFor();
      expect(await page.locator("body").innerText()).not.toMatch(/(?:\/tmp\/|\/Users\/|PID\s*\d+)/i);
      await page.close(); await context.close();
    } finally { await browser.close(); }
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});
