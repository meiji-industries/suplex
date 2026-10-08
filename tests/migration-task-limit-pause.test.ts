import { readFile } from "node:fs/promises";
import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

test("task limit pause migration preserves controls and starts without authorization", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  try {
    database.exec("CREATE TABLE suplex_task_controls (task_id TEXT PRIMARY KEY); INSERT INTO suplex_task_controls VALUES ('task')");
    const migration = await readFile(new URL("../apps/server/migrations/20260908133108006_task_limit_pause.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) database.exec(statement);
    expect(database.prepare("SELECT task_id AS taskId, limit_pause_json AS limitPause FROM suplex_task_controls").get()).toEqual({ taskId: "task", limitPause: null });
    database.prepare("UPDATE suplex_task_controls SET limit_pause_json = ? WHERE task_id = 'task'").run(JSON.stringify({ kind: "task_limit" }));
    expect(database.prepare("SELECT limit_pause_json AS limitPause FROM suplex_task_controls WHERE task_id = 'task'").get()).toEqual({ limitPause: JSON.stringify({ kind: "task_limit" }) });
  } finally { database.close(); }
});
