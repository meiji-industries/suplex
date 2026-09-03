import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService, type WebAuthnAdapter } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

function fakeWebAuthn(): WebAuthnAdapter {
  return {
    async generateRegistrationOptions(input) {
      return {
        rp: { name: "Forge", id: input.rpId },
        user: { id: input.userId, name: input.userName, displayName: input.displayName },
        challenge: Buffer.from("registration").toString("base64url"),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        attestation: "none",
      };
    },
    async verifyRegistrationResponse(input) {
      return { verified: true, credential: { id: input.response.id, publicKey: Uint8Array.from([1]), counter: 0, transports: ["internal"] } };
    },
    async generateAuthenticationOptions(input) {
      return { challenge: Buffer.from("authentication").toString("base64url"), rpId: input.rpId, allowCredentials: input.allowCredentials.map((credential) => ({ type: "public-key" as const, ...credential })), userVerification: "required" };
    },
    async verifyAuthenticationResponse() {
      return { verified: true, newCounter: 1 };
    },
  };
}

async function fixture(): Promise<{ root: string; database: ForgeDatabase; auth: AuthService; config: ReturnType<typeof createTestConfig> }> {
  const root = await mkdtemp(join(tmpdir(), "forge-company-clear-"));
  const config = createTestConfig(root, { reachableAddress: "https://forge.tailnet.ts.net:4111" });
  const database = new ForgeDatabase(config.databasePath);
  const auth = new AuthService(database, config, { webAuthn: fakeWebAuthn() });
  return { root, database, auth, config };
}

