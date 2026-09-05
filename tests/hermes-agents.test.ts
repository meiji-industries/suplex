import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { HermesAgentFailure, HermesAgentService } from "../src/hermes-agents.js";
import { jsonRequired } from "../src/task-utils.js";

let root: string;
let database: ForgeDatabase;
let auth: AuthService;
let service: HermesAgentService;
let adminId: string;
let memberId: string;
let companyId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-hermes-agent-test-"));
  const config = createTestConfig(root, { developmentAutoLogin: true });
  database = new ForgeDatabase(config.databasePath);
  auth = new AuthService(database, config);
  adminId = auth.ensureDevelopmentUser().id;

  const now = new Date().toISOString();
  memberId = "member_test_1";
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES (?, 'Member', 'member', 'member', 'active', ?, ?, 1)").run(memberId, now, now);
  });

  companyId = auth.createCompany(adminId, "Hermes Company").id;
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project_allowed', ?, 'Allowed', ?, ?, 'meiji/allowed', 'main', '', '', ?, ?)").run(companyId, join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project_second', ?, 'Second', ?, ?, 'meiji/second', 'main', '', '', ?, ?)").run(companyId, join(root, "repo2"), join(root, "worktrees2"), now, now);
    const otherCompanyId = auth.createCompany(adminId, "Other Company").id;
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project_other', ?, 'Other', ?, ?, 'meiji/other', 'main', '', '', ?, ?)").run(otherCompanyId, join(root, "other-repo"), join(root, "other-worktrees"), now, now);
  });
  service = new HermesAgentService(database, auth);
});

