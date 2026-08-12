import { readFile } from "node:fs/promises";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("migration 0020 accepts an interrupted intent whose reserved task was never inserted", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    database.exec(`
      CREATE TABLE forge_companies (id TEXT PRIMARY KEY);
      CREATE TABLE forge_projects (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES forge_companies(id));
      CREATE TABLE forge_artifacts (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_path TEXT NOT NULL);
      CREATE TABLE forge_tasks (id TEXT PRIMARY KEY, brief_artifact_id TEXT, image_artifact_ids_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE forge_task_creation_intents (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES forge_companies(id), project_id TEXT NOT NULL REFERENCES forge_projects(id), task_id TEXT NOT NULL, workflow_id TEXT NOT NULL, artifact_ids_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, error_code TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE forge_issue_timeline (id TEXT PRIMARY KEY);
      CREATE TABLE forge_workflow_snapshots (task_id TEXT NOT NULL);
      CREATE TABLE forge_issue_projections (task_id TEXT PRIMARY KEY, event_hash TEXT NOT NULL DEFAULT '');
      INSERT INTO forge_companies VALUES ('company');
      INSERT INTO forge_projects VALUES ('project', 'company');
      INSERT INTO forge_task_creation_intents VALUES ('intent', 'company', 'project', 'task-not-inserted', 'workflow', '[]', 'staging', NULL, '2026-08-11T00:00:00.000Z');
    `);
    const migration = await readFile(new URL("../drizzle/0020_durable_task_projection_provenance.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
    expect(database.prepare("SELECT artifact_manifest_json, error_code FROM forge_task_creation_intents WHERE id = 'intent'").get()).toEqual({ artifact_manifest_json: "[]", error_code: "legacy-artifact-manifest-unknown" });
  } finally {
    database.close();
  }
});
