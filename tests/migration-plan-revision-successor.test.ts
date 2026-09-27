import { readFile } from "node:fs/promises";

import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

async function migrationSql(): Promise<string[]> {
  const source = await readFile(new URL("../migrations/20260812055304_plan_revision_successor.sql", import.meta.url), "utf8");
  return source.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

function baseSchema(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE suplex_companies (id TEXT PRIMARY KEY);
    CREATE TABLE suplex_projects (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES suplex_companies(id));
    CREATE TABLE suplex_project_revisions (id TEXT PRIMARY KEY);
    CREATE TABLE suplex_users (id TEXT PRIMARY KEY);
    CREATE TABLE suplex_artifacts (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_path TEXT NOT NULL);
    CREATE TABLE suplex_developer_executions (id TEXT PRIMARY KEY);
    CREATE TABLE suplex_tasks (id TEXT PRIMARY KEY, predecessor_task_id TEXT, successor_task_id TEXT);
    INSERT INTO suplex_companies VALUES ('company');
    INSERT INTO suplex_projects VALUES ('project', 'company');
    INSERT INTO suplex_project_revisions VALUES ('project-revision');
    INSERT INTO suplex_users VALUES ('user');
    INSERT INTO suplex_artifacts VALUES ('reason', 'company', 'plan-revision-reason', 'reason.md', 'text/markdown', 1, '${"a".repeat(64)}', 'company/objects/reason');
  `);
}

test("the plan revision and successor migration preserves existing task links and installs guarded coordinates", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  try {
    baseSchema(database);
    database.exec("INSERT INTO suplex_tasks VALUES ('task-a', NULL, 'task-b'), ('task-b', 'task-a', NULL)");
    for (const statement of await migrationSql()) database.exec(statement);

    expect(database.prepare("SELECT id, predecessor_task_id, successor_task_id FROM suplex_tasks ORDER BY id").all()).toEqual([
      { id: "task-a", predecessor_task_id: null, successor_task_id: "task-b" },
      { id: "task-b", predecessor_task_id: "task-a", successor_task_id: null },
    ]);
    expect(() => database.prepare("INSERT INTO suplex_tasks VALUES ('task-c', 'task-a', NULL)").run()).toThrow(/UNIQUE constraint failed/);
    expect(() => database.prepare("INSERT INTO suplex_tasks VALUES ('task-d', NULL, 'task-b')").run()).toThrow(/UNIQUE constraint failed/);

    const sha = "b".repeat(40);
    const insert = database.prepare(`INSERT INTO suplex_plan_revision_requests
      (id, task_id, company_id, workflow_id, request_revision, actor_user_id, reason_artifact_id, disposition, status, blocker_code, developer_execution_id, worktree_path, branch_name, base_sha, head_sha, tree_sha, dirty_state, exact_base_sha, created_at, updated_at)
      VALUES (?, 'task-a', 'company', ?, ?, 'user', 'reason', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`);
    insert.run("revision-1", "workflow", 1, "new", "accepted", null, null, null, null, null, null, null, null, sha);
    expect(database.prepare("SELECT disposition, status, exact_base_sha FROM suplex_plan_revision_requests WHERE id = 'revision-1'").get()).toEqual({ disposition: "new", status: "accepted", exact_base_sha: sha });
    expect(() => insert.run("revision-duplicate", "workflow", 1, "new", "accepted", null, null, null, null, null, null, null, null, sha)).toThrow(/UNIQUE constraint failed/);
    expect(() => insert.run("revision-invalid", "workflow-2", 2, "new", "accepted", "unexpected-blocker", null, null, null, null, null, null, null, sha)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run("revision-reuse-invalid", "workflow-3", 3, "reuse", "accepted", null, null, null, null, null, null, null, null, null)).toThrow(/CHECK constraint failed/);

    database.exec("INSERT INTO suplex_tasks VALUES ('task-successor', NULL, NULL)");
    const successor = database.prepare(`INSERT INTO suplex_successor_intents
      (id, predecessor_task_id, predecessor_workflow_id, accepted_revision, successor_task_id, successor_workflow_id, company_id, project_id, project_revision_id, actor_user_id, reason_artifact_id, state, created_at, updated_at)
      VALUES (?, 'task-a', 'workflow', 7, 'task-successor', 'successor-workflow', 'company', 'project', 'project-revision', 'user', 'reason', 'workflow_starting', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`);
    successor.run("intent-1");
    expect(() => successor.run("intent-duplicate")).toThrow(/UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test("the plan revision and successor migration refuses ambiguous historical task links", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  try {
    baseSchema(database);
    database.exec("INSERT INTO suplex_tasks VALUES ('task-a', NULL, 'task-b'), ('task-c', NULL, 'task-b')");
    await expect(migrationSql().then((statements) => { for (const statement of statements) database.exec(statement); })).rejects.toThrow(/no_duplicate_successor_links/);
  } finally {
    database.close();
  }
});
