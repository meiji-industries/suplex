import { readFile } from "node:fs/promises";
import { DatabaseSync as Database } from "node:sqlite";
import { expect, test } from "vitest";

test("task turn workflow input migration backfills each turn from its session", async () => {
  const database = new Database(":memory:", { enableForeignKeyConstraints: false });
  try {
    database.exec("CREATE TABLE suplex_task_sessions (id text PRIMARY KEY, workflow_input_json text); CREATE TABLE suplex_task_turns (id text PRIMARY KEY, session_id text NOT NULL)");
    const first = JSON.stringify({ kind: "advisor", role: "planner_a", evidenceDirectory: "/first" });
    const second = JSON.stringify({ kind: "worker", mode: "direct", instruction: "Build" });
    database.prepare("INSERT INTO suplex_task_sessions (id, workflow_input_json) VALUES (?, ?), (?, ?), ('without-input', NULL)").run("advisor", first, "worker", second);
    database.exec("INSERT INTO suplex_task_turns (id, session_id) VALUES ('advisor-turn', 'advisor'), ('worker-turn', 'worker'), ('empty-turn', 'without-input')");

    const migration = await readFile(new URL("../apps/server/migrations/20260908024429009_task_turn_workflow_input.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) database.exec(statement);

    expect(database.prepare("SELECT id, workflow_input_json AS workflowInput FROM suplex_task_turns ORDER BY id").all()).toEqual([
      { id: "advisor-turn", workflowInput: first },
      { id: "empty-turn", workflowInput: null },
      { id: "worker-turn", workflowInput: second },
    ]);
  } finally { database.close(); }
});
