import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { AttentionService } from "../src/attention.js";
import { AuthService } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { newSessionToken, SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import type { WebAuthnAdapter } from "../src/auth.js";

const now = "2026-08-11T00:00:00.000Z";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) { return { rp: { name: "Forge", id: input.rpId }, user: { id: input.userId, name: input.userName, displayName: input.displayName }, challenge: "attention-api", pubKeyCredParams: [{ type: "public-key", alg: -7 }], attestation: "none" }; },
    async verifyRegistrationResponse(input) { return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 } }; },
    async generateAuthenticationOptions(input) { return { challenge: "attention-auth", rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" }; },
    async verifyAuthenticationResponse() { return { verified: true, newCounter: 1 }; },
  };
}

test("attention API exposes scoped actions and bounded redacted evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-attention-api-test-"));
  const config = createTestConfig(root, { reachableAddress: "http://127.0.0.1:4111" });
  const database = new ForgeDatabase(config.databasePath);
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member-a', 'Member', 'member@forge.local', 'member', 'active', ?, ?), ('revoked-user', 'Revoked', 'revoked@forge.local', 'member', 'revoked', ?, ?)").run(now, now, now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-b', 'Company B', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('member-a', 'company-a', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-a', 'company-a', 'Project A', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, state, created_at) VALUES ('revision-a', 'project-a', 1, 'identity-a', '{}', ?, ?, 'admin', 'accepted', ?)").run("a".repeat(40), "b".repeat(40), now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'brief.md', 'text/markdown', 1, ?, ?, ?)").run("b".repeat(64), "company-a/brief-a", now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-a', 'company-a', 'project-a', 'Needs a decision', 'brief-a', '[]', '{}', 0, 'workflow-a', 'revision-a', 'attention-a', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-completed', 'company-a', 'project-a', 'Recently completed', 'brief-a', '[]', '{}', 0, 'workflow-completed', 'revision-a', 'completed-a', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-b', 'company-b', 'Project B', ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(join(root, "repository-b"), join(root, "worktrees-b"), now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, state, created_at) VALUES ('revision-b', 'project-b', 1, 'identity-b', '{}', ?, ?, 'admin', 'accepted', ?)").run("a".repeat(40), "b".repeat(40), now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-b', 'company-b', 'task-brief', 'brief.md', 'text/markdown', 1, ?, ?, ?)").run("c".repeat(64), "company-b/brief-b", now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-b', 'company-b', 'project-b', 'Other company', 'brief-b', '[]', '{}', 0, 'workflow-b', 'revision-b', 'attention-b', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, authoritative_revision, projected_at, state_changed_at, projection_status, reconciled_at) VALUES ('task-a', 'company-a', 'project-a', 'workflow-a', 7, 'delivery_blocked', 'human', '[\"record_delivery_decision\",\"cancel_issue\"]', 'Decision required', ?, 'workflow-a:7', 7, ?, ?, 'current', ?)").run(now, now, now, now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, authoritative_revision, projected_at, state_changed_at, projection_status, reconciled_at) VALUES ('task-completed', 'company-a', 'project-a', 'workflow-completed', 3, 'done', 'human', '[]', NULL, ?, 'workflow-completed:3', 3, ?, ?, 'current', ?)").run(now, now, now, now);
      db.prepare("UPDATE forge_companies SET issue_code = 'ADAM' WHERE id = 'company-a'").run();
    });
    const artifactStore = new ArtifactStore(config.artifactRoot);
    const evidence = await artifactStore.put("company-a", "attention-evidence", { filename: "decision.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ summary: "Safe evidence", token: "do-not-show", nested: { stdout: "do-not-show" } }), "utf8") });
    const evidenceB = await artifactStore.put("company-b", "attention-evidence", { filename: "decision.json", mimeType: "application/json", bytes: Buffer.from('{"summary":"Company B evidence"}', "utf8") });
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidence.id, evidence.companyId, evidence.kind, evidence.filename, evidence.mimeType, evidence.byteSize, evidence.sha256, evidence.storagePath, evidence.createdAt);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evidenceB.id, evidenceB.companyId, evidenceB.kind, evidenceB.filename, evidenceB.mimeType, evidenceB.byteSize, evidenceB.sha256, evidenceB.storagePath, evidenceB.createdAt);
      db.prepare("INSERT INTO forge_attention_items (id, company_id, task_id, category, summary, action, evidence_ref, active, created_at, updated_at, source_revision, activated_at, actions_json, evidence_artifact_id, evidence_sha256) VALUES ('attention-a', 'company-a', 'task-a', 'member_decision', 'A decision is required', 'Record decision', ?, 1, ?, ?, 7, ?, ?, ?, ?)").run(evidence.id, now, now, now, JSON.stringify([{ command: "record_delivery_decision", label: "Record decision", expectedRevision: 7, requiresNote: true, destructive: false }, { command: "cancel_issue", label: "Cancel issue", expectedRevision: 7, requiresNote: false, destructive: true }]), evidence.id, evidence.sha256);
      db.prepare("INSERT INTO forge_attention_items (id, company_id, task_id, category, summary, action, evidence_ref, active, created_at, updated_at, source_revision, activated_at, actions_json, evidence_artifact_id, evidence_sha256) VALUES ('attention-b', 'company-b', 'task-b', 'member_decision', 'Company B decision', 'Record decision', ?, 1, ?, ?, 7, ?, ?, ?, ?)").run(evidenceB.id, now, now, now, JSON.stringify([{ command: "record_delivery_decision", label: "Record decision", expectedRevision: 7, requiresNote: true, destructive: false }]), evidenceB.id, evidenceB.sha256);
    });

    const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
    const attention = new AttentionService(database, auth, artifactStore);
    const app = createApp({ config, auth, attention, health: {
      temporal: async () => ({ id: "temporal", label: "Temporal", status: "healthy", summary: "Ready", details: {} }),
      database: async () => ({ id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} }),
      artifactRoot: async () => ({ id: "artifact-root", label: "Artifacts", status: "healthy", summary: "Ready", details: {} }),
      worker: async () => ({ id: "worker", label: "Worker", status: "healthy", summary: "Ready", details: {} }),
      codexAuth: async () => ({ id: "codex-auth", label: "Codex", status: "healthy", summary: "Ready", details: {} }),
      ghAuth: async () => ({ id: "gh-auth", label: "GitHub", status: "healthy", summary: "Ready", details: {} }),
    } });
    const invitation = auth.createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
    const options = await app.inject({ method: "POST", url: "/api/auth/recovery/options", payload: { token: invitation.token } });
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/recovery/verify", payload: { token: invitation.token, challengeId: options.json().challengeId, response: { id: "attention-api-admin", type: "public-key" } } });
    const cookies = (Array.isArray(enrolled.headers["set-cookie"]) ? enrolled.headers["set-cookie"] : [enrolled.headers["set-cookie"] ?? ""]) as string[];
    const cookie = cookies.map((value) => value.split(";", 1)[0] ?? "").find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
    const headers = { cookie, origin: config.reachableAddress };
    const overview = await app.inject({ method: "GET", url: "/api/attention", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().companies[0].attention[0]).toMatchObject({ id: "attention-a", issueKey: "ADAM-1", sourceRevision: 7, actions: expect.arrayContaining([expect.objectContaining({ command: "record_delivery_decision", expectedRevision: 7 })]) });
    expect(overview.json().companies[0].recentOutcomes[0]).toMatchObject({ taskId: "task-completed", issueKey: "ADAM-2", taskTitle: "Recently completed", phase: "done" });
    const evidenceResponse = await app.inject({ method: "GET", url: "/api/attention/attention-a/evidence", headers });
    expect(evidenceResponse.statusCode).toBe(200);
    expect(evidenceResponse.headers["cache-control"]).toBe("private, no-store");
    expect(evidenceResponse.json()).toMatchObject({ artifactId: evidence.id, kind: "attention-evidence", truncated: false });
    expect(evidenceResponse.json().content).not.toMatch(/do-not-show/);
    const memberSessionToken = newSessionToken();
    database.authQuery((db) => db.prepare("INSERT INTO forge_sessions (id, token_hash, user_id, expires_at, created_at, revoked_at, token_version) VALUES ('member-session', ?, 'member-a', ?, ?, NULL, 1)").run(createHash("sha256").update(memberSessionToken).digest("hex"), new Date(Date.now() + 3_600_000).toISOString(), now));
    const memberHeaders = { cookie: `${SESSION_COOKIE_NAME}=${memberSessionToken}`, origin: config.reachableAddress };
    const memberOverview = await app.inject({ method: "GET", url: "/api/attention", headers: memberHeaders });
    expect(memberOverview.statusCode).toBe(200);
    expect(memberOverview.json().companies).toHaveLength(1);
    expect(memberOverview.json().companies[0].attention.map((item: { id: string }) => item.id)).toEqual(["attention-a"]);
    expect((await app.inject({ method: "GET", url: "/api/attention/task-b", headers: memberHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/attention/attention-b/evidence", headers: memberHeaders })).statusCode).toBe(404);
    expect(attention.list("member-a")).toHaveLength(1);
    expect(() => attention.list("revoked-user")).toThrowError("Authentication required");
    expect(() => attention.get("member-a", "task-b")).toThrowError("Not found");
    await expect(attention.evidence("member-a", "attention-b")).rejects.toThrow("Not found");

    database.authQuery((db) => db.prepare("UPDATE forge_attention_items SET evidence_sha256 = ? WHERE id = 'attention-a'").run("0".repeat(64)));
    expect(attention.get("member-a", "task-a")).toEqual([]);
    database.authQuery((db) => db.prepare("UPDATE forge_attention_items SET evidence_sha256 = ?, active = 0 WHERE id = 'attention-a'").run(evidence.sha256));
    await expect(attention.evidence("member-a", "attention-a")).rejects.toThrow("Not found");

    const large = await artifactStore.put("company-a", "attention-evidence", { filename: "large.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ summary: "large", token: "secret-value-should-not-leak", payload: "x".repeat(80_000) }), "utf8") });
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(large.id, large.companyId, large.kind, large.filename, large.mimeType, large.byteSize, large.sha256, large.storagePath, large.createdAt);
      db.prepare("UPDATE forge_attention_items SET active = 1, evidence_artifact_id = ?, evidence_sha256 = ? WHERE id = 'attention-a'").run(large.id, large.sha256);
    });
    const bounded = await attention.evidence("member-a", "attention-a");
    expect(bounded.truncated).toBe(true);
    expect(bounded.content).not.toMatch(/authorization|secret-value-should-not-leak/i);
    await app.close();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
