import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { AttentionService } from "../src/attention.js";
import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { TaskService } from "../src/tasks.js";
import type { IssueWorkflowState } from "../src/temporal/issue-contracts.js";

const now = "2026-08-11T00:00:00.000Z";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "attention-browser", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "attention-browser-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

test("attention page proves desktop and narrow action/evidence disclosure", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-attention-browser-test-"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const database = new ForgeDatabase(config.databasePath);
  const staleProjectionAt = new Date(Date.now() - 60_000).toISOString();
  const app = (() => {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-b', 'Company B', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, state, created_at) VALUES ('revision-a', 'project-a', 1, 'identity-a', '{}', ?, ?, 'admin', 'accepted', ?)").run("a".repeat(40), "b".repeat(40), now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'brief.md', 'text/markdown', 1, ?, ?, ?)").run("b".repeat(64), "company-a/brief-a", now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Needs a decision', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'attention-browser', ?, ?)").run(now, now);
      db.prepare("UPDATE forge_companies SET issue_code = 'ATTN' WHERE id = 'company-a'").run();
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, authoritative_revision, projected_at, state_changed_at, projection_status, reconciled_at) VALUES ('task-a', 'company-a', 'project-a', 'workflow-a', 7, 'delivery_blocked', 'human', '[\"record_delivery_decision\",\"cancel_issue\"]', 'Decision required', ?, 'workflow-a:7', 7, ?, ?, 'current', ?)").run(now, staleProjectionAt, now, now);
      db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES ('task-a', 'company-a', 'workflow-a', 7, ?, ?)").run(JSON.stringify({ workflowId: "workflow-a", companyId: "company-a", projectId: "project-a", issueId: "task-a", projectRevisionId: "revision-a", phase: "delivery_blocked", revision: 7, owner: "human", allowedCommands: ["record_delivery_decision", "cancel_issue"], pendingAction: "Decision required", lastEventId: "workflow-a:7", continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: now }), now);
    });
    const artifactStore = new ArtifactStore(config.artifactRoot);
    const attentionPromise = artifactStore.put("company-a", "attention-evidence", { filename: "decision.json", mimeType: "application/json", bytes: Buffer.from('{"summary":"Safe evidence","prompt":"secret prompt","rawLog":"secret raw log","token":"secret token"}', "utf8") });
    return { attentionPromise, artifactStore };
  })();
  try {
    const { attentionPromise, artifactStore } = app;
    const evidence = await attentionPromise;
    const brief = await artifactStore.put("company-a", "task-brief", { filename: "brief.md", mimeType: "text/markdown", bytes: Buffer.from("A real browser action fixture.", "utf8") });
    database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET byte_size = ?, sha256 = ?, storage_path = ? WHERE id = 'brief-a' AND company_id = 'company-a'").run(brief.byteSize, brief.sha256, brief.storagePath));
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
      db.prepare("INSERT INTO forge_attention_items (id, company_id, task_id, category, summary, action, evidence_ref, active, created_at, updated_at, source_revision, activated_at, actions_json, evidence_artifact_id, evidence_sha256) VALUES ('attention-a', 'company-a', 'task-a', 'member_decision', 'A decision is required', 'Record decision', ?, 1, ?, ?, 7, ?, ?, ?, ?)").run(evidence.id, now, now, now, JSON.stringify([{ command: "record_delivery_decision", label: "Record decision", expectedRevision: 7, requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", expectedRevision: 7, requiresNote: false, destructive: true }]), evidence.id, evidence.sha256);
    });
    const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
    const attention = new AttentionService(database, auth, artifactStore);
    let workflowAttempts = 0;
    const tasks = new TaskService(database, auth, null as never, config, { workflow: {
      execute: async (command: string, _workflowId: string, input: { expectedRevision: number; actorUserId: string; note?: string }) => {
        if (command !== "record_delivery_decision") throw new Error(`unexpected command ${command}`);
        workflowAttempts += 1;
        if (workflowAttempts === 1) throw new Error("stale workflow revision");
        if (input.expectedRevision !== 7) throw new Error("stale workflow revision");
        const updatedAt = new Date().toISOString();
        database.authTransaction((db) => {
          db.prepare("UPDATE forge_issue_projections SET revision = 8, phase = 'delivery_blocked', owner = 'human', allowed_commands_json = '[]', pending_action = NULL, updated_at = ?, projected_at = ?, state_changed_at = ?, projection_status = 'current', reconciled_at = ?, authoritative_revision = 8, last_event_id = 'workflow-a:8' WHERE task_id = 'task-a' AND company_id = 'company-a' AND revision = 7").run(updatedAt, updatedAt, updatedAt, updatedAt);
          db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES ('task-a', 'company-a', 'workflow-a', 8, ?, ?)").run(JSON.stringify({ workflowId: "workflow-a", companyId: "company-a", projectId: "project-a", issueId: "task-a", projectRevisionId: "revision-a", phase: "delivery_blocked", revision: 8, owner: "human", allowedCommands: [], pendingAction: null, lastEventId: "workflow-a:8", continuationCount: 0, lastSummaryHash: null, blocker: null, stateChangedAt: updatedAt }), updatedAt);
          db.prepare("UPDATE forge_attention_items SET active = 0, updated_at = ? WHERE id = 'attention-a' AND company_id = 'company-a' AND active = 1").run(updatedAt);
          db.prepare("INSERT OR IGNORE INTO forge_projection_invalidations (id, company_id, task_id, revision, attention_changed, created_at) VALUES ('workflow-a:8', 'company-a', 'task-a', 8, 1, ?)").run(updatedAt);
        });
        return {} as IssueWorkflowState;
      },
    } as never });
    const server = createApp({ config, auth, tasks, attention, health: {
      temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    } });
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
      await page.goto(`http://127.0.0.1:${address.port}/attention`);
      await page.locator("section").getByText("Company A", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Switch company" }).click();
      await page.getByRole("menuitem", { name: /Company B/ }).click();
      expect(await page.url()).toMatch(/company=company-b/);
      await page.getByText("Projection status unknown", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Switch company" }).click();
      await page.getByRole("menuitem", { name: /Company A/ }).click();
      await page.getByText("Projection stale · r7 → r7", { exact: true }).waitFor();
      expect(await page.getByText("ATTN-1", { exact: true }).isVisible()).toBe(true);
      const narrowInteraction = await context.newPage();
      await narrowInteraction.setViewportSize({ width: 390, height: 844 });
      await narrowInteraction.goto(`http://127.0.0.1:${address.port}/attention?company=company-a`);
      await narrowInteraction.getByText("A decision is required", { exact: true }).click();
      await narrowInteraction.getByText(/Safe evidence/).waitFor();
      expect(await narrowInteraction.locator("body").textContent()).not.toContain("secret token");
      await narrowInteraction.close();
      await page.getByText("A decision is required", { exact: true }).click();
      await page.getByRole("button", { name: "Record decision" }).waitFor();
      await page.getByText(/Safe evidence/).waitFor();
      expect(await page.locator("body").textContent()).not.toContain("secret token");
      await page.getByRole("button", { name: "Cancel issue" }).click();
      const cancelDialog = page.locator('[data-slot="alert-dialog-content"]');
      await cancelDialog.waitFor({ timeout: 5_000 });
      expect(await cancelDialog.textContent()).toContain("Cancel ATTN-1 · Needs a decision?");
      await page.getByRole("button", { name: "Keep issue" }).click();
      await page.getByRole("button", { name: "Record decision" }).click();
      await page.getByRole("textbox", { name: "Record decision note" }).fill("Reviewed current delivery evidence.");
      const staleResponse = page.waitForResponse((response) => response.url().includes("/record-delivery-decision"));
      await page.getByRole("button", { name: "Record decision" }).click();
      const stale = await staleResponse;
      expect(stale.status()).toBe(409);
      await page.getByRole("status").waitFor();
      expect(await page.getByRole("status").textContent()).toContain("This issue changed");
      await page.getByRole("button", { name: "Record decision" }).click();
      await page.getByRole("textbox", { name: "Record decision note" }).fill("Reviewed current delivery evidence.");
      await page.getByRole("button", { name: "Record decision" }).click();
      await page.getByText("A decision is required", { exact: true }).waitFor({ state: "detached" });
      expect(workflowAttempts).toBe(2);
      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.goto(`http://127.0.0.1:${address.port}/attention`);
      expect(await narrow.getByRole("button", { name: "Open settings navigation" }).isVisible()).toBe(true);
      expect(await narrow.locator("section").getByText("Company A", { exact: true }).isVisible()).toBe(true);
      await narrow.getByRole("button", { name: "Refresh" }).click();
      await narrow.getByText("No decision needed.", { exact: true }).waitFor();
      await narrow.close(); await page.close(); await context.close();
    } finally { await browser.close(); }
    await server.close();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
