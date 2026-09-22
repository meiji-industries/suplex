import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { applyMigrations, readMigrations } from "../src/platform/database.js";

const migrations = readMigrations(resolve(process.cwd(), "drizzle"));
const migration = migrations.find((candidate) => candidate.tag.includes("herdr_execution_substrate"))!;

function execute(database: Database.Database, candidate: typeof migration): void {
  for (const statement of readFileSync(resolve(process.cwd(), "drizzle", `${candidate.tag}.sql`), "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
}

test("timeline rebuild preserves legacy rows, orders them deterministically, and is idempotent", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    for (const candidate of migrations.filter((item) => item.createdAt < migration.createdAt)) execute(database, candidate);
    const now = "2026-08-23T00:00:00.000Z";
    database.exec("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', '2026-08-23T00:00:00.000Z');");
    database.exec("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z');");
    database.exec("INSERT INTO suplex_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'brief', '2026-08-23T00:00:00.000Z');");
    database.exec("INSERT INTO suplex_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z');");
    const insert = database.prepare("INSERT INTO suplex_issue_timeline (id, task_id, company_id, workflow_id, run_id, revision, event_type, metadata_json, created_at, event_hash) VALUES (?, 'task', 'company', ?, ?, ?, 'event', '{}', ?, ?)");
    insert.run("z", "workflow-b", "run-b", 2, now, "hash-z");
    insert.run("a", "workflow-a", "run-a", 1, now, "hash-a");
    execute(database, migration);

    expect(database.prepare("SELECT id, workflow_id, run_id, revision, event_hash, source, stream_id FROM suplex_issue_timeline ORDER BY stream_id").all()).toEqual([
      { id: "a", workflow_id: "workflow-a", run_id: "run-a", revision: 1, event_hash: "hash-a", source: "workflow", stream_id: 1 },
      { id: "z", workflow_id: "workflow-b", run_id: "run-b", revision: 2, event_hash: "hash-z", source: "workflow", stream_id: 2 },
    ]);
    database.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric NOT NULL)");
    const record = database.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
    for (const candidate of migrations) record.run(candidate.hash, candidate.createdAt);
    expect(() => applyMigrations(database, resolve(process.cwd(), "drizzle"))).not.toThrow();
    expect(database.prepare("SELECT count(*) AS count FROM suplex_issue_timeline").get()).toEqual({ count: 2 });
  } finally {
    database.close();
  }
});
