import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

const migration = (file: string) => readFileSync(new URL(`../apps/server/migrations/${file}`, import.meta.url), "utf8").split("--> statement-breakpoint").join("\n");

test("approve then build rebuilds workflows without losing rows, custom names, or trigger rules", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(migration("20260907152227784_workflow_records.sql"));
    database.exec(`UPDATE suplex_workflows SET name = 'My plans', configuration_json = '{"deliveryTarget":"branch"}' WHERE id = 'workflow_native_competing_plans';
      INSERT INTO suplex_workflows (id, name, description, engine, archived_at, created_at, updated_at) VALUES ('custom', 'Approve then build', 'Mine', 'standard', '2026-10-01T00:00:00.000Z', 't', 't');
      CREATE TABLE suplex_github_trigger_rules (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES suplex_workflows(id));
      INSERT INTO suplex_github_trigger_rules VALUES ('rule', 'custom'), ('native', 'workflow_native_competing_plans');`);
    const before = database.prepare("SELECT * FROM suplex_workflows ORDER BY id").all();
    database.exec(migration("20261005005413639_approve_then_build_workflow.sql"));
    database.exec("PRAGMA foreign_keys = ON");
    const rows = database.prepare("SELECT * FROM suplex_workflows ORDER BY id").all();
    expect(rows.filter(row => row.id !== "workflow_native_approve_then_build")).toEqual(before);
    expect(rows.find(row => row.id === "workflow_native_approve_then_build")).toMatchObject({ name: "Approve then build (Suplex)", engine: "approve_then_build", configuration_json: "{}", archived_at: null });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("SELECT w.name FROM suplex_github_trigger_rules r JOIN suplex_workflows w ON w.id = r.workflow_id ORDER BY r.id").all().map(row => row.name)).toEqual(["My plans", "Approve then build"]);
    expect(() => database.exec("INSERT INTO suplex_github_trigger_rules VALUES ('missing', 'nope')")).toThrow(/FOREIGN KEY/);
    expect(() => database.exec("INSERT INTO suplex_workflows (id, name, description, engine, created_at, updated_at) VALUES ('bad', 'Bad', '', 'other', 't', 't')")).toThrow(/CHECK/);
  } finally { database.close(); }
});

test("approve then build uses its own name when no workflow has it", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(migration("20260907152227784_workflow_records.sql"));
    database.exec(migration("20261005005413639_approve_then_build_workflow.sql"));
    expect(database.prepare("SELECT name, engine FROM suplex_workflows WHERE id = 'workflow_native_approve_then_build'").get()).toEqual({ name: "Approve then build", engine: "approve_then_build" });
  } finally { database.close(); }
});