afterEach(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("canonical forge_agents identity and one-to-one extension are created atomically", () => {
  const issued = service.create(adminId, { name: "Hermes Unified", companyId, projectIds: ["project_allowed"] });

  // Base agent in forge_agents
  const baseAgent = database.authQuery((db) => db.prepare("SELECT * FROM forge_agents WHERE id = ?").get(issued.agent.id) as {
    id: string; name: string; avatar_seed: string;
  });
  expect(baseAgent).toMatchObject({
    id: issued.agent.id,
    name: "Hermes Unified",
  });

  // Extension row in forge_external_agents
  const extAgent = database.authQuery((db) => db.prepare("SELECT * FROM forge_external_agents WHERE id = ?").get(issued.agent.id) as {
    id: string; company_id: string; status: string;
  });
  expect(extAgent).toMatchObject({
    id: issued.agent.id,
    company_id: companyId,
    status: "pending",
  });
});

test("rejects a duplicate agent name with a helpful error", () => {
  service.create(adminId, { name: "Hermes Duplicate", companyId, projectIds: ["project_allowed"] });
  expect(() => service.create(adminId, { name: "Hermes Duplicate", companyId, projectIds: ["project_allowed"] })).toThrowError("An agent with this name already exists");
});

test("pairs once, persists only hashes, authenticates, and audits with explicit actor_agent_id", () => {
  const issued = service.create(adminId, { name: "Hermes Dev", companyId, projectIds: ["project_allowed"] });
  expect(issued.pairingCode).toMatch(/^fhp_/);

  const paired = service.exchange({ pairingCode: issued.pairingCode, profileId: "dev" });
  expect(paired.credential).toMatch(/^fha_/);
  expect(service.authenticate(paired.credential)).toMatchObject({ agentId: issued.agent.id, companyId, profileId: "dev", projectIds: ["project_allowed"] });
  expect(() => service.exchange({ pairingCode: issued.pairingCode, profileId: "dev" })).toThrowError(HermesAgentFailure);

  const dump = database.authQuery((db) => JSON.stringify({
    agents: db.prepare("SELECT * FROM forge_external_agents").all(),
    pairing: db.prepare("SELECT * FROM forge_hermes_pairing_codes").all(),
    credentials: db.prepare("SELECT * FROM forge_external_agent_credentials").all(),
    audit: db.prepare("SELECT action, metadata_json FROM forge_audit_events WHERE action LIKE 'hermes_%'").all(),
  }));
  expect(dump).not.toContain(issued.pairingCode);
  expect(dump).not.toContain(paired.credential);
  expect(dump).not.toContain("fhp_");
  expect(dump).not.toContain("fha_");

  // Verify Hermes pairing audit event has actor_agent_id set and actor_user_id null
  const pairAuditEvent = database.authQuery((db) => db.prepare("SELECT * FROM forge_audit_events WHERE action = 'hermes_agent_paired'").get() as {
    actor_user_id: string | null; actor_agent_id: string | null; action: string;
  });
  expect(pairAuditEvent.actor_agent_id).toBe(issued.agent.id);
  expect(pairAuditEvent.actor_user_id).toBeNull();

  // Verify admin creation audit event has actor_user_id set and actor_agent_id null
  const createAuditEvent = database.authQuery((db) => db.prepare("SELECT * FROM forge_audit_events WHERE action = 'hermes_agent_created'").get() as {
    actor_user_id: string | null; actor_agent_id: string | null; action: string;
  });
  expect(createAuditEvent.actor_user_id).toBe(adminId);
  expect(createAuditEvent.actor_agent_id).toBeNull();
});

test("admin-only access: non-admin member and unauthenticated callers are denied", () => {
  expect(() => service.create(memberId, { name: "Hermes Member", companyId, projectIds: ["project_allowed"] })).toThrowError(/not found/i);
  expect(() => service.create("non_existent_user", { name: "Hermes Anon", companyId, projectIds: ["project_allowed"] })).toThrowError(/authentication required/i);
  expect(() => service.list(memberId)).toThrowError(/not found/i);
  expect(() => service.replaceProjects(memberId, "any", ["project_allowed"])).toThrowError(/not found/i);
  expect(() => service.issueInitialPairing(memberId, "any")).toThrowError(/not found/i);
  expect(() => service.rotate(memberId, "any")).toThrowError(/not found/i);
  expect(() => service.revoke(memberId, "any")).toThrowError(/not found/i);
});

test("admin list returns Hermes agents with timestamps and grant details", () => {
  const agent1 = service.create(adminId, { name: "Agent 1", companyId, projectIds: ["project_allowed"] });
  const agent2 = service.create(adminId, { name: "Agent 2", companyId, projectIds: ["project_allowed", "project_second"] });

  const allAgents = service.list(adminId);
  expect(allAgents).toHaveLength(2);
  expect(allAgents.find((a) => a.id === agent1.agent.id)).toMatchObject({
    name: "Agent 1",
    status: "pending",
    projectIds: ["project_allowed"],
    pairingExpiresAt: expect.any(String),
    credentialCreatedAt: null,
  });
  expect(allAgents.find((a) => a.id === agent2.agent.id)).toMatchObject({
    name: "Agent 2",
    status: "pending",
    projectIds: ["project_allowed", "project_second"],
  });

  const companyScoped = service.list(adminId, companyId);
  expect(companyScoped).toHaveLength(2);
});

test("scope replacement: updates grants atomically, allows empty deny-all, rejects cross-company without partial change", () => {
  const issued = service.create(adminId, { name: "Scope Test", companyId, projectIds: ["project_allowed"] });

  // Update to two projects
  const updated = service.replaceProjects(adminId, issued.agent.id, ["project_allowed", "project_second"]);
  expect(updated.projectIds).toEqual(["project_allowed", "project_second"]);

  // Empty allowlist (deny-all)
  const denyAll = service.replaceProjects(adminId, issued.agent.id, []);
  expect(denyAll.projectIds).toEqual([]);

  // Cross-company project rejection leaves existing grants unchanged
  expect(() => service.replaceProjects(adminId, issued.agent.id, ["project_other"])).toThrowError(/not found/i);
  expect(service.getAdminAgent(issued.agent.id).projectIds).toEqual([]);
});

test("initial pairing code reissue works for pending agents and replaces prior code", () => {
  const issued = service.create(adminId, { name: "Reissue Test", companyId, projectIds: ["project_allowed"] });
  const firstCode = issued.pairingCode;

  const reissued = service.issueInitialPairing(adminId, issued.agent.id);
  expect(reissued.pairingCode).toMatch(/^fhp_/);
  expect(reissued.pairingCode).not.toBe(firstCode);

  // First code is replaced and fails
  expect(() => service.exchange({ pairingCode: firstCode, profileId: "profile-reissue" })).toThrowError(HermesAgentFailure);
  // Reissued code works
  const paired = service.exchange({ pairingCode: reissued.pairingCode, profileId: "profile-reissue" });
  expect(paired.agent.status).toBe("paired");

  // Cannot reissue initial code for already paired agent
  expect(() => service.issueInitialPairing(adminId, issued.agent.id)).toThrowError(HermesAgentFailure);
});

test("concurrent exchanges consume one pairing code exactly once", async () => {
  const issued = service.create(adminId, { name: "Hermes Concurrent", companyId, projectIds: ["project_allowed"] });
  database.close();
  const contenders = [0, 1].map(() => {
    const contender = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/hermes-exchange-contender.ts", join(root, "forge.sqlite"), issued.pairingCode, "profile-concurrent"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let ready!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    const result = new Promise<{ outcome: string; statusCode?: number; code?: string; message?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { contender.kill(); reject(new Error(`contender timed out: ${stdout} ${stderr}`)); }, 10_000);
      contender.on("close", (code) => {
        clearTimeout(timeout);
        const output = stdout.trim().split("\n").at(-1);
        if (code !== 0 || !output) {
          const error = new Error(`contender failed: ${stderr}`);
          rejectReady(error);
          return reject(error);
        }
        resolve(jsonRequired(output) as { outcome: string; statusCode?: number; code?: string; message?: string });
      });
    });
    contender.stdout.on("data", (chunk: Buffer) => { stdout += chunk; if (stdout.includes("ready\n")) ready(); });
    contender.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    return { contender, ready: readyPromise, result };
  });
  await Promise.all(contenders.map(({ ready }) => ready));
  contenders.forEach(({ contender }) => contender.stdin.end("go\n"));
  const outcomes = await Promise.all(contenders.map(({ result }) => result));
  database = new ForgeDatabase(join(root, "forge.sqlite"));
  expect(outcomes.filter(({ outcome }) => outcome === "success")).toHaveLength(1);
  expect(outcomes.filter(({ outcome }) => outcome === "failure")).toEqual([{ outcome: "failure", statusCode: 401, code: "pairing_invalid", message: "Pairing failed" }]);
  expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_external_agent_credentials WHERE agent_id = ? AND revoked_at IS NULL").get(issued.agent.id) as { count: number }).count).toBe(1);
  expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_hermes_pairing_codes WHERE agent_id = ? AND consumed_at IS NOT NULL").get(issued.agent.id) as { count: number }).count).toBe(1);
  expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action = 'hermes_agent_paired' AND actor_agent_id = ?").get(issued.agent.id) as { count: number }).count).toBe(1);
});

