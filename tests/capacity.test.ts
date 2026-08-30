import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { CapacityManager, type CapacityProfileIdentity, type CapacityQueueDetails } from "../src/capacity.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-capacity-test-"));
  const config = createTestConfig(root, {
    externalTurnCapacity: 3,
    externalTurnCapacityByProvider: { codex: 3, claude: 1, openrouter: 2 },
  });
  const database = new ForgeDatabase(config.databasePath);
  const profiles = {
    codex: { id: "profile_codex_override", name: "Codex override", provider: "codex" } satisfies CapacityProfileIdentity,
    codexPeer: { id: "profile_codex_peer", name: "Codex peer", provider: "codex" } satisfies CapacityProfileIdentity,
    claude: { id: "profile_claude_default", name: "Claude inherited", provider: "claude" } satisfies CapacityProfileIdentity,
    builder: { id: "profile_openrouter_builder", name: "GLM 5.3", provider: "openrouter" } satisfies CapacityProfileIdentity,
  };
  database.authQuery((db) => {
    const insert = db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, 'medium', 'standard', ?, ?, ?)");
    const now = "2026-08-30T00:00:00.000Z";
    insert.run(profiles.codex.id, profiles.codex.name, profiles.codex.provider, "gpt-5.6-sol", 1, now, now);
    insert.run(profiles.codexPeer.id, profiles.codexPeer.name, profiles.codexPeer.provider, "gpt-5.6-sol", 1, now, now);
    insert.run(profiles.claude.id, profiles.claude.name, profiles.claude.provider, "claude-opus", null, now, now);
    insert.run(profiles.builder.id, profiles.builder.name, profiles.builder.provider, "z-ai/glm-5.3", 1, now, now);
  });
  return { root, config, database, profiles };
}

test("profile limits and admin counters are independent within one provider", async () => {
  const value = await fixture();
  try {
    const slots = new CapacityManager(value.database, value.config);
    const releaseCodex = await slots.acquire(value.profiles.codex);
    const releasePeer = await slots.acquire(value.profiles.codexPeer);
    const controller = new AbortController();
    let ran = false;
    const queued = slots.run(async () => { ran = true; }, value.profiles.codex, undefined, controller.signal);
    try {
      expect(ran).toBe(false);
      expect(slots.listAdminLanes()).toEqual(expect.arrayContaining([
        expect.objectContaining({ profileId: value.profiles.codex.id, effectiveCapacity: 1, activeCount: 1, queuedCount: 1 }),
        expect.objectContaining({ profileId: value.profiles.codexPeer.id, effectiveCapacity: 1, activeCount: 1, queuedCount: 0 }),
      ]));
      releaseCodex();
      await queued;
      expect(ran).toBe(true);
    } finally {
      controller.abort();
      releaseCodex();
      releasePeer();
      await queued.catch(() => undefined);
    }
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a null profile capacity uses that profile provider default", async () => {
  const value = await fixture();
  try {
    const slots = new CapacityManager(value.database, value.config);
    const release = await slots.acquire(value.profiles.claude);
    const controller = new AbortController();
    const details: unknown[] = [];
    const queued = slots.acquire(value.profiles.claude, (detail) => details.push(detail), controller.signal);
    try {
      expect(details).toContainEqual({
        queued: true,
        profileId: value.profiles.claude.id,
        profileName: value.profiles.claude.name,
        provider: "claude",
        position: 1,
        activeCount: 1,
        capacity: 1,
      } satisfies CapacityQueueDetails);
      controller.abort();
      await expect(queued).rejects.toMatchObject({ name: "CancelledFailure" });
    } finally {
      controller.abort();
      release();
      await queued.catch(() => undefined);
    }
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a builder turn queues on the selected builder profile and publishes the lane status", async () => {
  const value = await fixture();
  try {
    const now = "2026-08-30T00:00:00.000Z";
    value.database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_agents (id, name, role, avatar_seed, profile_id, created_at, updated_at) VALUES ('agent_builder', 'Cheap Agent', 'builder', ?, ?, ?, ?)").run("a".repeat(32), value.profiles.builder.id, now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/tmp/forge-capacity-repo', '/tmp/forge-capacity-worktrees', 'acme/forge', 'main', 'main', 'true', 'true', '[]', ?, 'active', ?, ?)").run(JSON.stringify({ builder: "agent_builder" }), now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'capacity-brief', ?)").run("b".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', ?, 0, 'workflow', 'revision', 'capacity-task', ?, ?)").run(JSON.stringify({ builder: "agent_builder" }), now, now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, authoritative_event_hash, projected_at) VALUES ('task', 'company', 'project', 'workflow', 1, 'development', 'developer', '[]', 'Builder is working', ?, 'workflow:1', ?, 1, ?, ?)").run(now, "c".repeat(64), "c".repeat(64), now);
    });
    const context = createActivityContext(value.database, value.config);
    const release = await context.capacity.acquire(value.profiles.builder);
    let ran = false;
    const turn = context.invokeAgent({ taskId: "task", companyId: "company", projectId: "project", roleProfiles: { builder: value.profiles.builder.id } }, async () => { ran = true; }, "builder");
    try {
      expect(ran).toBe(false);
      expect(context.capacity.listAdminLanes()).toEqual(expect.arrayContaining([
        expect.objectContaining({ profileId: value.profiles.builder.id, activeCount: 1, queuedCount: 1 }),
        expect.objectContaining({ profileId: value.profiles.codex.id, activeCount: 0, queuedCount: 0 }),
      ]));
      expect(value.database.authQuery((db) => db.prepare("SELECT pending_action AS pendingAction FROM forge_issue_projections WHERE task_id = 'task'").get())).toEqual({ pendingAction: "Builder is working" });
      release();
      await turn;
      expect(ran).toBe(true);
      expect(value.database.authQuery((db) => db.prepare("SELECT pending_action AS pendingAction FROM forge_issue_projections WHERE task_id = 'task'").get())).toEqual({ pendingAction: "Builder is working" });
    } finally {
      release();
      await turn;
    }
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a restarted worker does not retain stale profile slots", async () => {
  const value = await fixture();
  try {
    const staleWorker = new CapacityManager(value.database, value.config);
    const releaseStale = await staleWorker.acquire(value.profiles.codex);
    const restartedWorker = new CapacityManager(value.database, value.config);
    const releaseRestarted = await restartedWorker.acquire(value.profiles.codex);
    releaseStale();
    releaseRestarted();
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
