import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AttentionService } from "../src/attention.js";
import type { WebAuthnAdapter } from "../src/auth.js";
import { AuthService } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { SESSION_COOKIE_NAME, newSessionToken } from "../src/auth-identifiers.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "attention-api", pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse() { return { verified: true, credential: { id: "credential", publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions() { return { challenge: "attention-auth", rpId: "localhost", allowCredentials: [], userVerification: "required" as const }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

test("attention API queries human-owned projections and returns their count", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-attention-api-test-"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const database = new ForgeDatabase(config.databasePath);
  try {
    const now = "2026-08-21T00:00:00.000Z";
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(join(root, "repository-a"), join(root, "worktrees-a"), now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'brief.md', 'text/markdown', 1, ?, ?, ?)").run("b".repeat(64), "company-a/brief-a", now);
      for (const [id, title] of [["task-human", "Needs a decision"], ["task-lead", "Lead is working"]]) db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'company-a', 'project-a', ?, 'brief-a', '[]', '{}', 0, ?, 'snapshot-a', ?, ?, ?)").run(id, title, `workflow-${id}`, id, now, now);
      db.prepare("UPDATE forge_companies SET issue_code = 'ACME' WHERE id = 'company-a'").run();
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, authoritative_revision, projected_at, state_changed_at, projection_status, reconciled_at) VALUES ('task-human', 'company-a', 'project-a', 'workflow-task-human', 7, 'delivery_blocked', 'human', '[\"record_delivery_decision\",\"cancel_issue\"]', 'Decision required', ?, 'workflow-task-human:7', 7, ?, ?, 'current', ?)").run(now, now, now, now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, authoritative_revision, projected_at, state_changed_at, projection_status, reconciled_at) VALUES ('task-lead', 'company-a', 'project-a', 'workflow-task-lead', 8, 'planning', 'lead', '[]', 'The Planner writes the plan', ?, 'workflow-task-lead:8', 8, ?, ?, 'current', ?)").run(now, now, now, now);
    });
    const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
    const attention = new AttentionService(database, auth);
    const app = createApp({ config, auth, attention, health: { engine: async () => ({ id: "engine", label: "Engine", status: "healthy", summary: "Ready", details: {} }), database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }), artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }), worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }), codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }), ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }) } });
    const token = newSessionToken();
    database.authQuery((db) => db.prepare("INSERT INTO forge_sessions (id, token_hash, user_id, expires_at, created_at, revoked_at, token_version) VALUES ('session-a', ?, 'admin', ?, ?, NULL, 1)").run(createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 3_600_000).toISOString(), now));
    const response = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: config.reachableAddress } });
    expect(response.statusCode).toBe(200);
    expect(response.json().companies[0]).toMatchObject({ attentionCount: 1, attention: [{ taskId: "task-human", taskTitle: "Needs a decision", summary: "Decision required", card: expect.objectContaining({ explanation: "Decision required" }), actions: expect.arrayContaining([expect.objectContaining({ command: "record_delivery_decision", expectedRevision: 7, idempotency: "required" })]) }] });
    expect(response.json().companies[0].attention.map((item: { taskId: string }) => item.taskId)).not.toContain("task-lead");
    await app.close();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