test("rejects cross-company grants without leaving records", () => {
  expect(() => service.create(adminId, { name: "Cross tenant", companyId, projectIds: ["project_other"] })).toThrowError(/not found/i);
  expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_external_agents").get() as { count: number }).count).toBe(0);
});

test("database constraints reject a cross-company grant", () => {
  const issued = service.create(adminId, { name: "Constraint", companyId, projectIds: ["project_allowed"] });
  expect(() => database.authTransaction((db) => db.prepare("INSERT INTO forge_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES (?, ?, 'project_other', ?)").run(issued.agent.id, companyId, new Date().toISOString()))).toThrowError(/foreign key/i);
});

test("rotation atomically replaces the active credential, records agent audit, and revocation is immediate", () => {
  const first = service.create(adminId, { name: "Hermes Rotate", companyId, projectIds: ["project_allowed"] });
  const original = service.exchange({ pairingCode: first.pairingCode, profileId: "profile-stable" });
  const rotation = service.rotate(adminId, first.agent.id);

  // Prior credential remains valid until rotation exchange succeeds
  expect(service.authenticate(original.credential).agentId).toBe(first.agent.id);
  const replacement = service.exchange({ pairingCode: rotation.pairingCode, profileId: "profile-stable" });
  expect(() => service.authenticate(original.credential)).toThrowError(/authentication/i);
  expect(service.authenticate(replacement.credential).agentId).toBe(first.agent.id);

  // Rotation audit event has actor_agent_id set
  const rotateAuditEvent = database.authQuery((db) => db.prepare("SELECT * FROM forge_audit_events WHERE action = 'hermes_agent_rotated'").get() as {
    actor_user_id: string | null; actor_agent_id: string | null;
  });
  expect(rotateAuditEvent.actor_agent_id).toBe(first.agent.id);
  expect(rotateAuditEvent.actor_user_id).toBeNull();

  service.revoke(adminId, first.agent.id);
  expect(() => service.authenticate(replacement.credential)).toThrowError(/authentication/i);
});

test("expired, consumed, replaced, malformed, revoked, and profile-mismatch share identical failure", () => {
  let now = new Date("2026-08-14T12:00:00.000Z");
  const expiring = new HermesAgentService(database, auth, { now: () => now, pairingTtlMs: 1_000 });
  const issued = expiring.create(adminId, { name: "Hermes Expiring", companyId, projectIds: ["project_allowed"] });
  now = new Date("2026-08-14T12:00:01.001Z");

  for (const pairingCode of [issued.pairingCode, "not-a-code", "fhp_invalid0000000000000000000000000000000000"]) {
    try {
      expiring.exchange({ pairingCode, profileId: "profile-expired" });
      throw new Error("expected exchange to fail");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 401, publicMessage: "Pairing failed", code: "pairing_invalid" });
    }
  }

  // Profile mismatch after rotation
  const fresh = service.create(adminId, { name: "Hermes Profile Mismatch", companyId, projectIds: ["project_allowed"] });
  service.exchange({ pairingCode: fresh.pairingCode, profileId: "profile-alpha" });
  const rot = service.rotate(adminId, fresh.agent.id);
  try {
    service.exchange({ pairingCode: rot.pairingCode, profileId: "profile-beta" });
    throw new Error("expected profile mismatch to fail");
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 401, publicMessage: "Pairing failed", code: "pairing_invalid" });
  }
});

test("one active profile per Forge instance", () => {
  const agent1 = service.create(adminId, { name: "Profile Unique 1", companyId, projectIds: ["project_allowed"] });
  const agent2 = service.create(adminId, { name: "Profile Unique 2", companyId, projectIds: ["project_allowed"] });

  service.exchange({ pairingCode: agent1.pairingCode, profileId: "shared-profile" });

  // Second agent pairing with same profile ID fails
  expect(() => service.exchange({ pairingCode: agent2.pairingCode, profileId: "shared-profile" })).toThrowError(HermesAgentFailure);

  // After revoking agent 1, profile can be reused
  service.revoke(adminId, agent1.agent.id);
  const reissued2 = service.issueInitialPairing(adminId, agent2.agent.id);
  const paired2 = service.exchange({ pairingCode: reissued2.pairingCode, profileId: "shared-profile" });
  expect(paired2.agent.status).toBe("paired");
});
