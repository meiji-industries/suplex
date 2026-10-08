import { readFile } from "node:fs/promises";

import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

async function migrationSql(): Promise<string[]> {
  const source = await readFile(new URL("../apps/server/migrations/20260813022954564_company_scoped_issue_keys.sql", import.meta.url), "utf8");
  return source.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

test("company issue numbers backfill deterministically and allocate without reuse", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  try {
    database.exec(`
      CREATE TABLE suplex_companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE suplex_tasks (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO suplex_companies VALUES ('company-a', 'A', 'active', '2026-01-01'), ('company-b', 'B', 'active', '2026-01-01');
      INSERT INTO suplex_tasks VALUES
        ('task-b', 'company-a', 'project-2', '2026-01-01T00:00:00Z'),
        ('task-a', 'company-a', 'project-1', '2026-01-01T00:00:00Z'),
        ('task-c', 'company-a', 'project-1', '2026-01-02T00:00:00Z'),
        ('task-d', 'company-b', 'project-9', '2026-01-03T00:00:00Z');
    `);
    for (const statement of await migrationSql()) database.exec(statement);

    expect(database.prepare("SELECT id, company_id, issue_number FROM suplex_tasks ORDER BY company_id, issue_number").all()).toEqual([
      { id: "task-a", company_id: "company-a", issue_number: 1 },
      { id: "task-b", company_id: "company-a", issue_number: 2 },
      { id: "task-c", company_id: "company-a", issue_number: 3 },
      { id: "task-d", company_id: "company-b", issue_number: 1 },
    ]);
    expect(database.prepare("SELECT id, next_issue_number FROM suplex_companies ORDER BY id").all()).toEqual([
      { id: "company-a", next_issue_number: 4 },
      { id: "company-b", next_issue_number: 2 },
    ]);

    database.prepare("INSERT INTO suplex_tasks (id, company_id, project_id, created_at) VALUES ('task-e', 'company-a', 'project-3', '2026-01-04')").run();
    database.prepare("INSERT INTO suplex_tasks (id, company_id, project_id, created_at) VALUES ('task-f', 'company-b', 'project-9', '2026-01-04')").run();
    expect(database.prepare("SELECT id, issue_number FROM suplex_tasks WHERE id IN ('task-e', 'task-f') ORDER BY id").all()).toEqual([
      { id: "task-e", issue_number: 4 },
      { id: "task-f", issue_number: 2 },
    ]);

    database.prepare("DELETE FROM suplex_tasks WHERE id = 'task-e'").run();
    database.prepare("INSERT INTO suplex_tasks (id, company_id, project_id, created_at) VALUES ('task-g', 'company-a', 'project-3', '2026-01-05')").run();
    expect(database.prepare("SELECT issue_number FROM suplex_tasks WHERE id = 'task-g'").get()).toEqual({ issue_number: 5 });
    expect(() => database.prepare("INSERT INTO suplex_tasks (id, company_id, project_id, created_at, issue_number) VALUES ('duplicate', 'company-a', 'project-3', '2026-01-06', 5)").run()).toThrow(/UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});
