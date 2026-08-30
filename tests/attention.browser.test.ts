import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { AttentionService } from "../src/attention.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

const now = "2026-08-21T00:00:00.000Z";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "attention-browser", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "attention-browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

test("attention page renders projection-backed task rows", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-attention-browser-test-"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const database = new ForgeDatabase(config.databasePath);
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'brief.md', 'text/markdown', 1, ?, ?, ?)").run("b".repeat(64), "company-a/brief-a", now);
      for (const [taskId, title] of [["task-a", "Needs a decision"], ["task-approval", "Approval needed"]]) db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'company-a', 'project-a', ?, 'brief-a', '[]', '{}', 0, ?, 'brief-a', ?, ?, ?)").run(taskId, title, `workflow-${taskId}`, `attention-browser-${taskId}`, now, now);
      db.prepare("UPDATE forge_companies SET issue_code = 'ATTN' WHERE id = 'company-a'").run();
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, authoritative_revision, projected_at, state_changed_at, projection_status, reconciled_at) VALUES ('task-a', 'company-a', 'project-a', 'workflow-task-a', 7, 'delivery_blocked', 'human', '[\"record_delivery_decision\",\"cancel_issue\"]', 'Decision required', ?, 'workflow-task-a:7', 7, ?, ?, 'current', ?)").run(now, now, now, now);
      db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at, run_id) VALUES ('task-a', 'company-a', 'workflow-task-a', 7, ?, ?, 'test')").run(JSON.stringify({ blocker: { category: "member_decision", summary: "Choose a behavior" }, mergeDecision: { question: "Choose a behavior", choices: [{ id: "safe", label: "Preserve changes", detail: "Keep the current worktree." }, { id: "clean", label: "Discard changes", detail: "Start from a clean worktree." }], recommendedChoiceId: "safe" } }), now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, authoritative_revision, projected_at, state_changed_at, projection_status, reconciled_at) VALUES ('task-approval', 'company-a', 'project-a', 'workflow-task-approval', 8, 'approval', 'human', '[\"approve_plan\",\"request_plan_revision\",\"cancel_issue\"]', 'Approve final plan', ?, 'workflow-task-approval:8', 8, ?, ?, 'current', ?)").run(now, now, now, now);
      db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at, run_id) VALUES ('task-approval', 'company-a', 'workflow-task-approval', 8, '{}', ?, 'test')").run(now);
    });
    const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
    const server = createApp({ config, auth, attention: new AttentionService(database, auth), health: { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address !== "object") throw new Error("Browser attention server did not expose a port");
    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    const options = await server.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await server.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "attention-browser-admin", type: "public-key" } } });
    const cookies = (Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [enrolled.headers["set-cookie"] ?? ""]) as string[];
    const cookie = cookies.flatMap((value) => { const [name, val] = (value.split(";", 1)[0] ?? "").split("=", 2); return name && val ? [{ name, value: val }] : []; });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      await context.addCookies(cookie.map(({ name, value }) => ({ name, value, domain: "127.0.0.1", path: "/" })));
      const page = await context.newPage();
      let actionBody: Record<string, unknown> | undefined;
      await page.route("**/api/tasks/task-approval/approve-plan", async (route) => {
        actionBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
      await page.goto(`http://127.0.0.1:${address.port}/attention`);
      await page.getByRole("link", { name: "Needs a decision", exact: true }).waitFor();
      expect(await page.getByRole("radio", { name: /Preserve changes/ }).isChecked()).toBe(true);
      expect(await page.getByRole("radio", { name: /Discard changes/ }).isVisible()).toBe(true);
      expect(await page.getByRole("textbox", { name: "Decision needed note" }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Choose a behavior" }).isVisible()).toBe(true);
      const approvalCard = page.getByRole("link", { name: "Approval needed", exact: true }).locator("..").locator("[data-task-attention-card]");
      expect(await approvalCard.getByRole("button", { name: "Approve plan" }).isVisible()).toBe(true);
      await approvalCard.getByRole("button", { name: "Approve plan" }).click();
      const dialog = page.getByRole("dialog", { name: "Approve plan" });
      await dialog.getByRole("textbox", { name: "Approve plan note" }).fill("LGTM");
      await dialog.getByRole("button", { name: "Approve plan" }).click();
      await expect.poll(() => actionBody).toBeDefined();
      expect(actionBody).toMatchObject({ expectedRevision: 8, note: "LGTM", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.getByRole("button", { name: "Open navigation" }).isVisible()).toBe(true);
      expect(await page.getByRole("radio", { name: /Preserve changes/ }).isChecked()).toBe(true);
      expect(await approvalCard.getByRole("button", { name: "Approve plan" }).isVisible()).toBe(true);
      await page.close(); await context.close();
    } finally { await browser.close(); await server.close(); }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