test("clearCompany wipes company-scoped data and resets it to factory state", async () => {
  const value = await fixture();
  const now = "2026-09-02T12:00:00.000Z";
  try {
    const invitation = value.auth.ensureBootstrapInvitation()!;
    const options = await value.auth.beginBootstrapRegistration(invitation.token);
    const admin = (await value.auth.completeBootstrapRegistration({ token: invitation.token, challengeId: options.challengeId, response: { id: "cred-1", type: "public-key" } })).user;
    const company = value.auth.createCompany(admin.id, "Wipe Me");

    const sql = (t: string): string => `SELECT count(*) AS n FROM ${t} WHERE company_id = ?`;
    const count = (t: string): number => (value.database.authQuery((db) => db.prepare(sql(t)).get(company.id)) as { n: number }).n;
    const countByTask = (t: string): number => (value.database.authQuery((db) => db.prepare(`SELECT count(*) AS n FROM ${t} WHERE task_id IN (SELECT id FROM forge_tasks WHERE company_id = ?)`).get(company.id)) as { n: number }).n;
    const countByProject = (t: string): number => (value.database.authQuery((db) => db.prepare(`SELECT count(*) AS n FROM ${t} WHERE project_id IN (SELECT id FROM forge_projects WHERE company_id = ?)`).get(company.id)) as { n: number }).n;
    const countByOverride = (): number => (value.database.authQuery((db) => db.prepare("SELECT count(*) AS n FROM forge_prompt_override_revisions WHERE override_id IN (SELECT id FROM forge_prompt_overrides WHERE project_id IN (SELECT id FROM forge_projects WHERE company_id = ?))").get(company.id)) as { n: number }).n;

    // Seed one of each company-scoped shape across the FK buckets.
    value.database.authTransaction((db) => {
      const insert = (s: string, ...params: unknown[]): void => { db.prepare(s).run(...params); };
      insert("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('artifact-brief', ?, 'task-brief', 'brief.md', 'text/markdown', 4, ?, 'objects/ab/brief.bin', ?)", company.id, "a".repeat(64), now);
      insert("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('artifact-evidence', ?, 'lead-evidence', 'e.json', 'application/json', 2, ?, 'objects/ae/e.bin', ?)", company.id, "b".repeat(64), now);
      insert("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', ?, 'P', '/repo/p', '/worktrees/p', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)", company.id, now, now);
      insert("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', ?, 'project-1', 'T', 'artifact-brief', '[]', '{}', 'wf-1', 'rev-1', 'key-1', ?, ?)", company.id, now, now);
      insert("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('exec-1', 'task-1', ?, 'wf-1', 'planner', 'completed', 1, ?)", company.id, now);
      insert("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, created_at) VALUES ('review-1', 'task-1', ?, 'wf-1', 1, 'base', 'head', 'tree', 'exec-1', 'sess-1', 'approved', 'ok', 'artifact-evidence', 'artifact-evidence', ?)", company.id, now);
      insert("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, status, created_at, updated_at) VALUES ('sess-1', 'task-1', 'planner', 0, 1, 'codex', 'ready', ?, ?)", now, now);
      insert("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, status, created_at, updated_at) VALUES ('turn-1', 'task-1', 'sess-1', 'planner', 'agent', 'exec-1', 'lead-plan', ?, 'turns/turn-1.json', 'completed', ?, ?)", "d".repeat(64), now, now);
      insert("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES ('task-1', ?, 'wf-1', 0, '{}', ?)", company.id, now);
      insert("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, updated_at, last_event_id, event_hash, authoritative_revision, projected_at, last_run_id, authoritative_event_hash, projection_status) VALUES ('task-1', ?, 'project-1', 'wf-1', 0, 'backlog', 'member', '[]', ?, 'wf-1:0', ?, 0, ?, 'run-1', ?, 'current')", company.id, now, "e".repeat(64), now, "f".repeat(64));
      insert("INSERT INTO forge_task_templates (id, company_id, project_id, name, description, role_agents, supplemental_review, auto_approve_plan, delivery_target, run_project_tests, visual_evidence, created_at) VALUES ('template-1', ?, 'project-1', 'Release', 'd', '{}', 0, 0, 'keep_in_worktree', 1, 'off', ?)", company.id, now);
      insert("INSERT INTO forge_task_template_seeds (project_id, template_name, seeded_at) VALUES ('project-1', 'Release', ?)", now);
      insert("INSERT INTO forge_prompt_overrides (id, scope, project_id, scope_key, template_id, mode, content, base_template_sha256, current_revision, updated_by_user_id, created_at, updated_at) VALUES ('override-1', 'project', 'project-1', 'project-1', 'lead-plan', 'append', 'x', ?, 1, ?, ?, ?)", "c".repeat(64), admin.id, now, now);
      insert("INSERT INTO forge_prompt_override_revisions (id, override_id, revision, mode, content, base_template_sha256, actor_user_id, created_at) VALUES ('rev-1', 'override-1', 1, 'append', 'x', ?, ?, ?)", "c".repeat(64), admin.id, now);
      insert("INSERT INTO forge_agents (id, kind, name, role, avatar_seed, created_at, updated_at) VALUES ('agent-1', 'hermes', 'Hermes', NULL, 'Hermes', ?, ?)", now, now);
      insert("INSERT INTO forge_external_agents (id, company_id, status, created_at, updated_at) VALUES ('agent-1', ?, 'pending', ?, ?)", company.id, now, now);
      insert("INSERT INTO forge_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES ('agent-1', ?, 'project-1', ?)", company.id, now);
      insert("INSERT INTO probe_workflows (probe_id, workflow_id, company_id, status) VALUES ('probe-1', 'probe-wf', ?, 'completed')", company.id);
      insert("INSERT INTO forge_task_command_activity (id, task_id, step_id, command, duration_ms, stdout, stderr, entries_json, started_at, finished_at) VALUES ('cmd-1', 'task-1', 's1', 'true', 1, '', '', '[]', ?, ?)", now, now);
    });

    // Artifact files on disk for the company.
    const artifactDir = join(value.config.artifactRoot, company.id);
    await mkdir(join(artifactDir, "objects", "ab"), { recursive: true });
    await writeFile(join(artifactDir, "objects", "ab", "brief.bin"), "brief");

    // A second company must be untouched.
    const other = value.auth.createCompany(admin.id, "Keep Me");
    value.database.authTransaction((db) => db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-other', ?, 'Other P', '/repo/other', '/worktrees/other', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(other.id, now, now));

    const cleared = await value.auth.clearCompany(admin.id, company.id);
    expect(cleared.status).toBe("active");
    expect(cleared.issueCode).toBeNull();

    for (const table of ["forge_projects", "forge_tasks", "forge_external_agents", "forge_artifacts", "forge_agent_executions", "forge_delivery_reviews", "forge_workflow_snapshots", "forge_issue_projections", "forge_task_templates", "forge_external_agent_project_grants", "probe_workflows"]) {
      expect(count(table), `${table} must be empty for the cleared company`).toBe(0);
    }
    expect(value.database.authQuery((db) => db.prepare("SELECT count(*) AS n FROM forge_agents WHERE id = 'agent-1'").get() as { n: number })).toEqual({ n: 0 });
    for (const table of ["forge_herdr_role_sessions", "forge_herdr_turns", "forge_task_command_activity"]) {
      expect(countByTask(table), `${table} must be empty for the cleared company`).toBe(0);
    }
    for (const table of ["forge_task_template_seeds", "forge_prompt_overrides"]) {
      expect(countByProject(table), `${table} must be empty for the cleared company`).toBe(0);
    }
    expect(countByOverride(), "forge_prompt_override_revisions must be empty for the cleared company").toBe(0);

    const reset = value.database.authQuery((db) => db.prepare("SELECT status, issue_code AS issueCode, next_issue_number AS nextIssueNumber FROM forge_companies WHERE id = ?").get(company.id)) as { status: string; issueCode: string | null; nextIssueNumber: number };
    expect(reset).toEqual({ status: "active", issueCode: null, nextIssueNumber: 1 });

    // Artifact files were removed.
    expect(existsSync(artifactDir)).toBe(false);

    // The sibling company is intact.
    expect(value.database.authQuery((db) => db.prepare("SELECT count(*) AS n FROM forge_projects WHERE company_id = ?").get(other.id))).toEqual({ n: 1 });
    const kept = value.database.authQuery((db) => db.prepare("SELECT name FROM forge_projects WHERE company_id = ?").get(other.id)) as { name: string } | undefined;
    expect(kept?.name).toBe("Other P");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("clearCompany requires an administrator and leaves memberships and audit history", async () => {
  const value = await fixture();
  try {
    const invitation = value.auth.ensureBootstrapInvitation()!;
    const options = await value.auth.beginBootstrapRegistration(invitation.token);
    const admin = (await value.auth.completeBootstrapRegistration({ token: invitation.token, challengeId: options.challengeId, response: { id: "cred-2", type: "public-key" } })).user;
    const company = value.auth.createCompany(admin.id, "Audited");

    const userInvitation = value.auth.inviteUser(admin.id, { displayName: "Member" });
    const user = (await value.auth.completeInvitationRegistration({ token: userInvitation.token, challengeId: (await value.auth.beginInvitationRegistration(userInvitation.token)).challengeId, response: { id: "cred-3", type: "public-key" } })).user;
    value.auth.addMembership(admin.id, user.id, company.id);
    value.auth.setCompanyStatus(admin.id, company.id, "archived");

    await value.auth.clearCompany(admin.id, company.id);

    expect(value.database.authQuery((db) => db.prepare("SELECT count(*) AS n FROM forge_memberships WHERE company_id = ?").get(company.id))).toEqual({ n: 1 });
    const audit = value.database.authQuery((db) => db.prepare("SELECT action FROM forge_audit_events WHERE company_id = ? ORDER BY created_at, rowid").all(company.id)) as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toContain("company_cleared");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});