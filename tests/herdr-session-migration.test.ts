import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { migrateLegacyHerdrSessions } from "../src/herdr-session-migration.js";

function seed(database: ForgeDatabase, now: string): void {
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/plain', 1, ?, 'brief.md', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?)").run(now, now);
  });
}

test("migrates active file-backed sessions once and leaves them runnable", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-migration-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  const sessionRef = "session_aaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", `${sessionRef}.json`), '{"sessionId":"01999999-1111-7222-8333-444444444444"}');
    seed(database, now);
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('execution', 'task', 'company', 'workflow', 'planner', 'running', 1, ?, ?)").run(sessionRef, now);
    });
    await expect(migrateLegacyHerdrSessions(database, root)).resolves.toEqual({ inspected: 1, migrated: 1, unresolved: [] });
    expect(database.authQuery((db) => db.prepare("SELECT codex_session_id, status FROM forge_herdr_role_sessions WHERE task_id = 'task' AND session_role = 'lead'").get())).toEqual({ codex_session_id: "01999999-1111-7222-8333-444444444444", status: "missing" });
    await expect(migrateLegacyHerdrSessions(database, root)).resolves.toEqual({ inspected: 1, migrated: 0, unresolved: [] });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves reviewer sessions unresolved instead of assigning them to lead", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-migration-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  const sessionRef = "session_bbbbbbbbbbbbbbbbbbbbbbbb";
  try {
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", `${sessionRef}.json`), '{"sessionId":"01999999-1111-7222-8333-444444444444"}');
    seed(database, now);
    database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('reviewer', 'task', 'company', 'workflow', 'reviewer', 'running', 1, ?, ?)").run(sessionRef, now));
    await expect(migrateLegacyHerdrSessions(database, root)).resolves.toEqual({ inspected: 1, migrated: 0, unresolved: ["reviewer"] });
    expect(database.authQuery((db) => db.prepare("SELECT * FROM forge_herdr_role_sessions WHERE task_id = 'task' AND session_role = 'lead'").get())).toBeUndefined();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("returns conflicting legacy sessions as unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-migration-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  const first = "session_cccccccccccccccccccccccc";
  const second = "session_dddddddddddddddddddddddd";
  try {
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", `${first}.json`), '{"sessionId":"01999999-1111-7222-8333-444444444444"}');
    await writeFile(join(root, "sessions", `${second}.json`), '{"sessionId":"02888888-1111-7222-8333-444444444444"}');
    seed(database, now);
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('first', 'task', 'company', 'workflow', 'builder', 'running', 1, ?, ?)").run(first, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at) VALUES ('second', 'task', 'company', 'workflow', 1, 1, 'cancelling', 'task', '/worktrees/task', ?, ?, ?)").run("b".repeat(40), second, now);
    });
    await expect(migrateLegacyHerdrSessions(database, root)).resolves.toEqual({ inspected: 2, migrated: 0, unresolved: ["first", "second"] });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("returns missing legacy sessions as unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-migration-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  const sessionRef = "session_eeeeeeeeeeeeeeeeeeeeeeee";
  try {
    seed(database, now);
    database.authQuery((db) => db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at) VALUES ('missing', 'task', 'company', 'workflow', 'planner', 'running', 1, ?, ?)").run(sessionRef, now));
    await expect(migrateLegacyHerdrSessions(database, root)).resolves.toEqual({ inspected: 1, migrated: 0, unresolved: ["missing"] });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
