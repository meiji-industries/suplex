import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("Blocked by references become dependency edges without losing or duplicating an edge", async () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`CREATE TABLE forge_tasks (id TEXT PRIMARY KEY, start_when_blocked_by_delivered INTEGER NOT NULL DEFAULT 0);
      ALTER TABLE forge_tasks ADD COLUMN blocked_by_task_id TEXT REFERENCES forge_tasks(id);
      CREATE INDEX forge_tasks_blocked_by_task_id_idx ON forge_tasks (blocked_by_task_id);
      CREATE INDEX forge_tasks_blocked_by_auto_start_idx ON forge_tasks(blocked_by_task_id) WHERE start_when_blocked_by_delivered = 1;
      CREATE TABLE forge_task_dependencies (task_id text NOT NULL, depends_on_task_id text NOT NULL, created_at text NOT NULL, PRIMARY KEY (task_id, depends_on_task_id), CHECK (task_id <> depends_on_task_id), FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE, FOREIGN KEY (depends_on_task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE);`);
    const task = database.prepare("INSERT INTO forge_tasks (id, blocked_by_task_id, start_when_blocked_by_delivered) VALUES (?, ?, ?)");
    for (const id of ["a", "b", "c"]) task.run(id, null, 0);
    task.run("legacy_only", "a", 1);
    task.run("edges_only", null, 0);
    task.run("overlap", "a", 0);
    task.run("distinct", "b", 0);
    task.run("self", null, 0);
    database.prepare("UPDATE forge_tasks SET blocked_by_task_id = id WHERE id = 'self'").run();
    const edge = database.prepare("INSERT INTO forge_task_dependencies VALUES (?, ?, 'before')");
    edge.run("edges_only", "a"); edge.run("edges_only", "b");
    edge.run("overlap", "a");
    edge.run("distinct", "c");

    const migration = await readFile(new URL("../drizzle/20260918164301166_consolidate_task_blocked_by_into_dependencies.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) database.exec(statement);

    expect(database.prepare("SELECT task_id AS taskId, depends_on_task_id AS dependsOn FROM forge_task_dependencies ORDER BY task_id, depends_on_task_id").all()).toEqual([
      { taskId: "distinct", dependsOn: "b" }, { taskId: "distinct", dependsOn: "c" },
      { taskId: "edges_only", dependsOn: "a" }, { taskId: "edges_only", dependsOn: "b" },
      { taskId: "legacy_only", dependsOn: "a" },
      { taskId: "overlap", dependsOn: "a" },
    ]);
    expect(database.prepare("SELECT created_at AS createdAt FROM forge_task_dependencies WHERE task_id = 'overlap'").get()).toEqual({ createdAt: "before" });
    expect(database.prepare("SELECT name FROM pragma_table_info('forge_tasks') ORDER BY cid").all()).toEqual([{ name: "id" }, { name: "start_when_blocked_by_delivered" }]);
    expect(database.prepare("SELECT start_when_blocked_by_delivered AS waiting FROM forge_tasks WHERE id = 'legacy_only'").get()).toEqual({ waiting: 1 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  } finally { database.close(); }
});
