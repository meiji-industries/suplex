import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("legacy issue associations use captured repository coordinates without changing authored content", async () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE forge_tasks (id TEXT PRIMARY KEY, title TEXT, configuration_json TEXT, issue_json TEXT)");
    const insert = database.prepare("INSERT INTO forge_tasks VALUES (?, ?, ?, ?)");
    insert.run("issue", "Task title", JSON.stringify({ repository: "client/repository", source: { kind: "issue", number: 42 } }), null);
    insert.run("pr", "Pull request", JSON.stringify({ repository: "client/repository", source: { kind: "pull_request", number: 42 } }), null);
    insert.run("existing", "Task title", JSON.stringify({ repository: "client/repository", source: { kind: "issue", number: 42 } }), '{"existing":true}');
    database.exec(await readFile(new URL("../drizzle/20260917034443375_backfill_task_issue_associations.sql", import.meta.url), "utf8"));
    expect(database.prepare("SELECT title, json_extract(issue_json, '$.url') AS url FROM forge_tasks WHERE id = 'issue'").get()).toEqual({ title: "Task title", url: "https://github.com/client/repository/issues/42" });
    expect(database.prepare("SELECT issue_json FROM forge_tasks WHERE id = 'pr'").get()).toEqual({ issue_json: null });
    expect(database.prepare("SELECT issue_json FROM forge_tasks WHERE id = 'existing'").get()).toEqual({ issue_json: '{"existing":true}' });
  } finally { database.close(); }
});
