import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { applyMigrations } from "../src/database.js";

const drizzleRoot = join(process.cwd(), "drizzle");
const now = "2026-08-12T00:00:00.000Z";

async function migrationFolder(root: string): Promise<string> {
  const destination = join(root, "drizzle");
  await mkdir(destination, { recursive: true });
  for (const filename of await readdir(drizzleRoot)) {
    if (/^\d{14}(?:\d{3})?_.*\.sql$/.test(filename) && filename !== "20260812065000_durable_capacity_lanes.sql") await cp(join(drizzleRoot, filename), join(destination, filename));
  }
  return destination;
}

function seedLegacyDatabase(database: Database.Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin', 'admin', 'active', ?, ?)").run(now, now);
  database.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
  database.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile', 'Profile', 'codex', 'gpt-5.6-sol', 'high', 'priority', 3, ?, ?)").run(now, now);
  database.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', 'setup', 'test', '[]', '[\"profile\"]', '{}', 'active', 'revision', ?, ?)").run(now, now);
  database.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('revision', 'project', 1, 'identity', '{}', ?, ?, 'admin', ?)").run("a".repeat(40), "b".repeat(40), now);
  for (const suffix of ["unique", "ambiguous", "released"]) {
    database.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company', 'task-brief', ?, 'text/plain', 1, ?, ?, ?)").run(`brief-${suffix}`, `${suffix}.txt`, "c".repeat(64), `company/${suffix}`, now);
    database.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, 'company', 'project', ?, ?, '[]', ?, 0, ?, 'revision', ?, ?, ?)").run(`task-${suffix}`, suffix, `brief-${suffix}`, JSON.stringify({ lead: "profile", reviewer: "profile", developer: "profile" }), `workflow-${suffix}`, `key-${suffix}`, now, now);
  }
  database.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('agent-unique', 'task-unique', 'company', 'workflow-unique', 'lead', 'running', 1, 'session-unique', ?)").run(now);
  database.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('agent-ambiguous-lead', 'task-ambiguous', 'company', 'workflow-ambiguous', 'lead', 'running', 1, 'session-ambiguous-lead', ?)").run(now);
  database.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('agent-ambiguous-reviewer', 'task-ambiguous', 'company', 'workflow-ambiguous', 'reviewer', 'running', 1, 'session-ambiguous-reviewer', ?)").run(now);
  database.prepare("INSERT INTO forge_capacity_requests (id, company_id, task_id, workflow_id, turn_kind, status, requested_at, acquired_at) VALUES ('capacity-unique', 'company', 'task-unique', 'workflow-unique', 'lead', 'active', ?, ?)").run(now, now);
  database.prepare("INSERT INTO forge_capacity_requests (id, company_id, task_id, workflow_id, turn_kind, status, requested_at, acquired_at) VALUES ('capacity-ambiguous', 'company', 'task-ambiguous', 'workflow-ambiguous', 'review', 'active', ?, ?)").run(now, now);
  database.prepare("INSERT INTO forge_capacity_requests (id, company_id, task_id, workflow_id, turn_kind, status, requested_at, acquired_at, released_at, release_reason) VALUES ('capacity-released', 'company', 'task-released', 'workflow-released', 'developer', 'released', ?, ?, ?, 'completed')").run(now, now, now);
}

test("the durable capacity migration preserves legacy history, binds a unique owner, and fails ambiguous ownership closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-capacity-migration-"));
  const folder = await migrationFolder(root);
  const sqlite = new Database(join(root, "forge.db"));
  try {
    applyMigrations(sqlite, folder);
    seedLegacyDatabase(sqlite);

    await cp(join(drizzleRoot, "20260812065000_durable_capacity_lanes.sql"), join(folder, "20260812065000_durable_capacity_lanes.sql"));
    applyMigrations(sqlite, folder);

    const rows = sqlite.prepare("SELECT id, logical_turn_key, profile_id, provider, model, reasoning_level, service_priority, lane_key, requested_capacity, status, execution_kind, execution_id, terminal_reason FROM forge_capacity_requests ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === "capacity-unique")).toMatchObject({ logical_turn_key: "workflow-unique:lead:legacy:capacity-unique", profile_id: "profile", provider: "codex", model: "gpt-5.6-sol", reasoning_level: "high", service_priority: "priority", lane_key: "codex:profile", requested_capacity: 3, status: "active", execution_kind: "agent", execution_id: "agent-unique", terminal_reason: null });
    expect(rows.find((row) => row.id === "capacity-ambiguous")).toMatchObject({ status: "ownership_ambiguous", execution_kind: null, execution_id: null, terminal_reason: "ownership_ambiguous" });
    expect(rows.find((row) => row.id === "capacity-released")).toMatchObject({ status: "released", terminal_reason: "completed" });
    expect(sqlite.prepare("SELECT capacity FROM forge_profiles WHERE id = 'profile'").get()).toEqual({ capacity: 3 });
  } finally {
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
